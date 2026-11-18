import { readFile, readdir, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url);
const budget = JSON.parse(await readFile(new URL("performance-budget.json", root), "utf8"));
const html = await readFile(new URL("dist/index.html", root), "utf8");
const entry = [...html.matchAll(/<script\b[^>]*src=["']([^"']+\.js)["']/g)]
  .map((match) => match[1])
  .find((file) => !/^https?:\/\//i.test(file));
if (!entry) throw new Error("未找到本地前端入口脚本");
const preloads = [
  ...html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+\.js)["']/g),
].map((match) => match[1]);
const css = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/g)].map((match) => match[1]);
const normalize = (file) => decodeURIComponent(file).replace(/^\//, "");
const initialJsFiles = [...new Set([entry, ...preloads].map(normalize))];
const initialCssFiles = [...new Set(css.map(normalize))];
const allJsFiles = (await readdir(new URL("dist/assets/", root), { withFileTypes: true }))
  .filter((item) => item.isFile() && item.name.endsWith(".js"))
  .map((item) => `assets/${item.name}`);
const measure = async (files) => {
  const rows = await Promise.all(
    files.map(async (file) => {
      const data = await readFile(new URL(`dist/${file}`, root));
      return { file, bytes: data.byteLength, gzipBytes: gzipSync(data).byteLength };
    }),
  );
  return { total: rows.reduce((sum, row) => sum + row.gzipBytes, 0), rows };
};
const initialJs = await measure(initialJsFiles),
  initialCss = await measure(initialCssFiles),
  totalJs = await measure(allJsFiles);
const largestJs = Math.max(0, ...totalJs.rows.map((row) => row.gzipBytes));
const fileBytes = async (path) => (await stat(new URL(path, root))).size;
const result = {
  event: "poster.frontend_budget",
  initialJsGzipBytes: initialJs.total,
  initialCssGzipBytes: initialCss.total,
  totalJsGzipBytes: totalJs.total,
  largestJsGzipBytes: largestJs,
  presetFontBytes: await fileBytes("dist/fonts/NotoSansSC-Bold.woff2"),
  demoBackgroundBytes: await fileBytes("dist/demo/clean-background.png"),
  initialJsFiles,
  initialCssFiles,
  budget,
};
console.log(JSON.stringify(result, null, 2));
const failures = [
  ["initialJsGzipBytes", result.initialJsGzipBytes],
  ["initialCssGzipBytes", result.initialCssGzipBytes],
  ["totalJsGzipBytes", result.totalJsGzipBytes],
  ["largestJsGzipBytes", result.largestJsGzipBytes],
  ["presetFontBytes", result.presetFontBytes],
  ["demoBackgroundBytes", result.demoBackgroundBytes],
].filter(([name, actual]) => actual > budget[name]);
if (failures.length)
  throw new Error(
    `前端性能预算未通过：${failures.map(([name, actual]) => `${name}=${actual}>${budget[name]}`).join(", ")}`,
  );
