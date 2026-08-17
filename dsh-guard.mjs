#!/usr/bin/env node
/**
 * dsh-guard — 给 `dsh <profile>`（例如 `dsh web`）加一层「启动看门狗 + 自动回滚」。
 *
 * 背景：安装第三方插件后 `dsh web` 经常打不开（坏插件让整棵树在启动阶段就崩溃）。
 * 本工具在每次成功启动后把当前 profile 配置拍成「已知可用」快照；下次启动一旦
 * 检测到失败，就自动「禁用」导致问题的插件（**保留已下载的文件和依赖，不删除**）
 * 并重试。
 *
 * 为什么是外部工具而不是 dsh 插件：坏插件会在插件树加载/启动阶段就让 dsh 崩溃，
 * 此时任何插件自身都还没机会运行，所以看门狗必须待在 dsh 进程之外。
 *
 * 用法：
 *   dsh-guard web                     看门狗启动 web（失败自动禁用坏插件并重试）
 *   dsh-guard web --host 127.0.0.1    web 后面的参数原样传给 dsh
 *   dsh-guard snapshot web            立刻把当前配置标记为「已知可用」（不启动）
 *   dsh-guard restore web             硬回滚：把 profile 完全恢复到快照（会移除快照后新增的插件）
 *   dsh-guard status web              显示当前配置与快照的差异
 *   dsh-guard --help
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** profile 目录里决定「能不能打开」的配置/清单文件。 */
const CONFIG_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** 启动失败的特征信息（dsh 的 load-failure 诊断都写到 stderr）。 */
const FATAL_MARKERS = [
  /fatal load failure/i,
  /plugin tree failed to load/i,
  /plugin\(s\) failed to load/i,
  /did not activate/i,
  /cannot resolve profile bundle/i,
  /declares no dsh\.bundle/i,
  /failed to parse/i,
  /failed to read overlay/i,
  /failed to read patches/i,
  /config file not found/i,
  /web boot:/i,
];

/** `dsh web` 启动成功时会打印 `dsh web: http://127.0.0.1:<port>`。 */
const SUCCESS_URL = /dsh (web|tui|headless)?:?\s+https?:\/\//i;

const DSH_HOME_ENV = "DSH_HOME";
const DEFAULT_GRACE_MS = 20000;
const DEFAULT_RETRY = 1;

/** 内置核心 bundle 前缀：这些是 dsh 安装自带的，永不参与「禁用」。 */
const INBOX_PREFIX = "@deepseek-ai/";

// ---------------------------------------------------------------------------
// 路径解析（与 DSH 自身 `resolveDshHome` 保持一致）
// ---------------------------------------------------------------------------

function expandHomePath(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function resolveDshHome() {
  const fromEnv = process.env[DSH_HOME_ENV];
  const base = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), ".dsh");
  return resolve(expandHomePath(base));
}

function profileDir(profile) {
  return join(resolveDshHome(), "profiles", profile);
}

function snapDir(profile) {
  return join(resolveDshHome(), "snapshots", profile);
}

// ---------------------------------------------------------------------------
// 配置快照：读取 / 比较 / 写入 / 恢复
// ---------------------------------------------------------------------------

function readConfig(dir) {
  const config = {};
  for (const name of CONFIG_FILES) {
    const p = join(dir, name);
    config[name] = existsSync(p) ? readFileSync(p) : null;
  }
  return config;
}

function readSnapshot(dir) {
  if (!existsSync(join(dir, "meta.json"))) return null;
  const config = {};
  for (const name of CONFIG_FILES) {
    const p = join(dir, name);
    config[name] = existsSync(p) ? readFileSync(p) : null;
  }
  return config;
}

function sameConfig(a, b) {
  for (const name of CONFIG_FILES) {
    const x = a[name];
    const y = b[name];
    if ((x === null) !== (y === null)) return false;
    if (x !== null && !x.equals(y)) return false;
  }
  return true;
}

