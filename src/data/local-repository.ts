import {
  PosterError,
  type DataRecord,
  type OutputAttachment,
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
import { normalizeSettings, normalizeWorkspaceBinding, validateBundle } from "./validation";
import { validatePng } from "./assets";
import { RequestCache, type RequestCacheOptions } from "./request-cache";
import { downloadBackground } from "./background-attachment";
import { assertRevisionUnchanged, nextRevision } from "./revisions";

interface StoredAsset {
  id: string;
  name: string;
  mimeType: string;
  bytes?: ArrayBuffer;
  blob?: Blob;
}
interface SavedTemplate {
  template: TemplateBundle["template"];
  assets: StoredAsset[];
  summary: TemplateSummary;
}
interface SavedSourceTemplate {
  template: { id: string };
  sourceTemplate: TemplateBundle["template"];
  assets: StoredAsset[];
  updatedAt?: number;
}
interface StoredOutputAttachment {
  recordId: string;
  fieldId: string;
  name: string;
  createdAt: number;
  bytes?: ArrayBuffer;
  blob?: Blob;
  mimeType?: string;
}

async function toStoredAsset(asset: PosterAsset): Promise<StoredAsset> {
  return {
    id: asset.id,
    name: asset.name,
    mimeType: asset.mimeType,
    bytes: await asset.blob.arrayBuffer(),
  };
}
function fromStoredAsset(asset: StoredAsset): PosterAsset {
  return {
    id: asset.id,
    name: asset.name,
    mimeType: asset.mimeType,
    blob: asset.blob ?? new Blob([asset.bytes!], { type: asset.mimeType }),
  };
}
function fromStoredOutput(output: StoredOutputAttachment): OutputAttachment {
  return {
    recordId: output.recordId,
    fieldId: output.fieldId,
    name: output.name,
    createdAt: output.createdAt,
    blob: output.blob ?? new Blob([output.bytes!], { type: output.mimeType ?? "image/png" }),
  };
}
function storedOutputSize(output: StoredOutputAttachment): number {
  return output.blob?.size ?? output.bytes?.byteLength ?? 0;
}
function outputVersion(output: StoredOutputAttachment | undefined): string {
  return output ? `${output.createdAt}:${storedOutputSize(output)}` : "empty";
}

export interface LocalRepositoryOptions extends RequestCacheOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  fetcher?: typeof fetch;
}

const DEMO_BACKGROUND_FIELD = {
  id: "demo-background",
  name: "示例底图",
  kind: "attachment" as const,
};

function withDemoDisplayValues(record: DataRecord): DataRecord {
  return {
    ...record,
    displayValues: {
      ...record.values,
      poster: "",
      [DEMO_BACKGROUND_FIELD.id]: "clean-background.png",
    },
  };
}

function demoContext(): WorkspaceContext {
  return {
    tableId: "local-demo",
    tableName: "本地示例 · 招聘岗位（虚构）",
    selectedRecordId: "demo-1",
    fields: [
      { id: "job", name: "岗位", kind: "text" },
      { id: "location", name: "地点", kind: "text" },
      { id: "responsibilities", name: "职责", kind: "text" },
      { id: "benefits", name: "待遇", kind: "text" },
      { id: "contact", name: "联系人", kind: "text" },
      { id: "phone", name: "电话 / 微信", kind: "phone" },
      { id: "poster", name: "招聘海报", kind: "attachment" },
      DEMO_BACKGROUND_FIELD,
    ],
    records: [
      {
        id: "demo-1",
        label: "本地示例 · 门店伙伴",
        values: {
          job: "门店伙伴",
          location: "杭州 · 示例门店",
          responsibilities: "接待顾客，维护店面\n参与日常陈列与盘点",
          benefits: "弹性排班 · 成长培训",
          contact: "示例联系人",
          phone: "000-0000-0000",
        },
      },
      {
        id: "demo-2",
        label: "本地示例 · 设计助理",
        values: {
          job: "设计助理",
          location: "上海 · 示例工作室",
          responsibilities: "协助制作品牌物料\n整理设计素材",
          benefits: "双休 · 带薪年假",
          contact: "示例负责人",
          phone: "000-0000-0001",
        },
      },
      {
        id: "demo-3",
        label: "本地示例 · 仓储专员",
        values: {
          job: "仓储专员",
          location: "苏州 · 示例仓库",
          responsibilities: "收货验货，整理库存\n配合出库与盘点",
          benefits: "餐补 · 岗位培训",
          contact: "示例同事",
          phone: "000-0000-0002",
        },
      },
    ].map(withDemoDisplayValues),
  };
}

