export type FieldKind =
  "text" | "number" | "select" | "phone" | "url" | "attachment" | "lookup" | "other";
export interface TableSummary {
  id: string;
  name: string;
}
export interface WorkspaceBinding {
  schemaVersion: 1;
  tableId: string;
  storageTableId: string;
}
export interface StorageStatus {
  tableId: string;
  name: string;
  created: boolean;
}
export interface TableField {
  id: string;
  name: string;
  kind: FieldKind;
}
export interface DataRecord {
  id: string;
  label: string;
  values: Record<string, string>;
  /** 主记录详情使用的完整只读文本，包含附件等非渲染字段；旧数据可省略。 */
  displayValues?: Record<string, string>;
}
export interface WorkspaceContext {
  tableId: string;
  tableName: string;
  fields: TableField[];
  records: DataRecord[];
  selectedRecordId: string | null;
}
export interface RecordPage {
  records: DataRecord[];
  hasMore: boolean;
  pageToken?: number;
  total?: number;
}

/** 字体和底图单独存为附件，模板 JSON 仅持有稳定资源标识。 */
export interface PosterAsset {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}
export interface TextBox {
  id: string;
  label: string;
  fieldId: string | null;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontId: string;
  fontSize: number;
  minFontSize: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  maxLines: number;
  /** 可选的向后兼容声明；锁定时禁止移动、缩放和属性修改。 */
  locked?: boolean;
}
export interface PosterTemplate {
  schemaVersion: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  backgroundId: string;
  /** 为空时使用模板素材，绑定时逐行读取附件或附件查找引用字段。 */
  backgroundFieldId?: string | null;
  fontIds: string[];
  boxes: TextBox[];
}
export interface TemplateBundle {
  template: PosterTemplate;
  assets: PosterAsset[];
  /** 仓储读取时的乐观修订号，不进入模板 JSON。 */ revision?: number;
}
export interface TemplateSource {
  tableId: string;
  tableName: string;
  recordId: string;
  recordName: string;
  backgroundFieldId: string;
}
export interface TemplateSummary {
  id: string;
  name: string;
  updatedAt: number;
}
export interface OutputAttachment {
  recordId: string;
  fieldId: string;
  name: string;
  blob: Blob;
  createdAt: number;
}
export interface OutputFile {
  id: string;
  name: string;
  loadBlob: () => Promise<Blob>;
}
export interface WorkspaceSettings {
  schemaVersion: 1;
  tableId: string;
  templateId: string | null;
  outputFieldId: string | null;
  backgroundFieldId?: string | null;
  /** 旧配置没有修订号；保存后由仓储生成。 */
  updatedAt?: number;
}

/** 领域只定义能力，飞书 SDK 与本地 IndexedDB 均由数据层适配。 */
export interface PosterRepository {
  readonly mode: "local" | "feishu";
  loadWorkspaceBinding(): Promise<WorkspaceBinding | null>;
  saveWorkspaceBinding(binding: WorkspaceBinding): Promise<void>;
  listTables(): Promise<TableSummary[]>;
  listStorageTables(): Promise<TableSummary[]>;
  initializeStorage(tableId?: string): Promise<StorageStatus>;
  loadContext(tableId?: string, includeRecords?: boolean): Promise<WorkspaceContext>;
  listRecords(tableId: string, pageToken?: number, pageSize?: number): Promise<RecordPage>;
  getTemplateSource(recordId: string, fieldId: string, tableId: string): Promise<TemplateSource>;
  loadSourceTemplate(source: TemplateSource): Promise<TemplateBundle | null>;
  saveSourceTemplate(
    source: TemplateSource,
    bundle: TemplateBundle,
    expectedUpdatedAt?: number | null,
  ): Promise<number>;
  loadBackground(recordId: string, fieldId: string, tableId: string): Promise<PosterAsset>;
  listTemplates(): Promise<TemplateSummary[]>;
  loadTemplate(id: string): Promise<TemplateBundle>;
  saveTemplate(bundle: TemplateBundle, expectedUpdatedAt?: number | null): Promise<TemplateSummary>;
  deleteTemplate(id: string, expectedUpdatedAt?: number | null): Promise<void>;
  readOutputVersion(recordId: string, fieldId: string, tableId?: string): Promise<string>;
  writePng(
    recordId: string,
    fieldId: string,
    file: File,
    tableId?: string,
    expectedVersion?: string,
  ): Promise<void>;
  loadSettings(tableId: string): Promise<WorkspaceSettings | null>;
  saveSettings(
    settings: WorkspaceSettings,
    expectedUpdatedAt?: number | null,
  ): Promise<WorkspaceSettings>;
  invalidate?(): void;
  listOutputs?(recordId?: string, fieldId?: string, tableId?: string): Promise<OutputAttachment[]>;
  listOutputFiles?(recordId: string, fieldId: string, tableId: string): Promise<OutputFile[]>;
  dispose?(): void;
}

export type PosterErrorCode =
  | "INVALID_TEMPLATE"
  | "INVALID_ASSET"
  | "FONT_LOAD_FAILED"
  | "TEXT_OVERFLOW"
  | "RENDER_FAILED"
  | "PERMISSION_DENIED"
  | "PLATFORM_ERROR"
  | "STORAGE_ERROR"
  | "REVISION_CONFLICT"
  | "WRITE_CONFLICT"
  | "WRITE_OUTCOME_UNKNOWN"
  | "CANCELLED";
export class PosterError extends Error {
  constructor(
    public readonly code: PosterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PosterError";
  }
}
