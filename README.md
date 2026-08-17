# dsh-guard

> 仓库地址：<https://github.com/yanwei999999/dsh-guard> · MIT License

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）加一层「启动看门狗 + 自动回滚」。

> 安装第三方插件后 `dsh web` 打不开了？只要启动失败一次，dsh-guard 就自动**禁用**导致
> 问题的插件（**保留已下载的文件和依赖，不删除**），然后自动重试——一个坏插件再也
> 不会让你的 profile 永久打不开。

## 为什么是「看门狗」而不是 dsh 插件

坏插件会让 dsh 在**插件树加载 / 启动阶段**就崩溃，此时任何插件自身都还没机会运行。
所以自动回滚必须待在 dsh 进程之外——这就是 dsh-guard 作为独立命令行工具存在的原因。

## 核心原则：禁用，不删除

dsh-guard 默认**不动别人已下载的东西**：

| 情况 | 自动处理 |
| --- | --- |
| 新装的第三方插件导致启动失败 | 在 `cordis.patch.yml` 里加 `disabled: true`，插件留在 `dependencies` 和 `node_modules` 里，在 dsh 插件清单中显示为「已禁用」 |
| 升级某个第三方插件后启动失败 | 同上，禁用它（保留下载） |
| 你自己改坏了 `cordis.patch.yml` 等配置 | 回滚这几个配置文件（不影响已下载插件） |

只有你**显式**运行 `dsh-guard restore` 才会做硬回滚（把 profile 完全恢复到快照，移除快照后新增的插件）。

## 安装

方式一（npm 全局安装，推荐）：

```bash
npm install -g dsh-guard
# 或直接从 GitHub 装：
npm install -g github:yanwei999999/dsh-guard
```

方式二（Windows 脚本，装在 `~/.dsh/tools`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1            # 只装命令
powershell -ExecutionPolicy Bypass -File .\install.ps1 -InstallProfile   # 同时让 `dsh web` 自动受保护
```

方式三（手动）：`dsh-guard.mjs` 是零编译的 Node ESM 脚本，唯一依赖是 `js-yaml`；
把它和 `package.json` 放到任意目录后 `npm install`，再用 `node dsh-guard.mjs web` 即可。

## 使用

```powershell
dsh-guard web                      # 等价于 dsh web，失败自动禁用坏插件并重试
dsh-guard web --host 127.0.0.1     # web 后面的参数原样传给 dsh
dsh-guard --grace 30000 web        # 启动成功判定窗口调到 30 秒

dsh-guard snapshot web             # 把当前配置标记为「已知可用」（不启动）
dsh-guard restore web              # 硬回滚到快照（会移除快照后新增的插件）
dsh-guard status web               # 查看当前配置与快照差异、将被禁用的插件
dsh-guard --help
```

### 让 `dsh web` 直接受保护

`install.ps1 -InstallProfile`（或手动）会在 PowerShell 的 `$PROFILE` 里加一个别名：

```powershell
function global:dsh {
    if ($args.Count -ge 1 -and ($args[0] -in @('web','tui','headless'))) {
        & node (Join-Path $env:USERPROFILE '.dsh\tools\dsh-guard\dsh-guard.mjs') @args
    } else {
        & dsh.cmd @args
    }
}
```

之后 `dsh web` 自动走看门狗；`dsh plugin`、`dsh --dump-config` 等其它命令仍原样转发给真正的 dsh。

## 工作原理

1. **成功即快照**：每次 `dsh web` 真正打开（控制台打印出 `dsh web: http://127.0.0.1:…`
   那行 URL，或进程稳定存活超过启动窗口）后，把 profile 的 4 个文件拍成「已知可用」快照，
   存在 `~/.dsh/snapshots/<profile>/`：

   - `package.json`（插件依赖 + `dsh.profile.bundles`）
   - `cordis.patch.yml`
   - `pnpm-lock.yaml`
   - `pnpm-workspace.yaml`

2. **失败即禁用**：下次启动检测到致命加载错误（`fatal load failure`、
   `plugin tree failed to load`、`cannot resolve profile bundle` 等），就对比快照找出
   「新增 / 版本变化」的第三方插件，读取它的 bundle patch 得到条目 id，在
   `cordis.patch.yml` 末尾追加 `disabled: true`，然后自动重试。全程不改 `package.json`
   的依赖、不跑 `pnpm install`，因此**什么都不删除**。

3. **没变化就不动**：当前配置与快照一致时，什么都不做，只把退出码原样返回。

## 注意事项

- 判定「成功打开」的可靠信号是 `dsh web: http://127.0.0.1:…` 那行 URL（由 `dsh-web-app`
  在树 settle 且 web 服务器绑定后打印，等价于「真的能打开了」）。
- 如果坏插件不是启动崩溃，而是「起来了但页面白屏 / 报错」，看门狗抓不到（进程没死）；
  此时用 `dsh-guard restore web` 手动硬回滚即可。
- `dsh plugin` 每次运行会根据 `dependencies` 重新调和 `dsh.profile.bundles`：已用
  `disabled: true` 禁用的插件**不会被重新启用**（它仍在 bundles 里，只是被禁用）；只有
  「移除 bundles 保留依赖」的兜底方式会在下次 `dsh plugin` 时被重新加回，此时看门狗会
  再次自动禁用。

## 与 dsh 的关联

- 兼容 dsh 的 `$DSH_HOME` 约定（默认 `~/.dsh`，可用 `DSH_HOME` 覆盖）。
- 沿用 dsh 的原生禁用语义（`cordis.patch.yml` 的 `disabled: true`，与 dsh 自带的
  `vision-router` 禁用方式一致），禁用后插件在 dsh 插件清单里仍可见、标记为禁用。
- npm 关键词 `deepseek-harness` / `dsh` / `cordis`，便于在 npm 上被搜到。

## License

[MIT](./LICENSE)
