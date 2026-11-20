// @refresh reset
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Modal, Spin } from "./ui/semi";
import { IconSave, IconDownload, IconUndo, IconRedo } from "@douyinfe/semi-icons";
import type {
  DataRecord,
  PosterAsset,
  PosterRepository,
  PosterTemplate,
  TemplateBundle,
  TemplateSummary,
  TextBox,
  WorkspaceContext,
  TableSummary,
  StorageStatus,
  TableField,
  TemplateRecordValues,
  TemplateRowSummary,
  TemplateSource,
} from "./domain/types";
import { PosterError } from "./domain/types";
import { moveTextBox, normalizeTextBox, resizeTextBox } from "./domain/geometry";
import { createRepository, createPosterAsset } from "./data";
import { scopeValues } from "./domain/field-binding";
import {
  PRESET_FONT,
  TITLE_PRESET_FONT,
  withPresetFonts,
  loadDefaultBundle,
  prefetchPresetFont,
  hasPresetFontSubset,
  promotePresetFont,
  withCompletePresetFont,
  loadPresetFontUpgrade,
  loadTitlePresetFont,
} from "./data/preset-fonts";
import { withSourceBackground } from "./application/source-background";
import { createPosterRenderer } from "./rendering/canvas";
import { loadWorkspaceBootstrap } from "./domain/workspace-bootstrap";
import { observeSemiA11y } from "./app/semi-a11y";
import { OperationLock } from "./application/operation-lock";
import { resolvePosterActionState } from "./application/action-state";
import { hasUnsavedChanges } from "./application/draft-state";
import {
  runBatchWrite,
  summarizeBatch,
  canRetryBatchRow,
  type BatchRowResult,
} from "./application/batch-write";
import { recordPages } from "./domain/record-pages";
import { findUnwrittenRows, type UnwrittenPlan } from "./application/unwritten-write";
import { WorkspaceSetup } from "./features/workspace/WorkspaceSetup";
import { WorkspaceTabs, type WorkspaceTab } from "./features/shell/WorkspaceTabs";
import { TemplateListPanel } from "./features/template/TemplateListPanel";
import { TemplateSettingsPanel } from "./features/template/TemplateSettingsPanel";
import { UnsavedNavigationModal } from "./features/editor/UnsavedNavigationModal";
import { BatchPanel } from "./features/batch/BatchPanel";
import { MobileTabs } from "./features/editor/MobileTabs";
import { alignLayers, moveLayer, type LayerAlignment } from "./domain/layer-operations";
import { pruneTemplateAssets } from "./domain/template-assets";
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "./domain/limits";
import { useOutputFiles } from "./features/records/useOutputFiles";
import { readRecordTemplate, useRecordBackground } from "./features/records/useRecordBackground";
import { RecordPanel } from "./features/records/RecordPanel";
import { RecordWorkspace } from "./features/records/RecordWorkspace";
import { ReadOnlyPosterPreview } from "./features/records/ReadOnlyPosterPreview";
import { rebindTemplateAssetIds } from "./application/template-identity";

const EditorStage = lazy(() =>
  import("./ui/EditorStage").then((module) => ({ default: module.EditorStage })),
);

const FieldMappingPanel = lazy(() =>
  import("./features/editor/FieldMappingPanel").then((module) => ({
    default: module.FieldMappingPanel,
  })),
);

const SettingsPanel = lazy(() =>
  import("./features/settings/SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);

const PropertyPanel = lazy(() =>
  import("./features/editor/PropertyPanel").then((module) => ({ default: module.PropertyPanel })),
);

const LayerPanel = lazy(() =>
  import("./features/editor/LayerPanel").then((module) => ({ default: module.LayerPanel })),
);

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 110) || "招聘海报";
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadDefaultSourceDraft(repository: PosterRepository, source: TemplateSource) {
  let warning = "";
  const background = repository.loadSourceBackground(source).catch((error) => {
    warning = error instanceof Error ? error.message : "模板底图读取失败";
    return null;
  });
  const bundle = await loadDefaultBundle(background);
  return { bundle, warning };
}

/** 逐字段比较；并集覆盖新出现的可选键（如首次打开斜体）。 */
function sameTextBox(a: TextBox, b: TextBox): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key as keyof TextBox] === b[key as keyof TextBox]);
}

type PendingNavigation = { title: string; action: () => Promise<void> | void };
type WorkspacePage = WorkspaceTab | "mapping";
/** 模板页右栏的三个分区。 */
type RightTab = "properties" | "layers" | "settings";
const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: "properties", label: "属性" },
  { id: "layers", label: "图层" },
  { id: "settings", label: "模板设置" },
];

