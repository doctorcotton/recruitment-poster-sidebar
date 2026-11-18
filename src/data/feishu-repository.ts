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
import { backgroundAttachment, cellText, FIELD_TYPES, fieldKind, richText } from "./feishu/values";
import { parseConfig, type SavedAsset, type SavedConfig } from "./feishu/config";
import { readAllRecords, readRecordPage, toDataRecord } from "./feishu/records";
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
  constructor(private readonly options: FeishuRepositoryOptions = {}) {
    this.cache = new RequestCache(options);
  }

  invalidate(): void {
    this.cache.invalidate();
    this.cache = new RequestCache(this.options);
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
      const viewId = explicitTableId === undefined ? selection.viewId : undefined;
      if (!tableId || (explicitTableId === undefined && !viewId))
        throw new PosterError("PLATFORM_ERROR", "请在多维表数据视图中打开招聘海报边栏。");
      const previousCache = this.cache;
      if (this.baseId !== undefined && this.baseId !== selection.baseId) this.invalidate();
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
      return structuredClone({ ...context, selectedRecordId });
    });
  }

  private recordFields(table: SdkTable, cache: RequestCache) {
    return cache.get(JSON.stringify(["record-fields", table.id]), async () =>
      (await table.getFieldMetaList()).map((field) => ({
        id: field.id,
        name: field.name,
        kind: fieldKind(field.type),
      })),
    );
  }

  listRecords(tableId: string, pageToken?: number, pageSize = 50): Promise<RecordPage> {
    const cache = this.cache;
    return this.run("分页读取记录", async (sdk) => {
      const table = await sdk.base.getTableById(tableId);
      const fields = await this.recordFields(table, cache);
      return readRecordPage(table, fields, pageToken, pageSize);
    });
  }

  loadBackground(recordId: string, fieldId: string, tableId: string): Promise<PosterAsset> {
    const cache = this.cache;
    return this.run("读取行底图", (sdk) =>
      this.readBackground(sdk, recordId, fieldId, tableId, cache),
    );
  }

  private async readBackground(
    sdk: FeishuSdkFacade,
    recordId: string,
    fieldId: string,
    tableId: string,
    cache: RequestCache,
  ): Promise<PosterAsset> {
    const table = await sdk.base.getTableById(tableId);
    const field = (await table.getFieldMetaList()).find((item) => item.id === fieldId);
    if (field?.type !== FIELD_TYPES.attachment && field?.type !== FIELD_TYPES.lookup) {
      throw new PosterError("INVALID_ASSET", "底图必须选择附件或附件查找引用字段。");
    }
    const record = await table.getRecordById(recordId);
    return this.downloadRecordBackground(
      table,
      recordId,
      fieldId,
      backgroundAttachment(record.fields[fieldId]),
      cache,
    );
  }

  private async downloadRecordBackground(
    table: SdkTable,
    recordId: string,
    fieldId: string,
    attachment: SdkAttachment,
    cache: RequestCache,
  ): Promise<PosterAsset> {
    // 用当前记录的附件快照定位字节，命中时无需向宿主申请临时 URL。
    const asset = await cache.get(
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

  getTemplateSource(recordId: string, fieldId: string, tableId: string): Promise<TemplateSource> {
    const cache = this.cache;
    return this.run("定位底图来源", async (sdk) => {
      let table = await sdk.base.getTableById(tableId);
      let fields = await table.getFieldMetaList();
      let record = await table.getRecordById(recordId);
      const field = fields.find((item) => item.id === fieldId);
      if (field?.type !== FIELD_TYPES.attachment && field?.type !== FIELD_TYPES.lookup)
        throw new PosterError("INVALID_ASSET", "底图字段必须是附件或附件查找引用。");
      const attachment = backgroundAttachment(record.fields[fieldId]);
      if (field.type === FIELD_TYPES.lookup) {
        const property = field.property as
          { refTableId?: unknown; refFieldId?: unknown } | undefined;
        if (
          typeof property?.refTableId !== "string" ||
          !property.refTableId ||
          typeof property.refFieldId !== "string" ||
          !property.refFieldId
        ) {
          throw new PosterError(
            "INVALID_TEMPLATE",
            "查找引用缺少来源表或字段，请使用直接引用原附件字段的查找引用。",
          );
        }
        table = await sdk.base.getTableById(property.refTableId);
        fields = await table.getFieldMetaList();
        fieldId = property.refFieldId;
        if (!fields.some((item) => item.id === fieldId && item.type === FIELD_TYPES.attachment))
          throw new PosterError(
            "INVALID_TEMPLATE",
            "查找引用未指向原附件字段，请使用直接引用原附件字段的查找引用。",
          );
        // 只认引用字段中的同一 token；重名文件、临时 URL 和表内行顺序均不作为关联依据。
        const index = await cache.get(
          JSON.stringify(["source-rows", table.id, fieldId]),
          async () => {
            const byToken: Record<string, SdkRecord | null | undefined> = Object.create(null);
            for (const row of await this.records(table)) {
              const attachments = row.fields[fieldId];
              if (!Array.isArray(attachments)) continue;
              for (const item of attachments) {
                if (
                  !item ||
                  typeof item !== "object" ||
                  !("token" in item) ||
                  typeof item.token !== "string"
                )
                  continue;
                const existing = byToken[item.token];
                byToken[item.token] = existing === undefined || existing === row ? row : null;
              }
            }
            return byToken;
          },
        );
        const match = index[attachment.token];
        if (!match)
          throw new PosterError(
            "INVALID_TEMPLATE",
            match === null
              ? "底图匹配多个来源记录，请确保底图仅对应一条来源记录。"
              : "未找到底图对应的来源记录，请检查来源原附件字段是否仍包含该底图。",
          );
        recordId = match.recordId;
        record = match;
        backgroundAttachment(record.fields[fieldId]);
      }
      const recordName =
        fields
          .filter(
            (item) => item.type !== FIELD_TYPES.attachment && item.type !== FIELD_TYPES.lookup,
          )
          .map((item) => cellText(record.fields[item.id]))
          .find(Boolean) ?? recordId;
      return {
        tableId: table.id,
        tableName: await table.getName(),
        recordId,
        recordName,
        backgroundFieldId: fieldId,
      };
    });
  }

  private async sourceTarget(sdk: FeishuSdkFacade, source: TemplateSource) {
    const table = await sdk.base.getTableById(source.tableId);
    const fields = await table.getFieldMetaList();
    if (
      !fields.some(
        (field) => field.id === source.backgroundFieldId && field.type === FIELD_TYPES.attachment,
      )
    ) {
      throw new PosterError("INVALID_TEMPLATE", "来源记录必须选择原始底图附件字段。");
    }
    const record = await table.getRecordById(source.recordId);
    const attachment = backgroundAttachment(record.fields[source.backgroundFieldId]);
    return { table, fields, record, attachment };
  }

  private sourceColumns(fields: SdkFieldMeta[]) {
    const find = (name: string, type: 1 | 17) => {
      const matches = fields.filter((field) => field.name === name);
      if (matches.length > 1 || (matches.length && matches[0].type !== type))
        throw new PosterError("INVALID_TEMPLATE", `来源表的“${name}”字段重名或类型不正确。`);
      return matches[0]?.id;
    };
    return {
      configField: find(SOURCE_CONFIG_FIELD, FIELD_TYPES.text),
      fontField: find(SOURCE_FONT_FIELD, FIELD_TYPES.attachment),
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
    cache: RequestCache,
  ): Promise<PosterAsset[]> {
    const positions = new Map(tokens.map((token, i) => [token, i]));
    let urls: Promise<string[]> | undefined;
    const assets: PosterAsset[] = [];
    for (const asset of manifest) {
      // 每次先核对当前单元格；只有缺少字节时才批量申请这一快照的 URL。
      const position = positions.get(asset.token);
      if (position === undefined)
        throw new PosterError("INVALID_ASSET", `模板素材“${asset.name}”附件已缺失。`);
      const blob = await cache.get(
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
    const cache = this.cache;
    return this.run("读取来源模板", async (sdk) => {
      const { table, fields, record, attachment } = await this.sourceTarget(sdk, source);
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
        throw new PosterError("INVALID_ASSET", "来源模板的字体附件清单不完整。");
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
        cache,
      );
      const background = await this.downloadRecordBackground(
        table,
        source.recordId,
        source.backgroundFieldId,
        attachment,
        cache,
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
    return this.write("保存来源模板", async (sdk) => {
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
        throw new PosterError("INVALID_ASSET", "来源模板只允许保存不超过 20 MB 的字体附件。");
      }
      const { table, fields, record } = await this.sourceTarget(sdk, source);
      const columns = this.sourceColumns(fields);
      const previousValue = columns.configField ? record.fields[columns.configField] : undefined;
      const previous = cellText(previousValue).trim() ? parseConfig(previousValue) : undefined;
      assertRevisionUnchanged(expectedUpdatedAt, previous?.updatedAt, "来源模板");
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
      // 只更新来源记录的这两个单元格，绝不写回底图、关联字段或其他业务数据。
      const confirmedId = await table.setRecord(source.recordId, {
        fields: { [configField]: richText(serialized), [fontField]: attachments },
      });
      if (!confirmedId || confirmedId !== source.recordId)
        throw new PosterError("PLATFORM_ERROR", "飞书未确认来源模板写入成功。");
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
          "来源模板写入后的配置或字体校验失败，请重新读取确认。",
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
    const cache = this.cache;
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
        cache,
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
    // 发起操作时捕获目标；PNG 写回只使业务记录快照失效，来源模板缓存可继续复用。
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
