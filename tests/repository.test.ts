import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import {
  createPosterAsset,
  createRepository,
  LocalPosterRepository,
  PosterError,
} from "../src/data";
import type { TemplateBundle, WorkspaceBinding } from "../src/domain/types";

function assertSettings(
  actual: Awaited<ReturnType<LocalPosterRepository["loadSettings"]>>,
  expected: unknown,
): void {
  assert.ok(actual);
  const { updatedAt, ...value } = actual;
  assert.ok(Number.isFinite(updatedAt));
  assert.deepEqual(value, expected);
}

function bundle(): TemplateBundle {
  return {
    template: {
      schemaVersion: 1,
      id: "stable-id",
      name: "测试模板",
      width: 400,
      height: 600,
      backgroundId: "background",
      fontIds: ["font"],
      boxes: [
        {
          id: "job",
          label: "岗位",
          fieldId: "job",
          text: "备用内容",
          x: 10,
          y: 20,
          width: 300,
          height: 80,
          fontId: "font",
          fontSize: 30,
          minFontSize: 16,
          color: "#000000",
          align: "left",
          lineHeight: 1.2,
          maxLines: 2,
        },
      ],
    },
    assets: [
      {
        id: "background",
        name: "底图.png",
        mimeType: "image/png",
        blob: new Blob(["image-bytes"], { type: "image/png" }),
      },
      {
        id: "font",
        name: "字体.otf",
        mimeType: "font/otf",
        blob: new Blob(["font-bytes"], { type: "font/otf" }),
      },
    ],
  };
}

test("IndexedDB 重新打开后恢复虚构上下文、模板、素材 Blob 与 PNG", async () => {
  const indexedDB = new IDBFactory();
  const options = { indexedDB, databaseName: "reload-test" };
  const first = new LocalPosterRepository(options);
  const context = await first.loadContext();
  assert.match(context.tableName, /本地示例/);
  assert.equal(context.records.length, 3);
  assert.deepEqual(
    context.fields.map((field) => field.id),
    [
      "job",
      "location",
      "responsibilities",
      "benefits",
      "contact",
      "phone",
      "poster",
      "demo-background",
      "demo-template-ref",
    ],
  );
  const expected = bundle();
  await first.saveTemplate(expected);
  await first.writePng(
    "demo-1",
    "poster",
    new File(["png-v1"], "招聘海报.png", { type: "image/png" }),
  );
  first.dispose();

  const reopened = new LocalPosterRepository(options);
  assert.deepEqual(await reopened.loadContext(), context);
  const loaded = await reopened.loadTemplate("stable-id");
  assert.deepEqual(loaded.template, expected.template);
  assert.equal(await loaded.assets[0].blob.text(), "image-bytes");
  assert.equal(await loaded.assets[1].blob.text(), "font-bytes");
  assert.equal((await reopened.listTemplates())[0].id, "stable-id");
  const outputs = await reopened.listOutputs();
  assert.equal(outputs[0].name, "招聘海报.png");
  assert.equal(await outputs[0].blob.text(), "png-v1");
  assert.equal(outputs[0].blob.type, "image/png");

  // 同一记录、同一附件字段的再次写回替换原单元格。
  await reopened.writePng(
    "demo-1",
    "poster",
    new File(["png-v2"], "新版.png", { type: "image/png" }),
  );
  assert.equal((await reopened.listOutputs()).length, 1);
  assert.equal(await (await reopened.listOutputs())[0].blob.text(), "png-v2");
  expected.template.name = "改名不改变 ID";
  await reopened.saveTemplate(expected);
  assert.equal((await reopened.listTemplates()).length, 1);
  assert.equal((await reopened.loadTemplate("stable-id")).template.name, "改名不改变 ID");
  reopened.dispose();
});

test("本地记录分页与只读元数据互不影响", async () => {
  const repo = new LocalPosterRepository({
    indexedDB: new IDBFactory(),
    databaseName: "record-pages",
  });
  assert.equal((await repo.loadContext("local-demo", false)).records.length, 0);
  const first = await repo.listRecords("local-demo", 0, 2);
  assert.deepEqual(
    first.records.map((row) => row.id),
    ["demo-1", "demo-2"],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.pageToken, 2);
  const second = await repo.listRecords("local-demo", first.pageToken, 2);
  assert.deepEqual(
    second.records.map((row) => row.id),
    ["demo-3"],
  );
  assert.equal(second.hasMore, false);
  assert.equal((await repo.loadContext("local-demo")).records.length, 3);
  repo.dispose();
});

