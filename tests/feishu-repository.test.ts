import assert from "node:assert/strict";
import test from "node:test";
import {
  FeishuPosterRepository,
  SETTINGS_TABLE_NAME,
  SOURCE_CONFIG_FIELD,
  SOURCE_FONT_FIELD,
  TEMPLATE_TABLE_NAME,
  type FeishuSdkFacade,
  type SdkAttachment,
  type SdkAttachmentField,
  type SdkFieldMeta,
  type SdkRecord,
  type SdkRecordInput,
  type SdkTable,
} from "../src/data/feishu-repository";
import { BACKGROUND_TIMEOUT_MS } from "../src/data/background-attachment";
import { hashBlob, MAX_ASSET_BYTES } from "../src/data/assets";
import { PlatformPosterError } from "../src/data/errors";
import type { TemplateBundle, WorkspaceBinding } from "../src/domain/types";
import type { IField } from "@lark-base-open/js-sdk";

function bundle(id = "template-1"): TemplateBundle {
  return {
    template: {
      schemaVersion: 1,
      id,
      name: "招聘模板",
      width: 600,
      height: 800,
      backgroundId: "bg",
      fontIds: ["font"],
      boxes: [
        {
          id: "box",
          label: "岗位",
          fieldId: "job",
          text: "",
          x: 10,
          y: 20,
          width: 400,
          height: 60,
          fontId: "font",
          fontSize: 30,
          minFontSize: 14,
          color: "#000",
          align: "left",
          lineHeight: 1.2,
          maxLines: 2,
        },
      ],
    },
    assets: [
      {
        id: "bg",
        name: "底图.png",
        mimeType: "image/png",
        blob: new Blob(["picture-v1"], { type: "image/png" }),
      },
      {
        id: "font",
        name: "中文.otf",
        mimeType: "font/otf",
        blob: new Blob(["font-v1"], { type: "font/otf" }),
      },
    ],
  };
}

function assertSettings(
  actual: Awaited<ReturnType<FeishuPosterRepository["loadSettings"]>>,
  expected: unknown,
): void {
  assert.ok(actual);
  const { updatedAt, ...value } = actual;
  assert.ok(Number.isFinite(updatedAt));
  assert.deepEqual(value, expected);
}

class MockTable implements SdkTable {
  rows = new Map<string, Record<string, unknown>>();
  pageCalls: Parameters<SdkTable["getRecordsByPage"]>[0][] = [];
  fieldMetaReads = 0;
  recordReads = 0;
  attachmentReads = 0;
  attachmentWrites: { recordId: string; fieldId: string; file: File }[] = [];
  urlGeneration = 0;
  writeResult = true;
  writeError: unknown;
  corruptReadback = false;
  readbackError: unknown;
  fieldError: unknown;
  nullAttachments = false;
  readonly urlTokenCalls: string[][] = [];
  readonly addedFields: Parameters<SdkTable["addField"]>[0][] = [];
  readonly setRecordCalls: { id: string; value: SdkRecordInput }[] = [];
  readonly deletedRecordIds: string[] = [];
  constructor(
    readonly id: string,
    readonly name: string,
    readonly fields: SdkFieldMeta[],
  ) {}
  async getName() {
    return this.name;
  }
  async getFieldMetaList() {
    this.fieldMetaReads++;
    return this.fields;
  }
  async addField(config: Parameters<SdkTable["addField"]>[0]) {
    if (this.fieldError) throw this.fieldError;
    this.addedFields.push(config);
    const id = `added-${this.fields.length}`;
    this.fields.push({ id, name: config.name ?? id, type: config.type });
    return id;
  }
  async getRecordsByPage(options: Parameters<SdkTable["getRecordsByPage"]>[0]) {
    this.pageCalls.push(options);
    const rows: SdkRecord[] = [...this.rows].map(([recordId, fields]) => ({
      recordId,
      fields: structuredClone(fields) as SdkRecordInput["fields"],
    }));
    // 用两条记录一页强制验证后续页读取。
    const offset = options.pageToken ?? 0;
    return {
      records: rows.slice(offset, offset + 2),
      total: rows.length,
      hasMore: offset + 2 < rows.length,
      pageToken: offset + 2,
    };
  }
  async getRecordById(recordId: string) {
    this.recordReads++;
    if (this.readbackError) throw this.readbackError;
    const fields = this.rows.get(recordId);
    if (!fields) throw { code: 10214998, message: "record missing" };
    const copy = structuredClone(fields);
    if (this.corruptReadback)
      copy[this.id === "settings" ? "value" : "config"] = [{ type: "text", text: "{}" }];
    return { fields: copy as SdkRecordInput["fields"] };
  }
  async getCellAttachmentUrls(tokens: string[], _fieldId: string, _recordId: string) {
    this.urlGeneration++;
    this.urlTokenCalls.push([...tokens]);
    return tokens.map((token) => `https://offline.test/${token}?v=${this.urlGeneration}`);
  }
  async getFieldById<T extends IField>(fieldId: string): Promise<T> {
    if (this.fieldError) throw this.fieldError;
    const field: SdkAttachmentField = {
      getValue: async (recordId) => {
        this.attachmentReads++;
        assert.equal(typeof recordId, "string");
        // SDK 声明未含 null，模拟宿主空附件实际可返回 null 的行为。
        if (this.nullAttachments || this.rows.get(recordId as string)?.[fieldId] === null)
          return null!;
        return (this.rows.get(recordId as string)?.[fieldId] ?? []) as SdkAttachment[];
      },
      setValue: async (recordId, value) => {
        assert.equal(typeof recordId, "string");
        const id = recordId as string;
        if (this.writeError) throw this.writeError;
        assert.ok(value instanceof File);
        this.attachmentWrites.push({ recordId: id, fieldId, file: value });
        if (!this.writeResult) return false;
        this.rows.get(id)![fieldId] = value;
        return true;
      },
    };
    // 测试替身只实现被测适配器实际调用的方法，生产 facade 仍由 SDK 类型约束。
    return field as T;
  }
  async addRecord(value?: Parameters<SdkTable["addRecord"]>[0]) {
    assert.ok(value && "fields" in value);
    const id = `row-${this.rows.size + 1}`;
    this.rows.set(id, structuredClone(value.fields));
    return id;
  }
  async setRecord(id: string, value: SdkRecordInput) {
    if (this.writeError) throw this.writeError;
    this.setRecordCalls.push({ id, value: structuredClone(value) });
    this.rows.set(id, { ...this.rows.get(id), ...structuredClone(value.fields) });
    return id;
  }
  async deleteRecord(id: string) {
    if (this.writeError) throw this.writeError;
    this.deletedRecordIds.push(id);
    return this.rows.delete(id);
  }
}

function mockSdk() {
  const main = new MockTable("main", "真实宿主的模拟表", [
    { id: "job", name: "岗位", type: 1 },
    { id: "number", name: "人数", type: 2 },
    { id: "select", name: "标签", type: 4 },
    { id: "phone", name: "电话", type: 13 },
    { id: "url", name: "链接", type: 15 },
    { id: "poster", name: "附件", type: 17 },
  ]);
  main.rows.set("r1", {
    job: [
      { type: "text", text: "设计" },
      { type: "text", text: "助理" },
    ],
    number: 0,
    select: [
      { id: "a", text: "全职" },
      { id: "b", text: "双休" },
    ],
    phone: "012345",
    url: [{ type: "url", text: "官网", link: "https://example.test" }],
    poster: [],
  });
  main.rows.set("r2", { job: "第二岗位" });
  main.rows.set("r3", { job: "第三岗位" });
  const templates = new MockTable("templates", TEMPLATE_TABLE_NAME, [
    { id: "templateId", name: "模板ID", type: 1 },
    { id: "name", name: "名称", type: 1 },
    { id: "config", name: "配置", type: 1 },
    { id: "assets", name: "素材", type: 17 },
  ]);
  const settings = new MockTable("settings", SETTINGS_TABLE_NAME, [
    { id: "key", name: "配置键", type: 1 },
    { id: "value", name: "配置值", type: 1 },
  ]);
  const uploads = new Map<string, File>();
  const state = {
    activeUploads: 0,
    maxUploads: 0,
    uploadCalls: 0,
    tableExists: false,
    settingsExist: false,
    selectionCalls: 0,
    baseId: "base-1",
    tableId: "main",
    viewId: "view-1",
    recordId: "r2",
    fail: undefined as unknown,
  };
  const sdk: FeishuSdkFacade = {
    base: {
      getSelection: async () => {
        state.selectionCalls++;
        if (state.fail) throw state.fail;
        return {
          baseId: state.baseId,
          fieldId: null,
          tableId: state.tableId,
          viewId: state.viewId,
          recordId: state.recordId,
        };
      },
      getTableById: async (id) =>
        id === "settings" ? settings : id === "templates" ? templates : main,
      getTableMetaList: async () => {
        if (state.fail) throw state.fail;
        return [
          { id: "main", name: main.name },
          ...(state.tableExists ? [{ id: "templates", name: TEMPLATE_TABLE_NAME }] : []),
          ...(state.settingsExist ? [{ id: "settings", name: SETTINGS_TABLE_NAME }] : []),
        ];
      },
      addTable: async (config) => {
        if (config.name === SETTINGS_TABLE_NAME) {
          assert.deepEqual(
            config.fields.map((field) => field.name),
            ["配置键", "配置值"],
          );
          state.settingsExist = true;
          return { tableId: "settings", index: 1 };
        }
        assert.deepEqual(
          config.fields.map((field) => field.name),
          ["模板ID", "名称", "配置", "素材"],
        );
        state.tableExists = true;
        return { tableId: "templates", index: 1 };
      },
      batchUploadFile: async (files) => {
        state.activeUploads++;
        state.maxUploads = Math.max(state.maxUploads, state.activeUploads);
        state.uploadCalls++;
        // 跨一个异步回合，若调用方并发上传，计数会稳定暴露。
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          return Array.from(files).map((file) => {
            const token = `token-${uploads.size + 1}`;
            uploads.set(token, file);
            return token;
          });
        } finally {
          state.activeUploads--;
        }
      },
    },
  };
  const fetchUrls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    fetchUrls.push(url);
    const token = new URL(url).pathname.slice(1);
    const file = uploads.get(token);
    return new Response(file ?? null, { status: file ? 200 : 404 });
  }) as typeof fetch;
  return { sdk, main, templates, settings, state, uploads, fetcher, fetchUrls };
}