export default function App() {
  const [repository] = useState(createRepository);
  const [renderer] = useState(createPosterRenderer);
  const [starting, setStarting] = useState(true);
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [storageTables, setStorageTables] = useState<TableSummary[] | null>(null);
  const [storageChoice, setStorageChoice] = useState("");
  const [tableChoice, setTableChoice] = useState("");
  const [selectingTable, setSelectingTable] = useState(true);
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage>("records");
  // 字段映射是模板模块的二级页，顶层 tab 始终高亮所属模块。
  const activeTab: WorkspaceTab = workspacePage === "mapping" ? "template" : workspacePage;
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [template, setTemplate] = useState<PosterTemplate | null>(null);
  const [assets, setAssets] = useState<PosterAsset[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const [recordId, setRecordId] = useState<string | null>(null);
  const [recordPageToken, setRecordPageToken] = useState<number | undefined>(undefined);
  const [recordHasMore, setRecordHasMore] = useState(false);
  const [recordSearch, setRecordSearch] = useState("");
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [allTableRows, setAllTableRows] = useState<DataRecord[] | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [unwrittenPlan, setUnwrittenPlan] = useState<UnwrittenPlan | null>(null);
  const [outputFieldId, setOutputFieldId] = useState<string>("");
  const [outputRevision, setOutputRevision] = useState(0);
  const outputList = useOutputFiles(
    repository,
    context?.tableId,
    recordId,
    outputFieldId,
    outputRevision,
  );
  const [notice, setNotice] = useState<{
    kind: "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const [templateRevision, setTemplateRevision] = useState<number | null>(null);
  const settingsRevision = useRef<number | null>(null);
  const [renderError, setRenderError] = useState("");
  const [overflowIds, setOverflowIds] = useState<string[]>([]);
  const [savedStamp, setSavedStamp] = useState("");
  const [savedOutputFieldId, setSavedOutputFieldId] = useState("");
  /** 数据表上指向模板表的查找引用字段，决定当前行使用哪个模板。 */
  const [templateFieldId, setTemplateFieldId] = useState("");
  /** 模板表上存底图的附件字段。 */
  const [templateBackgroundFieldId, setTemplateBackgroundFieldId] = useState("");
  const [templateFields, setTemplateFields] = useState<TableField[]>([]);
  /** 模板页列出的模板表行与当前选中行；记录页不读这些状态。 */
  const [templateRows, setTemplateRows] = useState<TemplateRowSummary[]>([]);
  const [templatePageRowId, setTemplatePageRowId] = useState<string | null>(null);
  const [templatePageSource, setTemplatePageSource] = useState<TemplateSource | null>(null);
  const [templatePageRowValues, setTemplatePageRowValues] = useState<TemplateRecordValues | null>(
    null,
  );
  const [templatePageLoading, setTemplatePageLoading] = useState(false);
  const [templatePageError, setTemplatePageError] = useState("");
  /** 进入模板页前的记录页画布快照：定位行未配置时离开模板模块要用它归还画布。 */
  const templateReturn = useRef<{
    template: PosterTemplate | null;
    assets: PosterAsset[];
    savedStamp: string;
    templateRevision: number | null;
  } | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("properties");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResults, setBatchResults] = useState<BatchRowResult[]>([]);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [propertyPopup, setPropertyPopup] = useState<{ x: number; y: number } | null>(null);
  const propertyPanel = useRef<HTMLElement>(null);
  const propertyTrigger = useRef<HTMLElement | null>(null);
  const [mobileTab, setMobileTab] = useState("canvas");
  const [, setHistoryTick] = useState(0);
  const history = useRef<{ undo: PosterTemplate[]; redo: PosterTemplate[] }>({
    undo: [],
    redo: [],
  });
  const job = useRef<AbortController | null>(null);
  const lastTask = useRef<{
    rows: DataRecord[];
    tableId: string;
    fieldId: string;
    emptyOnly: boolean;
  } | null>(null);
  const operationLock = useRef(new OperationLock());
  const backgroundInput = useRef<HTMLInputElement>(null),
    fontInput = useRef<HTMLInputElement>(null),
    packageInput = useRef<HTMLInputElement>(null);
  const bundle = useMemo<TemplateBundle | null>(
    () => (template ? pruneTemplateAssets({ template, assets }) : null),
    [template, assets],
  );
  // 版式快照：与保存基线比对即可判断“用户是否真的改过”，撤销回原样也会自动回到干净状态。
  const templateStamp = useMemo(() => JSON.stringify(template), [template]);
  const records = context?.records;
  const fields = context?.fields;
  const record = useMemo(
    () => records?.find((item) => item.id === recordId) ?? null,
    [records, recordId],
  );
  const emptyValues = useMemo<Record<string, string>>(() => ({}), []);
  const selected = template?.boxes.find((item) => item.id === selectedId) ?? null;
  const attachmentFields = useMemo(
    () => fields?.filter((field) => field.kind === "attachment") ?? [],
    [fields],
  );
  const visibleRecords = useMemo(() => {
    const query = recordSearch.trim().toLocaleLowerCase();
    return (
      (query ? records?.filter((row) => row.label.toLocaleLowerCase().includes(query)) : records) ??
      []
    );
  }, [recordSearch, records]);
  const selectedRows = useMemo(
    () => records?.filter((row) => selectedRecordIds.has(row.id)) ?? [],
    [records, selectedRecordIds],
  );
  const backgroundKey = JSON.stringify([
    context?.tableId,
    recordId,
    templateFieldId,
    templateBackgroundFieldId,
  ]);
  const {
    templateSource,
    templateRecord,
    sourceKey,
    sourceError,
    sourceLoading,
    adoptInitialRead,
  } = useRecordBackground({
    repository,
    context,
    recordId,
    locatorFieldId: templateFieldId,
    backgroundFieldId: templateBackgroundFieldId,
    backgroundKey,
    prepareBundle: withPresetFonts,
    onRestore: (loaded) => {
      const stamp = JSON.stringify(loaded.template);
      // 多条记录常共用同一模板行：画布内容本来就一致时只同步素材与基线，
      // 不清空撤销栈、不把选中框拽回第一个框。
      if (stamp !== templateStamp) {
        setTemplate(loaded.template);
        selectCanvasBox(loaded.template.boxes[0]?.id ?? null);
        history.current = { undo: [], redo: [] };
      }
      setAssets(loaded.assets);
      setSavedStamp(stamp);
      setTemplateRevision(loaded.revision ?? 0);
    },
    onNewSource: (next, warning) => {
      // 新来源保留当前版式作为草稿，但底图和基线都换成该模板行的真实数据。
      if (next) {
        const stamp = JSON.stringify(next.template);
        // 同一模板行的多条记录内容一致：不重建画布，保留选中图层与撤销栈。
        if (stamp !== templateStamp) setTemplate(next.template);
        setAssets(next.assets);
        setTemplateRevision(null);
        // 被动切换来源本身不是用户修改：以换底图后的版式为基线，只有后续真实编辑才算未保存。
        setSavedStamp(stamp);
      } else {
        setTemplateRevision(null);
        setSavedStamp(templateStamp);
      }
      if (warning) setNotice({ kind: "warning", text: warning });
    },
    draftBundle: () => bundle,
  });
  // 字段映射页与模板页共用同一份手选行草稿，编辑目标与保存目标保持一致。
  const inTemplateModule = workspacePage === "template" || workspacePage === "mapping";
  /** 正在编辑的模板行：模板模块用手选行，记录页用查找引用定位到的行。 */
  const editingSource = inTemplateModule ? templatePageSource : templateSource;
  const editingReady = inTemplateModule
    ? Boolean(templatePageSource) && !templatePageLoading
    : Boolean(templateSource) && sourceKey === backgroundKey;
  // 数据行变量和模板行文案合成一张扁平值表，图层用绑定键各自取值。
  const values = useMemo(() => {
    const base = record?.values ?? emptyValues;
    const source = editingSource;
    const row = templatePageRowValues ?? templateRecord;
    return source && row ? { ...base, ...scopeValues(source.tableId, row.values) } : base;
  }, [record, editingSource, templatePageRowValues, templateRecord, emptyValues]);
  const stageBundle = bundle;
  const fontAssets = assets.filter((asset) => template?.fontIds.includes(asset.id));
  const fontOptions = fontAssets.map(({ id, name }) => ({
    value: id,
    label:
      [PRESET_FONT, TITLE_PRESET_FONT].find((font) => font.id === id)?.label ??
      name.replace(/\.(otf|ttf|woff2?)$/i, ""),
  }));
  if (!fontOptions.some((option) => option.value === TITLE_PRESET_FONT.id)) {
    fontOptions.push({ value: TITLE_PRESET_FONT.id, label: TITLE_PRESET_FONT.label });
  }
  const dirty = hasUnsavedChanges({
    templateStamp: template ? templateStamp : "",
    baselineStamp: savedStamp,
    outputFieldId,
    savedOutputFieldId,
  });
  const recordSourcePending =
    sourceLoading ||
    Boolean(
      recordId &&
      templateFieldId &&
      templateBackgroundFieldId &&
      sourceKey !== backgroundKey &&
      !sourceError,
    );
  const sourcePending = inTemplateModule ? templatePageLoading : recordSourcePending;
  const actions = resolvePosterActionState({
    busy,
    sourceLoading: sourcePending,
    sourceError,
    hasTemplate: Boolean(template && context),
    usesRecordBackground: Boolean(templateFieldId),
    hasRecord: Boolean(record),
    hasOutputField: attachmentFields.some((field) => field.id === outputFieldId),
    recordCount: context?.records.length ?? 0,
  });
  const editorDisabled = actions.editorDisabled;
  const controlsDisabled = Boolean(busy || sourcePending);
  // 模板表字段列表由定位字段的引用表推导，供设置页、属性面板与图层绑定共用。
  const templateTableId = useMemo(
    () => fields?.find((field) => field.id === templateFieldId)?.refTableId ?? null,
    [fields, templateFieldId],
  );
  // 右栏内联与右键浮窗共用一份属性面板属性；浮窗要独立渲染，窄屏才不会被右栏隐藏。
  const propertyPanelProps = {
    selected,
    values,
    fields: context?.fields ?? [],
    templateFields,
    templateTableId,
    fontOptions,
    disabled: controlsDisabled || Boolean(selected?.locked),
    canDownload: actions.canPreview,
    onClose: closeProperties,
    onCopy: copyBox,
    onDelete: deleteBox,
    onAdd: addBox,
    onChange: changeBox,
    onFontChange: changeFont,
    onDownload: () => previewPng(true),
  };

  useEffect(() => observeSemiA11y(), []);

  // 首屏先用常用字子集出图；完整字体到货后替换素材，画布随之重绘一次。
  useEffect(() => {
    if (!hasPresetFontSubset(assets)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const upgrade = (attemptsLeft: number) => {
      void loadPresetFontUpgrade()
        .then((full) => {
          if (!disposed) setAssets((current) => promotePresetFont(current, full));
        })
        .catch(() => {
          // 完整字体失败时画面停在子集上；隔一会儿自动再试一次，不让用户手动刷。
          if (disposed || attemptsLeft <= 0) return;
          timer = setTimeout(() => upgrade(attemptsLeft - 1), 2000);
        });
    };
    upgrade(1);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [assets]);

  // 模板列表统一两个数据源：启用模板表时列模板行，否则列本地/独立模板库。
  const templateListRows = useMemo<TemplateRowSummary[]>(
    () =>
      templateTableId
        ? templateRows
        : templates.map((item) => ({ recordId: item.id, label: item.name, configured: true })),
    [templateTableId, templateRows, templates],
  );
  const selectedTemplateRowIdForList = templateTableId ? templatePageRowId : (template?.id ?? null);
  function selectTemplateRow(recordId: string) {
    // 记录页来源还在定位时不接受手选：此时选中的行会被随后的来源加载覆盖。
    if (recordSourcePending) return;
    if (templateTableId) requestTemplateRowChange(recordId);
    else requestLoad(recordId);
  }

  useEffect(() => {
    const refTableId = fields?.find((field) => field.id === templateFieldId)?.refTableId;
    if (!refTableId) {
      setTemplateFields((current) => (current.length ? [] : current));
      return;
    }
    let disposed = false;
    void repository
      .loadContext(refTableId, false)
      .then((metadata) => {
        if (!disposed) setTemplateFields(metadata.fields);
      })
      .catch(() => {
        if (!disposed) setTemplateFields((current) => (current.length ? [] : current));
      });
    return () => {
      disposed = true;
    };
  }, [repository, fields, templateFieldId]);

  // 模板页的列表与选中行；记录页不参与这套状态。
  useEffect(() => {
    if (!templateTableId || !templateBackgroundFieldId) {
      setTemplateRows((current) => (current.length ? [] : current));
      return;
    }
    let disposed = false;
    void repository
      .listTemplateRows(templateTableId, templateBackgroundFieldId)
      .then((rows) => {
        if (!disposed) setTemplateRows(rows);
      })
      .catch(() => {
        if (!disposed) setTemplateRows((current) => (current.length ? [] : current));
      });
    return () => {
      disposed = true;
    };
  }, [repository, templateTableId, templateBackgroundFieldId]);

  // 进入模板页时默认选中记录页定位到的模板行，否则取列表第一行。
  useEffect(() => {
    if (workspacePage !== "template" || !templateTableId || !templateBackgroundFieldId) return;
    if (templatePageRowId && templateRows.some((row) => row.recordId === templatePageRowId)) return;
    // 记录页来源还在定位时不抢选：等 templateSource 落定再选，避免它随后覆盖画布造成选行错位。
    if (recordSourcePending) return;
    const fromRecord =
      templateSource && templateRows.some((row) => row.recordId === templateSource.recordId)
        ? templateSource.recordId
        : null;
    const initial = fromRecord ?? templateRows[0]?.recordId ?? null;
    if (initial) setTemplatePageRowId(initial);
  }, [
    workspacePage,
    templateTableId,
    templateBackgroundFieldId,
    templateRows,
    templatePageRowId,
    templateSource,
    recordSourcePending,
  ]);

  // 选中行变化时把该行的配置载入编辑器；未配置的行从默认版式开始。
  useEffect(() => {
    if (workspacePage !== "template" || !templateTableId || !templateBackgroundFieldId) return;
    if (!templatePageRowId || templatePageSource?.recordId === templatePageRowId) return;
    let disposed = false;
    let firstBoxId: string | null = null;
    setTemplatePageLoading(true);
    setTemplatePageError("");
    void (async () => {
      const source = await repository.getTemplateSourceByRow(
        templateTableId,
        templatePageRowId,
        templateBackgroundFieldId,
      );
      if (disposed) return;
      // 行值与已保存配置互不依赖，并行读取可省掉一次串行往返。
      const [rowValues, saved] = await Promise.all([
        repository.loadTemplateRecord(source),
        repository.loadSourceTemplate(source),
      ]);
      if (disposed) return;
      if (saved) {
        const loaded = await withPresetFonts(saved);
        if (disposed) return;
        firstBoxId = loaded.template.boxes[0]?.id ?? null;
        setTemplate(loaded.template);
        setAssets(loaded.assets);
        setSavedStamp(JSON.stringify(loaded.template));
        setTemplateRevision(loaded.revision ?? 0);
      } else {
        const draft = await loadDefaultSourceDraft(repository, source);
        if (disposed) return;
        // 未配置的模板行从默认版式开始，底图取当前行附件。
        draft.bundle.template.id = `recruitment-${source.recordId}`;
        firstBoxId = draft.bundle.template.boxes[0]?.id ?? null;
        setTemplate(draft.bundle.template);
        setAssets(draft.bundle.assets);
        // 选中未配置模板行是浏览动作，落好底图的版式即为该行草稿的基线。
        setSavedStamp(JSON.stringify(draft.bundle.template));
        setTemplateRevision(null);
        if (draft.warning) setNotice({ kind: "warning", text: draft.warning });
      }
      setTemplatePageRowValues(rowValues);
      setTemplatePageSource(source);
      // 与记录页恢复一致：默认选中第一个图层，属性面板才有可编辑对象。
      selectCanvasBox(firstBoxId);
      history.current = { undo: [], redo: [] };
    })()
      .catch((error) => {
        if (!disposed)
          setTemplatePageError(error instanceof Error ? error.message : "模板行读取失败");
      })
      .finally(() => {
        if (!disposed) setTemplatePageLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    workspacePage,
    repository,
    templateTableId,
    templateBackgroundFieldId,
    templatePageRowId,
    templatePageSource,
  ]);

  // 离开模板模块（含字段映射页）后清掉手选行，编辑器回到记录页由查找引用定位的模板。
  useEffect(() => {
    if (workspacePage === "template" || workspacePage === "mapping") return;
    setTemplatePageRowId(null);
    setTemplatePageSource(null);
    setTemplatePageRowValues(null);
    setTemplatePageError("");
  }, [workspacePage]);

  useEffect(() => {
    let disposed = false;
    const onWindowError = (event: ErrorEvent) =>
      console.error({
        event: "poster.window_error",
        operationId: crypto.randomUUID(),
        message: event.message,
      });
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { code?: unknown; message?: unknown } | undefined;
      console.error({
        event: "poster.unhandled_rejection",
        operationId: crypto.randomUUID(),
        code: String(reason?.code ?? "FAILED"),
        message: String(reason?.message ?? reason ?? "未知异常"),
      });
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    void (async () => {
      const {
        tables: list,
        storageTables: stores,
        binding,
        errors,
      } = await loadWorkspaceBootstrap(repository);
      if (disposed) return;
      setTables(list);
      setStorageTables(stores);
      setTableChoice(list.length === 1 ? list[0].id : "");
      setStorageChoice(repository.mode === "local" && stores.length === 1 ? stores[0].id : "");
      if (errors.length) {
        setNotice({
          kind: "error",
          text: `${errors.join("；")}。可重新选择业务表和配置表修复连接。`,
        });
        return;
      }
      if (binding) {
        setTableChoice(binding.tableId);
        setStorageChoice(binding.storageTableId);
        // 已固定的 ID 失效时明确报错，不能换成另一张表或自动新建。
        if (
          !list.some((table) => table.id === binding.tableId) ||
          !stores.some((table) => table.id === binding.storageTableId)
        )
          throw new Error("已保存的业务表或配置表不存在，请重新选择");
        await openWorkspace(binding.tableId, binding.storageTableId, true);
      }
    })()
      .catch((error) => {
        if (!disposed) {
          setTables((current) => current ?? []);
          setStorageTables((current) => current ?? []);
          setNotice({ kind: "error", text: error.message ?? "读取已保存配置失败" });
        }
      })
      .finally(() => {
        if (!disposed) setStarting(false);
      });
    return () => {
      disposed = true;
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
      job.current?.abort();
      repository.dispose?.();
      renderer.dispose();
    };
    // 启动 effect 只随组合根实例执行；openWorkspace 使用同一轮闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository, renderer]);

  async function openWorkspace(tableId: string, configTableId = storageChoice, restoring = false) {
    if (!tableId || !configTableId || tableId === configTableId) return;
    // 字体体积最大也最先用得上：与后面的元数据、记录读取并行下载，不排在串行往返之后。
    prefetchPresetFont();
    await run("open-table", async ({ details }) => {
      const started = performance.now();
      // 业务表和配置表分别指定；只有用户明确选择"新建"才允许创建配置表。
      const storage = await repository.initializeStorage(
        configTableId === "__new__" ? undefined : configTableId,
      );
      repository.invalidate?.();
      // 模板库和配置读取与记录分页并行，记录列表无需等它们返回。
      const catalog = Promise.all([repository.listTemplates(), repository.loadSettings(tableId)]);
      void catalog.catch(() => {});
      const metadata = await repository.loadContext(tableId, false);
      const firstPage = await repository.listRecords(tableId, undefined, 50, metadata.viewId);
      const workspace = {
        ...metadata,
        records: firstPage.records,
        selectedRecordId: firstPage.records[0]?.id ?? null,
      };
      // 首屏记录与素材下载解耦，字体或底图较慢时仍可阅读业务字段。
      setContext(workspace);
      setTemplate(null);
      setAssets([]);
      setTemplateFieldId("");
      setTemplateBackgroundFieldId("");
      setTemplateFields([]);
      setOutputFieldId("");
      setRecordId(workspace.selectedRecordId);
      setRecordPageToken(firstPage.pageToken);
      setRecordHasMore(firstPage.hasMore);
      setRecordSearch("");
      setSelectedRecordIds(new Set());
      setBatchOpen(false);
      setBatchResults([]);
      setProgress(null);
      lastTask.current = null;
      setAllTableRows(null);
      setUnwrittenPlan(null);
      setPropertyPopup(null);
      setRenderError("");
      setOverflowIds([]);
      setStorageStatus(storage);
      setStorageChoice(storage.tableId);
      setStorageTables((current) =>
        current?.some((table) => table.id === storage.tableId)
          ? current
          : [...(current ?? []), { id: storage.tableId, name: storage.name }],
      );
      setSelectingTable(false);
      setWorkspacePage("records");
      setStarting(false);
      details.recordsReadyMs = Math.round(performance.now() - started);
      const [saved, settings] = await catalog;
      setTemplates(saved);
      const savedTemplate =
        settings?.templateId && saved.some((item) => item.id === settings.templateId)
          ? settings.templateId
          : undefined;
      // 区分「旧配置没有该键」与「用户明确选了不启用」：null 是显式关闭，不能被自动探测推翻。
      const locatorFieldId =
        settings && settings.templateFieldId !== undefined
          ? (settings.templateFieldId ?? "")
          : repository.mode === "feishu"
            ? (workspace.fields.find((field) => field.kind === "lookup" && field.refTableId)?.id ??
              "")
            : "";
      let backgroundFieldId = settings?.templateBackgroundFieldId ?? "";
      const refTableId = workspace.fields.find((field) => field.id === locatorFieldId)?.refTableId;
      if (refTableId && !backgroundFieldId) {
        // 模板底图列名不写死：先按名称含“底图”的附件字段兜底，用户仍可在设置页改。
        const templateMetadata = await repository.loadContext(refTableId, false);
        backgroundFieldId =
          templateMetadata.fields.find(
            (field) => field.kind === "attachment" && field.name.includes("底图"),
          )?.id ?? "";
        setTemplateFields(templateMetadata.fields);
      }
      const currentRecordId = workspace.selectedRecordId;
      let initialSource: Awaited<ReturnType<typeof readRecordTemplate>> | null = null;
      let initialSourceError = "";
      if (currentRecordId && locatorFieldId && backgroundFieldId) {
        const sourceStarted = performance.now();
        try {
          initialSource = await readRecordTemplate(
            repository,
            currentRecordId,
            locatorFieldId,
            workspace.tableId,
            backgroundFieldId,
          );
        } catch (error) {
          initialSourceError = error instanceof Error ? error.message : "模板来源读取失败";
        }
        details.sourceReadyMs = Math.round(performance.now() - sourceStarted);
      }

      let initial: TemplateBundle;
      if (initialSource?.saved) {
        initial = await withPresetFonts(initialSource.saved);
      } else if (savedTemplate) {
        initial = await withPresetFonts(await repository.loadTemplate(savedTemplate));
        initial.template.backgroundFieldId = null;
        if (initialSource) {
          const draft = await withSourceBackground(repository, initial, initialSource.source);
          initial = draft.bundle;
          if (draft.warning) setNotice({ kind: "warning", text: draft.warning });
        }
      } else {
        const draft = initialSource
          ? await loadDefaultSourceDraft(repository, initialSource.source)
          : { bundle: await loadDefaultBundle(), warning: "" };
        initial = draft.bundle;
        initial.template.id = `recruitment-${workspace.tableId}`;
        if (repository.mode === "feishu")
          initial.template.boxes = initial.template.boxes.map((box) => ({
            ...box,
            fieldId: workspace.fields.find((field) => field.name === box.label)?.id ?? null,
          }));
        if (draft.warning) setNotice({ kind: "warning", text: draft.warning });
      }
      const targets = workspace.fields.filter((field) => field.kind === "attachment");
      // 旧配置里的目标缺失或失效时，由用户重新绑定，避免改写其他附件列。
      const output = settings
        ? (targets.find((field) => field.id === settings.outputFieldId)?.id ?? "")
        : (targets[0]?.id ?? "");
      const currentSettings =
        settings ??
        (await repository.saveSettings(
          {
            schemaVersion: 1,
            tableId: workspace.tableId,
            templateId: savedTemplate ?? null,
            outputFieldId: output || null,
            templateFieldId: locatorFieldId || null,
            templateBackgroundFieldId: backgroundFieldId || null,
          },
          null,
        ));
      if (!restoring)
        await repository.saveWorkspaceBinding({
          schemaVersion: 1,
          tableId: workspace.tableId,
          storageTableId: storage.tableId,
        });
      if (currentRecordId && locatorFieldId && backgroundFieldId)
        adoptInitialRead(
          JSON.stringify([workspace.tableId, currentRecordId, locatorFieldId, backgroundFieldId]),
          workspace.fields,
          initialSource,
          initialSourceError,
        );
      setTemplateFieldId(locatorFieldId);
      setTemplateBackgroundFieldId(backgroundFieldId);
      setTemplate(initial.template);
      setAssets(initial.assets);
      setSelectedId(initial.template.boxes[0]?.id ?? null);
      setOutputFieldId(output);
      setSavedOutputFieldId(output);
      setTemplateRevision(
        initialSource && !initialSource.saved ? null : (initial.revision ?? null),
      );
      settingsRevision.current = currentSettings?.updatedAt ?? (currentSettings ? 0 : null);
      setSavedStamp(JSON.stringify(initial.template));
      history.current = { undo: [], redo: [] };
      setSelectedLayerIds(new Set());
      setOutputRevision((value) => value + 1);
      details.templateReadyMs = Math.round(performance.now() - started);
    });
  }
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  // 复用同一属性面板，右键只改变展示位置，字段绑定和编辑规则仍只有一份。
  function openProperties(id: string, x: number, y: number) {
    propertyTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(id);
    // 属性浮窗挂在「属性」分区里，先切过去再定位。
    setRightTab("properties");
    const width = Math.min(304, window.innerWidth - 24),
      height = Math.min(640, window.innerHeight - 24);
    setPropertyPopup({
      x: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - height - 12)),
    });
    requestAnimationFrame(() => propertyPanel.current?.focus());
  }
  function closeProperties() {
    setPropertyPopup(null);
    requestAnimationFrame(() => propertyTrigger.current?.focus());
  }
  useEffect(() => {
    if (!propertyPopup) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // Semi 下拉选项挂在 body 的 portal 中，选字段时不能被当作点击外部。
      if (!propertyPanel.current?.contains(target) && !target.closest(".semi-portal"))
        setPropertyPopup(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeProperties();
    };
    const resize = () => setPropertyPopup(null);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [propertyPopup]);

  function checkpoint() {
    if (!template) return;
    history.current.undo = [...history.current.undo.slice(-39), structuredClone(template)];
    history.current.redo = [];
    setHistoryTick((value) => value + 1);
  }
  function edit(change: (current: PosterTemplate) => PosterTemplate, remember = true) {
    if (!template || editorDisabled) return;
    const next = change(template);
    // 没有实际变化就不记历史、不重渲染，拖拽每帧的重复事件不会撑大撤销栈。
    if (next === template) return;
    if (remember) checkpoint();
    setTemplate(next);
  }
  function changeBox(id: string, updates: Partial<TextBox>, remember = false) {
    edit((current) => {
      const box = current.boxes.find((item) => item.id === id);
      if (!box || box.locked) return current;
      // 面板、拖拽、缩放手柄和键盘微调都经过同一个量化与边界收拢点。
      const normalized = normalizeTextBox({ ...box, ...updates });
      const next = moveTextBox(
        resizeTextBox(normalized, normalized.width, normalized.height, current),
        0,
        0,
        current,
      );
      // 可选字段（斜体等）首次设置会新增键，比较必须覆盖两边的键并集。
      const unchanged = sameTextBox(box, next);
      return unchanged
        ? current
        : { ...current, boxes: current.boxes.map((item) => (item.id === id ? next : item)) };
    }, remember);
  }
  function selectLayer(id: string) {
    setSelectedId(id);
    setSelectedLayerIds(new Set([id]));
    setMobileTab("properties");
  }
  function selectCanvasBox(id: string | null) {
    setSelectedId(id);
    setSelectedLayerIds(new Set(id ? [id] : []));
  }
  function toggleLayerSelection(id: string) {
    const next = new Set(selectedLayerIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedLayerIds(next);
    if (selectedId === id || !selectedId) setSelectedId(next.has(id) ? id : ([...next][0] ?? null));
  }
  function toggleLayerLock(id: string) {
    edit((current) => ({
      ...current,
      boxes: current.boxes.map((box) => (box.id === id ? { ...box, locked: !box.locked } : box)),
    }));
  }
  function moveSelectedLayer(id: string, direction: -1 | 1) {
    edit((current) => moveLayer(current, id, direction));
  }
  function alignSelectedLayers(operation: LayerAlignment) {
    edit((current) => alignLayers(current, selectedLayerIds, operation));
  }
  const undo = useCallback(() => {
    if (!template || !history.current.undo.length || editorDisabled) return;
    history.current.redo.push(structuredClone(template));
    setTemplate(history.current.undo.pop()!);
    setHistoryTick((value) => value + 1);
  }, [template, editorDisabled]);
  const redo = useCallback(() => {
    if (!template || !history.current.redo.length || editorDisabled) return;
    history.current.undo.push(structuredClone(template));
    setTemplate(history.current.redo.pop()!);
    setHistoryTick((value) => value + 1);
  }, [template, editorDisabled]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (workspacePage === "records") return;
      const target = event.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [undo, redo, workspacePage]);

  async function run(
    label: string,
    action: (telemetry: {
      details: Record<string, string | number | boolean | undefined>;
    }) => Promise<void>,
  ): Promise<boolean> {
    const release = operationLock.current.tryAcquire();
    if (!release) return false;
    const started = performance.now(),
      operationId = crypto.randomUUID(),
      details: Record<string, string | number | boolean | undefined> = {};
    let status = "ok";
    setBusy(label);
    setNotice(null);
    try {
      await action({ details });
      return true;
    } catch (error) {
      status = error instanceof PosterError ? error.code : "FAILED";
      const platformCode =
        error && typeof error === "object" && "platformCode" in error
          ? String(error.platformCode ?? "")
          : "";
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? Boolean(error.retryable)
          : undefined;
      details.platformCode = platformCode || undefined;
      details.retryable = retryable;
      const message = error instanceof Error ? error.message : "操作失败，请重试";
      setNotice({ kind: "error", text: `${message}（诊断号 ${operationId.slice(0, 8)}）` });
      return false;
    } finally {
      console.info({
        event: "poster.operation",
        operationId,
        operation: label,
        mode: repository.mode,
        status,
        elapsedMs: Math.round(performance.now() - started),
        ...details,
      });
      release();
      setBusy(null);
      job.current = null;
    }
  }

  function guardTemplateReplacement(title: string, action: () => Promise<void> | void) {
    if (!dirty) {
      void action();
      return;
    }
    setPendingNavigation({ title, action });
  }

  async function saveAndContinue() {
    if (!pendingNavigation) return;
    const next = pendingNavigation;
    if (await save()) {
      setPendingNavigation(null);
      await next.action();
    }
  }

  function discardAndContinue() {
    const next = pendingNavigation;
    setPendingNavigation(null);
    if (next) void next.action();
  }

  async function save(): Promise<boolean> {
    if (!bundle) return false;
    return await run("save", async () => {
      // 子集字体只用于预览：落库前必须换成完整字体，否则以后打开只剩常用字。
      const savedBundle = await withCompletePresetFont(bundle);
      if (templateFieldId) {
        if (!templateBackgroundFieldId)
          throw new Error("请先在「设置」里选择模板底图字段，再保存模板");
        if (!editingSource || !editingReady)
          throw new Error(templatePageError || sourceError || "模板行还未就绪，请等待或刷新");
        const revision = await repository.saveSourceTemplate(
          editingSource,
          savedBundle,
          templateRevision,
        );
        setTemplateRevision(revision);
        // 保存后该行变成已配置，列表状态同步刷新。
        if (templateTableId && templateBackgroundFieldId)
          setTemplateRows(
            await repository.listTemplateRows(templateTableId, templateBackgroundFieldId),
          );
      } else {
        const summary = await repository.saveTemplate(savedBundle, templateRevision);
        setTemplateRevision(summary.updatedAt);
        setTemplates(await repository.listTemplates());
      }
      // 两个存储位置不是事务：每一步确认后立即更新对应状态，避免部分成功被误报成全部未保存。
      const savedSettings = await repository.saveSettings(
        {
          schemaVersion: 1,
          tableId: context!.tableId,
          templateId: bundle.template.id,
          outputFieldId: outputFieldId || null,
          templateFieldId: templateFieldId || null,
          templateBackgroundFieldId: templateBackgroundFieldId || null,
        },
        settingsRevision.current,
      );
      settingsRevision.current = savedSettings.updatedAt ?? 0;
      setSavedOutputFieldId(outputFieldId);
      setSavedStamp(JSON.stringify(bundle.template));
      setNotice({
        kind: "success",
        text: editingSource
          ? "模板、字体和绑定已保存到模板表记录"
          : repository.mode === "local"
            ? "模板已保存到本地示例库"
            : "模板和素材已保存到多维表",
      });
    });
  }
  async function load(id: string) {
    return await run("load", async () => {
      const next = await withPresetFonts(await repository.loadTemplate(id));
      const savedSettings = await repository.saveSettings(
        {
          schemaVersion: 1,
          tableId: context!.tableId,
          templateId: id,
          outputFieldId: outputFieldId || null,
          templateFieldId: templateFieldId || null,
          templateBackgroundFieldId: templateBackgroundFieldId || null,
        },
        settingsRevision.current,
      );
      settingsRevision.current = savedSettings.updatedAt ?? 0;
      setSavedOutputFieldId(outputFieldId);
      setTemplate(next.template);
      setAssets(next.assets);
      selectCanvasBox(next.template.boxes[0]?.id ?? null);
      setTemplateRevision(next.revision ?? 0);
      setSavedStamp(JSON.stringify(next.template));
      history.current = { undo: [], redo: [] };
    });
  }
  function requestLoad(id: string) {
    guardTemplateReplacement("切换模板", async () => {
      await load(id);
    });
  }
  function addBox() {
    if (!template) return;
    const x = Math.min(80, Math.floor(template.width / 10));
    const y = Math.min(120, Math.floor(template.height / 10));
    const id = crypto.randomUUID();
    edit((current) => ({
      ...current,
      boxes: [
        ...current.boxes,
        {
          id,
          label: "新文字",
          fieldId: null,
          text: "输入文字",
          x,
          y,
          width: Math.min(400, current.width - x),
          height: Math.min(80, current.height - y),
          fontId: current.fontIds[0],
          fontSize: 36,
          minFontSize: 16,
          color: "#15191c",
          align: "left",
          lineHeight: 1.25,
          maxLines: 2,
        },
      ],
    }));
    setSelectedId(id);
    setSelectedLayerIds(new Set([id]));
    setMobileTab("properties");
  }
  function copyTemplate() {
    if (!template) return;
    checkpoint();
    setTemplate({
      ...structuredClone(template),
      id: crypto.randomUUID(),
      name: `${template.name} 副本`,
    });
    setTemplateRevision(null);
    setSavedStamp("");
  }
  function requestCopyTemplate() {
    guardTemplateReplacement("新建模板", copyTemplate);
  }

  async function confirmDeleteTemplate() {
    if (!template || !context || templateFieldId) return;
    const id = template.id;
    let nextId: string | null = null;
    const succeeded = await run("delete-template", async () => {
      await repository.deleteTemplate(id, templateRevision);
      const remaining = await repository.listTemplates();
      setTemplates(remaining);
      nextId = remaining[0]?.id ?? null;
      if (!nextId) {
        const initial = await withPresetFonts(await loadDefaultBundle());
        initial.template.id = `recruitment-${context.tableId}`;
        const savedSettings = await repository.saveSettings(
          {
            schemaVersion: 1,
            tableId: context.tableId,
            templateId: null,
            outputFieldId: outputFieldId || null,
            templateFieldId: templateFieldId || null,
            templateBackgroundFieldId: templateBackgroundFieldId || null,
          },
          settingsRevision.current,
        );
        settingsRevision.current = savedSettings.updatedAt ?? 0;
        setTemplate(initial.template);
        setAssets(initial.assets);
        setTemplateRevision(null);
        setSavedStamp("");
        setSelectedId(initial.template.boxes[0]?.id ?? null);
        history.current = { undo: [], redo: [] };
      }
      setDeletingTemplate(false);
    });
    if (succeeded) {
      if (nextId && !(await load(nextId))) return;
      setNotice({ kind: "success", text: "模板已删除" });
    }
  }
  function copyBox() {
    if (!selected) return;
    const id = crypto.randomUUID();
    edit((current) => ({
      ...current,
      boxes: [
        ...current.boxes,
        {
          ...moveTextBox(selected, 20, 20, current),
          id,
          label: `${selected.label} 副本`,
          locked: false,
        },
      ],
    }));
    selectCanvasBox(id);
  }
  function deleteBox() {
    if (!selected || selected.locked) return;
    edit((current) => ({
      ...current,
      boxes: current.boxes.filter((box) => box.id !== selected.id),
    }));
    selectCanvasBox(null);
  }

  function attachFont(asset: PosterAsset, boxId: string | null) {
    edit((current) => ({
      ...current,
      fontIds: Array.from(new Set([...current.fontIds, asset.id])),
      boxes: current.boxes.map((box) => (box.id === boxId ? { ...box, fontId: asset.id } : box)),
    }));
    setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
  }

  function changeFont(boxId: string, fontId: string) {
    if (editorDisabled || !template?.boxes.some((box) => box.id === boxId && !box.locked)) return;
    if (fontId === TITLE_PRESET_FONT.id && !fontAssets.some((asset) => asset.id === fontId)) {
      void run("load-preset-font", async () => {
        attachFont(await loadTitlePresetFont(), boxId);
      });
      return;
    }
    changeBox(boxId, { fontId }, true);
  }

  async function upload(file: File | undefined, kind: "background" | "font") {
    if (!file || !template || editorDisabled) return;
    await run(kind, async () => {
      const asset = await createPosterAsset(file);
      if (kind === "font") {
        if (!/\.(otf|ttf|woff2?)$/i.test(file.name))
          throw new Error("请选择 OTF、TTF、WOFF 或 WOFF2 字体");
        try {
          await new FontFace(`check-${asset.id}`, await file.arrayBuffer()).load();
        } catch {
          throw new Error("字体文件无法读取，请选择有效的 OTF、TTF、WOFF 或 WOFF2 字体");
        }
        attachFont(asset, selectedId);
      } else {
        const bitmap = await createImageBitmap(asset.blob);
        const width = bitmap.width,
          height = bitmap.height;
        bitmap.close();
        if (width * height > MAX_IMAGE_PIXELS || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
          throw new Error("底图尺寸过大");
        checkpoint();
        const sx = width / template.width,
          sy = height / template.height;
        setTemplate((current) =>
          current
            ? {
                ...current,
                width,
                height,
                backgroundId: asset.id,
                // 换底图时文字框跟着画布等比缩放，量化规则与手工编辑保持一致。
                boxes: current.boxes.map((box) => {
                  const scaled = normalizeTextBox({
                    ...box,
                    x: box.x * sx,
                    y: box.y * sy,
                    width: box.width * sx,
                    height: box.height * sy,
                    fontSize: Math.max(8, box.fontSize * sx),
                    minFontSize: Math.max(8, box.minFontSize * sx),
                  });
                  return moveTextBox(scaled, 0, 0, { width, height });
                }),
              }
            : current,
        );
        setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      }
      setNotice({ kind: "success", text: kind === "font" ? "字体已加载" : "底图已更新" });
    });
  }

  async function exportTemplate() {
    if (!bundle) return;
    await run("export-template", async () => {
      const { createTemplatePackage } = await import("./application/template-package");
      // 导出的模板包要带完整字体，不能把预览子集发给别人。
      const packed = await createTemplatePackage(await withCompletePresetFont(bundle));
      downloadBlob(packed, `${safeFilename(bundle.template.name)}.poster.zip`);
      setNotice({ kind: "success", text: "模板包已导出，包含声明 JSON 和原始素材" });
    });
  }

  async function importTemplate(file: File | undefined) {
    if (!file) return;
    await run("import-template", async () => {
      const { parseTemplatePackage } = await import("./application/template-package");
      const parsed = await parseTemplatePackage(file);
      const idMap = new Map<string, string>();
      const importedAssets: PosterAsset[] = [];
      for (const asset of parsed.assets) {
        const imported = await createPosterAsset(
          new File([asset.blob], asset.name, { type: asset.mimeType }),
        );
        idMap.set(asset.id, imported.id);
        if (!importedAssets.some((item) => item.id === imported.id)) importedAssets.push(imported);
      }
      const next = rebindTemplateAssetIds(
        parsed.template,
        idMap,
        crypto.randomUUID(),
        `${parsed.template.name} 导入`,
      );
      setTemplate(next);
      setAssets(importedAssets);
      // 模板表模式下导入会写到当前模板行，沿用该行修订号才能覆盖保存；独立模板库仍视为新模板。
      if (!templateFieldId) setTemplateRevision(null);
      setSavedStamp("");
      selectCanvasBox(next.boxes[0]?.id ?? null);
      history.current = { undo: [], redo: [] };
      setNotice({ kind: "success", text: "模板包已导入并生成新模板，请检查后保存" });
    });
  }

  async function previewPng(download = false) {
    if (!bundle) return;
    await run("preview", async () => {
      if (templateFieldId && !editingReady)
        throw new Error(templatePageError || sourceError || "模板行正在定位，请稍后重试");
      if (templateFieldId && !record) throw new Error("请先选择一条记录");
      if (!stageBundle) throw new Error("海报还没有可用的底图");
      // PNG 必须用完整字体：预览可能还停在常用字子集上。
      const blob = await renderer.png(await withCompletePresetFont(stageBundle), values);
      if (download) downloadBlob(blob, `${safeFilename(template!.name)}.png`);
      else setPreview({ url: URL.createObjectURL(blob), blob });
    });
  }
  async function write(rows: DataRecord[], emptyOnly = false) {
    if (!bundle || !context || !rows.length) return;
    await run("write", async ({ details }) => {
      details.rowCount = rows.length;
      if (templateFieldId && (!templateSource || sourceKey !== backgroundKey))
        throw new Error(sourceError || "模板行还未定位，请等待或刷新记录");
      // 记录和字段按不可变方式更新，任务只需固定本轮输入引用。
      const requestedRows = rows;
      lastTask.current = { rows, tableId: context.tableId, fieldId: outputFieldId, emptyOnly };
      const taskContext = { ...context, records: requestedRows };
      const writtenNames = new Map<string, string>();
      const rowValues = new Map<string, Record<string, string>>();
      const templateValuesBySource = new Map<string, Record<string, string>>();
      const targetFieldId = outputFieldId,
        currentSource = templateSource;
      const snapshot = {
        template: structuredClone(bundle.template),
        assets: bundle.assets.map((asset) => ({ ...asset })),
      };
      const controller = new AbortController();
      job.current = controller;
      setBatchResults([]);
      setProgress({ done: 0, total: requestedRows.length });
      const results = await runBatchWrite(
        requestedRows,
        taskContext,
        targetFieldId,
        controller.signal,
        {
          templateTable: templateTableId
            ? { tableId: templateTableId, fields: templateFields }
            : null,
          prepareBundle: async (row) => {
            if (!templateFieldId || !templateBackgroundFieldId) return snapshot;
            const source = await repository.getTemplateSource(
              row.id,
              templateFieldId,
              taskContext.tableId,
              templateBackgroundFieldId,
            );
            // 同一个模板行只读一次字段值，逐行复用。
            const sourceId = `${source.tableId}:${source.recordId}`;
            let scoped = templateValuesBySource.get(sourceId);
            if (!scoped) {
              const recordValues = await repository.loadTemplateRecord(source);
              scoped = scopeValues(source.tableId, recordValues.values);
              templateValuesBySource.set(sourceId, scoped);
            }
            rowValues.set(row.id, scoped);
            // 当前来源使用正在编辑的版式；其他来源读取其各自保存的模板。
            if (currentSource && sourceId === `${currentSource.tableId}:${currentSource.recordId}`)
              return snapshot;
            const saved = await repository.loadSourceTemplate(source);
            if (!saved) throw new Error(`模板“${source.recordName}”尚未保存，请先选择并保存该模板`);
            return saved;
          },
          // 逐行渲染同样要完整字体，避免写回的海报只有常用字。
          resolveBundle: async (_row, rowTemplate) => withCompletePresetFont(rowTemplate),
          readOutputVersion: (row) =>
            repository.readOutputVersion(row.id, targetFieldId, taskContext.tableId),
          render: (row, resolved, signal) =>
            renderer.png(
              resolved,
              rowValues.has(row.id) ? { ...row.values, ...rowValues.get(row.id) } : row.values,
              signal,
            ),
          write: async (row, rowTemplate, blob, expectedVersion) => {
            const file = new File(
              [blob],
              `${safeFilename(row.label)}-${safeFilename(rowTemplate.template.name)}.png`,
              { type: "image/png" },
            );
            // SDK 附件写入必须串行，下一条等待上一条完成。
            await repository.writePng(
              row.id,
              targetFieldId,
              file,
              taskContext.tableId,
              expectedVersion,
            );
            writtenNames.set(row.id, file.name);
          },
          onChange: (current) => {
            setBatchResults(current);
            const summary = summarizeBatch(current);
            setProgress({ done: summary.done, total: summary.total });
          },
        },
        emptyOnly,
      );
      if (writtenNames.size) {
        setContext((current) =>
          current?.tableId === taskContext.tableId
            ? {
                ...current,
                records: current.records.map((row) => {
                  const name = writtenNames.get(row.id);
                  return name
                    ? {
                        ...row,
                        displayValues: {
                          ...row.values,
                          ...row.displayValues,
                          [targetFieldId]: name,
                        },
                      }
                    : row;
                }),
              }
            : current,
        );
      }
      setOutputRevision((value) => value + 1);
      const summary = summarizeBatch(results);
      const issues = summary.failed + summary.unknown + summary.conflict + summary.stopped;
      Object.assign(details, {
        succeeded: summary.succeeded,
        failed: summary.failed,
        conflict: summary.conflict,
        outcomeUnknown: summary.unknown,
        stopped: summary.stopped,
      });
      setNotice({
        kind: issues ? "warning" : "success",
        text: `${repository.mode === "local" ? "本地示例" : "多维表"}处理完成：成功 ${summary.succeeded}，失败 ${summary.failed}，冲突 ${summary.conflict}，结果未知 ${summary.unknown}，停止 ${summary.stopped}。${issues ? "请查看逐行结果，未知和冲突项不会自动重试。" : ""}`,
      });
    });
  }

  async function retryBatch() {
    const task = lastTask.current;
    if (!task || task.tableId !== context?.tableId || task.fieldId !== outputFieldId) return;
    const ids = new Set(
      batchResults.filter((row) => canRetryBatchRow(row.status)).map((row) => row.recordId),
    );
    await write(
      task.rows.filter((row) => ids.has(row.id)),
      task.emptyOnly,
    );
  }

  function requestRecordChange(id: string) {
    if (id === recordId || busy) return;
    if (templateFieldId) guardTemplateReplacement("切换记录", () => setRecordId(id));
    else setRecordId(id);
  }

  function requestTemplateFieldChange(value: string) {
    const fieldId = value === "__none__" ? "" : value;
    if (fieldId === templateFieldId) return;
    guardTemplateReplacement("切换模板定位字段", () => {
      setTemplateFieldId(fieldId);
      // 换了定位字段就换了模板表，底图字段必须重新选择。
      setTemplateBackgroundFieldId("");
      // 修订号属于来源模板行，来源换了不能拿旧修订号去比对新模板。
      setTemplateRevision(null);
    });
  }

  function requestTemplateBackgroundFieldChange(value: string) {
    const fieldId = value === "__none__" ? "" : value;
    if (fieldId === templateBackgroundFieldId) return;
    guardTemplateReplacement("切换模板底图字段", () => setTemplateBackgroundFieldId(fieldId));
  }

  /** 模板页直接选模板行；记录页的模板仍由查找引用决定。 */
  function requestTemplateRowChange(recordId: string) {
    if (recordId === templatePageRowId) return;
    guardTemplateReplacement("切换模板", () => setTemplatePageRowId(recordId));
  }

  /** 离开模板页时把编辑器切回查找引用定位到的模板，避免两页共用错误的版式。 */
  async function restoreRecordTemplate(): Promise<void> {
    if (!templateSource) return;
    const snapshot = templateReturn.current;
    templateReturn.current = null;
    try {
      const saved = await repository.loadSourceTemplate(templateSource);
      if (!saved) {
        // 定位行没有已保存配置：归还进模板页前借走的画布，不能把手选行草稿残留在记录页。
        if (!snapshot) return;
        setTemplate(snapshot.template);
        setAssets(snapshot.assets);
        setSavedStamp(snapshot.savedStamp);
        setTemplateRevision(snapshot.templateRevision);
        setSelectedId(snapshot.template?.boxes[0]?.id ?? null);
        history.current = { undo: [], redo: [] };
        return;
      }
      const loaded = await withPresetFonts(saved);
      setTemplate(loaded.template);
      setAssets(loaded.assets);
      setSavedStamp(JSON.stringify(loaded.template));
      setTemplateRevision(loaded.revision ?? 0);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "模板恢复失败" });
    }
  }

  async function refreshRecords() {
    if (!context) return;
    await run("refresh", async () => {
      repository.invalidate?.();
      const metadata = await repository.loadContext(context.tableId, false);
      const firstPage = await repository.listRecords(
        context.tableId,
        undefined,
        50,
        metadata.viewId,
      );
      const next = {
        ...metadata,
        records: firstPage.records,
        selectedRecordId: firstPage.records[0]?.id ?? null,
      };
      setContext(next);
      setOutputRevision((value) => value + 1);
      setRecordId(next.selectedRecordId);
      setRecordPageToken(firstPage.pageToken);
      setRecordHasMore(firstPage.hasMore);
      setSelectedRecordIds(new Set());
      setBatchOpen(false);
      setAllTableRows(null);
      setUnwrittenPlan(null);
      if (next.tableId !== context.tableId) {
        const settings = await repository.loadSettings(next.tableId);
        settingsRevision.current = settings?.updatedAt ?? (settings ? 0 : null);
        // 切表后输出字段来自该表已保存设置，基线必须同步，否则会被误判成未保存修改。
        const nextOutputFieldId =
          settings?.outputFieldId ??
          next.fields.find((field) => field.kind === "attachment")?.id ??
          "";
        setOutputFieldId(nextOutputFieldId);
        setSavedOutputFieldId(nextOutputFieldId);
        // 与启动路径一致：显式保存的 null（不启用）优先于自动探测，仅旧配置缺键时才探测。
        setTemplateFieldId(
          settings && settings.templateFieldId !== undefined
            ? (settings.templateFieldId ?? "")
            : (next.fields.find((field) => field.kind === "lookup" && field.refTableId)?.id ?? ""),
        );
        setTemplateBackgroundFieldId(settings?.templateBackgroundFieldId ?? "");
        if (settings?.templateId && templates.some((item) => item.id === settings.templateId)) {
          const nextBundle = await withPresetFonts(
            await repository.loadTemplate(settings.templateId),
          );
          setTemplate(nextBundle.template);
          setAssets(nextBundle.assets);
          setSavedStamp(JSON.stringify(nextBundle.template));
          setTemplateRevision(nextBundle.revision ?? 0);
          setSelectedId(nextBundle.template.boxes[0]?.id ?? null);
          history.current = { undo: [], redo: [] };
        } else {
          // 新表没有已保存模板时版式原样保留，切线到当前版式，避免把浏览动作算成修改。
          setSavedStamp(templateStamp);
        }
      }
    });
  }
  function requestRefresh() {
    if (templateFieldId) guardTemplateReplacement("刷新记录", refreshRecords);
    else void refreshRecords();
  }

  function requestTableSwitch() {
    if (!context) return;
    guardTemplateReplacement("切换数据表", () => {
      setTableChoice(context.tableId);
      setStorageChoice(storageStatus?.tableId ?? "");
      setSelectingTable(true);
    });
  }

  function refreshTableList() {
    void run("list-tables", async () => {
      const [list, stores] = await Promise.all([
        repository.listTables(),
        repository.listStorageTables(),
      ]);
      setTables(list);
      setStorageTables(stores);
      if (!list.some((table) => table.id === tableChoice))
        setTableChoice(list.length === 1 ? list[0].id : "");
      if (storageChoice !== "__new__" && !stores.some((table) => table.id === storageChoice))
        setStorageChoice("");
    });
  }

  async function loadMoreRecords() {
    if (!context || !recordHasMore) return;
    await run("more-records", async () => {
      const page = await repository.listRecords(
        context.tableId,
        recordPageToken,
        50,
        context.viewId,
      );
      setContext((current) => {
        if (!current || current.tableId !== context.tableId) return current;
        const records = new Map(current.records.map((row) => [row.id, row]));
        for (const row of page.records) records.set(row.id, row);
        return { ...current, records: [...records.values()] };
      });
      setRecordPageToken(page.pageToken);
      setRecordHasMore(page.hasMore);
    });
  }

  function toggleRecordSelection(id: string) {
    setSelectedRecordIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function scanTable(emptyOnly: boolean) {
    if (!context || !outputFieldId) return;
    const tableId = context.tableId,
      fieldId = outputFieldId;
    void run(emptyOnly ? "scan-unwritten" : "read-all-records", async ({ details }) => {
      const controller = new AbortController();
      job.current = controller;
      const plan: UnwrittenPlan = { total: 0, skipped: 0, rows: [] };
      const seen = new Set<string>();
      let lastUpdate = 0;
      setScanCount(0);
      const scanned = () => {
        plan.total++;
        if (performance.now() - lastUpdate >= 100) {
          setScanCount(plan.total);
          lastUpdate = performance.now();
        }
      };
      try {
        for await (const page of recordPages(
          (token) => repository.listRecords(tableId, token, 200),
          controller.signal,
        )) {
          // 平台翻页期间记录可能移动，同一任务只处理每个记录 ID 一次。
          const rows = page.records.filter((row) => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
          });
          if (emptyOnly) {
            const result = await findUnwrittenRows(
              rows,
              fieldId,
              (row) => repository.readOutputVersion(row.id, fieldId, tableId),
              controller.signal,
              scanned,
            );
            plan.rows.push(...result.rows);
            plan.skipped += result.skipped;
          } else {
            plan.rows.push(...rows);
            plan.total += rows.length;
            setScanCount(plan.total);
          }
        }
      } catch (error) {
        if (!(error instanceof PosterError && error.code === "CANCELLED")) throw error;
        details.stopped = true;
        setNotice({ kind: "warning", text: `已停止扫描，已检查 ${plan.total} 条记录。` });
        return;
      }
      Object.assign(details, {
        rowCount: plan.total,
        pending: plan.rows.length,
        skipped: plan.skipped,
      });
      if (!emptyOnly) setAllTableRows(plan.rows);
      else if (plan.rows.length) setUnwrittenPlan(plan);
      else
        setNotice({
          kind: "success",
          text: `已扫描 ${plan.total} 条记录，所有记录均已写回，本次无需生成。`,
        });
    });
  }

  const notifyRenderError = useCallback((message: string) => setRenderError(message), []);
  const notifyOverflow = useCallback((ids: string[]) => setOverflowIds(ids), []);
  if (starting)
    return (
      <div className="boot-screen">
        <Spin size="large" />
        <h1>招聘海报</h1>
        <p>正在读取已保存配置…</p>
      </div>
    );
  if (selectingTable)
    return (
      <WorkspaceSetup
        tables={tables}
        storageTables={storageTables}
        tableChoice={tableChoice}
        storageChoice={storageChoice}
        mode={repository.mode}
        busy={busy}
        hasContext={Boolean(context)}
        dirty={dirty}
        notice={notice?.text ?? null}
        onTableChoice={setTableChoice}
        onStorageChoice={setStorageChoice}
        onEnter={() => void openWorkspace(tableChoice)}
        onCancel={() => {
          setStorageChoice(storageStatus?.tableId ?? "");
          setSelectingTable(false);
        }}
        onRefresh={refreshTableList}
      />
    );
  if (!context)
    return (
      <div className="boot-screen">
        <Spin size="large" />
        <h1>招聘海报</h1>
        <p>{notice?.text ?? "正在加载记录工作台…"}</p>
        {notice && <Button onClick={() => location.reload()}>重新加载</Button>}
      </div>
    );

  return (
    <div className={`app-shell ${busy === "write" ? "is-writing" : ""}`} data-page={workspacePage}>
      <header className="app-header">
        <div className="app-identity">
          <div className="brand-mark">
            <span />
            <span />
          </div>
          <strong>招聘海报</strong>
          <span className={`mode-badge ${repository.mode}`}>
            {repository.mode === "local" ? "本地示例" : "多维表"}
          </span>
        </div>
        <WorkspaceTabs
          value={activeTab}
          disabled={Boolean(busy)}
          onChange={(tab) => {
            setPropertyPopup(null);
            if (tab === "records") setMobileTab("canvas");
            // 字段映射页与模板页同属模板模块，从映射页切走同样要归还画布。
            const leavingTemplate = activeTab === "template" && tab !== "template";
            if (tab === "template" && activeTab !== "template")
              // 进入模板模块前快照记录页画布：定位行未配置时离开要靠它归还。
              templateReturn.current = { template, assets, savedStamp, templateRevision };
            // 只有模板页真的改过内容才拦截；刚进入时的默认草稿不该挡住模块切换。
            if (!leavingTemplate || !history.current.undo.length) {
              setWorkspacePage(tab);
              if (leavingTemplate) void restoreRecordTemplate();
              return;
            }
            guardTemplateReplacement("切换模块", async () => {
              setWorkspacePage(tab);
              await restoreRecordTemplate();
            });
          }}
        />
        <div className="header-actions">
          {workspacePage === "records" ? (
            <>
              <Button
                disabled={!actions.canPreview}
                loading={busy === "preview"}
                onClick={() => previewPng()}
              >
                预览
              </Button>
              <Button
                theme="solid"
                type="primary"
                disabled={!actions.canWriteCurrent}
                title={actions.writeBlockerText || undefined}
                loading={busy === "write"}
                onClick={() => write(record ? [record] : [])}
              >
                生成并写回
              </Button>
            </>
          ) : workspacePage === "settings" ? (
            <Button
              aria-label="保存设置"
              icon={<IconSave />}
              disabled={!actions.canSave}
              title={actions.saveBlockerText || undefined}
              loading={busy === "save"}
              onClick={save}
            >
              保存设置
            </Button>
          ) : (
            <>
              <Button
                aria-label="保存模板"
                icon={<IconSave />}
                disabled={!actions.canSave}
                loading={busy === "save"}
                onClick={save}
              >
                保存模板
              </Button>
              {workspacePage === "template" && (
                <Button
                  disabled={controlsDisabled}
                  onClick={() => {
                    setPropertyPopup(null);
                    setWorkspacePage("mapping");
                  }}
                >
                  字段映射
                </Button>
              )}
            </>
          )}
        </div>
      </header>
      {workspacePage === "template" && <MobileTabs value={mobileTab} onChange={setMobileTab} />}
      {(notice || renderError) && (
        <div
          className={`notice ${notice?.kind ?? "error"}`}
          role={notice?.kind === "success" ? "status" : "alert"}
        >
          <span>{notice?.text ?? renderError}</span>
          <button
            aria-label="关闭提示"
            onClick={() => {
              setNotice(null);
              setRenderError("");
            }}
          >
            ×
          </button>
        </div>
      )}
      <Suspense
        fallback={
          <div className="background-loading" role="status">
            正在加载编辑面板…
          </div>
        }
      >
        {!template || workspacePage === "records" ? (
          <RecordWorkspace
            tableName={context.tableName}
            disabled={controlsDisabled}
            onSwitchTable={requestTableSwitch}
            browser={
              <RecordPanel
                records={visibleRecords}
                loadedCount={context.records.length}
                hasMore={recordHasMore}
                search={recordSearch}
                recordId={recordId}
                selectedIds={selectedRecordIds}
                selectedCount={selectedRows.length}
                batchOpen={batchOpen}
                disabled={controlsDisabled}
                canGenerate={actions.canWriteBatch}
                blockerText={actions.writeBlockerText}
                onSearch={setRecordSearch}
                onSelectRecord={requestRecordChange}
                onToggleRecord={toggleRecordSelection}
                onToggleBatch={() => setBatchOpen((current) => !current)}
                onLoadMore={loadMoreRecords}
                onRefresh={requestRefresh}
                onWriteSelected={() => write(selectedRows)}
                onRequestAll={() => scanTable(false)}
                onWriteUnwritten={() => scanTable(true)}
              >
                {(busy === "read-all-records" || busy === "scan-unwritten") && (
                  <div className="batch-progress">
                    <span role="status">已扫描 {scanCount} 条记录</span>
                    <Button size="small" onClick={() => job.current?.abort()}>
                      停止扫描
                    </Button>
                  </div>
                )}
                <BatchPanel
                  progress={progress}
                  results={batchResults}
                  busy={busy}
                  onStop={() => job.current?.abort()}
                  onRetry={retryBatch}
                />
              </RecordPanel>
            }
            preview={
              <>
                {!template ? (
                  <div className="readonly-poster-stage" role="status">
                    {busy === "open-table" ? (
                      <span className="canvas-loading">正在加载海报模板与素材…</span>
                    ) : (
                      <Button onClick={() => void openWorkspace(context.tableId)}>
                        重新加载海报模板
                      </Button>
                    )}
                  </div>
                ) : (
                  <ReadOnlyPosterPreview
                    renderer={renderer}
                    bundle={record && !recordSourcePending && !sourceError ? stageBundle : null}
                    values={values}
                    recordLabel={record?.label ?? ""}
                    templateName={template.name}
                    placeholder={
                      sourceError || (recordId ? "正在读取当前行底图…" : "请选择一条记录")
                    }
                  />
                )}
                {template && !attachmentFields.some((field) => field.id === outputFieldId) && (
                  <div className="record-config-warning" role="status">
                    <span>生成前需要配置输出附件字段。</span>
                    <Button size="small" onClick={() => setWorkspacePage("settings")}>
                      去设置
                    </Button>
                  </div>
                )}
              </>
            }
            extras={
              <>
                {dirty && (
                  <div className="record-draft-state" role="status">
                    <span>模板或输出设置未保存，预览和生成使用当前草稿。</span>
                    <Button
                      size="small"
                      theme="borderless"
                      onClick={() => {
                        // 与顶部页签进入模板模块的路径保持一致：先快照画布再进入。
                        if (activeTab !== "template")
                          templateReturn.current = {
                            template,
                            assets,
                            savedStamp,
                            templateRevision,
                          };
                        setWorkspacePage("template");
                      }}
                    >
                      继续编辑
                    </Button>
                  </div>
                )}
                {outputList?.error && (
                  <p className="record-preview-warning" role="status">
                    附件列表读取失败：{outputList.error}{" "}
                    <Button
                      size="small"
                      disabled={Boolean(busy)}
                      onClick={() => setOutputRevision((value) => value + 1)}
                    >
                      重新读取
                    </Button>
                  </p>
                )}
                {Boolean(outputList?.files.length) && (
                  <section className="current-record-outputs">
                    <h3>{repository.mode === "local" ? "本地附件" : "当前记录附件"}</h3>
                    <div className="output-list">
                      {outputList?.files.map((output) => (
                        <button
                          key={output.id}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run("download-output", async () =>
                              downloadBlob(await output.loadBlob(), output.name),
                            )
                          }
                        >
                          <IconDownload />
                          <span>{output.name}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            }
          />
        ) : workspacePage === "template" ? (
          <>
            <main className={`workspace mobile-${mobileTab}`}>
              <TemplateListPanel
                rows={templateListRows}
                selectedRecordId={selectedTemplateRowIdForList}
                loading={templatePageLoading}
                error={templatePageError}
                tableName={context.tableName}
                storageName={storageStatus?.name ?? null}
                storageReady={Boolean(storageStatus)}
                onSelect={selectTemplateRow}
                onSwitchTable={requestTableSwitch}
                disabled={controlsDisabled || recordSourcePending}
              />
              <div className="canvas-column" id="panel-canvas" aria-labelledby="tab-canvas">
                <div className="document-bar">
                  <div>
                    <span className="document-dot" />
                    <strong>{template.name}</strong>
                  </div>
                  <label className="document-record-select">
                    <span>预览记录</span>
                    <Select
                      aria-label="预览记录"
                      value={recordId ?? undefined}
                      optionList={context.records.map((row) => ({
                        label: row.label,
                        value: row.id,
                      }))}
                      onChange={(value) => requestRecordChange(String(value))}
                      disabled={controlsDisabled}
                      size="small"
                    />
                  </label>
                  <div>
                    <Button
                      theme="borderless"
                      icon={<IconUndo />}
                      aria-label="撤销"
                      disabled={!history.current.undo.length || !!busy}
                      onClick={undo}
                    />
                    <Button
                      theme="borderless"
                      icon={<IconRedo />}
                      aria-label="重做"
                      disabled={!history.current.redo.length || !!busy}
                      onClick={redo}
                    />
                  </div>
                </div>
                {stageBundle ? (
                  <EditorStage
                    renderer={renderer}
                    bundle={stageBundle}
                    values={values}
                    selectedId={selectedId}
                    disabled={controlsDisabled}
                    onSelect={selectCanvasBox}
                    onEditProperties={openProperties}
                    onChangeBox={changeBox}
                    onCheckpoint={checkpoint}
                    onRenderError={notifyRenderError}
                    onOverflow={notifyOverflow}
                  />
                ) : (
                  <div className="background-loading" role="status">
                    {templatePageError ||
                      sourceError ||
                      (templatePageLoading || sourceLoading ? "正在定位模板行…" : "请选择一条记录")}
                  </div>
                )}
              </div>
              <div className="right-column" id="panel-properties">
                <div className="right-tabs" role="tablist" aria-label="模板编辑面板">
                  {RIGHT_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`right-tab-${tab.id}`}
                      aria-selected={rightTab === tab.id}
                      aria-controls={`right-panel-${tab.id}`}
                      tabIndex={rightTab === tab.id ? 0 : -1}
                      className={rightTab === tab.id ? "is-active" : ""}
                      onClick={() => setRightTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div
                  id={`right-panel-${rightTab}`}
                  role="tabpanel"
                  aria-labelledby={`right-tab-${rightTab}`}
                >
                  {rightTab === "properties" && !propertyPopup && (
                    <PropertyPanel
                      embedded
                      panelRef={propertyPanel}
                      popup={null}
                      {...propertyPanelProps}
                    />
                  )}
                  {rightTab === "layers" && (
                    <LayerPanel
                      boxes={template.boxes}
                      fields={context.fields}
                      templateFields={templateFields}
                      selectedId={selectedId}
                      selectedIds={selectedLayerIds}
                      overflowIds={overflowIds}
                      disabled={controlsDisabled}
                      onAdd={addBox}
                      onSelect={selectLayer}
                      onToggle={toggleLayerSelection}
                      onToggleLock={toggleLayerLock}
                      onMove={moveSelectedLayer}
                      onAlign={alignSelectedLayers}
                    />
                  )}
                  {rightTab === "settings" && (
                    <TemplateSettingsPanel
                      template={template}
                      source={editingSource}
                      fontAssets={fontAssets}
                      backgroundFieldName={
                        templateFields.find((field) => field.id === templateBackgroundFieldId)
                          ?.name ?? ""
                      }
                      disabled={controlsDisabled}
                      showLibraryActions={!templateFieldId}
                      canDelete={templates.some((item) => item.id === template.id)}
                      onNameChange={(name) => edit((current) => ({ ...current, name }))}
                      onEditMapping={() => {
                        setPropertyPopup(null);
                        setWorkspacePage("mapping");
                      }}
                      onUploadBackground={() => backgroundInput.current?.click()}
                      onUploadFont={() => fontInput.current?.click()}
                      onImport={() => packageInput.current?.click()}
                      onExport={exportTemplate}
                      onCopyTemplate={requestCopyTemplate}
                      onDeleteTemplate={() => setDeletingTemplate(true)}
                    />
                  )}
                </div>
              </div>
            </main>
            {propertyPopup && (
              <PropertyPanel
                panelRef={propertyPanel}
                popup={propertyPopup}
                {...propertyPanelProps}
              />
            )}
          </>
        ) : workspacePage === "settings" ? (
          <SettingsPanel
            tableName={context.tableName}
            storageName={storageStatus?.name ?? null}
            storageReady={Boolean(storageStatus)}
            fields={context.fields}
            templateFields={templateFields}
            templateFieldId={templateFieldId}
            templateBackgroundFieldId={templateBackgroundFieldId}
            outputFieldId={outputFieldId}
            dirty={dirty}
            disabled={controlsDisabled}
            sourceError={sourceError}
            onTemplateFieldChange={requestTemplateFieldChange}
            onTemplateBackgroundFieldChange={requestTemplateBackgroundFieldChange}
            onOutputFieldChange={(id) => {
              setOutputFieldId(id);
              setBatchResults([]);
              setProgress(null);
              lastTask.current = null;
            }}
            onSwitchTable={requestTableSwitch}
          />
        ) : (
          <FieldMappingPanel
            template={template}
            fields={context.fields}
            templateFields={templateFields}
            templateTableId={templateTableId}
            values={values}
            disabled={controlsDisabled}
            onChange={changeBox}
          />
        )}
      </Suspense>
      <input
        ref={backgroundInput}
        aria-label="上传底图文件"
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(event) => {
          void upload(event.target.files?.[0], "background");
          event.target.value = "";
        }}
      />
      <input
        ref={fontInput}
        aria-label="上传字体文件"
        type="file"
        accept=".otf,.ttf,.woff,.woff2"
        hidden
        onChange={(event) => {
          void upload(event.target.files?.[0], "font");
          event.target.value = "";
        }}
      />
      <input
        ref={packageInput}
        aria-label="导入模板包"
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) guardTemplateReplacement("导入模板", () => importTemplate(file));
        }}
      />
      <Modal
        title="删除模板"
        visible={deletingTemplate}
        onCancel={() => setDeletingTemplate(false)}
        footer={
          <>
            <Button onClick={() => setDeletingTemplate(false)}>取消</Button>
            <Button
              theme="solid"
              type="danger"
              loading={busy === "delete-template"}
              onClick={confirmDeleteTemplate}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          将删除模板“{template?.name}”，不会影响业务记录或已生成附件。此操作需要重新选择其他模板。
        </p>
      </Modal>
      <Modal
        title="一键生成写回"
        visible={unwrittenPlan !== null}
        onCancel={() => setUnwrittenPlan(null)}
        footer={
          <>
            <Button onClick={() => setUnwrittenPlan(null)}>取消</Button>
            <Button
              theme="solid"
              type="primary"
              disabled={!unwrittenPlan?.rows.length}
              onClick={() => {
                const rows = unwrittenPlan?.rows;
                setUnwrittenPlan(null);
                if (rows) void write(rows, true);
              }}
            >
              确认生成 {unwrittenPlan?.rows.length ?? 0} 条
            </Button>
          </>
        }
      >
        <p>
          已扫描 {unwrittenPlan?.total ?? 0} 条记录，已有附件跳过 {unwrittenPlan?.skipped ?? 0}{" "}
          条，本次只写回 {unwrittenPlan?.rows.length ?? 0} 条未生成记录。已有附件不会被覆盖。
        </p>
      </Modal>
      <Modal
        title="确认全表生成"
        visible={allTableRows !== null}
        onCancel={() => setAllTableRows(null)}
        footer={
          <>
            <Button onClick={() => setAllTableRows(null)}>取消</Button>
            <Button
              theme="solid"
              type="primary"
              disabled={!allTableRows?.length}
              onClick={() => {
                const rows = allTableRows;
                setAllTableRows(null);
                if (rows) void write(rows);
              }}
            >
              确认生成 {allTableRows?.length ?? 0} 条
            </Button>
          </>
        }
      >
        <p>
          已按需读取全表，共 {allTableRows?.length ?? 0}{" "}
          条记录。任务将逐行渲染并串行替换目标附件单元格，请确认输出字段正确。
        </p>
      </Modal>
      <UnsavedNavigationModal
        title={pendingNavigation?.title ?? null}
        busy={busy}
        error={notice?.kind === "error" ? notice.text : null}
        onCancel={() => setPendingNavigation(null)}
        onDiscard={discardAndContinue}
        onSave={saveAndContinue}
      />
      <Modal
        title="PNG 预览"
        visible={!!preview}
        onCancel={() => setPreview(null)}
        footer={
          <Button
            aria-label="下载 PNG"
            theme="solid"
            icon={<IconDownload />}
            onClick={() =>
              preview &&
              template &&
              downloadBlob(preview.blob, `${safeFilename(template.name)}.png`)
            }
          >
            下载 PNG
          </Button>
        }
        width={660}
        className="preview-modal"
      >
        <div className="preview-image-wrap">
          {preview && <img src={preview.url} alt="生成的招聘海报" />}
        </div>
      </Modal>
    </div>
  );
}
