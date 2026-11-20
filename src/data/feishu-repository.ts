import {
  PosterError,
  type OutputAttachment,
  type OutputFile,
  type PosterAsset,
  type PosterRepository,
  type RecordPage,
  type StorageStatus,
  type TableSummary,
  type TemplateBundle,
  type TemplateRecordValues,
  type TemplateRowSummary,
  type TemplateSource,
  type TemplateSummary,
  type WorkspaceBinding,
  type WorkspaceContext,
  type WorkspaceSettings,
} from "../domain/types";
import { hashBlob, MAX_ASSET_BYTES } from "./assets";
import { downloadAttachment, downloadBackground } from "./background-attachment";
import { platformError } from "./errors";
import { normalizeSettings, normalizeWorkspaceBinding, validateBundle } from "./validation";
import { RequestCache, type RequestCacheOptions } from "./request-cache";
import { assertRevisionUnchanged, nextRevision } from "./revisions";
import type { IAddTableConfig, IAttachmentField } from "@lark-base-open/js-sdk";
import { backgroundAttachment, cellText, FIELD_TYPES, lookupKey, richText } from "./feishu/values";
import { parseConfig, type SavedAsset, type SavedConfig } from "./feishu/config";
import {
  readAllRecords,
  readRecordPage,
  recordLabel,
  toDataRecord,
  toTableField,
} from "./feishu/records";
import { outputField, readFeishuOutputVersion, writeFeishuPng } from "./feishu/output";
import type {
  FeishuSdkFacade,
  SdkAttachment,
  SdkFieldMeta,
  SdkRecord,
  SdkRecordInput,
  SdkTable,
} from "./feishu/sdk";

export type {
  FeishuSdkFacade,
  SdkAttachment,
  SdkAttachmentField,
  SdkFieldMeta,
  SdkRecord,
  SdkRecordInput,
  SdkTable,
} from "./feishu/sdk";
export { attachmentVersion, cellText } from "./feishu/values";

export const TEMPLATE_TABLE_NAME = "招聘海报模板";
export const SETTINGS_TABLE_NAME = "招聘海报配置";
export const SOURCE_CONFIG_FIELD = "海报模板配置";
/** 用户表里可能已经写成“模版配置”，两种写法都认，避免模板表出现重复的配置列。 */
export const SOURCE_CONFIG_ALIASES = [SOURCE_CONFIG_FIELD, "模版配置"];
export const SOURCE_FONT_FIELD = "海报字体";
const TEMPLATE_FIELDS: IAddTableConfig["fields"] = [
  { name: "模板ID", type: 1 },
  { name: "名称", type: 1 },
  { name: "配置", type: 1 },
  { name: "素材", type: 17 },
];
const SETTINGS_FIELDS: IAddTableConfig["fields"] = [
  { name: "配置键", type: 1 },
  { name: "配置值", type: 1 },
];

export interface FeishuRepositoryOptions extends RequestCacheOptions {
  sdk?: FeishuSdkFacade;
  loadSdk?: () => Promise<FeishuSdkFacade>;
  fetcher?: typeof fetch;
}

interface TemplateTable {
  table: SdkTable;
  idField: string;
  nameField: string;
  configField: string;
  assetField: string;
}
interface SavedRow {
  recordId: string;
  config: SavedConfig;
  attachments: SdkRecord["fields"][string];
}
interface SettingsTable {
  table: SdkTable;
  keyField: string;
  valueField: string;
  created: boolean;
}
interface SdkScope {
  queue: Promise<unknown>;
  invalidate: Set<(recordsOnly: boolean) => void>;
}
// 同一宿主 SDK 共享一个写入边界，避免两个边栏仓储重复建表、建模板或同时上传。
const sdkScopes = new WeakMap<FeishuSdkFacade, SdkScope>();

async function loadDefaultSdk(): Promise<FeishuSdkFacade> {
  // 动态导入延迟到首次仓储调用，本地模式和组件构造均不触发宿主握手。
  const { bitable } = await import("@lark-base-open/js-sdk");
  return bitable;
}

export class FeishuPosterRepository implements PosterRepository {
  readonly mode = "feishu" as const;
  private sdk?: Promise<FeishuSdkFacade>;
  private scope?: SdkScope;
  private readonly invalidateFromScope = (recordsOnly: boolean) => {
    if (recordsOnly) this.cache.invalidate((key) => key.startsWith("context:"));
    else this.invalidate();
  };
  private activeTableId?: string;
  private configuredSettingsTableId?: string;
  private baseId?: string | null;
  private cache: RequestCache;
  /**
   * 附件字节常驻缓存：键里已经带上附件快照（token / 大小 / 时间戳）或内容哈希，
   * 同一份字节永远是对的，因此不受 TTL 与“保存后失效”影响，
   * 只由 LRU 的条目数与字节上限淘汰。切走再切回同一模板行不会重新下载。
   */
  private assetCache: RequestCache;
  constructor(private readonly options: FeishuRepositoryOptions = {}) {
    this.cache = new RequestCache(options);
    this.assetCache = this.createAssetCache();
  }

  private createAssetCache(): RequestCache {
    const { options } = this;
    return new RequestCache({
      ...options,
      ttlMs: Number.POSITIVE_INFINITY,
      // 常驻缓存按字节淘汰；放入几套模板的底图与字体，仍受上限约束。
      maxBytes: options.maxBytes ?? 48 * 1024 * 1024,
    });
  }

  /** 刷新元数据：配置、记录和字段会变，按内容快照命中的附件字节留着。 */
  invalidate(): void {
    this.cache.invalidate();
    this.cache = new RequestCache(this.options);
  }

  /** 换 Base 时连素材一起丢：表 ID 跨 Base 可能重名，不能借用别的 Base 的字节。 */
  private invalidateAll(): void {
    this.invalidate();
    this.assetCache = this.createAssetCache();
  }

  private cached<T>(
    key: string,
    action: string,
    work: (sdk: FeishuSdkFacade, cache: RequestCache) => Promise<T>,
  ): Promise<T> {
    const cache = this.cache;
    return cache
      .get(key, () => this.run(action, (sdk) => work(sdk, cache)))
      .then((value) => structuredClone(value));
  }