test("读取当前视图的分页记录，文本、数字、选项、电话与 URL 正确映射", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const context = await repo.loadContext();
  assert.equal(context.records.length, 3);
  assert.equal(context.selectedRecordId, "r2");
  assert.deepEqual(context.records[0].values, {
    job: "设计助理",
    number: "0",
    select: "全职、双休",
    phone: "012345",
    url: "官网",
  });
  assert.equal(context.fields.at(-1)?.kind, "attachment");
  assert.deepEqual(mock.main.pageCalls, [
    { pageSize: 200, viewId: "view-1" },
    { pageSize: 200, viewId: "view-1", pageToken: 2 },
  ]);
});

test("记录名称取飞书主字段，主字段为空时显示未命名记录", async () => {
  const mock = mockSdk();
  mock.main.fields.find((field) => field.id === "phone")!.isPrimary = true;
  const repo = new FeishuPosterRepository(mock);
  const context = await repo.loadContext();
  assert.deepEqual(
    context.records.map((record) => record.label),
    ["012345", "未命名记录", "未命名记录"],
  );
});

test("工作区元数据与记录分页分离，全表读取保持兼容", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const metadata = await repo.loadContext("main", false);
  assert.equal(metadata.records.length, 0);
  assert.equal(mock.main.pageCalls.length, 0);
  const first = await repo.listRecords("main", undefined, 2);
  assert.deepEqual(
    first.records.map((row) => row.id),
    ["r1", "r2"],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.pageToken, 2);
  const second = await repo.listRecords("main", first.pageToken, 2);
  assert.deepEqual(
    second.records.map((row) => row.id),
    ["r3"],
  );
  assert.equal(second.hasMore, false);
  assert.equal((await repo.loadContext("main")).records.length, 3);
  assert.equal(mock.main.fieldMetaReads, 1);
});

test("记录列表按视图顺序读取，不传视图时才是表内插入顺序", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  // 视图内顺序与插入顺序相反：列表必须照视图返回顺序，而不是表底层顺序。
  const viewOrder = ["r3", "r2", "r1"];
  mock.main.getRecordsByPage = async (options) => {
    mock.main.pageCalls.push(options);
    const order = options.viewId ? viewOrder : ["r1", "r2", "r3"];
    return {
      records: order.map((id) => ({
        recordId: id,
        fields: structuredClone(mock.main.rows.get(id)!) as SdkRecordInput["fields"],
      })),
      total: order.length,
      hasMore: false,
      pageToken: order.length,
    };
  };
  const viewed = await repo.listRecords("main", undefined, 50, "view-1");
  assert.deepEqual(
    viewed.records.map((row) => row.id),
    viewOrder,
  );
  assert.deepEqual(mock.main.pageCalls.at(-1), { pageSize: 50, viewId: "view-1" });
  const plain = await repo.listRecords("main", undefined, 50);
  assert.deepEqual(
    plain.records.map((row) => row.id),
    ["r1", "r2", "r3"],
  );
  assert.deepEqual(mock.main.pageCalls.at(-1), { pageSize: 50 });
});

test("保存并重读模板：稳定 ID、刷新附件 URL、完整素材字节、没有临时 URL 持久化", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  assert.deepEqual(await repo.listTemplates(), []);
  assert.equal(mock.state.tableExists, false);
  const expected = bundle();
  assert.equal((await repo.saveTemplate(expected)).id, "template-1");
  assert.equal(mock.state.uploadCalls, 2);
  const raw = JSON.stringify([...mock.templates.rows.values()]);
  assert.ok(!raw.includes("https://"));
  const reopened = new FeishuPosterRepository(mock);
  const loaded = await reopened.loadTemplate("template-1");
  assert.deepEqual(loaded.template, expected.template);
  assert.equal(await loaded.assets[0].blob.text(), "picture-v1");
  assert.equal(await loaded.assets[1].blob.text(), "font-v1");
  await reopened.loadTemplate("template-1");
  assert.match(mock.fetchUrls[0], /v=1$/);
  assert.equal(mock.fetchUrls.length, 2);
  reopened.invalidate();
  await reopened.loadTemplate("template-1");
  assert.equal(mock.templates.urlGeneration, 2);
  assert.match(mock.fetchUrls[2], /v=2$/);
  expected.template.name = "改名";
  await repo.saveTemplate(expected);
  assert.equal(mock.templates.rows.size, 1);
  assert.equal(mock.state.uploadCalls, 2);
  assert.equal((await repo.listTemplates())[0].name, "改名");
});

test("并发保存仍串行上传；跨模板、改名及同字节素材复用已有 token", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await Promise.all([repo.saveTemplate(bundle("first")), repo.saveTemplate(bundle("second"))]);
  // 分页记录已提供所有已有附件，只回读两次新写入的单元格。
  assert.equal(mock.templates.attachmentReads, 2);
  assert.equal(mock.state.maxUploads, 1);
  assert.equal(mock.state.uploadCalls, 2);
  const third = bundle("third");
  third.assets[0].name = "新文件名.png";
  await repo.saveTemplate(third);
  assert.equal(mock.state.uploadCalls, 2);
  third.assets[0].blob = new Blob(["new-image"]);
  await repo.saveTemplate(third);
  assert.equal(mock.state.uploadCalls, 3);
});

test("PNG 只替换指定附件单元格，拒绝非附件字段，写回失败不吞错", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await repo.loadContext();
  const before = structuredClone(mock.main.rows.get("r1")!.job);
  const png = new File(["PNG"], "海报.png", { type: "image/png" });
  await repo.writePng("r1", "poster", png);
  assert.deepEqual(mock.main.rows.get("r1")!.job, before);
  assert.equal(mock.main.attachmentWrites.length, 1);
  assert.equal(await mock.main.attachmentWrites[0].file.text(), "PNG");
  await assert.rejects(repo.writePng("r1", "job", png), { code: "INVALID_ASSET" });
  mock.main.writeResult = false;
  await assert.rejects(repo.writePng("r1", "poster", png), { code: "WRITE_OUTCOME_UNKNOWN" });
  mock.main.writeError = { code: 10216997, message: "permission denied" };
  await assert.rejects(
    repo.writePng("r1", "poster", png),
    (error) =>
      error instanceof Error &&
      (error as { code?: string }).code === "WRITE_OUTCOME_UNKNOWN" &&
      /10216997/.test(error.message),
  );
});

test("飞书当前记录输出附件按同一快照下载为 Blob，不持久化临时 URL", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  mock.uploads.set("output-token", new File([png], "海报.png", { type: "image/png" }));
  mock.main.rows.get("r1")!.poster = [
    {
      token: "output-token",
      name: "海报.png",
      type: "image/png",
      size: png.length,
      timeStamp: 123,
    },
  ];
  const outputs = await repo.listOutputs("r1", "poster", "main");
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].name, "海报.png");
  assert.equal(outputs[0].createdAt, 123);
  assert.equal(outputs[0].blob.type, "image/png");
  assert.equal(outputs[0].blob.size, png.length);
  assert.match(mock.fetchUrls[0], /output-token/);
});

test("飞书输出列表只读元数据，点击时按原 token 和记录读取文件", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const first = { token: "file-a", name: "附件.txt", type: "text/plain", size: 4, timeStamp: 1 };
  const second = { ...first, token: "file-b", name: "其他.txt" };
  mock.main.rows.get("r1")!.poster = [first, second];
  const files = await repo.listOutputFiles("r1", "poster", "main");
  assert.deepEqual(
    files.map(({ id, name }) => [id, name]),
    [
      [first.token, first.name],
      [second.token, second.name],
    ],
  );
  assert.equal(mock.main.attachmentReads, 1);
  assert.equal(mock.state.selectionCalls, 0);
  assert.equal(mock.main.urlTokenCalls.length, 0);
  assert.equal(mock.fetchUrls.length, 0);

  mock.state.tableId = "other-table";
  mock.main.rows.get("r1")!.poster = [second, first];
  await assert.rejects(
    files[0].loadBlob(),
    (error) => error instanceof PlatformPosterError && error.platformCode === "404",
  );
  mock.uploads.set(first.token, new File(["used"], first.name));
  const blob = await files[0].loadBlob();
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "used");
  assert.deepEqual(mock.main.urlTokenCalls, [[first.token], [first.token]]);
  assert.equal(mock.main.attachmentReads, 1);
  assert.equal(mock.state.selectionCalls, 0);
});

test("飞书 PNG 写回后其他实例的工作区记录快照重新分页", async () => {
  const mock = mockSdk();
  const reader = new FeishuPosterRepository(mock);
  const writer = new FeishuPosterRepository(mock);
  assert.equal((await reader.loadContext("main")).records[0].displayValues?.poster, "");
  const write = new File(["png"], "海报.png", { type: "image/png" });
  await writer.writePng("r1", "poster", write, "main");
  mock.main.rows.get("r1")!.poster = [{ token: "written", name: write.name }];
  assert.equal((await reader.loadContext("main")).records[0].displayValues?.poster, write.name);
  assert.equal(mock.main.pageCalls.length, 4);
});

