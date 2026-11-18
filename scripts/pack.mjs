import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}/output`, { recursive: true });
const target = `${root}/output/poster-sidebar.zip`;
await rm(target, { force: true });
const result = spawnSync("zip", ["-qr", target, "."], { cwd: `${root}/dist`, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`静态边栏包已生成：${target}`);
