import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const violations = [];

function filesUnder(relativeDir) {
  const directory = path.join(root, relativeDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(relativeDir, entry.name);
    return entry.isDirectory()
      ? filesUnder(relative)
      : /\.tsx?$/.test(entry.name)
        ? [relative]
        : [];
  });
}

function assertNoImports(relativeDir, forbidden, rule) {
  for (const file of filesUnder(relativeDir)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const pattern of forbidden)
      if (source.includes(pattern)) violations.push(`${rule}: ${file} -> ${pattern}`);
  }
}

assertNoImports(
  "src/domain",
  ["../data", "../rendering", "../features", "../app", "@lark-base-open", "react"],
  "领域层依赖交付或平台实现",
);
assertNoImports(
  "src/application",
  ["../data", "../rendering", "../features", "../app", "@lark-base-open", "react"],
  "应用命令依赖交付或平台实现",
);
assertNoImports(
  "src/features",
  ["../../data", "../data", "@lark-base-open"],
  "功能组件绕过组合根直调数据实现",
);
assertNoImports(
  "src/data",
  ["../features", "../app", "../application", "react"],
  "数据适配器反向依赖上层",
);
assertNoImports(
  "src/rendering",
  ["../data", "../features", "../app", "@lark-base-open"],
  "渲染器依赖数据或界面实现",
);

if (violations.length) {
  console.error(`架构检查失败：\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("架构检查通过");