test("飞书模板、配置和输出附件在写入前核对乐观修订", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const saved = await repo.saveTemplate(bundle(), null);
  await assert.rejects(repo.saveTemplate(bundle(), null), { code: "REVISION_CONFLICT" });
  await assert.rejects(repo.saveTemplate(bundle(), saved.updatedAt - 1), {
    code: "REVISION_CONFLICT",
  });
  await repo.saveTemplate(bundle(), saved.updatedAt);
  const settings = await repo.saveSettings(
    { schemaVersion: 1, tableId: "main", templateId: "template-1", outputFieldId: "poster" },
    null,
  );
  await assert.rejects(
    repo.saveSettings(
      { schemaVersion: 1, tableId: "main", templateId: "template-1", outputFieldId: null },
      null,
    ),
    { code: "REVISION_CONFLICT" },
  );
  await repo.saveSettings(
    { schemaVersion: 1, tableId: "main", templateId: "template-1", outputFieldId: "poster" },
    settings.updatedAt,
  );
  const initial = await repo.readOutputVersion("r1", "poster", "main");
  const file = new File(["png"], "poster.png", { type: "image/png" });
  await repo.writePng("r1", "poster", file, "main", initial);
  await assert.rejects(repo.writePng("r1", "poster", file, "main", initial), {
    code: "WRITE_CONFLICT",
  });
  assert.equal(mock.main.attachmentWrites.length, 1);
  const revision = (await repo.loadTemplate("template-1")).revision;
  await assert.rejects(repo.deleteTemplate("template-1", null), { code: "REVISION_CONFLICT" });
  await repo.deleteTemplate("template-1", revision);
  assert.deepEqual(await repo.listTemplates(), []);
  assert.equal(mock.templates.deletedRecordIds.length, 1);
});

test("SDK 权限、限流及其他错误保留代码；失败不会回退本地或自动重试", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  mock.state.fail = { code: 10212997, message: "no access" };
  await assert.rejects(
    repo.loadContext(),
    (error) =>
      error instanceof PlatformPosterError &&
      error.code === "PERMISSION_DENIED" &&
      error.platformCode === "10212997",
  );
  mock.state.fail = { code: 99991400, message: "limited" };
  await assert.rejects(
    repo.loadContext(),
    (error) =>
      error instanceof PlatformPosterError && error.code === "PLATFORM_ERROR" && error.retryable,
  );
  mock.state.fail = { code: 10212998, message: "missing" };
  await assert.rejects(
    repo.loadContext(),
    (error) =>
      error instanceof PlatformPosterError && error.platformCode === "10212998" && !error.retryable,
  );
  assert.equal(repo.mode, "feishu");
  assert.equal(mock.state.selectionCalls, 3);
  mock.state.fail = undefined;
  assert.equal((await repo.loadContext()).records.length, 3);
});

test("构造不加载 SDK，初始化失败保留飞书模式", async () => {
  let calls = 0;
  const repo = new FeishuPosterRepository({
    loadSdk: async () => {
      calls++;
      throw new Error("host unavailable");
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(repo.loadContext(), { code: "PLATFORM_ERROR" });
  assert.equal(calls, 1);
  assert.equal(repo.mode, "feishu");
});

test("附件下载 HTTP 权限及 CORS 错误均变成可识别领域错误", async () => {
  const mock = mockSdk();
  await new FeishuPosterRepository(mock).saveTemplate(bundle());
  const forbidden = new FeishuPosterRepository({
    sdk: mock.sdk,
    fetcher: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(forbidden.loadTemplate("template-1"), { code: "PERMISSION_DENIED" });
  const cors = new FeishuPosterRepository({
    sdk: mock.sdk,
    fetcher: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(
    cors.loadTemplate("template-1"),
    (error) => error instanceof PlatformPosterError && /CORS/.test(error.message),
  );
});

test("配置 readback 不一致时不报告保存成功", async () => {
  const mock = mockSdk();
  mock.templates.corruptReadback = true;
  await assert.rejects(new FeishuPosterRepository(mock).saveTemplate(bundle()), {
    code: "PLATFORM_ERROR",
  });
});

test("重复分页 token 会快速失败", async () => {
  const mock = mockSdk();
  mock.main.getRecordsByPage = async () => ({ records: [], total: 0, hasMore: true, pageToken: 2 });
  await assert.rejects(new FeishuPosterRepository(mock).loadContext(), { code: "PLATFORM_ERROR" });
  await assert.rejects(new FeishuPosterRepository(mock).listRecords("main", 2), {
    code: "PLATFORM_ERROR",
  });
});

test("飞书配置独立建表，按 tableId 保存纯 JSON，重开后恢复并更新原记录", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  assert.equal(await repo.loadSettings("main"), null);
  assert.equal(mock.state.settingsExist, false);
  const first = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: "template-1",
    outputFieldId: "poster",
  };
  await repo.saveSettings(first);
  assert.equal(mock.state.settingsExist, true);
  assert.equal(mock.state.tableExists, false);
  const reopened = new FeishuPosterRepository(mock);
  assertSettings(await reopened.loadSettings("main"), first);
  const copy = (await reopened.loadSettings("main"))!;
  copy.templateId = "local-mutation";
  assertSettings(await reopened.loadSettings("main"), first);
  await reopened.saveSettings({
    schemaVersion: 1,
    tableId: "another",
    templateId: null,
    outputFieldId: null,
  });
  await reopened.saveSettings({ ...first, outputFieldId: "new-field" });
  assert.equal(mock.settings.rows.size, 2);
  assert.equal((await reopened.loadSettings("main"))!.outputFieldId, "new-field");
  assert.equal((await reopened.loadSettings("another"))!.templateId, null);
  const row = [...mock.settings.rows.values()][0];
  const raw = (row.value as { text: string }[])[0].text;
  assert.deepEqual(Object.keys(JSON.parse(raw)), [
    "schemaVersion",
    "tableId",
    "templateId",
    "outputFieldId",
    "updatedAt",
  ]);
  assert.equal(mock.state.uploadCalls, 0);
});

test("配置保存后必须回读，权限、重复键及跨表配置明确失败", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const settings = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: null,
    outputFieldId: "poster",
  };
  mock.settings.corruptReadback = true;
  await assert.rejects(repo.saveSettings(settings), { code: "PLATFORM_ERROR" });
  mock.settings.corruptReadback = false;
  mock.settings.readbackError = { code: 10214997, message: "forbidden" };
  await assert.rejects(repo.saveSettings(settings), { code: "PERMISSION_DENIED" });
  mock.settings.readbackError = undefined;
  await repo.saveSettings(settings);
  const original = structuredClone([...mock.settings.rows.values()][0]);
  mock.settings.rows.set("duplicate", original);
  repo.invalidate();
  await assert.rejects(repo.loadSettings("main"), { code: "INVALID_TEMPLATE" });
  await assert.rejects(repo.saveSettings(settings), { code: "INVALID_TEMPLATE" });
  mock.settings.rows.delete("duplicate");
  mock.settings.rows.set("row-1", {
    ...original,
    value: [{ type: "text", text: JSON.stringify({ ...settings, tableId: "other" }) }],
  });
  repo.invalidate();
  await assert.rejects(repo.loadSettings("main"), { code: "INVALID_TEMPLATE" });
});

test("上下文缓存隔离表与视图，选中行实时更新，TTL 和手动刷新生效", async () => {
  const mock = mockSdk();
  let now = 0;
  const repo = new FeishuPosterRepository({ ...mock, ttlMs: 50, now: () => now });
  const [first, second] = await Promise.all([repo.loadContext(), repo.loadContext()]);
  assert.equal(first.records.length, 3);
  assert.equal(second.records.length, 3);
  assert.equal(mock.main.pageCalls.length, 2);
  first.records[0].values.job = "caller mutation";
  mock.state.recordId = "r3";
  assert.equal((await repo.loadContext()).selectedRecordId, "r3");
  assert.equal((await repo.loadContext()).records[0].values.job, "设计助理");
  mock.state.viewId = "view-2";
  await repo.loadContext();
  assert.equal(mock.main.pageCalls.length, 4);
  mock.state.tableId = "other-table";
  await repo.loadContext();
  assert.equal(mock.main.pageCalls.length, 6);
  mock.state.tableId = "main";
  mock.state.viewId = "view-1";
  await repo.loadContext();
  assert.equal(mock.main.pageCalls.length, 6);
  now = 50;
  await repo.loadContext();
  assert.equal(mock.main.pageCalls.length, 8);
  repo.invalidate();
  await repo.loadContext();
  assert.equal(mock.main.pageCalls.length, 10);
});

test("模板和设置请求合并，保存自动失效，错误 Promise 不留缓存", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await repo.saveTemplate(bundle());
  const before = mock.templates.pageCalls.length;
  await Promise.all([repo.listTemplates(), repo.listTemplates()]);
  assert.equal(mock.templates.pageCalls.length, before + 1);
  const changed = bundle();
  changed.template.name = "更新名称";
  await repo.saveTemplate(changed);
  assert.equal((await repo.listTemplates())[0].name, "更新名称");
  await repo.saveSettings({
    schemaVersion: 1,
    tableId: "main",
    templateId: "a",
    outputFieldId: null,
  });
  const count = mock.settings.pageCalls.length;
  await Promise.all([repo.loadSettings("main"), repo.loadSettings("main")]);
  assert.equal(mock.settings.pageCalls.length, count + 1);
  await repo.loadSettings("different-table");
  assert.equal(mock.settings.pageCalls.length, count + 2);
  repo.invalidate();
  mock.state.fail = { code: 99991400 };
  await assert.rejects(repo.listTemplates(), { code: "PLATFORM_ERROR" });
  mock.state.fail = undefined;
  assert.equal((await repo.listTemplates()).length, 1);
});

test("在途上下文读取失效后，旧结果不会回填新一代缓存", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const original = mock.main.getRecordsByPage.bind(mock.main);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let blocked = false;
  mock.main.getRecordsByPage = async (options) => {
    const snapshot = await original(options);
    if (!blocked) {
      blocked = true;
      started();
      await gate;
    }
    return snapshot;
  };
  const stale = repo.loadContext();
  await entered;
  repo.invalidate();
  mock.main.rows.get("r1")!.job = "new-value";
  const fresh = repo.loadContext();
  release();
  assert.equal((await stale).records[0].values.job, "设计助理");
  assert.equal((await fresh).records[0].values.job, "new-value");
  assert.equal((await repo.loadContext()).records[0].values.job, "new-value");
  assert.equal(mock.main.pageCalls.length, 4);
});

test("素材缓存按 token 和 hash 复用，下载失败后可恢复", async () => {
  const mock = mockSdk();
  const writer = new FeishuPosterRepository(mock);
  await writer.saveTemplate(bundle("a"));
  await writer.saveTemplate(bundle("b"));
  let broken = true;
  const repo = new FeishuPosterRepository({
    ...mock,
    fetcher: (async (...args: Parameters<typeof fetch>) => {
      if (broken) throw new TypeError("CORS failure");
      return mock.fetcher(...args);
    }) as typeof fetch,
  });
  await assert.rejects(repo.loadTemplate("a"), { code: "PLATFORM_ERROR" });
  broken = false;
  await repo.loadTemplate("a");
  await repo.loadTemplate("b");
  assert.equal(mock.fetchUrls.length, 2);
  repo.invalidate();
  await repo.loadTemplate("b");
  assert.equal(mock.fetchUrls.length, 4);
});

test("SDK 初始化拒绝后允许显式重新调用，不永久缓存拒绝的 Promise", async () => {
  const mock = mockSdk();
  let attempts = 0;
  const repo = new FeishuPosterRepository({
    loadSdk: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary host error");
      return mock.sdk;
    },
  });
  await assert.rejects(repo.loadContext(), { code: "PLATFORM_ERROR" });
  assert.equal((await repo.loadContext()).tableId, "main");
  assert.equal(attempts, 2);
});

