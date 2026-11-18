import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const playwright = require("playwright");
const { PNG } = require("pngjs");
const pixelmatchModule = require("pixelmatch");
const pixelmatch = pixelmatchModule.default ?? pixelmatchModule;
const AxeBuilder = require("@axe-core/playwright").default;
const browserName = process.env.BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName))
  throw new Error(`不支持的浏览器：${browserName}`);
const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.SMOKE_PORT || "5178";
const baseUrl = `http://127.0.0.1:${port}/`;
const output = process.env.SMOKE_OUTPUT_DIR || `${root}artifacts`;
const reportPath = `${output}/${browserName === "chromium" ? "browser-smoke.json" : `browser-smoke-${browserName}.json`}`;
await mkdir(output, { recursive: true });
let server;
async function ensureServer() {
  const running = await fetch(baseUrl).catch(() => null);
  if (running?.ok) return;
  server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", port, "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const ready = await fetch(baseUrl).catch(() => null);
    if (ready?.ok) return;
  }
  throw new Error("Vite 开发服务启动超时");
}
const browser = await playwright[browserName].launch(
  browserName === "chromium" ? { channel: "chrome", headless: true } : { headless: true },
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  acceptDownloads: true,
});
await context.tracing.start({ screenshots: true, snapshots: true });
let traceStopped = false;
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [],
  requests = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