test("本地错误明确返回领域错误，拒绝非附件字段和不完整模板", async () => {
  const repository = new LocalPosterRepository({ indexedDB: new IDBFactory() });
  const file = new File(["PNG"], "image.png", { type: "image/png" });
  await assert.rejects(repository.writePng("demo-1", "job", file), { code: "INVALID_ASSET" });
  await assert.rejects(repository.writePng("missing", "poster", file), {
    code: "INVALID_TEMPLATE",
  });
  await assert.rejects(repository.writePng("demo-1", "poster", file, "other-table"), {
    code: "INVALID_TEMPLATE",
  });
  await assert.rejects(repository.loadTemplate("missing"), { code: "INVALID_TEMPLATE" });
  const incomplete = bundle();
  incomplete.assets = [];
  await assert.rejects(repository.saveTemplate(incomplete), { code: "INVALID_ASSET" });
  repository.dispose();
  await assert.rejects(repository.listTemplates(), { code: "STORAGE_ERROR" });
});

test("本地模板、配置和输出附件拒绝覆盖外部新修订", async () => {
  const repo = new LocalPosterRepository({
    indexedDB: new IDBFactory(),
    databaseName: "optimistic-revisions",
  });
  const saved = await repo.saveTemplate(bundle(), null);
  await assert.rejects(repo.saveTemplate(bundle(), null), { code: "REVISION_CONFLICT" });
  await assert.rejects(repo.saveTemplate(bundle(), saved.updatedAt - 1), {
    code: "REVISION_CONFLICT",
  });
  await repo.saveTemplate(bundle(), saved.updatedAt);
  const settings = await repo.saveSettings(
    { schemaVersion: 1, tableId: "local-demo", templateId: "stable-id", outputFieldId: "poster" },
    null,
  );
  await assert.rejects(
    repo.saveSettings(
      { schemaVersion: 1, tableId: "local-demo", templateId: "stable-id", outputFieldId: null },
      null,
    ),
    { code: "REVISION_CONFLICT" },
  );
  await repo.saveSettings(
    { schemaVersion: 1, tableId: "local-demo", templateId: "stable-id", outputFieldId: "poster" },
    settings.updatedAt,
  );
  const initial = await repo.readOutputVersion("demo-1", "poster", "local-demo");
  const file = new File(["png"], "poster.png", { type: "image/png" });
  await repo.writePng("demo-1", "poster", file, "local-demo", initial);
  await assert.rejects(repo.writePng("demo-1", "poster", file, "local-demo", initial), {
    code: "WRITE_CONFLICT",
  });
  const revision = (await repo.loadTemplate("stable-id")).revision;
  await assert.rejects(repo.deleteTemplate("stable-id", null), { code: "REVISION_CONFLICT" });
  await repo.deleteTemplate("stable-id", revision);
  assert.deepEqual(await repo.listTemplates(), []);
  repo.dispose();
});