test("按字段 ID 读取直接保留 SDK 权限错误码", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  mock.templates.fieldError = { code: 10213997, message: "field forbidden" };
  await assert.rejects(
    repo.saveTemplate(bundle()),
    (error) =>
      error instanceof PlatformPosterError &&
      error.platformCode === "10213997" &&
      error.code === "PERMISSION_DENIED",
  );
  mock.main.fieldError = { code: 10213997, message: "field forbidden" };
  await assert.rejects(
    repo.writePng("r1", "poster", new File(["png"], "a.png", { type: "image/png" }), "main"),
    { code: "PERMISSION_DENIED" },
  );
});

test("空附件单元格为 null 时其他模板仍能保存，缺失素材给出领域错误", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await repo.saveTemplate(bundle("first"));
  mock.templates.rows.get("row-1")!.assets = null;
  await repo.saveTemplate(bundle("second"));
  assert.equal(mock.templates.rows.size, 2);
  assert.equal(mock.state.uploadCalls, 4);
  await assert.rejects(repo.loadTemplate("first"), { code: "INVALID_ASSET" });
  mock.templates.nullAttachments = true;
  await assert.rejects(
    repo.saveTemplate(bundle("third")),
    (error) => error instanceof Error && /素材校验失败/.test(error.message),
  );
});

test("附件下载 URL 严格使用同一快照的 token，后续单元格顺序变化不串素材", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await repo.saveTemplate(bundle());
  const original = mock.templates.getCellAttachmentUrls.bind(mock.templates);
  const expectedTokens = (mock.templates.rows.get("row-1")!.assets as SdkAttachment[]).map(
    (item) => item.token,
  );
  mock.templates.getCellAttachmentUrls = async (tokens, fieldId, recordId) => {
    (mock.templates.rows.get(recordId)![fieldId] as SdkAttachment[]).reverse();
    return original(tokens, fieldId, recordId);
  };
  const loaded = await repo.loadTemplate("template-1");
  assert.deepEqual(mock.templates.urlTokenCalls[0], expectedTokens);
  assert.equal(await loaded.assets[0].blob.text(), "picture-v1");
  assert.equal(await loaded.assets[1].blob.text(), "font-v1");
});

test("同 SDK 多实例整段写入串行，模板与配置不重复，上传没有并发", async () => {
  const mock = mockSdk();
  const first = new FeishuPosterRepository(mock);
  const second = new FeishuPosterRepository(mock);
  await Promise.all([first.saveTemplate(bundle()), second.saveTemplate(bundle())]);
  assert.equal(mock.templates.rows.size, 1);
  assert.equal(mock.state.maxUploads, 1);
  assert.equal(mock.state.uploadCalls, 2);
  const settings = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: "template-1",
    outputFieldId: "poster",
  };
  await Promise.all([first.saveSettings(settings), second.saveSettings(settings)]);
  assert.equal(mock.settings.rows.size, 1);
  assertSettings(await first.loadSettings("main"), settings);
});

test("同 SDK 任一实例保存后其他实例缓存失效，失败写入也不锁死队列", async () => {
  const mock = mockSdk();
  const first = new FeishuPosterRepository(mock);
  const second = new FeishuPosterRepository(mock);
  assert.deepEqual(await second.listTemplates(), []);
  assert.equal(await second.loadSettings("main"), null);
  await first.saveTemplate(bundle());
  assert.equal((await second.listTemplates()).length, 1);
  const settings = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: "template-1",
    outputFieldId: "poster",
  };
  await first.saveSettings(settings);
  assertSettings(await second.loadSettings("main"), settings);
  mock.main.writeError = { code: 10216997 };
  await assert.rejects(
    first.writePng("r1", "poster", new File(["png"], "a.png", { type: "image/png" }), "main"),
    { code: "WRITE_OUTCOME_UNKNOWN" },
  );
  mock.main.writeError = undefined;
  await second.writePng("r1", "poster", new File(["new"], "b.png", { type: "image/png" }), "main");
  assert.equal(mock.main.attachmentWrites.length, 1);
  first.dispose();
  second.dispose();
});

test("发起 PNG 写回时捕获 tableId，异步切表不改变目标", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const other = new MockTable("other", "另一张表", mock.main.fields);
  other.rows.set("r1", { job: "other-job", poster: [] });
  const getTable = mock.sdk.base.getTableById;
  mock.sdk.base.getTableById = async (id) => (id === "other" ? other : getTable(id));
  await repo.loadContext();
  const file = new File(["png"], "a.png", { type: "image/png" });
  const pending = repo.writePng("r1", "poster", file, "main");
  mock.state.tableId = "other";
  await pending;
  assert.equal(mock.main.attachmentWrites.length, 1);
  assert.equal(other.attachmentWrites.length, 0);
  await repo.writePng("r1", "poster", file, "other");
  assert.equal(other.attachmentWrites.length, 1);
});

test("Base 切换后上下文、模板列表、配置和素材缓存全部隔离", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  await repo.loadContext();
  await repo.saveTemplate(bundle());
  await repo.saveSettings({
    schemaVersion: 1,
    tableId: "main",
    templateId: "old-template",
    outputFieldId: "poster",
  });
  assert.equal((await repo.listTemplates())[0].name, "招聘模板");
  assert.equal((await repo.loadSettings("main"))!.templateId, "old-template");
  await repo.loadTemplate("template-1");
  const raw = mock.templates.rows.get("row-1")!.config as { type: string; text: string }[];
  const config = JSON.parse(raw[0].text);
  config.template.name = "另一 Base 的模板";
  raw[0].text = JSON.stringify(config);
  const setting = mock.settings.rows.get("row-1")!.value as { type: string; text: string }[];
  setting[0].text = JSON.stringify({
    schemaVersion: 1,
    tableId: "main",
    templateId: "new-template",
    outputFieldId: "new-poster",
  });
  mock.main.rows.get("r1")!.job = "另一 Base 的岗位";
  mock.state.baseId = "base-2";
  assert.equal((await repo.loadContext()).records[0].values.job, "另一 Base 的岗位");
  assert.equal((await repo.listTemplates())[0].name, "另一 Base 的模板");
  assert.equal((await repo.loadSettings("main"))!.templateId, "new-template");
  await repo.loadTemplate("template-1");
  assert.equal(mock.fetchUrls.length, 4);
});

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const JPEG_BYTES = new Uint8Array([255, 216, 255, 224, 2]);
function attach(
  mock: ReturnType<typeof mockSdk>,
  recordId: string,
  token: string,
  bytes = PNG_BYTES,
  fieldId = "background",
  type = "image/png",
) {
  const attachment: SdkAttachment = {
    token,
    name: "相同文件名.png",
    type,
    size: bytes.length,
    timeStamp: 1,
  };
  mock.uploads.set(token, new File([bytes], attachment.name, { type }));
  mock.main.rows.get(recordId)![fieldId] = [attachment];
  return attachment;
}

test("逐行底图读取真实单元格、PNG/JPEG 字节和 BLAKE2b ID，改名不改变内容 ID", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 17 });
  attach(mock, "r1", "row1");
  attach(mock, "r2", "row2", JPEG_BYTES, "background", "image/jpeg");
  const repo = new FeishuPosterRepository(mock);
  const [first, second] = await Promise.all([
    repo.loadBackground("r1", "background", "main"),
    repo.loadBackground("r2", "background", "main"),
  ]);
  assert.equal(first.id, `asset-${await hashBlob(new Blob([PNG_BYTES]))}`);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(new Uint8Array(await second.blob.arrayBuffer()), JPEG_BYTES);
  assert.equal(second.mimeType, "image/jpeg");
  assert.deepEqual(Object.keys(first).sort(), ["blob", "id", "mimeType", "name"]);
  assert.equal(mock.state.uploadCalls, 0);
  attach(mock, "r1", "renamed").name = "新名字.png";
  assert.equal((await repo.loadBackground("r1", "background", "main")).id, first.id);
});

