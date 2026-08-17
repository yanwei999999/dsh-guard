// 测试用假 dsh：第 1 次启动失败（模拟坏插件），之后启动成功。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const counterFile = join(tmpdir(), "fake-dsh-count.txt");
let n = existsSync(counterFile) ? Number.parseInt(readFileSync(counterFile, "utf8"), 10) : 0;
n += 1;
writeFileSync(counterFile, String(n));

const [profile] = process.argv.slice(2);

if (n === 1) {
  process.stderr.write(`dsh: plugin tree failed to load: broken-plugin did not activate\n`);
  process.exit(1);
}

process.stdout.write(`dsh ${profile}: http://127.0.0.1:3080\n`);
await sleep(300);
process.exit(0);