page.on("request", (request) => requests.push(request.url()));
if (process.env.DEBUG_OBSERVER === "1") {
  page.on("console", (message) => {
    if (message.text().startsWith("RO_NEW")) console.log(message.text());
  });
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback) {
        const observer = new NativeObserver(callback);
        console.log("RO_NEW", new Error().stack);
        return observer;
      }
    };
  });
}
const waitForDraw = () => page.locator(".canvas-loading").waitFor({ state: "hidden" });
async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`通过：${name}`);
}
async function expectNoHorizontalOverflow(selector) {
  const layout = await page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.clientWidth > 0)
      .map((element) => ({
        panel: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
  );
  assert.ok(layout.length > 0, selector);
  assert.deepEqual(
    layout.filter((item) => item.scrollWidth > item.clientWidth + 1),
    [],
  );
}
async function enterWorkspace() {
  const chooser = page.getByRole("heading", { name: "连接数据表", exact: true });
  const records = page.locator(".records-workspace");
  await chooser.or(records).first().waitFor();
  if (await chooser.isVisible())
    await page.getByRole("button", { name: "查看记录", exact: true }).click();
  await records.waitFor();
  await waitForDraw();
}
async function openAdvancedEditor() {
  if (await page.locator(".workspace").isVisible()) return;
  await page.getByRole("button", { name: "高级编辑", exact: true }).click();
  await page.locator(".workspace").waitFor();
  await waitForDraw();
}
async function openMapping() {
  if (await page.locator(".mapping-workspace").isVisible()) return;
  if (await page.locator(".records-workspace").isVisible()) await openAdvancedEditor();
  await page.getByRole("button", { name: "字段映射", exact: true }).click();
  await page.locator(".mapping-workspace").waitFor();
}
async function returnRecords() {
  await page.getByRole("button", { name: "返回记录", exact: true }).click();
  await page.locator(".records-workspace").waitFor();
  await waitForDraw();
}
async function returnAdvanced() {
  await page.getByRole("button", { name: "返回高级编辑", exact: true }).click();
  await page.locator(".workspace").waitFor();
  await waitForDraw();
}
async function settingsCount() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("recruitment-poster-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("context", "readonly"),
            keys = tx.objectStore("context").getAllKeys();
          keys.onsuccess = () =>
            resolve(keys.result.filter((key) => String(key).startsWith("settings:")).length);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function closeNotice() {
  if (await page.getByRole("button", { name: "关闭提示", exact: true }).count())
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await waitForDraw();
}
async function dragJob(dx, dy) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await waitForDraw();
  await page.evaluate(() => {
    window.__pointerTrace = [];
    window.__pointerRecorder?.();
    const record = (event) => {
      const matrix = document.querySelector("svg.selection-overlay").getScreenCTM();
      window.__pointerTrace.push({
        type: event.type,
        x: event.clientX,
        y: event.clientY,
        scale: matrix.a,
        e: matrix.e,
        f: matrix.f,
      });
    };
    document.addEventListener("pointermove", record, true);
    document.addEventListener("pointerdown", record, true);
    document.addEventListener("pointerup", record, true);
    window.__pointerRecorder = () => {
      document.removeEventListener("pointermove", record, true);
      document.removeEventListener("pointerdown", record, true);
      document.removeEventListener("pointerup", record, true);
    };
  });
  const box = page.locator('[data-box-id="job"] .box-outline');
  const rect = await box.boundingBox();
  const scale = await box.evaluate((element) => element.ownerSVGElement.getScreenCTM().a);
  const before = {
    x: Number(await page.getByLabel("文字框X", { exact: true }).inputValue()),
    y: Number(await page.getByLabel("文字框Y", { exact: true }).inputValue()),
  };
  await page.mouse.move(rect.x + rect.width / 3, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 3 + dx, rect.y + rect.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
  const after = {
    x: Number(await page.getByLabel("文字框X", { exact: true }).inputValue()),
    y: Number(await page.getByLabel("文字框Y", { exact: true }).inputValue()),
  };
  const trace = await page.evaluate(() => window.__pointerTrace);
  const start = trace.find((event) => event.type === "pointerdown");
  const actualDx = trace.at(-1).x - start.x,
    actualDy = trace.at(-1).y - start.y;
  // 文字框不能越过原稿边缘；右移时可能先到边界，而不是移动完整鼠标距离。
  const width = Number(await page.getByLabel("文字框宽度", { exact: true }).inputValue());
  const height = Number(await page.getByLabel("文字框高度", { exact: true }).inputValue());
  const expectedX = Math.max(0, Math.min(882 - width, before.x + actualDx / start.scale));
  const expectedY = Math.max(0, Math.min(1783 - height, before.y + actualDy / start.scale));
  assert.ok(
    Math.abs(after.x - expectedX) < 1,
    JSON.stringify({ before, after, expectedX, scale, trace }),
  );
  assert.ok(
    Math.abs(after.y - expectedY) < 1,
    JSON.stringify({ before, after, expectedY, scale, trace }),
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(Number(await page.getByLabel("文字框X", { exact: true }).inputValue()), before.x);
  await page.evaluate(() => window.__pointerRecorder?.());
}

try {
  await ensureServer();
  await page.goto(baseUrl);
  await check("旧绑定损坏时仍显示真实表选项，并可重新确认修复", async () => {
    await page.getByRole("heading", { name: "连接数据表", exact: true }).waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("recruitment-poster-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("context", "readwrite");
            tx.objectStore("context").put({ schemaVersion: 0 }, "workspace-binding");
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.reload();
    await page.getByRole("heading", { name: "连接数据表", exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "自动恢复连接失败" }).waitFor();
    assert.ok(
      (await page.getByLabel("业务数据表", { exact: true }).innerText()).includes("本地示例"),
    );
    assert.ok(
      (await page.getByLabel("配置数据表", { exact: true }).innerText()).includes("本地示例配置"),
    );
  });
  await check("字体延迟或暂时失败时首屏记录仍可阅读，可在原页重试预览", async () => {
    const pattern = "**/fonts/NotoSansSC-Bold.woff2";
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      pattern,
      async (route) => {
        await held;
        await route.fulfill({ status: 503, body: "unavailable" });
      },
      { times: 1 },
    );
    try {
      await page.getByRole("button", { name: "查看记录", exact: true }).click();
      await page.locator(".record-field-row").first().waitFor();
      assert.ok(await page.getByRole("button", { name: "生成并写回", exact: true }).isDisabled());
      assert.ok((await page.locator(".record-field-list").innerText()).includes("门店伙伴"));
    } finally {
      release();
    }
    await page.getByRole("button", { name: "重新加载海报模板", exact: true }).click();
    await page.locator("canvas.readonly-poster-canvas").waitFor();
    await waitForDraw();
  });
  await check("分别选择业务表和已有配置表，确认后显示配置状态", async () => {
    assert.ok((await page.locator(".record-table-card").innerText()).includes("本地示例"));
    await page.getByRole("button", { name: "切换数据表", exact: true }).click();
    await page.getByRole("button", { name: "不保存并继续", exact: true }).click();
    await page.getByRole("heading", { name: "连接数据表", exact: true }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.locator(".records-workspace").waitFor();
  });
  await check("内置字体首次加载和失败重试均只请求 WOFF2", async () => {
    const fontRequests = requests.filter((url) =>
      /\.(?:woff2?|otf|ttf)$/i.test(new URL(url).pathname),
    );
    assert.equal(fontRequests.length, 2);
    assert.deepEqual(
      [...new Set(fontRequests)],
      [new URL("fonts/NotoSansSC-Bold.woff2", baseUrl).href],
    );
  });
  await check("默认首屏是主记录字段和只读海报，不暴露高级编辑", async () => {
    await page.getByRole("heading", { name: "本地示例 · 门店伙伴", exact: true }).first().waitFor();
    assert.deepEqual(
      await page
        .locator(".record-field-row")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-field-id"))),
      [
        "job",
        "location",
        "responsibilities",
        "benefits",
        "contact",
        "phone",
        "poster",
        "demo-background",
      ],
    );
    assert.equal(await page.getByRole("button", { name: "保存模板", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("绑定字段", { exact: true }).count(), 0);
    assert.equal(await page.locator(".layer-list").count(), 0);
    assert.deepEqual(
      await page
        .locator(".readonly-poster-canvas")
        .evaluate((canvas) => [canvas.width, canvas.height]),
      [882, 1783],
    );
    await page.screenshot({ path: `${output}/records-workspace.png` });
  });
  await check("记录首页桌面通过 axe WCAG AA 检查", async () => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        targets: item.nodes.map((node) => node.target),
      })),
      [],
    );
  });
  await check("记录首页窄屏保持字段优先并通过 axe", async () => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.locator(".record-fields-panel").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        targets: item.nodes.map((node) => node.target),
      })),
      [],
    );
    await page.screenshot({ path: `${output}/records-narrow.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check("记录工作台在中间宽度保持三栏，短窄屏首屏仍可看到主记录", async () => {
    for (const width of [1024, 768]) {
      await page.setViewportSize({ width, height: 720 });
      await expectNoHorizontalOverflow(
        ".app-header, .records-workspace, .records-browser, .record-fields-panel, .records-preview-column",
      );
      const browser = await page.locator(".records-browser").boundingBox();
      const fields = await page.locator(".record-fields-panel").boundingBox();
      const preview = await page.locator(".records-preview-column").boundingBox();
      assert.ok(browser.x < fields.x && fields.x < preview.x);
      assert.equal(fields.y, preview.y);
    }
    await page.screenshot({ path: `${output}/records-medium.png` });
    await page.setViewportSize({ width: 320, height: 568 });
    const title = await page.locator("#record-fields-title").boundingBox();
    assert.ok(title.y + title.height <= 568, JSON.stringify(title));
    await expectNoHorizontalOverflow(".app-header, .records-workspace, .record-fields-panel");
    await page.screenshot({ path: `${output}/records-short.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check("高级编辑载入默认底图与六个文字框", async () => {
    await openAdvancedEditor();
    assert.equal(await page.locator("[data-box-id]").count(), 6);
    assert.deepEqual(
      await page.locator("canvas").evaluate((canvas) => [canvas.width, canvas.height]),
      [882, 1783],
    );
    assert.equal(errors.length, 0, errors.join("\n"));
  });
  await check("桌面工作台通过 axe WCAG AA 检查", async () => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        targets: item.nodes.map((node) => node.target),
      })),
      [],
    );
  });
  await check("中间宽度保留完整编辑工具，窄屏隐藏画布时仍能适应缩放", async () => {
    await page.setViewportSize({ width: 768, height: 720 });
    await expectNoHorizontalOverflow(
      ".app-header, .left-panel, .canvas-column, .document-bar, .stage-toolbar, .right-panel",
    );
    assert.ok(await page.locator(".left-panel").isVisible());
    assert.ok(await page.locator(".right-panel").isVisible());
    await page.screenshot({ path: `${output}/editor-medium.png` });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.getByRole("button", { name: "适应画布", exact: true }).click();
    await page.getByRole("tab", { name: "模板", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "适应画布", exact: true }).count(), 0);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole("tab", { name: "画布", exact: true }).click();
    await page.waitForFunction(() => {
      const scroller = document.querySelector(".stage-scroller").getBoundingClientRect();
      const artboard = document.querySelector(".artboard").getBoundingClientRect();
      return artboard.right <= scroller.right + 1 && artboard.bottom <= scroller.bottom + 1;
    });
    await expectNoHorizontalOverflow(".app-header, .mobile-tabs, .document-bar, .stage-toolbar");
    await page.screenshot({ path: `${output}/editor-short.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check("右键属性浮窗可绑定字段并支持键盘与外部关闭", async () => {
    await page.locator('[data-box-id="job"] .box-outline').click({ button: "right" });
    const popup = page.getByRole("dialog", { name: "文字框属性", exact: true });
    await popup.waitFor();
    assert.equal(await popup.getByLabel("图层名称", { exact: true }).inputValue(), "岗位");
    await popup.getByRole("button", { name: "修改字段映射", exact: true }).click();
    await page.locator(".mapping-workspace").waitFor();
    await page.getByLabel("绑定字段", { exact: true }).click();
    await page
      .getByRole("option")
      .filter({ hasText: /^地点$/ })
      .click();
    await page.locator(".mapping-current-value").filter({ hasText: "杭州 · 示例门店" }).waitFor();
    await page.getByLabel("绑定字段", { exact: true }).click();
    await page
      .getByRole("option")
      .filter({ hasText: /^岗位$/ })
      .click();
    await page.locator(".mapping-current-value").filter({ hasText: "门店伙伴" }).waitFor();
    await returnAdvanced();
    await page.locator('[data-box-id="job"] .box-outline').click({ button: "right" });
    await popup.waitFor();
    await popup.getByLabel("字体颜色 HEX", { exact: true }).fill("#e04030");
    assert.equal(await popup.getByLabel("文字颜色", { exact: true }).inputValue(), "#e04030");
    await popup.getByRole("button", { name: "黑色", exact: true }).click();
    assert.equal(await popup.getByLabel("文字颜色", { exact: true }).inputValue(), "#000000");
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    await page.locator('[data-box-id="job"]').focus();
    await page.keyboard.press("Shift+F10");
    await popup.waitFor();
    await page.locator(".app-identity").click();
    await popup.waitFor({ state: "hidden" });
  });
  await check("拖动坐标、撤销以及缩放后拖动", async () => {
    await dragJob(25, 12);
    await page.getByRole("button", { name: "放大画布", exact: true }).click();
    await dragJob(21, 9);
    await page.getByRole("button", { name: "适应画布", exact: true }).click();
  });
  await check("方向键、Shift 大步、Alt 微调与精确坐标均可撤销", async () => {
    const field = page.getByLabel("文字框X", { exact: true });
    await page.locator('[data-box-id="job"]').focus();
    const before = Number(await field.inputValue());
    await page.keyboard.press("ArrowRight");
    assert.equal(Number(await field.inputValue()), before + 1);
    await page.keyboard.press("Shift+ArrowLeft");
    assert.equal(Number(await field.inputValue()), before - 9);
    await page.keyboard.press("Alt+ArrowRight");
    assert.ok(Math.abs(Number(await field.inputValue()) - (before - 8.9)) < 0.001);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(Number(await field.inputValue()), before - 9);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(Number(await field.inputValue()), before);
    await field.fill("300.5");
    await field.press("Enter");
    await field.press("Tab");
    assert.equal(Number(await field.inputValue()), 300.5);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
  });
  await check("调整文字框大小", async () => {
    const oldWidth = Number(await page.getByLabel("文字框宽度", { exact: true }).inputValue());
    const handle = await page
      .getByRole("button", { name: "调整岗位大小", exact: true })
      .boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 20, handle.y + handle.height / 2 + 10);
    await page.mouse.up();
    assert.ok(Number(await page.getByLabel("文字框宽度", { exact: true }).inputValue()) > oldWidth);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
  });
  await check("上传字体并在浏览器加载", async () => {
    await page.getByLabel("上传字体文件").setInputFiles(`${root}assets/fonts/NotoSansSC-Bold.otf`);
    await page.locator(".notice").filter({ hasText: "字体已加载" }).waitFor();
    await closeNotice();
    assert.ok(await page.evaluate(() => document.fonts.size >= 1));
  });
  await check("无效字体明确失败", async () => {
    await page.getByLabel("上传字体文件").setInputFiles({
      name: "invalid.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("invalid-font"),
    });
    await page.getByRole("alert").filter({ hasText: "字体文件无法读取" }).waitFor();
    await closeNotice();
  });
  await check("字段绑定可切换为固定文字", async () => {
    await openMapping();
    await page.getByLabel("绑定字段", { exact: true }).click();
    await page.getByRole("option").filter({ hasText: "固定文字" }).click();
    await page.locator(".mapping-fixed-note").waitFor();
    await returnAdvanced();
    await page.getByLabel("固定文字内容", { exact: true }).fill("前端画布验证");
    await page.getByLabel("模板名称", { exact: true }).fill("本地验收模板");
    await waitForDraw();
  });
  await check("模板保存后刷新自动恢复，同表配置记录数不增长", async () => {
    await page.getByRole("button", { name: "保存模板", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "模板已保存" }).waitFor();
    const count = await settingsCount();
    await page.reload();
    await enterWorkspace();
    await openAdvancedEditor();
    assert.equal(await page.getByRole("heading", { name: "连接数据表", exact: true }).count(), 0);
    assert.equal(await settingsCount(), count);
    assert.equal(await page.getByLabel("模板名称", { exact: true }).inputValue(), "本地验收模板");
    assert.equal(
      await page.getByLabel("固定文字内容", { exact: true }).inputValue(),
      "前端画布验证",
    );
  });
  await check("模板 ZIP 导出导入生成新模板，删除后回退已存模板", async () => {
    const promise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出模板", exact: true }).click();
    const download = await promise;
    await page.locator(".notice").filter({ hasText: "模板包已导出" }).waitFor();
    await closeNotice();
    await page.getByLabel("导入模板包", { exact: true }).setInputFiles(await download.path());
    await page.locator(".notice").filter({ hasText: "模板包已导入" }).waitFor();
    await closeNotice();
    assert.match(await page.getByLabel("模板名称", { exact: true }).inputValue(), /导入$/);
    await page.getByRole("button", { name: "保存模板", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "模板已保存" }).waitFor();
    await closeNotice();
    await page.getByRole("button", { name: "删除模板", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "模板已删除" }).waitFor();
    await closeNotice();
    assert.equal(await page.getByLabel("模板名称", { exact: true }).inputValue(), "本地验收模板");
  });
  await check("PNG 预览与实际下载", async () => {
    await returnRecords();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByAltText("生成的招聘海报", { exact: true }).waitFor();
    assert.deepEqual(
      await page
        .getByAltText("生成的招聘海报", { exact: true })
        .evaluate((image) => [image.naturalWidth, image.naturalHeight]),
      [882, 1783],
    );
    const promise = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button", { name: "下载 PNG", exact: true }).click();
    const download = await promise;
    await download.saveAs(`${output}/sidebar-poster.png`);
    const bytes = await readFile(`${output}/sidebar-poster.png`);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), 882);
    assert.equal(bytes.readUInt32BE(20), 1783);
    assert.ok(bytes.length < 10_000_000);
    if (browserName === "chromium") {
      const baselinePath = `${root}tests/fixtures/poster-baseline.png`;
      if (process.env.UPDATE_BASELINE === "1") {
        await mkdir(`${root}tests/fixtures`, { recursive: true });
        await writeFile(baselinePath, bytes);
      } else {
        const baseline = await readFile(baselinePath);
        const actualImage = PNG.sync.read(bytes),
          expectedImage = PNG.sync.read(baseline);
        const diff = new PNG({ width: actualImage.width, height: actualImage.height });
        const changed = pixelmatch(
          actualImage.data,
          expectedImage.data,
          diff.data,
          actualImage.width,
          actualImage.height,
          { threshold: 0.1 },
        );
        const ratio = changed / (actualImage.width * actualImage.height);
        if (ratio > 0.005) {
          await writeFile(`${output}/poster-diff.png`, PNG.sync.write(diff));
          assert.fail(`PNG 像素差异比例 ${(ratio * 100).toFixed(3)}% 超过 0.5%`);
        }
      }
    }
    await page.keyboard.press("Escape");
  });
  await check("单条与批量生成直接写入示例附件", async () => {
    await page.getByRole("button", { name: "生成并写回", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "成功 1" }).waitFor();
    await closeNotice();
    assert.equal(await page.locator(".output-list button").count(), 1);
    await page.getByRole("button", { name: "批量生成", exact: true }).click();
    await page.getByRole("button", { name: "一键生成写回", exact: true }).click();
    assert.ok(
      (await page.getByRole("dialog", { name: "一键生成写回", exact: true }).innerText()).includes(
        "已有附件跳过 1 条",
      ),
    );
    await page.getByRole("button", { name: "确认生成 2 条", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "成功 2" }).waitFor();
    await closeNotice();
    assert.equal(await page.locator(".output-list button").count(), 3);
    await page.getByRole("button", { name: "一键生成写回", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "无需生成" }).waitFor();
    await closeNotice();
    await page.getByRole("button", { name: "读取全表并生成", exact: true }).click();
    await page.getByRole("button", { name: "确认生成 3 条", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "成功 3" }).waitFor();
    await closeNotice();
    assert.equal(await page.locator(".output-list button").count(), 3);
  });
  await check("搜索已加载记录并仅生成勾选的两条", async () => {
    await page.getByLabel("搜索已加载记录", { exact: true }).fill("仓储");
    assert.equal(await page.locator(".record-row").count(), 1);
    await page.getByLabel("搜索已加载记录", { exact: true }).fill("");
    await page.getByLabel("选择批量记录 本地示例 · 门店伙伴", { exact: true }).check();
    await page.getByLabel("选择批量记录 本地示例 · 设计助理", { exact: true }).check();
    await page.getByRole("button", { name: "生成已选记录 · 2", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "成功 2" }).waitFor();
    await closeNotice();
    assert.equal(await page.locator(".batch-result-row.status-succeeded").count(), 2);
    assert.equal(await page.locator(".output-list button").count(), 3);
  });
  await check("高级编辑往返保留记录搜索和批量勾选", async () => {
    await page.getByLabel("搜索已加载记录", { exact: true }).fill("门店");
    await openAdvancedEditor();
    await returnRecords();
    assert.equal(await page.getByLabel("搜索已加载记录", { exact: true }).inputValue(), "门店");
    assert.equal(
      await page.getByLabel("选择批量记录 本地示例 · 门店伙伴", { exact: true }).isChecked(),
      true,
    );
    await page.getByLabel("搜索已加载记录", { exact: true }).fill("");
  });
  await check("长文本自动换行、PNG 导出与溢出阻断", async () => {
    await openAdvancedEditor();
    await page.locator(".layer-row").filter({ hasText: "职责" }).click();
    await openMapping();
    await page.getByLabel("绑定字段", { exact: true }).click();
    await page.getByRole("option").filter({ hasText: "固定文字" }).click();
    await page.locator(".mapping-fixed-note").waitFor();
    await returnAdvanced();
    const longText =
      "负责门店日常运营与客户服务，协调团队完成商品陈列、库存盘点和活动执行，主动跟进客户反馈并持续改进服务。".repeat(
        3,
      );
    await page.getByLabel("固定文字内容", { exact: true }).fill(longText);
    await waitForDraw();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 PNG", exact: true }).click();
    await (await downloaded).saveAs(`${output}/sidebar-long-text.png`);
    const bytes = await readFile(`${output}/sidebar-long-text.png`);
    assert.equal(bytes.readUInt32BE(16), 882);
    assert.equal(bytes.readUInt32BE(20), 1783);
    assert.ok(bytes.length < 10_000_000);
    await page.getByLabel("固定文字内容", { exact: true }).fill(longText.repeat(20));
    await waitForDraw();
    await page.getByRole("button", { name: "下载 PNG", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "最小字号下仍溢出" }).waitFor();
    await page.getByLabel("固定文字内容", { exact: true }).fill(longText);
    await closeNotice();
  });
  await page.screenshot({ path: `${output}/sidebar-wide.png` });
  await check("窄边栏布局及属性面板", async () => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.getByRole("tab", { name: "画布", exact: true }).click();
    await page.getByRole("button", { name: "适应画布", exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/sidebar-narrow.png` });
    await page.locator('[data-box-id="responsibilities"] .box-outline').click({ button: "right" });
    const popup = page.getByRole("dialog", { name: "文字框属性", exact: true });
    await popup.waitFor();
    const bounds = await popup.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 420 &&
        bounds.y + bounds.height <= 900,
    );
    await popup.getByLabel("固定文字内容", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: `${output}/sidebar-context-properties.png` });
    await popup.getByRole("button", { name: "关闭属性浮窗", exact: true }).click();
    await popup.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "文字属性", exact: true }).click();
    await page.getByLabel("文字字号", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("tab", { name: "模板", exact: true }).click();
    await page.getByRole("button", { name: "保存模板", exact: true }).waitFor();
  });
  await check("窄屏工作台通过 axe 且页签支持方向键", async () => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        targets: item.nodes.map((node) => node.target),
      })),
      [],
    );
    await page.getByRole("tab", { name: "模板", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { name: "画布", exact: true }).getAttribute("aria-selected"),
      "true",
    );
  });
  await check("绑定逐行底图，模板和字体设置随来源记录保存并恢复", async () => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openMapping();
    await page.getByLabel("底图字段", { exact: true }).click();
    await page
      .getByRole("option")
      .filter({ hasText: /^示例底图$/ })
      .click();
    await page.getByRole("button", { name: "不保存并继续", exact: true }).click();
    await page.locator(".mapping-data-card").filter({ hasText: "模板来源：" }).waitFor();
    await returnAdvanced();
    await page.locator(".layer-row").filter({ hasText: "岗位" }).first().click();
    await page.getByLabel("模板名称", { exact: true }).fill("来源模板 A");
    await page.getByLabel("字体颜色 HEX", { exact: true }).fill("#d03040");
    await page.getByRole("button", { name: "保存模板", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "已保存到底图来源记录" }).waitFor();
    await closeNotice();
    await returnRecords();
    await page.locator(".record-row").filter({ hasText: "设计助理" }).click();
    await waitForDraw();
    await openAdvancedEditor();
    await page.getByLabel("模板名称", { exact: true }).fill("来源模板 B");
    await page.getByRole("button", { name: "保存模板", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "已保存到底图来源记录" }).waitFor();
    await closeNotice();
    await returnRecords();
    await page.locator(".record-row").filter({ hasText: "门店伙伴" }).click();
    await waitForDraw();
    await openAdvancedEditor();
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="模板名称"]').value === "来源模板 A",
    );
    await page.reload();
    await enterWorkspace();
    await openAdvancedEditor();
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="模板名称"]').value === "来源模板 A",
    );
    assert.equal(await page.getByLabel("字体颜色 HEX", { exact: true }).inputValue(), "#d03040");
  });
  await check("图层锁定禁止键盘移动，多选后可对齐", async () => {
    await page.locator(".layer-row").filter({ hasText: "岗位" }).first().click();
    const before = await page.locator('[data-box-id="job"] .box-outline').getAttribute("x");
    await page.getByRole("button", { name: "锁定图层 岗位", exact: true }).click();
    await page.locator(".locked-note").waitFor();
    await page.locator('[data-box-id="job"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator('[data-box-id="job"] .box-outline').getAttribute("x"), before);
    await page.getByRole("button", { name: "解锁图层 岗位", exact: true }).click();
    await page.getByLabel("选择图层 岗位", { exact: true }).check();
    await page.getByLabel("选择图层 地点", { exact: true }).check();
    await page.getByLabel("对齐所选图层", { exact: true }).click();
    await page
      .getByRole("option")
      .filter({ hasText: /^左对齐$/ })
      .click();
    const jobX = await page.locator('[data-box-id="job"] .box-outline').getAttribute("x");
    const locationX = await page.locator('[data-box-id="location"] .box-outline').getAttribute("x");
    assert.equal(jobX, locationX);
  });
  await check("记录页不会撤销隐藏模板", async () => {
    await returnRecords();
    const before = await page
      .locator(".readonly-poster-canvas")
      .evaluate((canvas) => canvas.toDataURL());
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(100);
    const after = await page
      .locator(".readonly-poster-canvas")
      .evaluate((canvas) => canvas.toDataURL());
    assert.equal(after, before);
  });
  await check("窄屏批量收据按页挂载，末页和长字段均可查看", async () => {
    // 已绑定逐行底图。附加记录没有保存来源模板，会在预检中快速产生失败收据。
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("recruitment-poster-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("context", "readwrite");
            const store = tx.objectStore("context");
            const query = store.get("workspace");
            query.onsuccess = () => {
              const workspace = query.result;
              workspace.fields[0].name = "LongFieldName".repeat(15);
              for (let index = 1; index <= 40; index++) {
                workspace.records.push({
                  id: `pagination-${index}`,
                  label: `分页测试记录 ${index}`,
                  values: {},
                });
              }
              store.put(workspace, "workspace");
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await page.reload();
    await enterWorkspace();
    await page.getByText("LongFieldName".repeat(15), { exact: true }).waitFor();
    await expectNoHorizontalOverflow(
      ".records-workspace, .record-fields-panel, .record-field-list",
    );
    await page.getByRole("button", { name: "批量生成", exact: true }).click();
    await page.getByRole("button", { name: "读取全表并生成", exact: true }).click();
    await page.getByRole("button", { name: "确认生成 43 条", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "失败 41" }).waitFor();
    await closeNotice();
    const results = page.getByRole("region", { name: "批量生成结果", exact: true });
    const rows = results.getByRole("listitem");
    const previous = results.getByRole("button", { name: "上一页", exact: true });
    const next = results.getByRole("button", { name: "下一页", exact: true });
    await results.getByText("1–20 / 43", { exact: true }).waitFor();
    assert.equal(await rows.count(), 20);
    assert.ok(await previous.isDisabled());
    await next.click();
    await results.getByText("21–40 / 43", { exact: true }).waitFor();
    assert.equal(await rows.count(), 20);
    await next.click();
    await results.getByText("41–43 / 43", { exact: true }).waitFor();
    assert.equal(await rows.count(), 3);
    assert.ok(await next.isDisabled());
    await rows.last().getByText("分页测试记录 40", { exact: true }).waitFor();
    await expectNoHorizontalOverflow(".record-batch-panel, .batch-pagination, .batch-result-list");
    await page.screenshot({ path: `${output}/records-batch-last-page.png` });
    await previous.click();
    await results.getByText("21–40 / 43", { exact: true }).waitFor();
    await results.getByRole("button", { name: "仅重试可安全重试的记录", exact: true }).click();
    await page.locator(".notice").filter({ hasText: "成功 0，失败 41" }).waitFor();
    assert.equal(
      await page
        .getByRole("progressbar", { name: "批量生成进度", exact: true })
        .getAttribute("max"),
      "41",
    );
  });
  await check("运行链路不调用自建 API 或第三方服务", async () => {
    assert.equal(
      requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith("blob:")).length,
      0,
    );
    assert.equal(errors.length, 0, errors.join("\n"));
  });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        browser: browserName,
        passed: true,
        checks,
        backendRequests: 0,
        pageErrors: errors,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`浏览器验收通过，共 ${checks.length} 项。`);
} catch (error) {
  await context.tracing.stop({ path: `${output}/browser-trace-${browserName}.zip` });
  traceStopped = true;
  await page.screenshot({ path: `${output}/browser-failure.png` }).catch(() => undefined);
  console.error({
    error: error.message,
    body: (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(-2400),
    pageErrors: errors,
  });
  throw error;
} finally {
  if (!traceStopped) await context.tracing.stop();
  await context.close();
  await browser.close();
  server?.kill();
}