test("Lookup 使用扁平附件值，URL 请求复用 token 快照，不调用附件字段接口", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "查找底图", type: 19 });
  attach(mock, "r1", "lookup-token");
  mock.main.fieldError = { code: 10213997 };
  const original = mock.main.getCellAttachmentUrls.bind(mock.main);
  mock.main.getCellAttachmentUrls = async (tokens, field, record) => {
    mock.main.rows.get(record)![field] = [];
    return original(tokens, field, record);
  };
  const repo = new FeishuPosterRepository(mock);
  assert.equal((await repo.loadContext()).fields.at(-1)?.kind, "lookup");
  assert.equal((await repo.loadBackground("r1", "background", "main")).mimeType, "image/png");
  assert.deepEqual(mock.main.urlTokenCalls[0], ["lookup-token"]);
});

test("空、多附件、非图片、文本 Lookup 与无效大小均明确拒绝且不下载", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 19 });
  const valid = attach(mock, "r1", "valid");
  const repo = new FeishuPosterRepository(mock);
  const values: unknown[] = [
    null,
    undefined,
    [],
    [valid, valid],
    [{ ...valid, type: "application/pdf" }],
    [{ ...valid, token: "" }],
    [{ ...valid, size: 0 }],
    [{ ...valid, size: MAX_ASSET_BYTES + 1 }],
    [{ type: "text", text: "不是图片" }],
    { value: [valid] },
  ];
  for (const value of values) {
    mock.main.rows.get("r1")!.background = value;
    await assert.rejects(repo.loadBackground("r1", "background", "main"), {
      code: "INVALID_ASSET",
    });
  }
  await assert.rejects(repo.loadBackground("r1", "job", "main"), { code: "INVALID_ASSET" });
  assert.equal(mock.fetchUrls.length, 0);
});

test("不同记录即使 token 相同也使用各自临时 URL，刷新和附件变化不会串行缓存", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 17 });
  attach(mock, "r1", "shared");
  attach(mock, "r2", "shared");
  const original = mock.main.getCellAttachmentUrls.bind(mock.main);
  mock.main.getCellAttachmentUrls = async (tokens, field, record) =>
    (await original(tokens, field, record)).map((url) => `${url}&record=${record}`);
  const repo = new FeishuPosterRepository(mock);
  await repo.loadBackground("r1", "background", "main");
  await repo.loadBackground("r2", "background", "main");
  assert.ok(mock.fetchUrls[0].includes("record=r1"));
  assert.ok(mock.fetchUrls[1].includes("record=r2"));
  await repo.loadBackground("r1", "background", "main");
  assert.equal(mock.fetchUrls.length, 2);
  assert.equal(mock.main.urlTokenCalls.length, 2);
  repo.invalidate();
  await repo.loadBackground("r1", "background", "main");
  assert.equal(mock.fetchUrls.length, 3);
  attach(mock, "r1", "replacement", JPEG_BYTES, "background", "image/jpeg");
  assert.equal((await repo.loadBackground("r1", "background", "main")).mimeType, "image/jpeg");
});

test("底图下载失败不吞错、不缓存拒绝，HTTP 和 SDK 错误码保留且队列可恢复", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 17 });
  attach(mock, "r1", "valid");
  let failure: unknown = { code: 99991400, message: "limited" };
  const repo = new FeishuPosterRepository({
    ...mock,
    fetcher: (async (...args: Parameters<typeof fetch>) => {
      if (failure) throw failure;
      return mock.fetcher(...args);
    }) as typeof fetch,
  });
  await assert.rejects(
    repo.loadBackground("r1", "background", "main"),
    (error) =>
      error instanceof PlatformPosterError && error.platformCode === "99991400" && error.retryable,
  );
  failure = undefined;
  await repo.loadBackground("r1", "background", "main");
  mock.main.readbackError = { code: 10214997 };
  await assert.rejects(
    repo.loadBackground("r1", "background", "main"),
    (error) =>
      error instanceof PlatformPosterError &&
      error.platformCode === "10214997" &&
      error.code === "PERMISSION_DENIED",
  );
  mock.main.readbackError = undefined;
  for (const status of [403, 404, 429, 500]) {
    const failed = new FeishuPosterRepository({
      ...mock,
      fetcher: (async () => new Response(null, { status })) as typeof fetch,
    });
    await assert.rejects(
      failed.loadBackground("r1", "background", "main"),
      (error) => error instanceof PlatformPosterError && error.platformCode === String(status),
    );
  }
  await repo.loadContext();
});

test("底图以魔数核验图片并限制声明与实际响应体 20MB，缺失 URL 可重试", async () => {
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 17 });
  attach(mock, "r1", "valid");
  for (const response of [
    new Response("伪 PNG", { headers: { "content-type": "image/png" } }),
    new Response(null),
    new Response(PNG_BYTES, { headers: { "content-length": String(MAX_ASSET_BYTES + 1) } }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_ASSET_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    ),
  ]) {
    const repo = new FeishuPosterRepository({
      ...mock,
      fetcher: (async () => response) as typeof fetch,
    });
    await assert.rejects(repo.loadBackground("r1", "background", "main"), {
      code: "INVALID_ASSET",
    });
  }
  const original = mock.main.getCellAttachmentUrls.bind(mock.main);
  mock.main.getCellAttachmentUrls = async () => [];
  const repo = new FeishuPosterRepository(mock);
  await assert.rejects(repo.loadBackground("r1", "background", "main"), { code: "INVALID_ASSET" });
  mock.main.getCellAttachmentUrls = original;
  await repo.loadBackground("r1", "background", "main");
});

test("底图响应体超时 20 秒中止下载并释放串行队列", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = mockSdk();
  mock.main.fields.push({ id: "background", name: "底图", type: 17 });
  attach(mock, "r1", "valid");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  const repo = new FeishuPosterRepository({
    ...mock,
    fetcher: (async (_url, init) => {
      signal = init?.signal ?? undefined;
      const stream = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      entered();
      return new Response(stream);
    }) as typeof fetch,
  });
  const pending = repo.loadBackground("r1", "background", "main");
  await started;
  context.mock.timers.tick(BACKGROUND_TIMEOUT_MS - 1);
  assert.equal(signal?.aborted, false);
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof PlatformPosterError && error.platformCode === "TIMEOUT",
  );
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
  await repo.loadContext();
});

function sourceFixture() {
  const mock = mockSdk();
  const source = new MockTable("source", "模板表", [
    { id: "title", name: "海报类型", type: 1 },
    { id: "image", name: "模板底图", type: 17 },
  ]);
  const attachment: SdkAttachment = {
    token: "source-image",
    name: "相同文件名.png",
    type: "image/png",
    size: PNG_BYTES.length,
    timeStamp: 1,
  };
  mock.uploads.set(attachment.token, new File([PNG_BYTES], attachment.name, { type: "image/png" }));
  source.rows.set("s1", { title: "正编业代", image: [attachment], untouched: "原业务数据" });
  // 数据表用查找引用定位模板行，被引用字段是模板表的文本键，不是附件。
  mock.main.fields.push({
    id: "posterType",
    name: "海报类型",
    type: 19,
    property: { refTableId: source.id, refFieldId: "title" },
  });
  mock.main.rows.get("r1")!.posterType = [{ text: "正编业代" }];
  const original = mock.sdk.base.getTableById;
  mock.sdk.base.getTableById = async (id) => (id === source.id ? source : original(id));
  return { ...mock, source, attachment };
}

test("查找引用值唯一定位模板行，底图来自模板行附件，预览不建字段", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  const source = await repo.getTemplateSource("r1", "posterType", "main", "image");
  assert.deepEqual(source, {
    tableId: "source",
    tableName: "模板表",
    recordId: "s1",
    recordName: "正编业代",
    backgroundFieldId: "image",
  });
  assert.deepEqual(await repo.loadTemplateRecord(source), {
    fields: [
      { id: "title", name: "海报类型", kind: "text", isPrimary: undefined },
      { id: "image", name: "模板底图", kind: "attachment", isPrimary: undefined },
    ],
    values: { title: "正编业代" },
  });
  assert.equal(await repo.loadSourceTemplate(source), null);
  assert.equal(mock.source.addedFields.length, 0);
  assert.equal(mock.state.uploadCalls, 0);
  assert.equal(mock.state.tableExists, false);
});

test("模板定位零匹配、多行同键、空引用值、缺少元数据与错误字段均不猜测", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  mock.source.rows.set("duplicate", { title: "正编业代", image: [] });
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  mock.source.rows.delete("duplicate");
  mock.source.rows.clear();
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  monkeypatchRecordValue(mock, "r1", "posterType", []);
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  monkeypatchRecordValue(mock, "r1", "posterType", [{ text: "正编业代" }, { text: "销售主管" }]);
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  monkeypatchRecordValue(mock, "r1", "posterType", [{ text: "正编业代" }]);
  const field = mock.main.fields.find((item) => item.id === "posterType")!;
  field.property = undefined;
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  field.property = { refTableId: "source", refFieldId: "missing" };
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "image"), {
    code: "INVALID_TEMPLATE",
  });
  field.property = { refTableId: "source", refFieldId: "title" };
  // 模板底图字段必须是模板表的附件字段。
  await assert.rejects(repo.getTemplateSource("r1", "posterType", "main", "title"), {
    code: "INVALID_ASSET",
  });
  assert.equal(mock.source.setRecordCalls.length, 0);
});

/** MockTable 的记录是普通对象，这里只替换定位字段的值以便覆盖多值与空值分支。 */
function monkeypatchRecordValue(
  mock: ReturnType<typeof sourceFixture>,
  recordId: string,
  fieldId: string,
  value: unknown,
) {
  mock.main.rows.get(recordId)![fieldId] = value;
}