  private getSdk(): Promise<FeishuSdkFacade> {
    if (!this.sdk) {
      const pending = this.options.sdk
        ? Promise.resolve(this.options.sdk)
        : Promise.resolve().then(this.options.loadSdk ?? loadDefaultSdk);
      this.sdk = pending;
      void pending.catch(() => {
        if (this.sdk === pending) this.sdk = undefined;
      });
    }
    return this.sdk;
  }

  private run<T>(action: string, work: (sdk: FeishuSdkFacade) => Promise<T>): Promise<T> {
    return this.getSdk()
      .then((sdk) => {
        const scope = this.sdkScope(sdk);
        // 读取可并行；缓存负责同键合并，写入完成后再统一失效，旧代不能回填。
        scope.invalidate.add(this.invalidateFromScope);
        return work(sdk);
      })
      .catch((error) => {
        throw platformError(error, action);
      });
  }

  private sdkScope(sdk: FeishuSdkFacade): SdkScope {
    let scope = sdkScopes.get(sdk);
    if (!scope) {
      scope = { queue: Promise.resolve(), invalidate: new Set() };
      sdkScopes.set(sdk, scope);
    }
    this.scope = scope;
    return scope;
  }

  private write<T>(
    action: string,
    work: (sdk: FeishuSdkFacade) => Promise<T>,
    recordsOnly = false,
  ): Promise<T> {
    return this.getSdk()
      .then((sdk) => {
        const scope = this.sdkScope(sdk);
        scope.invalidate.add(this.invalidateFromScope);
        // 所有建表、配置、模板和附件写入共享串行边界，锁内不递归调用公共写方法。
        const result = scope.queue.then(async () => {
          try {
            return await work(sdk);
          } finally {
            for (const invalidateCache of scope.invalidate) invalidateCache(recordsOnly);
          }
        });
        scope.queue = result.catch(() => undefined);
        return result;
      })
      .catch((error) => {
        throw platformError(error, action);
      });
  }

  private async records(table: SdkTable, viewId?: string): Promise<SdkRecord[]> {
    return readAllRecords(table, viewId);
  }

  listTables(): Promise<TableSummary[]> {
    return this.run("读取业务表列表", async (sdk) =>
      (await sdk.base.getTableMetaList())
        .filter((table) => table.name !== SETTINGS_TABLE_NAME && table.name !== TEMPLATE_TABLE_NAME)
        .map((table) => ({ id: table.id, name: table.name })),
    );
  }

  listStorageTables(): Promise<TableSummary[]> {
    return this.run("读取配置存储表列表", async (sdk) =>
      (await sdk.base.getTableMetaList())
        .filter((table) => table.name !== TEMPLATE_TABLE_NAME)
        .map((table) => ({ id: table.id, name: table.name })),
    );
  }

  private async workspaceBindingTarget(sdk: FeishuSdkFacade) {
    const { baseId } = await sdk.base.getSelection();
    if (typeof baseId !== "string" || !baseId.trim())
      throw new PosterError("PLATFORM_ERROR", "无法读取当前 Base ID，不能读取或保存工作区绑定。");
    if (!sdk.bridge)
      throw new PosterError("PLATFORM_ERROR", "当前飞书宿主不支持工作区绑定持久化。");
    // 插件命名空间固定，按 Base 隔离；当前选中的业务表不参与键计算。
    return { bridge: sdk.bridge, key: `recruitment-poster:workspace:v1:${baseId}` };
  }

  loadWorkspaceBinding(): Promise<WorkspaceBinding | null> {
    return this.run("读取工作区绑定", async (sdk) => {
      const { bridge, key } = await this.workspaceBindingTarget(sdk);
      const value = await bridge.getData<unknown>(key);
      return this.readStoredBinding(value);
    });
  }