function writeSnapshot(dir, config) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of CONFIG_FILES) {
    if (config[name] === null) continue;
    writeFileSync(join(dir, name), config[name]);
    files.push(name);
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ savedAt: new Date().toISOString(), files }, null, 2) + "\n");
}

/** 只把快照里选定的文件写回 profile（硬回滚用；不影响其它文件）。 */
function restoreFiles(dir, config, names) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    if (config[name] === null) continue;
    writeFileSync(join(dir, name), config[name]);
  }
}

function restoreSnapshot(dir, config) {
  restoreFiles(dir, config, CONFIG_FILES);
}

// ---------------------------------------------------------------------------
// 差异分析：找出「导致启动失败」的第三方 bundle
// ---------------------------------------------------------------------------

function readManifest(config) {
  const raw = config["package.json"];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 找出需要禁用的第三方 bundle：相对快照「新增」的，或依赖版本/来源「改变」的。
 * 内置 `@deepseek-ai/*` 一律排除（禁用它等于让 dsh 本身不可用）。
 * @returns bundle 包名数组。
 */
function computeOffenders(currentManifest, goodManifest) {
  const cur = currentManifest?.dsh?.profile?.bundles ?? [];
  const snap = goodManifest?.dsh?.profile?.bundles ?? [];
  const curDeps = currentManifest?.dependencies ?? {};
  const snapDeps = goodManifest?.dependencies ?? {};
  const out = new Set();
  for (const name of cur) {
    if (name.startsWith(INBOX_PREFIX)) continue;
    if (!snap.includes(name)) out.add(name);
    else if ((curDeps[name] ?? null) !== (snapDeps[name] ?? null)) out.add(name);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// 「禁用而不删除」的实现
// ---------------------------------------------------------------------------

/** 解析 bundle 包目录（第三方插件由 pnpm 装进 profile 的 node_modules）。 */
function bundleDir(profileDirPath, name) {
  const dir = join(profileDirPath, "node_modules", name);
  return existsSync(join(dir, "package.json")) ? dir : null;
}

/** 从 bundle 的 cordis.patch.yml 里提取它 insert 出来的条目 id。 */
function extractEntryIds(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const patchRel = manifest?.dsh?.bundle?.patch;
    if (!patchRel) return [];
    const patches = yaml.load(readFileSync(join(dir, patchRel), "utf8")) ?? [];
    const ids = [];
    for (const p of patches) {
      if (p && Array.isArray(p.insert)) {
        for (const e of p.insert) if (e && typeof e.id === "string") ids.push(e.id);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * 在 profile 的 `cordis.patch.yml` 末尾追加 `- id: X` / `  disabled: true`，
 * **不改动、不重排已有内容**（保留用户手写的注释与格式）。已存在的禁用项会跳过。
 * @returns 实际新增的禁用条目数量。
 */
function disableEntries(profileDirPath, ids) {
  const patchPath = join(profileDirPath, "cordis.patch.yml");
  const alreadyDisabled = new Set();
  if (existsSync(patchPath)) {
    try {
      const patches = yaml.load(readFileSync(patchPath, "utf8")) ?? [];
      for (const p of patches) if (p && p.id && p.disabled === true) alreadyDisabled.add(p.id);
    } catch {
      /* 读不了就当没有，走文本追加，最多造成一次重复的禁用条目（幂等，无害）。 */
    }
  }
  const toAdd = ids.filter((id) => typeof id === "string" && id.length > 0 && !alreadyDisabled.has(id));
  if (toAdd.length === 0) return 0;

  let content = existsSync(patchPath)
    ? readFileSync(patchPath, "utf8")
    : "# profile patch layer (disabled entries appended by dsh-guard)\n";
  if (content && !content.endsWith("\n")) content += "\n";
  for (const id of toAdd) content += `- id: ${id}\n  disabled: true\n`;
  writeFileSync(patchPath, content);
  return toAdd.length;
}

/**
 * 兜底禁用：当拿不到 bundle 的条目 id 时，把它从 `dsh.profile.bundles` 移除，
 * 但**保留在 dependencies 和 node_modules**（仍然不删除下载的东西）。
 * @returns 是否有改动。
 */
function removeFromBundles(profileDirPath, names) {
  const manifestPath = join(profileDirPath, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  const next = bundles.filter((n) => !names.includes(n));
  if (next.length === bundles.length) return false;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// pnpm：硬回滚（restore）后，把 node_modules 对齐到快照的依赖状态
// ---------------------------------------------------------------------------

function runPnpmInstall(dir) {
  const run = (args) => {
    if (process.platform === "win32") {
      const command = ["pnpm", ...args].map(winQuoteArg).join(" ");
      return spawnSync(command, { cwd: dir, stdio: "inherit", shell: true });
    }
    return spawnSync("pnpm", args, { cwd: dir, stdio: "inherit" });
  };
  let r = run(["install", "--frozen-lockfile"]);
  if (r.status === 0) return true;
  if (r.error && r.error.code === "ENOENT") {
    process.stderr.write("[dsh-guard] 未找到 pnpm，跳过 node_modules 对齐（通常不影响回滚后的启动）。\n");
    return false;
  }
  process.stderr.write("[dsh-guard] pnpm install --frozen-lockfile 失败，回退到 pnpm install ...\n");
  r = run(["install"]);
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// 启动 dsh 子进程，实时转发输出，并观察「成功 URL / 致命错误」
// ---------------------------------------------------------------------------

function winQuoteArg(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

function spawnDsh(profile, dshArgs) {
  if (process.env.DSH_BIN) {
    return spawn(process.execPath, [process.env.DSH_BIN, profile, ...dshArgs], {
      stdio: ["inherit", "pipe", "pipe"],
    });
  }
  if (process.platform === "win32") {
    const command = ["dsh", profile, ...dshArgs].map(winQuoteArg).join(" ");
    return spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  }
  return spawn("dsh", [profile, ...dshArgs], { stdio: ["inherit", "pipe", "pipe"] });
}

function runDsh(profile, dshArgs) {
  return new Promise((resolvePromise) => {
    const child = spawnDsh(profile, dshArgs);
    const saw = { url: false, fatal: false };
    let buf = "";
    let stderrBuf = "";

    const feed = (chunk, sink, tag) => {
      const s = chunk.toString();
      sink.write(s);
      if (tag === "stdout") {
        // 成功信号只来自 stdout（`dsh web: http://…` 这行 URL）。
        buf += s;
        if (buf.length > 1_000_000) buf = buf.slice(-200_000);
        if (!saw.url && SUCCESS_URL.test(buf)) saw.url = true;
      } else {
        // 致命信号只来自 stderr。
        stderrBuf += s;
        if (stderrBuf.length > 1_000_000) stderrBuf = stderrBuf.slice(-200_000);
        if (!saw.fatal && FATAL_MARKERS.some((m) => m.test(stderrBuf))) saw.fatal = true;
      }
    };

    child.stdout.on("data", (c) => feed(c, process.stdout, "stdout"));
    child.stderr.on("data", (c) => feed(c, process.stderr, "stderr"));
    child.on("error", (err) => resolvePromise({ error: err, saw }));
    child.on("exit", (code, signal) => resolvePromise({ code, signal, saw }));
  });
}

// ---------------------------------------------------------------------------
// 启动看门狗主流程
// ---------------------------------------------------------------------------

async function guard(profile, dshArgs, opts) {
  const pDir = profileDir(profile);
  const sDir = snapDir(profile);

  for (let attempt = 0; ; attempt++) {
    const current = readConfig(pDir);
    const good = readSnapshot(sDir);
    const changed = good === null || !sameConfig(current, good);

    const started = Date.now();
    const result = await runDsh(profile, dshArgs);
    const elapsed = Date.now() - started;

    if (result.error) {
      process.stderr.write(`[dsh-guard] 无法启动 dsh：${result.error.message}\n`);
      process.stderr.write("[dsh-guard] 请确认 dsh 在 PATH 上（可设置 DSH_BIN 指向 bin.js）。\n");
      return 1;
    }

    const { code, signal, saw } = result;
    const cleanExit = code === 0 || code === 130 || signal === "SIGINT" || signal === "SIGTERM";
    const success = saw.url || elapsed >= opts.graceMs;

    // 1) 成功：看到 URL，或撑过了启动窗口。
    if (success) {
      if (changed) writeSnapshot(sDir, current);
      return code ?? 0;
    }

    // 2) 干净退出但没看到 URL（`dsh web --help`，或启动瞬间 Ctrl+C）：不算失败。
    if (cleanExit) return code ?? 0;

    // 3) 启动失败。
    const bootFailure = saw.fatal || elapsed < opts.graceMs;

    if (bootFailure && good !== null && changed && attempt < opts.retry) {
      const offenders = computeOffenders(readManifest(current), readManifest(good));
      if (offenders.length > 0) {
        // 禁用而不删除：保留已下载的插件，只让它不再参与启动。
        const unhandled = [];
        let disabled = 0;
        for (const name of offenders) {
          const dir = bundleDir(pDir, name);
          const ids = dir ? extractEntryIds(dir) : [];
          if (ids.length > 0) disabled += disableEntries(pDir, ids);
          else unhandled.push(name);
        }
        if (unhandled.length > 0) removeFromBundles(pDir, unhandled);
        process.stderr.write(
          `\n[dsh-guard] ⚠ 启动失败。已禁用（未删除）插件：${offenders.join(", ")}；其依赖与下载文件均保留。\n`,
        );
        process.stderr.write(`[dsh-guard] 第 ${attempt + 2} 次尝试启动 …\n\n`);
        continue;
      }

      // 没有第三方插件变更：多半是用户自己改坏了 cordis.patch.yml 等，回滚这几个文件（不动已下载插件）。
      restoreFiles(pDir, good, ["cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
      process.stderr.write(
        `\n[dsh-guard] ⚠ 启动失败，且未发现新增/变更的第三方插件，已回滚 profile 自身的配置改动（未动已下载插件）。\n`,
      );
      process.stderr.write(`[dsh-guard] 第 ${attempt + 2} 次尝试启动 …\n\n`);
      continue;
    }

    if (bootFailure) {
      if (good === null || !changed) {
        process.stderr.write("[dsh-guard] 启动失败，但没有可用的「上次正确配置」（或配置未变化），无法自动处理。\n");
        process.stderr.write(`[dsh-guard] 请手动修复：${pDir}\n`);
      }
      return code ?? 1;
    }

    return code ?? 0;
  }
}

// ---------------------------------------------------------------------------
// 子命令：snapshot / restore / status
// ---------------------------------------------------------------------------

function printStatus(profile) {
  const pDir = profileDir(profile);
  const sDir = snapDir(profile);
  const current = readConfig(pDir);
  const good = readSnapshot(sDir);

  process.stdout.write(`DSH 配置目录 : ${resolveDshHome()}\n`);
  process.stdout.write(`Profile     : ${profile}\n`);
  process.stdout.write(`快照目录     : ${sDir}\n\n`);

  if (good === null) {
    process.stdout.write("还没有「已知可用」快照。第一次成功启动（或运行 snapshot）后会生成。\n");
    return 0;
  }

  let diffCount = 0;
  for (const name of CONFIG_FILES) {
    const c = current[name];
    const g = good[name];
    let state;
    if (c === null && g === null) state = "（两边都没有）";
    else if (c === null) state = "当前缺失";
    else if (g === null) state = "快照缺失";
    else state = c.equals(g) ? "一致" : "不同";
    if (state === "不同" || state === "当前缺失" || state === "快照缺失") diffCount += 1;
    process.stdout.write(`  ${name.padEnd(22)} ${state}\n`);
  }

  const offenders = computeOffenders(readManifest(current), readManifest(good));
  if (offenders.length > 0) {
    process.stdout.write("\n启动失败时会被「禁用」（保留下载、不删除）的插件：\n");
    for (const name of offenders) process.stdout.write(`  - ${name}\n`);
  }

  process.stdout.write("\n");
  if (diffCount === 0) process.stdout.write("当前配置与快照一致。\n");
  else process.stdout.write(`有 ${diffCount} 个文件与快照不同。自动看门狗会优先「禁用」坏插件（不删除）；如需硬回滚请用 restore。\n`);
  return 0;
}

function printHelp() {
  process.stdout.write(`dsh-guard — dsh 启动看门狗：失败自动禁用坏插件并重试（不删除已下载的东西）

用法：
  dsh-guard [守卫参数] <profile> [传给 dsh 的参数…]
  dsh-guard snapshot <profile>      把当前配置标记为「已知可用」（不启动）
  dsh-guard restore <profile>       硬回滚到快照（会移除快照后新增的插件；请谨慎）
  dsh-guard status <profile>        显示当前配置与快照差异、将被禁用的插件
  dsh-guard --help

守卫参数（必须放在 <profile> 前面）：
  --grace <毫秒>       启动成功判定窗口，默认 ${DEFAULT_GRACE_MS}
  --retry <次数>       失败处理后自动重试次数，默认 ${DEFAULT_RETRY}
  --no-install         硬回滚后不跑 pnpm install
  --profile <名字>     显式指定 profile（等价于位置参数）

示例：
  dsh-guard web
  dsh-guard web --host 127.0.0.1
  dsh-guard snapshot web
`);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { graceMs: DEFAULT_GRACE_MS, retry: DEFAULT_RETRY, noInstall: false };
  let profile = null;
  let action = null;
  let i = 0;

  const num = (v, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grace") { opts.graceMs = num(argv[++i], DEFAULT_GRACE_MS); continue; }
    if (a === "--retry") { opts.retry = num(argv[++i], DEFAULT_RETRY); continue; }
    if (a === "--profile") { profile = argv[++i]; continue; }
    if (a === "--no-install") { opts.noInstall = true; continue; }
    if (a === "--help" || a === "-h") { printHelp(); return null; }
    break;
  }

  const first = argv[i];

  if (first === "snapshot" || first === "restore" || first === "rollback" || first === "status") {
    action = first === "rollback" ? "restore" : first;
    profile = profile ?? argv[i + 1] ?? "web";
  } else {
    profile = profile ?? first ?? "web";
    const dshArgs = first === undefined ? [] : argv.slice(i + 1);
    return { action: "guard", profile, dshArgs, opts };
  }

  return { action, profile, dshArgs: [], opts };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const parsed = parseArgs(process.argv.slice(2));
if (parsed === null) process.exit(0);

const { action, profile, dshArgs, opts } = parsed;
const sDir = snapDir(profile);

if (action === "snapshot") {
  writeSnapshot(sDir, readConfig(profileDir(profile)));
  process.stdout.write(`[dsh-guard] ✔ 已把 ${profile} 当前配置标记为「已知可用」：${sDir}\n`);
  process.exit(0);
}

if (action === "restore") {
  const good = readSnapshot(sDir);
  if (good === null) {
    process.stderr.write(`[dsh-guard] 没有可用的快照：${sDir}\n`);
    process.exit(1);
  }
  restoreSnapshot(profileDir(profile), good);
  if (!opts.noInstall) runPnpmInstall(profileDir(profile));
  process.stdout.write(`[dsh-guard] ✔ 已把 ${profile} 硬回滚到上次可用配置（快照后新增的插件会被移除）。\n`);
  process.exit(0);
}

if (action === "status") {
  process.exit(printStatus(profile));
}

guard(profile, dshArgs, opts).then((code) => {
  process.exitCode = code ?? 0;
});