test("来源配置仅显式保存时创建字段、上传字体，来源业务字段和底图保持原值且可重开恢复", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  const source = await repo.getTemplateSource("r1", "posterType", "main", "image");
  const expected = bundle();
  expected.template.backgroundFieldId = "image";
  await repo.saveSourceTemplate(source, expected);
  assert.deepEqual(
    mock.source.addedFields.map((field) => [field.name, field.type]),
    [
      [SOURCE_CONFIG_FIELD, 1],
      [SOURCE_FONT_FIELD, 17],
    ],
  );
  assert.equal(mock.state.uploadCalls, 1);
  assert.equal(mock.source.rows.get("s1")!.untouched, "原业务数据");
  assert.deepEqual(mock.source.rows.get("s1")!.image, [mock.attachment]);
  const configField = mock.source.fields.find((field) => field.name === SOURCE_CONFIG_FIELD)!.id;
  const fontField = mock.source.fields.find((field) => field.name === SOURCE_FONT_FIELD)!.id;
  assert.deepEqual(
    Object.keys(mock.source.setRecordCalls[0].value.fields).sort(),
    [configField, fontField].sort(),
  );
  const config = JSON.parse(
    (mock.source.rows.get("s1")![configField] as { text: string }[])[0].text,
  );
  assert.deepEqual(
    config.assets.map((asset: { id: string }) => asset.id),
    ["font"],
  );
  assert.ok(!JSON.stringify(config).includes("https://"));
  assert.ok(!JSON.stringify(config).includes("source-image"));
  const reopened = new FeishuPosterRepository(mock);
  const recordReads = mock.source.recordReads;
  const loaded = (await reopened.loadSourceTemplate(source))!;
  assert.equal(mock.source.recordReads, recordReads + 1);
  assert.equal(loaded.template.backgroundFieldId, "image");
  assert.equal(loaded.template.backgroundId, `asset-${await hashBlob(new Blob([PNG_BYTES]))}`);
  assert.equal(await loaded.assets.find((asset) => asset.id === "font")!.blob.text(), "font-v1");
  const urlReads = mock.source.urlGeneration;
  const again = (await reopened.loadSourceTemplate(source))!;
  assert.equal(mock.source.urlGeneration, urlReads);
  assert.strictEqual(
    again.assets.find((asset) => asset.id === "font")!.blob,
    loaded.assets.find((asset) => asset.id === "font")!.blob,
  );
  await reopened.saveSourceTemplate(source, expected);
  assert.equal(mock.state.uploadCalls, 1);
  assert.equal(mock.source.addedFields.length, 2);
  const next = {
    ...mock.attachment,
    token: "next-image",
    type: "image/jpeg",
    size: JPEG_BYTES.length,
  };
  mock.source.rows.get("s1")!.image = [next];
  mock.uploads.set(next.token, new File([JPEG_BYTES], "next.jpg"));
  assert.equal((await reopened.loadSourceTemplate(source))!.assets[0].mimeType, "image/jpeg");
  assert.equal(mock.state.tableExists, false);
});

test("来源字段类型冲突、字体缺失/损坏、写入拒绝和错误回读均明确失败", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  const source = await repo.getTemplateSource("r1", "posterType", "main", "image");
  mock.source.fields.push({ id: "bad-config", name: SOURCE_CONFIG_FIELD, type: 17 });
  await assert.rejects(repo.saveSourceTemplate(source, bundle()), { code: "INVALID_TEMPLATE" });
  mock.source.fields.pop();
  mock.source.fields.push({ id: "bad-font", name: SOURCE_FONT_FIELD, type: 1 });
  await assert.rejects(repo.saveSourceTemplate(source, bundle()), { code: "INVALID_TEMPLATE" });
  mock.source.fields.pop();
  await assert.rejects(repo.saveSourceTemplate(source, bundle(), 1000), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(mock.source.addedFields.length, 0);
  mock.source.fieldError = { code: 10213997 };
  await assert.rejects(repo.saveSourceTemplate(source, bundle()), { code: "PERMISSION_DENIED" });
  mock.source.fieldError = undefined;
  await repo.saveSourceTemplate(source, bundle());
  const fontField = mock.source.fields.find((field) => field.name === SOURCE_FONT_FIELD)!.id;
  const fonts = structuredClone(mock.source.rows.get("s1")![fontField] as SdkAttachment[]);
  mock.source.rows.get("s1")![fontField] = [];
  await assert.rejects(repo.loadSourceTemplate(source), { code: "INVALID_ASSET" });
  mock.source.rows.get("s1")![fontField] = fonts;
  mock.uploads.set(fonts[0].token, new File(["corrupted"], "font.otf"));
  await assert.rejects(repo.loadSourceTemplate(source), { code: "INVALID_ASSET" });
  mock.source.writeError = { code: 10214997 };
  await assert.rejects(repo.saveSourceTemplate(source, bundle()), { code: "PERMISSION_DENIED" });
  mock.source.writeError = undefined;
  const original = mock.source.getRecordById.bind(mock.source);
  let count = 0;
  mock.source.getRecordById = async (id) => {
    const record = await original(id);
    if (++count === 2) record.fields[fontField] = [];
    return record;
  };
  await assert.rejects(repo.saveSourceTemplate(source, bundle()), { code: "PLATFORM_ERROR" });
});

test("来源分页快照跨逐行 PNG 输出复用，显式保存、刷新与 Base 切换重新扫描", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  mock.main.rows.get("r2")!.posterType = [{ text: "正编业代" }];
  mock.source.rows.set("other-1", { title: "其他记录", image: [] });
  mock.source.rows.set("other-2", { title: "另一页记录", image: [] });
  await repo.loadContext();
  const first = await repo.getTemplateSource("r1", "posterType", "main", "image");
  assert.equal(mock.source.pageCalls.length, 2);
  await repo.writePng("r1", "poster", new File(["png"], "a.png", { type: "image/png" }), "main");
  await repo.getTemplateSource("r2", "posterType", "main", "image");
  await repo.writePng("r2", "poster", new File(["png"], "b.png", { type: "image/png" }), "main");
  await repo.getTemplateSource("r1", "posterType", "main", "image");
  assert.equal(mock.source.pageCalls.length, 2);
  await repo.saveSourceTemplate(first, bundle());
  await repo.getTemplateSource("r1", "posterType", "main", "image");
  assert.equal(mock.source.pageCalls.length, 4);
  repo.invalidate();
  await repo.getTemplateSource("r1", "posterType", "main", "image");
  assert.equal(mock.source.pageCalls.length, 6);
  mock.source.rows.get("s1")!.title = "另一 Base 的来源";
  mock.main.rows.get("r1")!.posterType = [{ text: "另一 Base 的来源" }];
  mock.state.baseId = "base-2";
  await repo.loadContext();
  assert.equal(
    (await repo.getTemplateSource("r1", "posterType", "main", "image")).recordName,
    "另一 Base 的来源",
  );
  assert.equal(mock.source.pageCalls.length, 8);
});

test("业务表列表排除内置配置和模板表，启动读取不创建存储", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  assert.deepEqual(await repo.listTables(), [{ id: "main", name: mock.main.name }]);
  assert.equal(mock.state.settingsExist, false);
  assert.equal(mock.state.tableExists, false);
  assert.equal(mock.state.selectionCalls, 0);
  mock.state.settingsExist = true;
  mock.state.tableExists = true;
  const tables = await repo.listTables();
  tables[0].name = "副本";
  assert.deepEqual(await repo.listTables(), [{ id: "main", name: mock.main.name }]);
});

test("显式业务表按实际 ID 隔离相同字段和记录 ID，不借用其他表的视图或选择行", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const other = new MockTable("other", "另一个业务表", structuredClone(mock.main.fields));
  other.rows.set("r1", { job: "另一表第一岗位" });
  other.rows.set("r2", { job: "另一表第二岗位" });
  other.rows.set("r3", { job: "另一表第三岗位" });
  const originalGetTable = mock.sdk.base.getTableById;
  const requested: string[] = [];
  mock.sdk.base.getTableById = async (id) => {
    requested.push(id);
    return id === "other" ? other : originalGetTable(id);
  };
  // 宿主选中 main/r2，显式 other 不得拿同名 r2 当作选中行。
  const explicit = await repo.loadContext("other");
  assert.equal(explicit.tableId, "other");
  assert.equal(explicit.tableName, other.name);
  assert.equal(explicit.selectedRecordId, "r1");
  assert.equal(explicit.records[0].values.job, "另一表第一岗位");
  assert.equal(explicit.records.length, 3);
  assert.deepEqual(other.pageCalls, [{ pageSize: 200 }, { pageSize: 200, pageToken: 2 }]);
  const main = await repo.loadContext("main");
  assert.equal(main.records[0].values.job, "设计助理");
  assert.equal(main.selectedRecordId, "r2");
  assert.deepEqual((await repo.loadContext("other")).records, explicit.records);
  assert.equal(other.pageCalls.length, 2);
  assert.deepEqual(requested, ["other", "main"]);
  mock.state.tableId = "other";
  mock.state.recordId = "r2";
  // 显式表与宿主当前表相同时采纳宿主视图，视图不同即新的读取范围。
  const sameTable = await repo.loadContext("other");
  assert.equal(sameTable.selectedRecordId, "r2");
  assert.equal(sameTable.viewId, "view-1");
  assert.equal(other.pageCalls.length, 4);
  // 视图清空后不依赖视图，切换 Base 后原上下文缓存必须失效。
  mock.state.viewId = "";
  mock.state.baseId = "base-2";
  other.rows.get("r1")!.job = "新 Base 岗位";
  const refreshed = await repo.loadContext("other");
  assert.equal(refreshed.records[0].values.job, "新 Base 岗位");
  assert.equal(refreshed.viewId, undefined);
  assert.equal(other.pageCalls.length, 6);
  await assert.rejects(repo.loadContext(), { code: "PLATFORM_ERROR" });
});

