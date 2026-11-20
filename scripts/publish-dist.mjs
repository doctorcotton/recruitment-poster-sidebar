import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 dist 推到发布镜像仓。
 *
 * 飞书插件市场发布时会 clone 整个仓库再静态部署 dist。主仓历史里带有大字体，
 * 完整 clone 要 30 秒以上会被发布接口掐断；镜像仓只有一个提交，clone 几秒完成。
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const remote = "https://github.com/doctorcotton/recruitment-poster-sidebar-dist.git";
const work = await mkdtemp(join(tmpdir(), "poster-dist-"));
const repo = join(work, "repo");
const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "inherit" });

try {
  execFileSync("git", ["clone", "--quiet", remote, repo], { stdio: "inherit" });
  await rm(join(repo, "dist"), { recursive: true, force: true });
  await cp(join(root, "dist"), join(repo, "dist"), { recursive: true });
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "recruitment-poster-sidebar-dist", version, private: true, output: "dist" }, null, 2)}\n`,
  );
  git(["add", "-A"]);
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()) {
    git([
      "-c",
      "user.name=史海鹏",
      "-c",
      "user.email=doctorcotton@users.noreply.github.com",
      "commit",
      "-m",
      `build(产物): 发布 v${version}`,
    ]);
    git(["push", "origin", "HEAD:main"]);
    console.log(`发布镜像已更新：v${version}`);
  } else {
    console.log("产物无变化，镜像仓未改动");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