test("同毫秒内两个本地仓储争用同一修订时，仅一个写入提交", async (context) => {
  context.mock.method(Date, "now", () => 1000);
  const options = { indexedDB: new IDBFactory(), databaseName: "concurrent-revisions" };
  const first = new LocalPosterRepository(options);
  const second = new LocalPosterRepository(options);
  const expectOneWrite = async (attempts: Promise<unknown>[], code: string) => {
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected");
    assert.equal(failure?.reason.code, code);
  };
  try {
    const initial = await first.saveTemplate(bundle(), null);
    await expectOneWrite(
      [
        first.saveTemplate(bundle(), initial.updatedAt),
        second.saveTemplate(bundle(), initial.updatedAt),
      ],
      "REVISION_CONFLICT",
    );
    assert.equal((await first.listTemplates())[0].updatedAt, 1001);

    const settings = {
      schemaVersion: 1 as const,
      tableId: "local-demo",
      templateId: null,
      outputFieldId: "poster",
    };
    await expectOneWrite(
      [first.saveSettings(settings, null), second.saveSettings(settings, null)],
      "REVISION_CONFLICT",
    );
    const source = await first.getTemplateSource(
      "demo-1",
      "demo-template-ref",
      "local-demo",
      "demo-template-background",
    );
    await expectOneWrite(
      [
        first.saveSourceTemplate(source, bundle(), null),
        second.saveSourceTemplate(source, bundle(), null),
      ],
      "REVISION_CONFLICT",
    );

    const file = new File(["png"], "海报.png", { type: "image/png" });
    await first.writePng("demo-1", "poster", file);
    const outputVersion = await first.readOutputVersion("demo-1", "poster");
    await expectOneWrite(
      [
        first.writePng("demo-1", "poster", file, undefined, outputVersion),
        second.writePng("demo-1", "poster", file, undefined, outputVersion),
      ],
      "WRITE_CONFLICT",
    );
    assert.notEqual(await first.readOutputVersion("demo-1", "poster"), outputVersion);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("本地数据库打开失败后，同一仓储实例可以重试", async (context) => {
  const indexedDB = new IDBFactory();
  const open = indexedDB.open.bind(indexedDB);
  let calls = 0;
  context.mock.method(indexedDB, "open", (name: string, version?: number) => {
    if (++calls === 1) throw new Error("暂时不可用");
    return open(name, version);
  });
  const repo = new LocalPosterRepository({ indexedDB });
  await assert.rejects(repo.loadContext(), { code: "STORAGE_ERROR" });
  assert.equal((await repo.loadContext()).tableId, "local-demo");
  assert.equal(calls, 2);
  repo.dispose();
});

test("素材 ID 由字节决定，拒绝 SVG、脚本、空文件和过大素材", async () => {
  const a = await createPosterAsset(new File(["pixels"], "a.png", { type: "image/png" }));
  const b = await createPosterAsset(new File(["pixels"], "b.png"));
  assert.equal(a.id, b.id);
  assert.equal(b.mimeType, "image/png");
  assert.notEqual(a.id, (await createPosterAsset(new File(["different"], "a.png"))).id);
  for (const file of [
    new File(["<svg/>"], "a.svg"),
    new File(["x"], "a.js"),
    new File([], "empty.png"),
    new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png"),
  ]) {
    await assert.rejects(createPosterAsset(file), { code: "INVALID_ASSET" });
  }
});

test("仓储工厂同步选模式，构造飞书模式不执行 SDK", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    const host: { parent?: unknown; location: { search: string } } = { location: { search: "" } };
    host.parent = host;
    Object.defineProperty(globalThis, "window", { configurable: true, value: host });
    assert.equal(createRepository().mode, "local");
    host.location.search = "?mode=feishu";
    assert.equal(createRepository().mode, "feishu");
    host.location.search = "";
    host.parent = {};
    assert.equal(createRepository().mode, "feishu");
    host.location.search = "?mode=local";
    assert.equal(createRepository().mode, "feishu");
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("没有 IndexedDB 时快速失败", async () => {
  const repository = new LocalPosterRepository();
  await assert.rejects(
    repository.loadContext(),
    (error) => error instanceof PosterError && error.code === "STORAGE_ERROR",
  );
});

test("本地设置按 tableId 持久化，读取副本不污染缓存，重开数据库无需升级", async () => {
  const indexedDB = new IDBFactory();
  const options = { indexedDB, databaseName: "settings-reload" };
  const repo = new LocalPosterRepository(options);
  assert.equal(await repo.loadSettings("table-a"), null);
  const settings = {
    schemaVersion: 1 as const,
    tableId: "table-a",
    templateId: "template-a",
    outputFieldId: "poster",
  };
  await repo.saveSettings(settings);
  await repo.saveSettings({
    schemaVersion: 1,
    tableId: "table-b",
    templateId: null,
    outputFieldId: null,
  });
  const copy = (await repo.loadSettings("table-a"))!;
  copy.templateId = "changed";
  assertSettings(await repo.loadSettings("table-a"), settings);
  repo.dispose();
  const reopened = new LocalPosterRepository(options);
  assertSettings(await reopened.loadSettings("table-a"), settings);
  assert.equal((await reopened.loadSettings("table-b"))!.templateId, null);
  await reopened.saveSettings({ ...settings, outputFieldId: "new-output" });
  assert.equal((await reopened.loadSettings("table-a"))!.outputFieldId, "new-output");
  await assert.rejects(reopened.saveSettings({ ...settings, schemaVersion: 2 } as never), {
    code: "INVALID_TEMPLATE",
  });
  reopened.dispose();
});

test("本地缓存 TTL 与手动刷新可重新读取其他实例保存的设置", async () => {
  let now = 0;
  const options = {
    indexedDB: new IDBFactory(),
    databaseName: "settings-cache",
    ttlMs: 20,
    now: () => now,
  };
  const first = new LocalPosterRepository(options);
  const second = new LocalPosterRepository(options);
  assert.equal(await first.loadSettings("a"), null);
  await second.saveSettings({
    schemaVersion: 1,
    tableId: "a",
    templateId: "new",
    outputFieldId: null,
  });
  assert.equal(await first.loadSettings("a"), null);
  now = 20;
  assert.equal((await first.loadSettings("a"))!.templateId, "new");
  await second.saveSettings({
    schemaVersion: 1,
    tableId: "a",
    templateId: "fresh",
    outputFieldId: null,
  });
  first.invalidate();
  assert.equal((await first.loadSettings("a"))!.templateId, "fresh");
  first.dispose();
  second.dispose();
});

test("本地逐行底图通过可注入 fetch 读取真实示例字节，失败不缓存且错误码保留", async () => {
  const bytes = await readFile(new URL("../public/demo/clean-background.webp", import.meta.url));
  const urls: string[] = [];
  let broken = true;
  const repo = new LocalPosterRepository({
    indexedDB: new IDBFactory(),
    fetcher: (async (url, options) => {
      urls.push(String(url));
      assert.ok(options?.signal instanceof AbortSignal);
      if (broken) throw { code: 99991400, message: "test failure" };
      return new Response(bytes);
    }) as typeof fetch,
  });
  await assert.rejects(
    repo.loadBackground("demo-1", "demo-background", "local-demo"),
    (error) =>
      error instanceof PosterError && "platformCode" in error && error.platformCode === "99991400",
  );
  broken = false;
  const first = await repo.loadBackground("demo-1", "demo-background", "local-demo");
  const second = await repo.loadBackground("demo-2", "demo-background", "local-demo");
  assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()), new Uint8Array(bytes));
  assert.equal(first.id, second.id);
  assert.equal(first.mimeType, "image/webp");
  first.name = "副本改名";
  assert.equal(
    (await repo.loadBackground("demo-1", "demo-background", "local-demo")).name,
    "clean-background.webp",
  );
  assert.deepEqual(urls, Array(2).fill("./demo/clean-background.webp"));
  for (const [record, field, table] of [
    ["missing", "demo-background", "local-demo"],
    ["demo-1", "poster", "local-demo"],
    ["demo-1", "demo-background", "other"],
  ]) {
    await assert.rejects(repo.loadBackground(record, field, table), { code: "INVALID_ASSET" });
  }
  assert.equal(urls.length, 2);
  repo.dispose();
});

test("旧 IndexedDB 上下文只补入底图字段，记录、选择行、模板、输出均保留且不重复追加", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "old-background-context";
  const first = new LocalPosterRepository({ indexedDB, databaseName });
  const old = await first.loadContext();
  old.fields = old.fields.filter((field) => field.id !== "demo-background");
  old.tableName = "保留原表名";
  old.records[0].values.job = "用户自定义岗位";
  old.selectedRecordId = "demo-2";
  await first.saveTemplate(bundle());
  await first.writePng(
    "demo-1",
    "poster",
    new File(["existing-output"], "原输出.png", { type: "image/png" }),
  );
  first.dispose();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("context", "readwrite");
    tx.objectStore("context").put(old, "workspace");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  const reopened = new LocalPosterRepository({ indexedDB, databaseName });
  const migrated = await reopened.loadContext();
  assert.deepEqual(migrated.records, old.records);
  assert.equal(migrated.selectedRecordId, "demo-2");
  assert.equal(migrated.tableName, old.tableName);
  assert.deepEqual(migrated.fields.slice(0, -1), old.fields);
  assert.equal(migrated.fields.at(-1)?.id, "demo-background");
  assert.equal(migrated.fields.filter((field) => field.id === "demo-background").length, 1);
  reopened.invalidate();
  assert.deepEqual(await reopened.loadContext(), migrated);
  assert.equal((await reopened.loadTemplate("stable-id")).template.name, "测试模板");
  assert.equal(await (await reopened.listOutputs())[0].blob.text(), "existing-output");
  reopened.dispose();
});

test("本地来源配置按记录隔离，重开恢复模板与字体，只保存字体并排除普通模板列表", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "source-reload";
  const bytes = await readFile(new URL("../public/demo/clean-background.webp", import.meta.url));
  const options = {
    indexedDB,
    databaseName,
    fetcher: (async () => new Response(bytes)) as typeof fetch,
  };
  const repo = new LocalPosterRepository(options);
  const first = await repo.getTemplateSource(
    "demo-1",
    "demo-template-ref",
    "local-demo",
    "demo-template-background",
  );
  const second = await repo.getTemplateSource(
    "demo-2",
    "demo-template-ref",
    "local-demo",
    "demo-template-background",
  );
  assert.notEqual(first.recordId, second.recordId);
  assert.equal(await repo.loadSourceTemplate(first), null);
  const a = bundle();
  a.template.name = "来源 A";
  a.template.backgroundFieldId = "demo-template-background";
  a.template.boxes[0].color = "#123456";
  const b = bundle();
  b.template.name = "来源 B";
  b.template.boxes[0].color = "#abcdef";
  await repo.saveSourceTemplate(first, a);
  await repo.saveSourceTemplate(second, b);
  assert.deepEqual(await repo.listTemplates(), []);
  await repo.saveTemplate(bundle());
  assert.equal((await repo.listTemplates()).length, 1);
  const invalid = bundle();
  invalid.assets = [];
  await assert.rejects(repo.saveSourceTemplate(first, invalid), { code: "INVALID_ASSET" });
  await assert.rejects(
    repo.getTemplateSource("demo-1", "demo-template-ref", "local-demo", "poster"),
    {
      code: "INVALID_ASSET",
    },
  );
  repo.dispose();
  const reopened = new LocalPosterRepository(options);
  const restoredA = (await reopened.loadSourceTemplate(first))!;
  const restoredB = (await reopened.loadSourceTemplate(second))!;
  assert.equal(restoredA.template.id, "stable-id");
  assert.equal(restoredA.template.name, "来源 A");
  assert.equal(restoredB.template.name, "来源 B");
  assert.equal(restoredA.template.boxes[0].color, "#123456");
  assert.equal(restoredB.template.boxes[0].color, "#abcdef");
  assert.equal(restoredA.template.backgroundFieldId, "demo-template-background");
  assert.equal(
    await restoredA.assets.find((asset) => asset.id === "font")!.blob.text(),
    "font-bytes",
  );
  assert.equal(restoredA.assets[0].blob.size, bytes.length);
  assert.equal((await reopened.loadTemplate("stable-id")).template.name, "测试模板");
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
  });
  const saved = await new Promise<{ assets: { id: string }[] }>((resolve) => {
    const request = db
      .transaction("templates")
      .objectStore("templates")
      .get("source:local-demo-template:template-1");
    request.onsuccess = () => resolve(request.result);
  });
  assert.deepEqual(
    saved.assets.map((asset) => asset.id),
    ["font"],
  );
  db.close();
  reopened.dispose();
});