test("配置初始化返回回读的表 ID 和名称，多仓储并发只创建一次且再次复用", async () => {
  const mock = mockSdk();
  const first = new FeishuPosterRepository(mock);
  const second = new FeishuPosterRepository(mock);
  const addTable = mock.sdk.base.addTable;
  let calls = 0;
  mock.sdk.base.addTable = async (config) => {
    calls++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return addTable(config);
  };
  const results = await Promise.all([first.initializeStorage(), second.initializeStorage()]);
  assert.deepEqual(results, [
    { tableId: "settings", name: SETTINGS_TABLE_NAME, created: true },
    { tableId: "settings", name: SETTINGS_TABLE_NAME, created: false },
  ]);
  assert.equal(calls, 1);
  assert.equal(mock.state.tableExists, false);
  assert.deepEqual(await first.initializeStorage(), results[1]);
  assert.equal(calls, 1);
  assert.equal(mock.settings.rows.size, 0);
});

test("配置初始化在权限拒绝、无有效 ID、字段类型错误或回读失败时拒绝成功", async () => {
  const mock = mockSdk();
  const repo = new FeishuPosterRepository(mock);
  const addTable = mock.sdk.base.addTable;
  mock.sdk.base.addTable = async () => {
    throw { code: 10213997, message: "无建表权限" };
  };
  await assert.rejects(
    repo.initializeStorage(),
    (error) =>
      error instanceof PlatformPosterError &&
      error.code === "PERMISSION_DENIED" &&
      error.platformCode === "10213997",
  );
  assert.equal(mock.state.settingsExist, false);
  mock.sdk.base.addTable = async () => ({ tableId: "", index: 1 });
  await assert.rejects(repo.initializeStorage(), { code: "PLATFORM_ERROR" });
  mock.sdk.base.addTable = addTable;
  mock.settings.fields[1].type = 17;
  await assert.rejects(repo.initializeStorage(), { code: "INVALID_TEMPLATE" });
  // 无效的已有表同样拒绝复用，不能以存在同名表为由宣告就绪。
  await assert.rejects(repo.initializeStorage(), { code: "INVALID_TEMPLATE" });
  mock.settings.fields[1].type = 1;
  const getName = mock.settings.getName;
  mock.settings.getName = async () => {
    throw { code: 10213997, message: "无读表权限" };
  };
  await assert.rejects(repo.initializeStorage(), { code: "PERMISSION_DENIED" });
  mock.settings.getName = getName;
  assert.deepEqual(await repo.initializeStorage(), {
    tableId: "settings",
    name: SETTINGS_TABLE_NAME,
    created: false,
  });
});

function storageFixture() {
  const mock = mockSdk();
  const custom = new MockTable("custom-settings", "自建插件配置", []);
  const getTable = mock.sdk.base.getTableById;
  const getTables = mock.sdk.base.getTableMetaList;
  mock.sdk.base.getTableById = async (id) => (id === custom.id ? custom : getTable(id));
  mock.sdk.base.getTableMetaList = async () => [
    ...(await getTables()),
    { id: custom.id, name: custom.name },
  ];
  const addTable = mock.sdk.base.addTable;
  let tableCreations = 0;
  mock.sdk.base.addTable = async (config) => {
    tableCreations++;
    return addTable(config);
  };
  return { ...mock, custom, tableCreations: () => tableCreations };
}

function bindingFixture() {
  const mock = storageFixture();
  const data = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: string[] = [];
  const bridge: NonNullable<FeishuSdkFacade["bridge"]> = {
    getData: async <T>(key: string) => {
      reads.push(key);
      return structuredClone(data.get(key)) as T;
    },
    setData: async <T>(key: string, value: T) => {
      writes.push(key);
      data.set(key, structuredClone(value));
      return true;
    },
  };
  mock.sdk.bridge = bridge;
  return { ...mock, data, reads, writes, bridge };
}

test("bridge 仅保存连接指针，仓储重建和选中表改变后仍恢复同一绑定", async () => {
  const mock = bindingFixture();
  const repo = new FeishuPosterRepository(mock);
  const key = "recruitment-poster:workspace:v1:base-1";
  assert.equal(await repo.loadWorkspaceBinding(), null);
  mock.data.set(key, null);
  assert.equal(await repo.loadWorkspaceBinding(), null);
  const expected: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "main",
    storageTableId: mock.custom.id,
  };
  const input = { ...expected, extra: "不应持久化" };
  const saving = repo.saveWorkspaceBinding(input);
  input.tableId = "changed";
  await saving;
  assert.deepEqual(mock.data.get(key), expected);
  repo.dispose();
  mock.state.tableId = "another-selected-table";
  const reopened = new FeishuPosterRepository(mock);
  const copy = (await reopened.loadWorkspaceBinding())!;
  copy.storageTableId = "changed";
  assert.deepEqual(await reopened.loadWorkspaceBinding(), expected);
  assert.deepEqual(mock.writes, [key]);
  assert.ok(mock.reads.every((value) => value === key));
  assert.equal(mock.tableCreations(), 0);
  assert.equal(mock.custom.rows.size, 0);
  assert.equal(mock.settings.rows.size, 0);
  assert.equal(mock.state.tableExists, false);
  reopened.dispose();
});

test("bridge 绑定按 Base 隔离，切换回原 Base 恢复原指针", async () => {
  const mock = bindingFixture();
  const repo = new FeishuPosterRepository(mock);
  const a: WorkspaceBinding = { schemaVersion: 1, tableId: "main", storageTableId: mock.custom.id };
  const b: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "other",
    storageTableId: "other-storage",
  };
  await repo.saveWorkspaceBinding(a);
  mock.state.baseId = "base-2";
  assert.equal(await repo.loadWorkspaceBinding(), null);
  await repo.saveWorkspaceBinding(b);
  assert.deepEqual(await repo.loadWorkspaceBinding(), b);
  mock.state.baseId = "base-1";
  assert.deepEqual(await repo.loadWorkspaceBinding(), a);
  assert.deepEqual(
    [...mock.data.keys()],
    ["recruitment-poster:workspace:v1:base-1", "recruitment-poster:workspace:v1:base-2"],
  );
  assert.equal(mock.tableCreations(), 0);
  repo.dispose();
});

test("bridge 保存 false、回读不一致和权限异常均明确失败，平台 code 保留", async () => {
  const mock = bindingFixture();
  const repo = new FeishuPosterRepository(mock);
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "main",
    storageTableId: mock.custom.id,
  };
  mock.bridge.setData = async () => false;
  await assert.rejects(repo.saveWorkspaceBinding(binding), { code: "PLATFORM_ERROR" });
  assert.equal(mock.reads.length, 0);
  mock.bridge.setData = async () => true;
  mock.data.set("recruitment-poster:workspace:v1:base-1", { ...binding, tableId: "wrong" });
  await assert.rejects(repo.saveWorkspaceBinding(binding), { code: "PLATFORM_ERROR" });
  const permissionError = { code: 10214997, message: "禁止持久化" };
  mock.bridge.setData = async () => {
    throw permissionError;
  };
  await assert.rejects(
    repo.saveWorkspaceBinding(binding),
    (error) =>
      error instanceof PlatformPosterError &&
      error.code === "PERMISSION_DENIED" &&
      error.platformCode === "10214997" &&
      error.cause === permissionError,
  );
  mock.bridge.getData = async () => {
    throw { code: 99991400, message: "访问受限" };
  };
  await assert.rejects(
    repo.loadWorkspaceBinding(),
    (error) =>
      error instanceof PlatformPosterError && error.platformCode === "99991400" && error.retryable,
  );
  assert.equal(mock.tableCreations(), 0);
  assert.equal(mock.settings.rows.size, 0);
  repo.dispose();
});

test("bridge 坏值、缺 Base ID 或无 bridge 明确报错，不按名称查表或新建", async () => {
  const mock = bindingFixture();
  const repo = new FeishuPosterRepository(mock);
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "main",
    storageTableId: mock.custom.id,
  };
  mock.sdk.base.getTableMetaList = async () => {
    assert.fail("绑定操作不应扫描表元数据");
  };
  for (const value of [
    false,
    "{}",
    [],
    {},
    { ...binding, schemaVersion: 2 },
    { ...binding, tableId: "" },
    { ...binding, storageTableId: "  " },
    { ...binding, storageTableId: 1 },
  ]) {
    mock.data.set("recruitment-poster:workspace:v1:base-1", value);
    if (
      value === "{}" ||
      (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    )
      assert.equal(await repo.loadWorkspaceBinding(), null);
    else await assert.rejects(repo.loadWorkspaceBinding(), { code: "INVALID_TEMPLATE" });
    await assert.rejects(repo.saveWorkspaceBinding(value as WorkspaceBinding), {
      code: "INVALID_TEMPLATE",
    });
  }
  assert.equal(mock.writes.length, 0);
  for (const baseId of [null, undefined, "", "  "]) {
    mock.state.baseId = baseId as never;
    await assert.rejects(repo.loadWorkspaceBinding(), { code: "PLATFORM_ERROR" });
    await assert.rejects(repo.saveWorkspaceBinding(binding), { code: "PLATFORM_ERROR" });
  }
  mock.state.baseId = "base-1";
  delete mock.sdk.bridge;
  await assert.rejects(repo.loadWorkspaceBinding(), { code: "PLATFORM_ERROR" });
  await assert.rejects(repo.saveWorkspaceBinding(binding), { code: "PLATFORM_ERROR" });
  assert.equal(mock.tableCreations(), 0);
  repo.dispose();
});

