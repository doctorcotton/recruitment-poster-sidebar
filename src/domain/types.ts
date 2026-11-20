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
  /** 飞书主字段，其值就是记录名称；本地示例和旧数据可省略。 */
  isPrimary?: boolean;
  /** 查找引用字段指向的表；只有 kind 为 lookup 时才有值。 */
  refTableId?: string;
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
  /** 当前视图 ID；记录列表按该视图的顺序与筛选读取，缺失时退回全表顺序。 */
  viewId?: string;
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
  /** 绑定字段所属表；为空表示业务数据表，用于复用同一模板里的模板表文案。 */
  fieldTableId?: string | null;
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
  /** 可选声明；字体文件没有真斜体时由浏览器合成倾斜。 */
  italic?: boolean;
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
/** 数据行经查找引用字段定位到的模板行；配置、字体和底图都落在这一行上。 */
export interface TemplateSource {
  tableId: string;
  tableName: string;
  recordId: string;
  recordName: string;
  /** 模板表里存底图的附件字段。 */
  backgroundFieldId: string;
}
/** 模板行的只读字段值，供绑定到模板表的文字图层取值。 */
export interface TemplateRecordValues {
  fields: TableField[];
  values: Record<string, string>;
}
/** 模板表一行的轻量摘要，供模板页列表展示与切换。 */
export interface TemplateRowSummary {
  recordId: string;
  /** 模板表主字段值，也是列表里唯一展示的文本。 */
  label: string;
  /** 该行是否已有可解析的模板配置。 */
  configured: boolean;
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
  /** 数据表上指向模板表的查找引用字段，决定当前行使用哪个模板。 */
  templateFieldId?: string | null;
  /** 模板表上存底图的附件字段。 */
  templateBackgroundFieldId?: string | null;
  /** 旧配置的单表底图字段；仅用于兼容既有工作区。 */
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
  /** 传入 viewId 时按该视图的顺序与筛选读取，不传则读全表顺序。 */
  listRecords(
    tableId: string,
    pageToken?: number,
    pageSize?: number,
    viewId?: string,
  ): Promise<RecordPage>;
  /** 定位字段是数据表上的查找引用，底图字段来自模板表，两者不属于同一张表。 */
  getTemplateSource(
    recordId: string,
    locatorFieldId: string,
    tableId: string,
    backgroundFieldId: string,
  ): Promise<TemplateSource>;
  loadSourceTemplate(source: TemplateSource): Promise<TemplateBundle | null>;
  /** 只取模板行的底图附件；未保存配置的模板行也要贴真实底图。 */
  loadSourceBackground(source: TemplateSource): Promise<PosterAsset>;
  loadTemplateRecord(source: TemplateSource): Promise<TemplateRecordValues>;
  /** 列出模板表所有行；模板页直接选模板用，不经过数据行的查找引用。 */
  listTemplateRows(
    templateTableId: string,
    backgroundFieldId: string,
  ): Promise<TemplateRowSummary[]>;
  /** 按模板表行直接构造来源，绕过查找引用定位。 */
  getTemplateSourceByRow(
    templateTableId: string,
    recordId: string,
    backgroundFieldId: string,
  ): Promise<TemplateSource>;
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