test("本地仅列出虚构示例表，显式表 ID 校验且初始化标识持久化不覆盖旧数据", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "storage-initialization";
  const options = { indexedDB, databaseName };
  const repo = new LocalPosterRepository(options);
  const context = await repo.loadContext();
  assert.deepEqual(await repo.listTables(), [{ id: "local-demo", name: context.tableName }]);
  assert.deepEqual(await repo.loadContext("local-demo"), context);
  await repo.saveTemplate(bundle());
  const settings = {
    schemaVersion: 1 as const,
    tableId: "local-demo",
    templateId: "stable-id",
    outputFieldId: "poster",
  };
  await repo.saveSettings(settings);
  await repo.writePng(
    "demo-1",
    "poster",
    new File(["old-png"], "旧海报.png", { type: "image/png" }),
  );
  assert.deepEqual(await repo.initializeStorage(), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: true,
  });
  assert.deepEqual(await repo.initializeStorage(), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: false,
  });
  await assert.rejects(repo.loadContext("missing"), { code: "INVALID_TEMPLATE" });
  await assert.rejects(repo.loadContext(""), { code: "INVALID_TEMPLATE" });
  repo.dispose();
  const reopened = new LocalPosterRepository(options);
  assert.deepEqual(await reopened.initializeStorage(), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: false,
  });
  assert.deepEqual(await reopened.loadContext("local-demo"), context);
  assertSettings(await reopened.loadSettings("local-demo"), settings);
  assert.equal((await reopened.loadTemplate("stable-id")).template.name, "测试模板");
  assert.equal(await (await reopened.listOutputs())[0].blob.text(), "old-png");
  reopened.dispose();
});