/** 本地演示使用浏览器原生结构化存储，Blob 不转换成 URL 或 base64。 */
export class LocalPosterRepository implements PosterRepository {
  readonly mode = "local" as const;
  private database?: Promise<IDBDatabase>;
  private disposed = false;
  private configuredSettingsTableId?: string;
  private cache: RequestCache;
  constructor(private readonly options: LocalRepositoryOptions = {}) {
    this.cache = new RequestCache(options);
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.cache.get(key, load).then((value) => structuredClone(value));
  }

  invalidate(): void {
    this.cache.invalidate();
    // 新代缓存与旧代嵌套读取隔离，旧请求仍可结束，但不再参与后续读取。
    this.cache = new RequestCache(this.options);
  }

  private open(): Promise<IDBDatabase> {
    if (this.disposed) return Promise.reject(new PosterError("STORAGE_ERROR", "本地存储已关闭。"));
    if (!this.database) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const factory = this.options.indexedDB ?? globalThis.indexedDB;
        if (!factory)
          return reject(new PosterError("STORAGE_ERROR", "当前浏览器不支持 IndexedDB。"));
        const request = factory.open(this.options.databaseName ?? "recruitment-poster-v1", 1);
        let blocked = false;
        request.onupgradeneeded = () => {
          request.result.createObjectStore("context");
          request.result.createObjectStore("templates", { keyPath: "template.id" });
          request.result.createObjectStore("outputs", { keyPath: ["recordId", "fieldId"] });
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(
            new PosterError("STORAGE_ERROR", "本地数据库升级被其他页面阻塞，请关闭旧页面后重试。"),
          );
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            if (this.database === opening) this.database = undefined;
          };
          if (blocked || this.disposed) {
            db.close();
            reject(new PosterError("STORAGE_ERROR", "本地存储已关闭。"));
          } else resolve(db);
        };
      });
      this.database = opening;
      void opening.catch(() => {
        if (this.database === opening) this.database = undefined;
      });
    }
    return this.database;
  }

  private async transaction<T>(
    store: string,
    mode: IDBTransactionMode,
    action: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    try {
      const db = await this.open();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("事务已中止"));
        action(
          tx.objectStore(store),
          (result) => {
            value = result;
          },
          (error) => {
            reject(error);
            tx.abort();
          },
        );
      });
    } catch (error) {
      if (error instanceof PosterError) throw error;
      throw new PosterError(
        "STORAGE_ERROR",
        `本地存储失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private update<Stored, Result>(
    storeName: string,
    key: IDBValidKey,
    mutate: (previous: Stored | undefined, store: IDBObjectStore) => Result,
  ): Promise<Result> {
    // 读取当前版本和读改写在一个事务内完成，跨实例共用 IndexedDB 的写入顺序。
    return this.transaction(storeName, "readwrite", (store, result, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          result(mutate(request.result, store));
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async listTables(): Promise<TableSummary[]> {
    const context = await this.loadContext();
    return [{ id: context.tableId, name: context.tableName }];
  }

  async listStorageTables(): Promise<TableSummary[]> {
    return [{ id: "local-settings", name: "本地示例配置" }];
  }

  async loadWorkspaceBinding(): Promise<WorkspaceBinding | null> {
    // 复用旧版 context 存储区；读取不生成默认绑定，也不改写已有工作区。
    const value = await this.transaction<unknown>("context", "readonly", (store, result) => {
      const request = store.get("workspace-binding");
      request.onsuccess = () => result(request.result);
    });
    return value === null || value === undefined ? null : normalizeWorkspaceBinding(value);
  }

  async saveWorkspaceBinding(binding: WorkspaceBinding): Promise<void> {
    const value = normalizeWorkspaceBinding(binding);
    await this.transaction<void>("context", "readwrite", (store, result) => {
      store.put(structuredClone(value), "workspace-binding");
      result(undefined);
    });
  }

  async initializeStorage(tableId?: string): Promise<StorageStatus> {
    if (tableId !== undefined && tableId !== "local-settings")
      throw new PosterError("INVALID_TEMPLATE", "本地示例配置表不存在。");
    if (tableId !== undefined) {
      await this.open();
      this.configuredSettingsTableId = tableId;
      this.invalidate();
      return { tableId, name: "本地示例配置", created: false };
    }
    // 沿用 context 存储区，不升级数据库，也不覆盖旧上下文、设置和素材。
    const status = await this.transaction<StorageStatus>(
      "context",
      "readwrite",
      (store, result) => {
        const request = store.get("storage-ready");
        request.onsuccess = () => {
          const status = {
            tableId: "local-settings",
            name: "本地示例配置",
            created: request.result === undefined,
          };
          store.put(true, "storage-ready");
          result(status);
        };
      },
    );
    this.configuredSettingsTableId = status.tableId;
    this.invalidate();
    return status;
  }

  async loadContext(tableId?: string, includeRecords = true): Promise<WorkspaceContext> {
    if (tableId !== undefined && tableId !== "local-demo")
      throw new PosterError("INVALID_TEMPLATE", "本地示例数据表不存在。");
    const context = await this.cached("context", () =>
      this.transaction<WorkspaceContext>("context", "readwrite", (store, result) => {
        const request = store.get("workspace");
        request.onsuccess = () => {
          const context: WorkspaceContext = request.result ?? demoContext();
          const missingBackground = !context.fields.some(
            (field) => field.id === DEMO_BACKGROUND_FIELD.id,
          );
          // 旧数据库只追加新字段，保留用户已有记录、字段顺序、模板和输出。
          if (missingBackground) context.fields.push({ ...DEMO_BACKGROUND_FIELD });
          if (!request.result || missingBackground) store.put(context, "workspace");
          result(context);
        };
      }),
    );
    return includeRecords ? context : { ...context, records: [], selectedRecordId: null };
  }

  async listRecords(tableId: string, pageToken = 0, pageSize = 50): Promise<RecordPage> {
    if (
      !Number.isSafeInteger(pageToken) ||
      pageToken < 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0
    )
      throw new PosterError("INVALID_TEMPLATE", "本地记录分页参数无效。");
    const context = await this.loadContext(tableId);
    const records = context.records.slice(pageToken, pageToken + pageSize),
      next = pageToken + records.length;
    return {
      records,
      hasMore: next < context.records.length,
      pageToken: next < context.records.length ? next : undefined,
      total: context.records.length,
    };
  }

  async loadBackground(recordId: string, fieldId: string, tableId: string): Promise<PosterAsset> {
    const cache = this.cache;
    const context = await this.loadContext();
    if (tableId !== context.tableId || !context.records.some((record) => record.id === recordId)) {
      throw new PosterError("INVALID_ASSET", "本地示例底图对应的数据表或记录不存在。");
    }
    if (fieldId !== DEMO_BACKGROUND_FIELD.id)
      throw new PosterError("INVALID_ASSET", "当前行底图附件为空，请选择示例底图字段。");
    return cache
      .get("demo-background", () =>
        downloadBackground(
          "/demo/clean-background.png",
          "clean-background.png",
          this.options.fetcher,
        ),
      )
      .then((asset) => structuredClone(asset));
  }

  async getTemplateSource(
    recordId: string,
    fieldId: string,
    tableId: string,
  ): Promise<TemplateSource> {
    const context = await this.loadContext();
    const record = context.records.find((item) => item.id === recordId);
    if (tableId !== context.tableId || !record || fieldId !== DEMO_BACKGROUND_FIELD.id)
      throw new PosterError("INVALID_ASSET", "请选择本地示例记录的示例底图字段。");
    return {
      tableId,
      tableName: context.tableName,
      recordId,
      recordName: record.label,
      backgroundFieldId: fieldId,
    };
  }

  private async sourceKey(source: TemplateSource): Promise<string> {
    await this.getTemplateSource(source.recordId, source.backgroundFieldId, source.tableId);
    return `source:${source.tableId}:${source.recordId}`;
  }

  async loadSourceTemplate(source: TemplateSource): Promise<TemplateBundle | null> {
    const key = await this.sourceKey(source);
    const saved = await this.transaction<SavedSourceTemplate | undefined>(
      "templates",
      "readonly",
      (store, result) => {
        const request = store.get(key);
        request.onsuccess = () => result(request.result);
      },
    );
    if (!saved) return null;
    const background = await this.loadBackground(
      source.recordId,
      source.backgroundFieldId,
      source.tableId,
    );
    const bundle = {
      template: { ...saved.sourceTemplate, backgroundId: background.id },
      assets: [background, ...saved.assets.map(fromStoredAsset)],
      revision: saved.updatedAt ?? 0,
    };
    validateBundle(bundle);
    return bundle;
  }

  async saveSourceTemplate(
    source: TemplateSource,
    bundle: TemplateBundle,
    expectedUpdatedAt?: number | null,
  ): Promise<number> {
    validateBundle(bundle);
    const key = await this.sourceKey(source);
    // 来源关联独立于普通模板 ID；只持久化配置与字体，底图继续从来源附件读取。
    const fontAssets = bundle.template.fontIds.map((id) =>
      bundle.assets.find((asset) => asset.id === id)!,
    );
    if (
      fontAssets.some(
        (asset) =>
          !["font/otf", "font/ttf", "font/woff", "font/woff2"].includes(asset.mimeType) ||
          asset.blob.size > 20 * 1024 * 1024,
      )
    ) {
      throw new PosterError("INVALID_ASSET", "来源模板只允许保存不超过 20 MB 的字体附件。");
    }
    const assets = await Promise.all(fontAssets.map(toStoredAsset));
    const updatedAt = await this.update<SavedSourceTemplate, number>(
      "templates",
      key,
      (previous, store) => {
        assertRevisionUnchanged(expectedUpdatedAt, previous?.updatedAt, "来源模板");
        const updatedAt = nextRevision(previous?.updatedAt);
        store.put({
          template: { id: key },
          sourceTemplate: bundle.template,
          assets,
          updatedAt,
        } satisfies SavedSourceTemplate);
        return updatedAt;
      },
    );
    this.invalidate();
    return updatedAt;
  }

  listTemplates(): Promise<TemplateSummary[]> {
    return this.cached("templates", () =>
      this.transaction<TemplateSummary[]>("templates", "readonly", (store, result) => {
        const request = store.getAll();
        request.onsuccess = () =>
          result(
            (request.result as (SavedTemplate | SavedSourceTemplate)[])
              .flatMap((item) => ("summary" in item ? [item.summary] : []))
              .sort((a, b) => b.updatedAt - a.updatedAt),
          );
      }),
    );
  }

  async loadTemplate(id: string): Promise<TemplateBundle> {
    const saved = await this.cached(`template:${id}`, () =>
      this.transaction<SavedTemplate | undefined>("templates", "readonly", (store, result) => {
        const request = store.get(id);
        request.onsuccess = () => result(request.result);
      }),
    );
    if (!saved) throw new PosterError("INVALID_TEMPLATE", "本地模板不存在。");
    return {
      template: saved.template,
      assets: saved.assets.map(fromStoredAsset),
      revision: saved.summary.updatedAt,
    };
  }

  async saveTemplate(
    bundle: TemplateBundle,
    expectedUpdatedAt?: number | null,
  ): Promise<TemplateSummary> {
    validateBundle(bundle);
    const storedAssets = await Promise.all(bundle.assets.map(toStoredAsset));
    const summary = await this.update<SavedTemplate, TemplateSummary>(
      "templates",
      bundle.template.id,
      (previous, store) => {
        assertRevisionUnchanged(expectedUpdatedAt, previous?.summary.updatedAt, "模板");
        const summary = {
          id: bundle.template.id,
          name: bundle.template.name,
          updatedAt: nextRevision(previous?.summary.updatedAt),
        };
        store.put({ template: bundle.template, assets: storedAssets, summary });
        return summary;
      },
    );
    this.invalidate();
    return summary;
  }

  async deleteTemplate(id: string, expectedUpdatedAt?: number | null): Promise<void> {
    await this.update<SavedTemplate, void>("templates", id, (previous, store) => {
      if (!previous) throw new PosterError("INVALID_TEMPLATE", "本地模板不存在。");
      assertRevisionUnchanged(expectedUpdatedAt, previous.summary.updatedAt, "模板");
      store.delete(id);
    });
    this.invalidate();
  }

  async readOutputVersion(recordId: string, fieldId: string, tableId?: string): Promise<string> {
    const context = await this.loadContext();
    if (tableId !== undefined && tableId !== context.tableId)
      throw new PosterError("INVALID_TEMPLATE", "本地示例不能读取其他数据表。");
    const output = await this.transaction<StoredOutputAttachment | undefined>(
      "outputs",
      "readonly",
      (store, result) => {
        const request = store.get([recordId, fieldId]);
        request.onsuccess = () => result(request.result);
      },
    );
    return outputVersion(output);
  }

  async writePng(
    recordId: string,
    fieldId: string,
    file: File,
    tableId?: string,
    expectedVersion?: string,
  ): Promise<void> {
    validatePng(file);
    const context = await this.loadContext();
    if (tableId !== undefined && tableId !== context.tableId)
      throw new PosterError("INVALID_TEMPLATE", "本地示例不能写入其他数据表。");
    if (!context.records.some((record) => record.id === recordId))
      throw new PosterError("INVALID_TEMPLATE", "示例记录不存在。");
    if (!context.fields.some((field) => field.id === fieldId && field.kind === "attachment"))
      throw new PosterError("INVALID_ASSET", "海报输出必须选择附件字段。");
    const bytes = await file.arrayBuffer();
    await this.update<StoredOutputAttachment, void>(
      "outputs",
      [recordId, fieldId],
      (previous, store) => {
        if (expectedVersion !== undefined && outputVersion(previous) !== expectedVersion)
          throw new PosterError(
            "WRITE_CONFLICT",
            "输出附件已被其他操作修改，请核对当前附件后再重试。",
          );
        store.put({
          recordId,
          fieldId,
          name: file.name,
          bytes,
          mimeType: file.type,
          createdAt: nextRevision(previous?.createdAt),
        });
      },
    );
    this.invalidate();
  }

  listOutputs(
    _recordId?: string,
    _fieldId?: string,
    _tableId?: string,
  ): Promise<OutputAttachment[]> {
    return this.cached("outputs", () =>
      this.transaction<OutputAttachment[]>("outputs", "readonly", (store, result) => {
        const request = store.getAll();
        request.onsuccess = () =>
          result((request.result as StoredOutputAttachment[]).map(fromStoredOutput));
      }),
    );
  }

  loadSettings(tableId: string): Promise<WorkspaceSettings | null> {
    // 本地只有一张合法配置表，持久化键沿用旧格式，缓存仍按所选存储表隔离。
    return this.cached(
      JSON.stringify(["settings", this.configuredSettingsTableId ?? "local-settings", tableId]),
      async () => {
        const value = await this.transaction<unknown>("context", "readonly", (store, result) => {
          const request = store.get(`settings:${tableId}`);
          request.onsuccess = () => result(request.result);
        });
        return value === undefined ? null : normalizeSettings(value, tableId);
      },
    );
  }

  async saveSettings(
    value: WorkspaceSettings,
    expectedUpdatedAt?: number | null,
  ): Promise<WorkspaceSettings> {
    const input = normalizeSettings(value);
    const settings = await this.update<unknown, WorkspaceSettings>(
      "context",
      `settings:${input.tableId}`,
      (previousValue, store) => {
        const previous =
          previousValue === undefined ? null : normalizeSettings(previousValue, input.tableId);
        assertRevisionUnchanged(expectedUpdatedAt, previous?.updatedAt, "工作区配置");
        const settings = { ...input, updatedAt: nextRevision(previous?.updatedAt) };
        store.put(settings, `settings:${settings.tableId}`);
        return settings;
      },
    );
    this.invalidate();
    return settings;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    void this.database?.then(
      (db) => db.close(),
      () => undefined,
    );
  }
}