  private readStoredBinding(value: unknown): WorkspaceBinding | null {
    // 宿主存储兼容空值和 JSON 文本；非空旧版本仍严格校验，不能猜测业务表 ID。
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        throw new PosterError(
          "INVALID_TEMPLATE",
          "已保存的工作区绑定不是有效 JSON，请重新选择数据表",
        );
      }
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
      return null;
    return normalizeWorkspaceBinding(value);
  }

  async saveWorkspaceBinding(binding: WorkspaceBinding): Promise<void> {
    // 调用时复制并校验，排队期间调用方修改对象也不会改变写入目标。
    const value = normalizeWorkspaceBinding(binding);
    return this.write("保存工作区绑定", async (sdk) => {
      const { bridge, key } = await this.workspaceBindingTarget(sdk);
      if (!(await bridge.setData(key, structuredClone(value))))
        throw new PosterError("PLATFORM_ERROR", "飞书未确认工作区绑定保存成功。");
      const confirmed = this.readStoredBinding(await bridge.getData<unknown>(key));
      if (
        !confirmed ||
        confirmed.tableId !== value.tableId ||
        confirmed.storageTableId !== value.storageTableId
      ) {
        throw new PosterError("PLATFORM_ERROR", "工作区绑定保存后校验失败，请重新读取确认。");
      }
    });
  }

  initializeStorage(tableId?: string): Promise<StorageStatus> {
    // 与保存设置共享 SDK 写入队列，多个边栏同时初始化也只建一张配置表。
    return this.write("初始化配置表", async (sdk) => {
      const target = (await this.settingsTable(sdk, true, tableId, tableId !== undefined))!;
      const status = {
        tableId: target.table.id,
        name: await target.table.getName(),
        created: target.created,
      };
      // 仅成功初始化后切换存储；后续读写固定使用 ID，不再按名称猜测或另建表。
      this.configuredSettingsTableId = target.table.id;
      return status;
    });
  }

  loadContext(explicitTableId?: string, includeRecords = true): Promise<WorkspaceContext> {
    let cache = this.cache;
    return this.run("读取当前表", async (sdk) => {
      const selection = await sdk.base.getSelection();
      const tableId = explicitTableId ?? selection.tableId;
      // 视图只在同表时有效：显式指定别的表时，宿主视图属于当前表而不是目标表。
      const viewId =
        explicitTableId === undefined || explicitTableId === selection.tableId
          ? selection.viewId
          : undefined;
      if (!tableId || (explicitTableId === undefined && !viewId))
        throw new PosterError("PLATFORM_ERROR", "请在多维表数据视图中打开招聘海报边栏。");
      const previousCache = this.cache;
      if (this.baseId !== undefined && this.baseId !== selection.baseId) this.invalidateAll();
      this.baseId = selection.baseId;
      // 自身切换 Base 时使用新代；外部刷新已淘汰的旧调用仍停留在旧代。
      if (cache === previousCache) cache = this.cache;
      const context = await cache.get(
        `context:${JSON.stringify([selection.baseId, tableId, viewId, includeRecords])}`,
        async () => {
          const table = await sdk.base.getTableById(tableId);
          const fields = await this.recordFields(table, cache);
          const tableName = await table.getName();
          const records = includeRecords
            ? (await this.records(table, viewId ?? undefined)).map((record) =>
                toDataRecord(record, fields),
              )
            : [];
          return { tableId: table.id, tableName, fields, records };
        },
      );
      if (cache === this.cache) this.activeTableId = context.tableId;
      // 记录 ID 可能在不同表重复，只有同表选择才能用于当前业务表。
      const selectedRecordId =
        selection.tableId === tableId &&
        context.records.some((record) => record.id === selection.recordId)
          ? selection.recordId
          : (context.records[0]?.id ?? null);
      return structuredClone({
        ...context,
        selectedRecordId,
        ...(viewId ? { viewId } : {}),
      });
    });
  }

  private recordFields(table: SdkTable, cache: RequestCache) {
    return cache.get(JSON.stringify(["record-fields", table.id]), async () =>
      (await this.fieldMeta(table, cache)).map(toTableField),
    );
  }

  /** 同一切换里定位来源、读行值与读配置都要字段元数据，缓存后只请求宿主一次。 */
  private fieldMeta(table: SdkTable, cache: RequestCache): Promise<SdkFieldMeta[]> {
    return cache.get(JSON.stringify(["field-meta", table.id]), () => table.getFieldMetaList());
  }

  /**
   * 行数据始终直读宿主：底图、文案和配置都可能被其他人改动，
   * 缓存会让人看不到变化。省下的往返由调用方并行读取完成。
   */
  private templateRow(table: SdkTable, recordId: string): ReturnType<SdkTable["getRecordById"]> {
    return table.getRecordById(recordId);
  }

  listRecords(
    tableId: string,
    pageToken?: number,
    pageSize = 50,
    viewId?: string,
  ): Promise<RecordPage> {
    const cache = this.cache;
    return this.run("分页读取记录", async (sdk) => {
      const table = await sdk.base.getTableById(tableId);
      const fields = await this.recordFields(table, cache);
      return readRecordPage(table, fields, pageToken, pageSize, viewId);
    });
  }

  loadBackground(recordId: string, fieldId: string, tableId: string): Promise<PosterAsset> {
    const { cache, assetCache } = this;
    return this.run("读取行底图", (sdk) =>
      this.readBackground(sdk, recordId, fieldId, tableId, cache, assetCache),
    );
  }

  private async readBackground(
    sdk: FeishuSdkFacade,
    recordId: string,
    fieldId: string,
    tableId: string,
    cache: RequestCache,
    assetCache: RequestCache,
  ): Promise<PosterAsset> {
    const table = await sdk.base.getTableById(tableId);
    const [fields, record] = await Promise.all([
      this.fieldMeta(table, cache),
      this.templateRow(table, recordId),
    ]);
    const field = fields.find((item) => item.id === fieldId);
    if (field?.type !== FIELD_TYPES.attachment && field?.type !== FIELD_TYPES.lookup) {
      throw new PosterError("INVALID_ASSET", "底图必须选择附件或附件查找引用字段。");
    }
    return this.downloadRecordBackground(
      table,
      recordId,
      fieldId,
      backgroundAttachment(record.fields[fieldId]),
      assetCache,
    );
  }

  private async downloadRecordBackground(
    table: SdkTable,
    recordId: string,
    fieldId: string,
    attachment: SdkAttachment,
    assetCache: RequestCache,
  ): Promise<PosterAsset> {
    // 用当前记录的附件快照定位字节，命中时无需向宿主申请临时 URL。
    const asset = await assetCache.get(
      JSON.stringify([
        "background",
        table.id,
        recordId,
        fieldId,
        attachment.token,
        attachment.size,
        attachment.timeStamp,
      ]),
      async () => {
        const urls = await table.getCellAttachmentUrls([attachment.token], fieldId, recordId);
        if (urls.length !== 1 || !urls[0])
          throw new PosterError("INVALID_ASSET", "当前行底图附件的临时下载地址缺失。");
        return downloadBackground(urls[0], attachment.name, this.options.fetcher);
      },
    );
    return { ...asset, name: attachment.name };
  }

  getTemplateSource(
    recordId: string,
    locatorFieldId: string,
    tableId: string,
    backgroundFieldId: string,
  ): Promise<TemplateSource> {
    const cache = this.cache;
    return this.run("定位模板行", async (sdk) => {
      const table = await sdk.base.getTableById(tableId);
      const fields = await this.fieldMeta(table, cache);
      const locator = fields.find((item) => item.id === locatorFieldId);
      if (locator?.type !== FIELD_TYPES.lookup)
        throw new PosterError("INVALID_TEMPLATE", "模板定位字段必须是查找引用字段。");
      const property = locator.property as
        { refTableId?: unknown; refFieldId?: unknown } | undefined;
      if (
        typeof property?.refTableId !== "string" ||
        !property.refTableId ||
        typeof property.refFieldId !== "string" ||
        !property.refFieldId
      ) {
        throw new PosterError("INVALID_TEMPLATE", "查找引用缺少来源表或字段，请重建该字段。");
      }
      const keyFieldId = property.refFieldId;
      const record = await table.getRecordById(recordId);
      // 定位键就是查找引用单元格的展示文本，底图是否填写不参与定位。
      const key = lookupKey(record.fields[locatorFieldId]);
      if (!key)
        throw new PosterError(
          "INVALID_TEMPLATE",
          `当前记录的“${locator.name}”为空，无法确定使用哪个模板。`,
        );

      const templateTable = await sdk.base.getTableById(property.refTableId);
      const templateFields = await this.fieldMeta(templateTable, cache);
      if (!templateFields.some((item) => item.id === keyFieldId))
        throw new PosterError("INVALID_TEMPLATE", "查找引用指向的模板字段已不存在，请重建该字段。");
      if (
        !templateFields.some(
          (item) => item.id === backgroundFieldId && item.type === FIELD_TYPES.attachment,
        )
      )
        throw new PosterError("INVALID_ASSET", "模板底图字段必须是模板表的附件字段。");

      const byKey = await cache.get(
        JSON.stringify(["template-rows", templateTable.id, keyFieldId, key]),
        async () => {
          const index: Record<string, SdkRecord[]> = Object.create(null);
          for (const row of await this.records(templateTable)) {
            const rowKey = cellText(row.fields[keyFieldId]).trim();
            if (!rowKey) continue;
            (index[rowKey] ??= []).push(row);
          }
          return index;
        },
      );
      const matches = byKey[key] ?? [];
      if (matches.length !== 1)
        throw new PosterError(
          "INVALID_TEMPLATE",
          matches.length
            ? `模板表有 ${matches.length} 行匹配“${key}”，请保证模板键值唯一。`
            : `模板表里没有“${key}”对应的行，请检查“${locator.name}”的引用值。`,
        );
      const templateRecord = matches[0];
      return {
        tableId: templateTable.id,
        tableName: await templateTable.getName(),
        recordId: templateRecord.recordId,
        recordName: recordLabel(templateRecord, templateFields.map(toTableField)),
        backgroundFieldId,
      };
    });
  }

  loadSourceBackground(source: TemplateSource): Promise<PosterAsset> {
    const { cache, assetCache } = this;
    return this.run("读取模板底图", async (sdk) => {
      const { table, attachment } = await this.sourceTarget(sdk, source, cache);
      return this.downloadRecordBackground(
        table,
        source.recordId,
        source.backgroundFieldId,
        attachment,
        assetCache,
      );
    });
  }

  loadTemplateRecord(source: TemplateSource): Promise<TemplateRecordValues> {
    const cache = this.cache;
    return this.run("读取模板行", async (sdk) => {
      const table = await sdk.base.getTableById(source.tableId);
      const [fields, record] = await Promise.all([
        this.fieldMeta(table, cache),
        this.templateRow(table, source.recordId),
      ]);
      const tableFields = fields.map(toTableField);
      const { values } = toDataRecord(
        { recordId: source.recordId, fields: record.fields },
        tableFields,
      );
      return { fields: tableFields, values };
    });
  }

  listTemplateRows(
    templateTableId: string,
    backgroundFieldId: string,
  ): Promise<TemplateRowSummary[]> {
    const cache = this.cache;
    return this.run("读取模板行列表", async (sdk) => {
      const table = await sdk.base.getTableById(templateTableId);
      const fields = await this.fieldMeta(table, cache);
      this.assertTemplateBackgroundField(fields, backgroundFieldId);
      const tableFields = fields.map(toTableField);
      const { configField } = this.sourceColumns(fields);
      return (await this.records(table)).map((row) => ({
        recordId: row.recordId,
        label: recordLabel(row, tableFields),
        // 配置损坏的行在列表里标成未配置，由用户点进去重新保存，不让整张列表报错。
        configured: configField ? hasTemplateConfig(row.fields[configField]) : false,
      }));
    });
  }

  getTemplateSourceByRow(
    templateTableId: string,
    recordId: string,
    backgroundFieldId: string,
  ): Promise<TemplateSource> {
    const cache = this.cache;
    return this.run("读取模板行来源", async (sdk) => {
      const table = await sdk.base.getTableById(templateTableId);
      const [fields, record, tableName] = await Promise.all([
        this.fieldMeta(table, cache),
        this.templateRow(table, recordId),
        table.getName(),
      ]);
      this.assertTemplateBackgroundField(fields, backgroundFieldId);
      return {
        tableId: table.id,
        tableName,
        recordId,
        recordName: recordLabel(record, fields.map(toTableField)),
        backgroundFieldId,
      };
    });
  }

  private assertTemplateBackgroundField(fields: SdkFieldMeta[], backgroundFieldId: string): void {
    if (
      !fields.some(
        (field) => field.id === backgroundFieldId && field.type === FIELD_TYPES.attachment,
      )
    ) {
      throw new PosterError("INVALID_ASSET", "模板底图字段必须是模板表的附件字段。");
    }
  }

  private async sourceTarget(sdk: FeishuSdkFacade, source: TemplateSource, cache?: RequestCache) {
    const table = await sdk.base.getTableById(source.tableId);
    // 读取可以复用字段缓存；写入先确认最新列，再读取行内的修订号。
    const [fields, record] = cache
      ? await Promise.all([this.fieldMeta(table, cache), this.templateRow(table, source.recordId)])
      : [await table.getFieldMetaList(), await this.templateRow(table, source.recordId)];
    if (
      !fields.some(
        (field) => field.id === source.backgroundFieldId && field.type === FIELD_TYPES.attachment,
      )
    ) {
      throw new PosterError("INVALID_TEMPLATE", "模板行必须选择模板表里的底图附件字段。");
    }
    const attachment = backgroundAttachment(record.fields[source.backgroundFieldId]);
    return { table, fields, record, attachment };
  }

  private sourceColumns(fields: SdkFieldMeta[]) {
    const find = (names: string[], type: 1 | 17, label: string) => {
      const matched = names.flatMap((name) => {
        const matches = fields.filter((field) => field.name === name);
        if (matches.length > 1 || (matches.length && matches[0].type !== type))
          throw new PosterError("INVALID_TEMPLATE", `模板表的“${name}”字段重名或类型不正确。`);
        return matches;
      });
      if (matched.length > 1)
        throw new PosterError(
          "INVALID_TEMPLATE",
          `模板表同时存在“${names.join("”和“")}”，请保留其中一列${label}。`,
        );
      return matched[0]?.id;
    };
    return {
      configField: find(SOURCE_CONFIG_ALIASES, FIELD_TYPES.text, "存放模板配置"),
      fontField: find([SOURCE_FONT_FIELD], FIELD_TYPES.attachment, "存放字体附件"),
    };
  }

  private async addSourceColumn(table: SdkTable, name: string, type: 1 | 17): Promise<string> {
    const id = await table.addField({ name, type });
    if (!id) throw new PosterError("PLATFORM_ERROR", `飞书未确认创建“${name}”字段成功。`);
    return id;
  }

  private async loadSavedAssets(
    table: SdkTable,
    recordId: string,
    fieldId: string,
    tokens: string[],
    manifest: SavedAsset[],
    assetCache: RequestCache,
  ): Promise<PosterAsset[]> {
    const positions = new Map(tokens.map((token, i) => [token, i]));
    let urls: Promise<string[]> | undefined;
    const assets: PosterAsset[] = [];
    for (const asset of manifest) {
      // 每次先核对当前单元格；只有缺少字节时才批量申请这一快照的 URL。
      const position = positions.get(asset.token);
      if (position === undefined)
        throw new PosterError("INVALID_ASSET", `模板素材“${asset.name}”附件已缺失。`);
      // 键含内容哈希：同一份字节在不同行、不同时间都直接复用。
      const blob = await assetCache.get(
        JSON.stringify(["asset", table.id, fieldId, asset.token, asset.hash, asset.mimeType]),
        async () => {
          urls ??= table.getCellAttachmentUrls(tokens, fieldId, recordId);
          const url = (await urls)[position];
          if (!url)
            throw new PosterError("INVALID_ASSET", `素材“${asset.name}”的临时下载地址缺失。`);
          const bytes = await downloadAttachment(
            url,
            this.options.fetcher,
            `下载素材“${asset.name}”（网络或 CORS）`,
          );
          if ((await hashBlob(bytes)) !== asset.hash)
            throw new PosterError("INVALID_ASSET", `模板素材“${asset.name}”与保存内容不一致。`);
          // 缓存带 MIME 的 Blob，后续行可复用渲染器已解码的字体或图片。
          return bytes.slice(0, bytes.size, asset.mimeType);
        },
      );
      assets.push({ id: asset.id, name: asset.name, mimeType: asset.mimeType, blob });
    }
    return assets;
  }

  loadSourceTemplate(source: TemplateSource): Promise<TemplateBundle | null> {
    const { cache, assetCache } = this;
    return this.run("读取模板行配置", async (sdk) => {
      const { table, fields, record, attachment } = await this.sourceTarget(sdk, source, cache);
      const { configField, fontField } = this.sourceColumns(fields);
      if (!configField || !cellText(record.fields[configField]).trim()) return null;
      const config = parseConfig(record.fields[configField]);
      if (
        !fontField ||
        config.assets.length !== config.template.fontIds.length ||
        config.assets.some(
          (asset) =>
            !config.template.fontIds.includes(asset.id) || !asset.mimeType.startsWith("font/"),
        )
      ) {
        throw new PosterError("INVALID_ASSET", "模板行的字体附件清单不完整。");
      }
      const value = record.fields[fontField];
      const tokens = (Array.isArray(value) ? value : []).flatMap((item) =>
        item && typeof item === "object" && "token" in item && typeof item.token === "string"
          ? [item.token]
          : [],
      );
      const assets = await this.loadSavedAssets(
        table,
        source.recordId,
        fontField,
        tokens,
        config.assets,
        assetCache,
      );
      const background = await this.downloadRecordBackground(
        table,
        source.recordId,
        source.backgroundFieldId,
        attachment,
        assetCache,
      );
      const bundle = {
        template: { ...config.template, backgroundId: background.id },
        assets: [background, ...assets],
        revision: config.updatedAt,
      };
      validateBundle(bundle);
      return bundle;
    });
  }

  saveSourceTemplate(
    source: TemplateSource,
    bundle: TemplateBundle,
    expectedUpdatedAt?: number | null,
  ): Promise<number> {
    return this.write("保存模板行配置", async (sdk) => {
      validateBundle(bundle);
      const fonts = bundle.template.fontIds.map((id) =>
        bundle.assets.find((asset) => asset.id === id)!,
      );
      if (
        fonts.some(
          (asset) =>
            !["font/otf", "font/ttf", "font/woff", "font/woff2"].includes(asset.mimeType) ||
            asset.blob.size > MAX_ASSET_BYTES,
        )
      ) {
        throw new PosterError("INVALID_ASSET", "模板行只允许保存不超过 20 MB 的字体附件。");
      }
      const { table, fields, record } = await this.sourceTarget(sdk, source);
      const columns = this.sourceColumns(fields);
      const previousValue = columns.configField ? record.fields[columns.configField] : undefined;
      const previous = cellText(previousValue).trim() ? parseConfig(previousValue) : undefined;
      assertRevisionUnchanged(expectedUpdatedAt, previous?.updatedAt, "模板配置");
      // 两列和版本均验证后再补缺字段，避免在已知冲突时修改用户表结构。
      const configField =
        columns.configField ??
        (await this.addSourceColumn(table, SOURCE_CONFIG_FIELD, FIELD_TYPES.text));
      const fontField =
        columns.fontField ??
        (await this.addSourceColumn(table, SOURCE_FONT_FIELD, FIELD_TYPES.attachment));
      const currentFonts = record.fields[fontField];
      const currentTokens = new Set(
        (Array.isArray(currentFonts) ? currentFonts : []).flatMap((item) =>
          item && typeof item === "object" && "token" in item ? [item.token] : [],
        ),
      );
      const reusable = new Map(
        previous?.assets
          .filter((asset) => currentTokens.has(asset.token))
          .map((asset) => [asset.hash, asset.token]),
      );
      const assets: SavedAsset[] = [];
      for (const font of fonts) {
        const hash = await hashBlob(font.blob);
        let token = reusable.get(hash);
        if (!token) {
          const uploaded = await sdk.base.batchUploadFile([
            new File([font.blob], font.name, { type: font.mimeType }),
          ]);
          if (uploaded.length !== 1 || !uploaded[0])
            throw new PosterError("PLATFORM_ERROR", "飞书未返回有效字体上传凭据。");
          token = uploaded[0];
          reusable.set(hash, token);
        }
        assets.push({
          id: font.id,
          name: font.name,
          mimeType: font.mimeType,
          size: font.blob.size,
          token,
          hash,
        });
      }
      const config: SavedConfig = {
        schemaVersion: 1,
        template: bundle.template,
        assets,
        updatedAt: nextRevision(previous?.updatedAt),
      };
      const serialized = JSON.stringify(config);
      const attachments: SdkAttachment[] = [
        ...new Map(
          assets.map((asset) => [
            asset.token,
            {
              token: asset.token,
              name: asset.name,
              type: asset.mimeType,
              size: asset.size,
              timeStamp: config.updatedAt,
            },
          ]),
        ).values(),
      ];
      // 只更新模板行的这两个单元格，绝不写回底图、查找引用或其他业务数据。
      const confirmedId = await table.setRecord(source.recordId, {
        fields: { [configField]: richText(serialized), [fontField]: attachments },
      });
      if (!confirmedId || confirmedId !== source.recordId)
        throw new PosterError("PLATFORM_ERROR", "飞书未确认模板行写入成功。");
      const confirmed = await table.getRecordById(source.recordId);
      const confirmedFonts = confirmed.fields[fontField];
      const confirmedTokens = new Set(
        (Array.isArray(confirmedFonts) ? confirmedFonts : []).flatMap((item) =>
          item && typeof item === "object" && "token" in item ? [item.token] : [],
        ),
      );
      if (
        cellText(confirmed.fields[configField]) !== serialized ||
        assets.some((asset) => !confirmedTokens.has(asset.token))
      ) {
        throw new PosterError(
          "PLATFORM_ERROR",
          "模板行写入后的配置或字体校验失败，请重新读取确认。",
        );
      }
      return config.updatedAt;
    });
  }

  private async templateTable(sdk: FeishuSdkFacade, create = false): Promise<TemplateTable | null> {
    const matches = (await sdk.base.getTableMetaList()).filter(
      (table) => table.name === TEMPLATE_TABLE_NAME,
    );
    if (matches.length > 1)
      throw new PosterError("INVALID_TEMPLATE", "存在多个同名招聘海报模板表，请先保留一个。");
    let tableId = matches[0]?.id;
    if (!tableId && create)
      tableId = (await sdk.base.addTable({ name: TEMPLATE_TABLE_NAME, fields: TEMPLATE_FIELDS }))
        .tableId;
    if (!tableId) return null;
    const table = await sdk.base.getTableById(tableId);
    const fields = await table.getFieldMetaList();
    const ids = TEMPLATE_FIELDS.map((required) => {
      const field = fields.find((field) => field.name === required.name);
      if (!field || field.type !== required.type)
        throw new PosterError(
          "INVALID_TEMPLATE",
          `模板表的“${required.name}”字段缺失或类型不正确。`,
        );
      return field.id;
    });
    return { table, idField: ids[0], nameField: ids[1], configField: ids[2], assetField: ids[3] };
  }

  private async savedRows(target: TemplateTable): Promise<SavedRow[]> {
    const rows = await this.records(target.table);
    const saved: SavedRow[] = [];
    const ids = new Set<string>();
    for (const row of rows) {
      // 新建表或用户保留的空行没有配置，不当作模板。
      if (!cellText(row.fields[target.configField]).trim()) continue;
      const config = parseConfig(row.fields[target.configField]);
      if (
        cellText(row.fields[target.idField]) !== config.template.id ||
        ids.has(config.template.id)
      ) {
        throw new PosterError("INVALID_TEMPLATE", "模板 ID 与配置不一致或存在重复模板 ID。");
      }
      ids.add(config.template.id);
      saved.push({ recordId: row.recordId, config, attachments: row.fields[target.assetField] });
    }
    return saved;
  }

  listTemplates(): Promise<TemplateSummary[]> {
    return this.cached("templates", "读取模板列表", async (sdk) => {
      const target = await this.templateTable(sdk);
      if (!target) return [];
      return (await this.savedRows(target))
        .map(({ config }) => ({
          id: config.template.id,
          name: config.template.name,
          updatedAt: config.updatedAt,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  loadTemplate(id: string): Promise<TemplateBundle> {
    const assetCache = this.assetCache;
    return this.run("读取模板", async (sdk) => {
      const target = await this.templateTable(sdk);
      const row =
        target && (await this.savedRows(target)).find((row) => row.config.template.id === id);
      if (!target || !row) throw new PosterError("INVALID_TEMPLATE", "飞书模板不存在。");
      const field = await target.table.getFieldById<IAttachmentField>(target.assetField);
      const attachments = (await field.getValue(row.recordId)) ?? [];
      const tokens = attachments.map((attachment) => attachment.token);
      const assets = await this.loadSavedAssets(
        target.table,
        row.recordId,
        target.assetField,
        tokens,
        row.config.assets,
        assetCache,
      );
      const bundle = { template: row.config.template, assets, revision: row.config.updatedAt };
      validateBundle(bundle);
      return bundle;
    });
  }

  saveTemplate(
    bundle: TemplateBundle,
    expectedUpdatedAt?: number | null,
  ): Promise<TemplateSummary> {
    return this.write("保存模板", async (sdk) => {
      validateBundle(bundle);
      const target = (await this.templateTable(sdk, true))!;
      const rows = await this.savedRows(target);
      const existing = rows.find((row) => row.config.template.id === bundle.template.id);
      assertRevisionUnchanged(expectedUpdatedAt, existing?.config.updatedAt, "模板");
      const field = await target.table.getFieldById<IAttachmentField>(target.assetField);
      const reusable = new Map<string, string>();
      for (const row of rows) {
        // 分页结果已经包含附件单元格，省去逐模板再读一次；新写入仍回读确认。
        const tokens = new Set(
          Array.isArray(row.attachments)
            ? row.attachments.flatMap((item) =>
                item && typeof item === "object" && "token" in item ? [item.token] : [],
              )
            : [],
        );
        for (const asset of row.config.assets)
          if (tokens.has(asset.token)) reusable.set(asset.hash, asset.token);
      }
      const assets: SavedAsset[] = [];
      for (const asset of bundle.assets) {
        const hash = await hashBlob(asset.blob);
        let token = reusable.get(hash);
        if (!token) {
          const uploaded = await sdk.base.batchUploadFile([
            new File([asset.blob], asset.name, { type: asset.mimeType }),
          ]);
          token = uploaded[0];
          if (uploaded.length !== 1 || !token)
            throw new PosterError("PLATFORM_ERROR", "飞书未返回有效素材上传凭据。");
          reusable.set(hash, token);
        }
        assets.push({
          id: asset.id,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.blob.size,
          token,
          hash,
        });
      }
      const config: SavedConfig = {
        schemaVersion: 1,
        template: bundle.template,
        assets,
        updatedAt: nextRevision(existing?.config.updatedAt),
      };
      const serialized = JSON.stringify(config);
      const attachments: SdkAttachment[] = [
        ...new Map(
          assets.map((asset) => [
            asset.token,
            {
              token: asset.token,
              name: asset.name,
              type: asset.mimeType,
              size: asset.size,
              timeStamp: config.updatedAt,
            },
          ]),
        ).values(),
      ];
      const value: SdkRecordInput = {
        fields: {
          [target.idField]: richText(bundle.template.id),
          [target.nameField]: richText(bundle.template.name),
          [target.configField]: richText(serialized),
          [target.assetField]: attachments,
        },
      };
      const recordId = existing
        ? await target.table.setRecord(existing.recordId, value)
        : await target.table.addRecord(value);
      if (!recordId) throw new PosterError("PLATFORM_ERROR", "飞书未确认模板写入成功。");
      const confirmed = await target.table.getRecordById(recordId);
      if (
        cellText(confirmed.fields[target.idField]) !== bundle.template.id ||
        cellText(confirmed.fields[target.configField]) !== serialized
      ) {
        throw new PosterError("PLATFORM_ERROR", "模板写入后的配置校验失败，请重新读取模板确认。");
      }
      const savedTokens = new Set(
        ((await field.getValue(recordId)) ?? []).map((attachment) => attachment.token),
      );
      if (assets.some((asset) => !savedTokens.has(asset.token)))
        throw new PosterError("PLATFORM_ERROR", "模板写入后的素材校验失败。");
      return { id: config.template.id, name: config.template.name, updatedAt: config.updatedAt };
    });
  }

  deleteTemplate(id: string, expectedUpdatedAt?: number | null): Promise<void> {
    return this.write("删除模板", async (sdk) => {
      const target = await this.templateTable(sdk);
      if (!target) throw new PosterError("INVALID_TEMPLATE", "飞书模板不存在。");
      const existing = (await this.savedRows(target)).find((row) => row.config.template.id === id);
      if (!existing) throw new PosterError("INVALID_TEMPLATE", "飞书模板不存在。");
      assertRevisionUnchanged(expectedUpdatedAt, existing.config.updatedAt, "模板");
      if (!(await target.table.deleteRecord(existing.recordId)))
        throw new PosterError("PLATFORM_ERROR", "飞书未确认模板删除成功。");
      if ((await this.savedRows(target)).some((row) => row.config.template.id === id))
        throw new PosterError("PLATFORM_ERROR", "模板删除后的回读校验失败。");
    });
  }

  listOutputFiles(recordId: string, fieldId: string, tableId: string): Promise<OutputFile[]> {
    return this.run("读取当前输出附件列表", async (sdk) => {
      const table = await sdk.base.getTableById(tableId);
      const field = await outputField(table, fieldId);
      const attachments = (await field.getValue(recordId)) ?? [];
      return attachments.map(({ token, name, type }) => ({
        id: token,
        name,
        loadBlob: () =>
          this.run("下载输出附件", async () => {
            // 点击时才生成临时 URL，使用列出文件时的 token，避免错下后来替换的附件。
            const [url] = await table.getCellAttachmentUrls([token], fieldId, recordId);
            if (!url) throw new PosterError("INVALID_ASSET", `附件“${name}”的临时下载地址缺失。`);
            const blob = await downloadAttachment(url, this.options.fetcher, `下载附件“${name}”`);
            return blob.slice(0, blob.size, type);
          }),
      }));
    });
  }

  listOutputs(recordId?: string, fieldId?: string, tableId?: string): Promise<OutputAttachment[]> {
    return this.run("读取当前输出附件", async (sdk) => {
      const selection = recordId && fieldId && tableId ? undefined : await sdk.base.getSelection();
      const targetRecordId = recordId ?? selection?.recordId,
        targetFieldId = fieldId ?? selection?.fieldId,
        targetTableId = tableId ?? selection?.tableId;
      if (!targetRecordId || !targetFieldId || !targetTableId) return [];
      const table = await sdk.base.getTableById(targetTableId);
      const field = await outputField(table, targetFieldId);
      const attachments = (await field.getValue(targetRecordId)) ?? [];
      if (attachments.length > 20)
        throw new PosterError(
          "INVALID_ASSET",
          "当前附件单元格超过 20 个文件，请先在多维表中整理后再读取。",
        );
      const urls = attachments.length
        ? await table.getCellAttachmentUrls(
            attachments.map((item) => item.token),
            targetFieldId,
            targetRecordId,
          )
        : [];
      const outputs: OutputAttachment[] = [];
      for (const [index, attachment] of attachments.entries()) {
        if (!urls[index])
          throw new PosterError("INVALID_ASSET", `附件“${attachment.name}”的临时下载地址缺失。`);
        const asset = await downloadBackground(urls[index], attachment.name, this.options.fetcher);
        outputs.push({
          recordId: targetRecordId,
          fieldId: targetFieldId,
          name: attachment.name,
          blob: asset.blob,
          createdAt: attachment.timeStamp ?? Date.now(),
        });
      }
      return outputs;
    });
  }

  readOutputVersion(recordId: string, fieldId: string, tableId?: string): Promise<string> {
    return this.run("读取输出附件快照", (sdk) =>
      readFeishuOutputVersion(sdk, tableId ?? this.activeTableId, recordId, fieldId),
    );
  }

  writePng(
    recordId: string,
    fieldId: string,
    file: File,
    tableId?: string,
    expectedVersion?: string,
  ): Promise<void> {
    // 发起操作时捕获目标；PNG 写回只使业务记录快照失效，模板行缓存可继续复用。
    const requestedTableId = tableId ?? this.activeTableId;
    return this.write(
      "写回 PNG 附件",
      (sdk) => writeFeishuPng(sdk, requestedTableId, recordId, fieldId, file, expectedVersion),
      true,
    );
  }

  private async settingsTable(
    sdk: FeishuSdkFacade,
    create = false,
    tableId?: string,
    addMissingFields = false,
  ): Promise<SettingsTable | null> {
    const explicit = tableId !== undefined;
    if (explicit && !tableId) throw new PosterError("INVALID_TEMPLATE", "请选择有效的配置存储表。");
    if (!explicit) {
      const matches = (await sdk.base.getTableMetaList()).filter(
        (table) => table.name === SETTINGS_TABLE_NAME,
      );
      if (matches.length > 1)
        throw new PosterError(
          "INVALID_TEMPLATE",
          "存在多个同名招聘海报配置表，请明确选择配置存储表。",
        );
      tableId = matches[0]?.id;
    }
    const created = !explicit && !tableId && create;
    if (created) {
      tableId = (await sdk.base.addTable({ name: SETTINGS_TABLE_NAME, fields: SETTINGS_FIELDS }))
        .tableId;
      if (!tableId) throw new PosterError("PLATFORM_ERROR", "飞书未返回有效的配置表 ID。");
    }
    if (!tableId) return null;
    const table = await sdk.base.getTableById(tableId);
    const fields = await table.getFieldMetaList();
    // 先检查所有同名字段，再补缺列，避免发现类型冲突前已修改用户表。
    for (const required of SETTINGS_FIELDS) {
      const matches = fields.filter((field) => field.name === required.name);
      if (matches.length > 1 || (matches.length === 1 && matches[0].type !== required.type)) {
        throw new PosterError(
          "INVALID_TEMPLATE",
          `配置表的“${required.name}”字段重名或类型不正确，请使用文本字段。`,
        );
      }
      if (!matches.length && !addMissingFields)
        throw new PosterError("INVALID_TEMPLATE", `配置表的“${required.name}”字段缺失。`);
    }
    const ids: string[] = [];
    for (const required of SETTINGS_FIELDS) {
      const field = fields.find((field) => field.name === required.name);
      const id =
        field?.id ?? (await table.addField({ name: required.name, type: FIELD_TYPES.text }));
      if (!id)
        throw new PosterError("PLATFORM_ERROR", `飞书未确认创建“${required.name}”字段成功。`);
      ids.push(id);
    }
    return { table, keyField: ids[0], valueField: ids[1], created };
  }

  private async settingsRow(
    target: SettingsTable,
    tableId: string,
  ): Promise<SdkRecord | undefined> {
    const rows = (await this.records(target.table)).filter(
      (row) => cellText(row.fields[target.keyField]) === tableId,
    );
    if (rows.length > 1)
      throw new PosterError(
        "INVALID_TEMPLATE",
        "当前表存在重复的招聘海报配置键，请先清理重复配置。",
      );
    return rows[0];
  }

  loadSettings(tableId: string): Promise<WorkspaceSettings | null> {
    return this.cached(
      JSON.stringify(["settings", this.configuredSettingsTableId, tableId]),
      "读取工作区配置",
      async (sdk) => {
        const target = await this.settingsTable(sdk, false, this.configuredSettingsTableId);
        if (!target) return null;
        const row = await this.settingsRow(target, tableId);
        if (!row) return null;
        let value: unknown;
        try {
          value = JSON.parse(cellText(row.fields[target.valueField]));
        } catch {
          throw new PosterError("INVALID_TEMPLATE", "工作区配置不是有效 JSON。");
        }
        return normalizeSettings(value, tableId);
      },
    );
  }

  saveSettings(
    value: WorkspaceSettings,
    expectedUpdatedAt?: number | null,
  ): Promise<WorkspaceSettings> {
    return this.write("保存工作区配置", async (sdk) => {
      const input = normalizeSettings(value);
      const target = (await this.settingsTable(sdk, true, this.configuredSettingsTableId))!;
      const existing = await this.settingsRow(target, input.tableId);
      let previous: WorkspaceSettings | null = null;
      if (existing) {
        try {
          previous = normalizeSettings(
            JSON.parse(cellText(existing.fields[target.valueField])),
            input.tableId,
          );
        } catch {
          throw new PosterError(
            "INVALID_TEMPLATE",
            "已保存的工作区配置损坏，请重新读取并修复后再保存。",
          );
        }
      }
      assertRevisionUnchanged(expectedUpdatedAt, previous?.updatedAt ?? undefined, "工作区配置");
      const settings = { ...input, updatedAt: nextRevision(previous?.updatedAt) };
      const serialized = JSON.stringify(settings);
      const record: SdkRecordInput = {
        fields: {
          [target.keyField]: richText(settings.tableId),
          [target.valueField]: richText(serialized),
        },
      };
      const id = existing
        ? await target.table.setRecord(existing.recordId, record)
        : await target.table.addRecord(record);
      if (!id) throw new PosterError("PLATFORM_ERROR", "飞书未确认工作区配置写入成功。");
      const confirmed = await target.table.getRecordById(id);
      if (
        cellText(confirmed.fields[target.keyField]) !== settings.tableId ||
        cellText(confirmed.fields[target.valueField]) !== serialized
      ) {
        throw new PosterError("PLATFORM_ERROR", "工作区配置保存后校验失败，请重新读取确认。");
      }
      return settings;
    });
  }

  dispose(): void {
    this.scope?.invalidate.delete(this.invalidateFromScope);
    this.invalidate();
  }
}

/** 列表只关心该行有没有可解析配置；坏数据算未配置，不让整张列表不可用。 */
function hasTemplateConfig(value: unknown): boolean {
  if (!cellText(value).trim()) return false;
  try {
    parseConfig(value);
    return true;
  } catch {
    return false;
  }
}