test("本地显式未知表无需访问存储即拒绝，初始化失败不能返回就绪", async () => {
  const repo = new LocalPosterRepository();
  await assert.rejects(repo.loadContext("missing"), { code: "INVALID_TEMPLATE" });
  await assert.rejects(repo.initializeStorage(), { code: "STORAGE_ERROR" });
  repo.dispose();
});

test("本地配置列表提供唯一现有模拟表，显式复用不改变旧初始化标记", async () => {
  const repo = new LocalPosterRepository({
    indexedDB: new IDBFactory(),
    databaseName: "explicit-storage",
  });
  assert.deepEqual(await repo.listStorageTables(), [
    { id: "local-settings", name: "本地示例配置" },
  ]);
  const value = {
    schemaVersion: 1 as const,
    tableId: "local-demo",
    templateId: "saved",
    outputFieldId: "poster",
  };
  await repo.saveSettings(value);
  assert.deepEqual(await repo.initializeStorage("local-settings"), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: false,
  });
  assertSettings(await repo.loadSettings("local-demo"), value);
  assert.deepEqual(await repo.initializeStorage(), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: true,
  });
  assert.deepEqual(await repo.initializeStorage(), {
    tableId: "local-settings",
    name: "本地示例配置",
    created: false,
  });
  repo.dispose();
});