test("恢复固定表指针后反复初始化和配置读写只更新原业务键，不增加行或新建表", async () => {
  const mock = bindingFixture();
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "main",
    storageTableId: mock.custom.id,
  };
  const first = new FeishuPosterRepository(mock);
  await first.initializeStorage(binding.storageTableId);
  const settings = {
    schemaVersion: 1 as const,
    tableId: binding.tableId,
    templateId: null,
    outputFieldId: "poster",
  };
  await first.saveSettings(settings);
  await first.saveWorkspaceBinding(binding);
  const originalRowId = [...mock.custom.rows.keys()][0];
  first.dispose();
  for (let i = 0; i < 3; i++) {
    const repo = new FeishuPosterRepository(mock);
    const restored = (await repo.loadWorkspaceBinding())!;
    assert.deepEqual(restored, binding);
    for (let j = 0; j < 2; j++) {
      assert.equal((await repo.initializeStorage(restored.storageTableId)).created, false);
      assertSettings(await repo.loadSettings(restored.tableId), settings);
      await repo.saveSettings(settings);
      assert.deepEqual([...mock.custom.rows.keys()], [originalRowId]);
    }
    repo.dispose();
  }
  assert.equal(mock.custom.setRecordCalls.length, 6);
  assert.equal(mock.settings.rows.size, 0);
  assert.equal(mock.tableCreations(), 0);
  assert.equal(mock.state.settingsExist, false);
  assert.equal(mock.state.tableExists, false);
});

test("配置表列表包含自建表与现有招聘海报配置，读取列表不新建表", async () => {
  const mock = storageFixture();
  const repo = new FeishuPosterRepository(mock);
  mock.state.settingsExist = true;
  mock.state.tableExists = true;
  assert.deepEqual(await repo.listStorageTables(), [
    { id: "main", name: mock.main.name },
    { id: "settings", name: SETTINGS_TABLE_NAME },
    { id: mock.custom.id, name: mock.custom.name },
  ]);
  assert.equal(mock.tableCreations(), 0);
});

test("同 SDK 并发复用已有空自建表只补两列，不新建表或修改业务字段", async () => {
  const mock = storageFixture();
  mock.custom.fields.push({ id: "business", name: "业务字段", type: 2 });
  mock.custom.rows.set("original", { business: 42 });
  const first = new FeishuPosterRepository(mock);
  const second = new FeishuPosterRepository(mock);
  const expected = { tableId: mock.custom.id, name: mock.custom.name, created: false };
  assert.deepEqual(
    await Promise.all([
      first.initializeStorage(mock.custom.id),
      second.initializeStorage(mock.custom.id),
    ]),
    [expected, expected],
  );
  assert.deepEqual(mock.custom.addedFields, [
    { name: "配置键", type: 1 },
    { name: "配置值", type: 1 },
  ]);
  assert.deepEqual(mock.custom.fields[0], { id: "business", name: "业务字段", type: 2 });
  assert.deepEqual([...mock.custom.rows], [["original", { business: 42 }]]);
  assert.equal(mock.tableCreations(), 0);
});

test("配置读写按所选存储表隔离，改选清除缓存，再选回恢复原配置", async () => {
  const mock = storageFixture();
  const repo = new FeishuPosterRepository(mock);
  const defaults = new FeishuPosterRepository(mock);
  const value = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: "default",
    outputFieldId: "poster",
  };
  await defaults.initializeStorage();
  await defaults.saveSettings(value);
  const before = structuredClone([...mock.settings.rows]);
  await repo.initializeStorage(mock.custom.id);
  assert.equal(await repo.loadSettings("main"), null);
  await repo.saveSettings({ ...value, templateId: "custom" });
  assert.equal((await repo.loadSettings("main"))!.templateId, "custom");
  assert.deepEqual([...mock.settings.rows], before);
  assertSettings(await defaults.loadSettings("main"), value);
  await repo.initializeStorage("settings");
  assertSettings(await repo.loadSettings("main"), value);
  await repo.saveSettings({ ...value, templateId: "updated-default" });
  await repo.initializeStorage(mock.custom.id);
  assert.equal((await repo.loadSettings("main"))!.templateId, "custom");
  assert.equal(mock.tableCreations(), 1);
});

test("自建表只补缺失列，字段类型错误或权限拒绝均失败且不回退建表", async () => {
  const mock = storageFixture();
  const repo = new FeishuPosterRepository(mock);
  // 即使配置键缺失，也必须先发现配置值类型冲突，不能先改表再失败。
  mock.custom.fields.push({ id: "wrong", name: "配置值", type: 2 });
  await assert.rejects(
    repo.initializeStorage(mock.custom.id),
    (error) => error instanceof Error && /配置值.*类型不正确/.test(error.message),
  );
  assert.equal(mock.custom.addedFields.length, 0);
  mock.custom.fields[0].type = 1;
  mock.custom.fieldError = { code: 10213997, message: "禁止创建字段" };
  await assert.rejects(
    repo.initializeStorage(mock.custom.id),
    (error) =>
      error instanceof PlatformPosterError &&
      error.code === "PERMISSION_DENIED" &&
      error.platformCode === "10213997",
  );
  mock.custom.fieldError = undefined;
  await repo.initializeStorage(mock.custom.id);
  assert.deepEqual(mock.custom.addedFields, [{ name: "配置键", type: 1 }]);
  assert.equal(mock.tableCreations(), 0);
});

test("选中配置表被删除或失去权限时读写失败，不访问默认表或另建表", async () => {
  const mock = storageFixture();
  const repo = new FeishuPosterRepository(mock);
  await repo.initializeStorage(mock.custom.id);
  const value = {
    schemaVersion: 1 as const,
    tableId: "main",
    templateId: null,
    outputFieldId: "poster",
  };
  await repo.saveSettings(value);
  const getTable = mock.sdk.base.getTableById;
  const requested: string[] = [];
  let failure = { code: 10212997, message: "配置表无权限" };
  mock.sdk.base.getTableById = async (id) => {
    requested.push(id);
    if (id === mock.custom.id) throw failure;
    return getTable(id);
  };
  for (const code of [10212997, 10212998]) {
    failure = { code, message: "配置表不可访问" };
    repo.invalidate();
    await assert.rejects(
      repo.loadSettings("main"),
      (error) => error instanceof PlatformPosterError && error.platformCode === String(code),
    );
    await assert.rejects(
      repo.saveSettings(value),
      (error) => error instanceof PlatformPosterError && error.platformCode === String(code),
    );
    await assert.rejects(
      repo.initializeStorage(mock.custom.id),
      (error) => error instanceof PlatformPosterError && error.platformCode === String(code),
    );
  }
  assert.deepEqual(requested, Array(6).fill(mock.custom.id));
  assert.equal(mock.tableCreations(), 0);
  assert.equal(mock.settings.rows.size, 0);
});

test("宿主空绑定不阻断首次连接，JSON 文本绑定可恢复并验证保存回读", async () => {
  const mock = bindingFixture();
  const repo = new FeishuPosterRepository(mock);
  const key = "recruitment-poster:workspace:v1:base-1";
  for (const empty of [undefined, null, "", {}, "{}"]) {
    mock.data.set(key, empty);
    assert.equal(await repo.loadWorkspaceBinding(), null);
  }
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    tableId: "main",
    storageTableId: mock.custom.id,
  };
  mock.data.set(key, JSON.stringify(binding));
  assert.deepEqual(await repo.loadWorkspaceBinding(), binding);
  mock.bridge.getData = async <T>(key: string) => JSON.stringify(mock.data.get(key)) as T;
  await repo.saveWorkspaceBinding(binding);
  assert.equal(mock.tableCreations(), 0);
  repo.dispose();
});

test("模板页按行列出模板表：只取主字段文本并标记是否已配置", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  assert.deepEqual(await repo.listTemplateRows("source", "image"), [
    { recordId: "s1", label: "正编业代", configured: false },
  ]);
  // 底图字段不是附件时快速失败，不返回误导性列表。
  await assert.rejects(repo.listTemplateRows("source", "title"), { code: "INVALID_ASSET" });
  const source = await repo.getTemplateSourceByRow("source", "s1", "image");
  assert.deepEqual(source, {
    tableId: "source",
    tableName: "模板表",
    recordId: "s1",
    recordName: "正编业代",
    backgroundFieldId: "image",
  });
  await assert.rejects(repo.getTemplateSourceByRow("source", "missing", "image"), {
    code: "PLATFORM_ERROR",
  });
});

test("未保存配置的模板行也读附件字段里的真实底图", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  const source = await repo.getTemplateSourceByRow("source", "s1", "image");
  // 该行还没有保存过配置，但底图仍必须来自模板行的附件字段。
  assert.equal(await repo.loadSourceTemplate(source), null);
  const asset = await repo.loadSourceBackground(source);
  assert.equal(asset.name, "相同文件名.png");
  assert.equal(asset.mimeType, "image/png");
  assert.deepEqual(new Uint8Array(await asset.blob.arrayBuffer()), PNG_BYTES);
  // 附件为空时快速失败，让用户补齐，不静默回落到示例底图。
  mock.source.rows.set("s1", { title: "正编业代", image: [] });
  await assert.rejects(repo.loadSourceBackground(source), { code: "INVALID_ASSET" });
});

test("模板行保存配置后列表标记为已配置，坏配置只标该行未配置", async () => {
  const mock = sourceFixture();
  const repo = new FeishuPosterRepository(mock);
  const source = await repo.getTemplateSourceByRow("source", "s1", "image");
  await repo.saveSourceTemplate(source, { ...bundle(), template: { ...bundle().template } });
  const configField = mock.source.fields.find((field) => field.name === SOURCE_CONFIG_FIELD)!.id;
  mock.source.rows.set("s2", {
    title: "坏配置行",
    image: [],
    [configField]: [{ type: "text", text: "{不是 JSON" }],
  });
  assert.deepEqual(
    await repo
      .listTemplateRows("source", "image")
      .then((rows) => rows.map((row) => [row.label, row.configured])),
    [
      ["正编业代", true],
      ["坏配置行", false],
    ],
  );
});