test("本地拒绝非法配置表 ID，重新选择配置表使缓存失效且保留各业务表配置", async () => {
  const options = { indexedDB: new IDBFactory(), databaseName: "selected-storage-cache" };
  const first = new LocalPosterRepository(options);
  const second = new LocalPosterRepository(options);
  await first.initializeStorage("local-settings");
  const a = { schemaVersion: 1 as const, tableId: "a", templateId: "old", outputFieldId: null };
  const b = { ...a, tableId: "b", templateId: "other-table" };
  await first.saveSettings(a);
  await first.saveSettings(b);
  assertSettings(await first.loadSettings("a"), a);
  await second.saveSettings({ ...a, templateId: "fresh" });
  for (const id of ["missing", "", "local-demo"])
    await assert.rejects(first.initializeStorage(id), { code: "INVALID_TEMPLATE" });
  await first.initializeStorage("local-settings");
  assert.equal((await first.loadSettings("a"))!.templateId, "fresh");
  assertSettings(await first.loadSettings("b"), b);
  first.dispose();
  second.dispose();
  const unavailable = new LocalPosterRepository();
  await assert.rejects(unavailable.initializeStorage("missing"), { code: "INVALID_TEMPLATE" });
  await assert.rejects(unavailable.initializeStorage("local-settings"), { code: "STORAGE_ERROR" });
  unavailable.dispose();
});

test("本地连接指针重开恢复，结构化副本隔离，重复保存不升级数据库或覆盖原上下文设置", async () => {
  const options = { indexedDB: new IDBFactory(), databaseName: "workspace-binding-reload" };
  const repo = new LocalPosterRepository(options);
  assert.equal(await repo.loadWorkspaceBinding(), null);
  const context = await repo.loadContext();
  const settings = {
    schemaVersion: 1 as const,
    tableId: context.tableId,
    templateId: "old-template",
    outputFieldId: "poster",
  };
  await repo.saveSettings(settings);
  const expected: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: context.tableId,
    storageTableId: "local-settings",
  };
  const input = { ...expected, extra: "不应保存" };
  const saving = repo.saveWorkspaceBinding(input);
  input.tableId = "changed";
  await saving;
  const copy = (await repo.loadWorkspaceBinding())!;
  copy.storageTableId = "changed";
  assert.deepEqual(await repo.loadWorkspaceBinding(), expected);
  repo.dispose();
  const reopened = new LocalPosterRepository(options);
  assert.deepEqual(await reopened.loadWorkspaceBinding(), expected);
  for (let i = 0; i < 3; i++) {
    await reopened.initializeStorage(expected.storageTableId);
    assertSettings(await reopened.loadSettings(expected.tableId), settings);
    await reopened.saveSettings(settings);
    await reopened.saveWorkspaceBinding(expected);
  }
  assert.deepEqual(await reopened.loadContext(), context);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = options.indexedDB.open(options.databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(db.version, 1);
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    const request = db.transaction("context").objectStore("context").getAllKeys();
    request.onsuccess = () => resolve(request.result);
  });
  assert.deepEqual(keys, ["settings:local-demo", "workspace", "workspace-binding"]);
  db.close();
  reopened.dispose();
});

test("本地连接指针坏值明确失败且保留原值，不生成默认绑定", async () => {
  const options = { indexedDB: new IDBFactory(), databaseName: "workspace-binding-invalid" };
  const repo = new LocalPosterRepository(options);
  assert.equal(await repo.loadWorkspaceBinding(), null);
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = options.indexedDB.open(options.databaseName, 1);
    request.onsuccess = () => resolve(request.result);
  });
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "local-demo",
    storageTableId: "local-settings",
  };
  for (const value of [
    false,
    "{}",
    [],
    {},
    { ...binding, schemaVersion: 2 },
    { ...binding, tableId: " " },
    { ...binding, storageTableId: null },
  ]) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("context", "readwrite");
      tx.objectStore("context").put(value, "workspace-binding");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await assert.rejects(repo.loadWorkspaceBinding(), { code: "INVALID_TEMPLATE" });
    await assert.rejects(repo.saveWorkspaceBinding(value as WorkspaceBinding), {
      code: "INVALID_TEMPLATE",
    });
    const stored = await new Promise<unknown>((resolve) => {
      const request = db.transaction("context").objectStore("context").get("workspace-binding");
      request.onsuccess = () => resolve(request.result);
    });
    assert.deepEqual(stored, value);
  }
  db.close();
  repo.dispose();
  await assert.rejects(repo.loadWorkspaceBinding(), { code: "STORAGE_ERROR" });
  await assert.rejects(repo.saveWorkspaceBinding(binding), { code: "STORAGE_ERROR" });
});

test("本地模板页列出模板行、按行构造来源并按已保存配置标记", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "template-rows";
  const bytes = await readFile(new URL("../public/demo/clean-background.webp", import.meta.url));
  const options = {
    indexedDB,
    databaseName,
    fetcher: (async () => new Response(bytes)) as typeof fetch,
  };
  const repo = new LocalPosterRepository(options);
  assert.deepEqual(
    (await repo.listTemplateRows("local-demo-template", "demo-template-background")).map((row) => [
      row.recordId,
      row.label,
      row.configured,
    ]),
    [
      ["template-1", "本地示例模板", false],
      ["template-2", "本地示例模板 B", false],
    ],
  );
  await assert.rejects(repo.listTemplateRows("local-demo-template", "poster"), {
    code: "INVALID_ASSET",
  });
  const source = await repo.getTemplateSourceByRow(
    "local-demo-template",
    "template-2",
    "demo-template-background",
  );
  assert.equal(source.recordName, "本地示例模板 B");
  await assert.rejects(
    repo.getTemplateSourceByRow("local-demo-template", "missing", "demo-template-background"),
    { code: "INVALID_TEMPLATE" },
  );
  await repo.saveSourceTemplate(source, bundle());
  const rows = await repo.listTemplateRows("local-demo-template", "demo-template-background");
  assert.deepEqual(
    rows.map((row) => [row.recordId, row.configured]),
    [
      ["template-1", false],
      ["template-2", true],
    ],
  );
  repo.dispose();
});
