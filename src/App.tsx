// @refresh reset
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Modal, Spin } from "./ui/semi";
import {
  IconPlus,
  IconSave,
  IconDownload,
  IconUndo,
  IconRedo,
  IconImage,
  IconFont,
  IconDelete,
} from "@douyinfe/semi-icons";
import type {
  DataRecord,
  PosterAsset,
  PosterTemplate,
  TemplateBundle,
  TemplateSummary,
  TextBox,
  WorkspaceContext,
  TableSummary,
  StorageStatus,
} from "./domain/types";
import { PosterError } from "./domain/types";
import { moveTextBox, resizeTextBox } from "./domain/geometry";
import { createRepository, createPosterAsset } from "./data";
import { resolveRecordBundle, withRecordBackground } from "./domain/record-background";
import { PRESET_FONT, withPresetFonts, loadDefaultBundle } from "./data/preset-fonts";
import { createPosterRenderer } from "./rendering/canvas";
import { loadWorkspaceBootstrap } from "./domain/workspace-bootstrap";
import { observeSemiA11y } from "./app/semi-a11y";
import { OperationLock } from "./application/operation-lock";
import { resolvePosterActionState } from "./application/action-state";
import {
  runBatchWrite,
  summarizeBatch,
  canRetryBatchRow,
  type BatchRowResult,
} from "./application/batch-write";
import { recordPages } from "./domain/record-pages";
import { findUnwrittenRows, type UnwrittenPlan } from "./application/unwritten-write";
import { WorkspaceSetup } from "./features/workspace/WorkspaceSetup";
import { UnsavedNavigationModal } from "./features/editor/UnsavedNavigationModal";
import { BatchPanel } from "./features/batch/BatchPanel";
import { MobileTabs } from "./features/editor/MobileTabs";
import { alignLayers, moveLayer, type LayerAlignment } from "./domain/layer-operations";
import { pruneTemplateAssets } from "./domain/template-assets";
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "./domain/limits";
import { useOutputFiles } from "./features/records/useOutputFiles";
import { useRecordBackground } from "./features/records/useRecordBackground";
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

type PendingNavigation = { title: string; action: () => Promise<void> | void };
type WorkspacePage = "records" | "template" | "mapping";

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
  const records = context?.records;
  const fields = context?.fields;
  const record = useMemo(
    () => records?.find((item) => item.id === recordId) ?? null,
    [records, recordId],
  );
  const emptyValues = useMemo<Record<string, string>>(() => ({}), []);
  const values = record?.values ?? emptyValues;
  const selected = template?.boxes.find((item) => item.id === selectedId) ?? null;
  const attachmentFields = useMemo(
    () =>
      fields?.filter(
        (field) => field.kind === "attachment" && field.id !== template?.backgroundFieldId,
      ) ?? [],
    [fields, template?.backgroundFieldId],
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
  const backgroundKey = JSON.stringify([context?.tableId, recordId, template?.backgroundFieldId]);
  const { rowBackground, templateSource, sourceKey, sourceError, sourceLoading } =
    useRecordBackground({
      repository,
      context,
      recordId,
      backgroundFieldId: template?.backgroundFieldId,
      backgroundKey,
      prepareBundle: withPresetFonts,
      onRestore: (loaded, fieldId) => {
        // 来源表保存的是该底图的版式，当前业务表使用自己的底图引用字段。
        const restored = { ...loaded.template, backgroundFieldId: fieldId };
        setTemplate(restored);
        setAssets(loaded.assets);
        setSavedStamp(JSON.stringify(restored));
        setTemplateRevision(loaded.revision ?? 0);
        selectCanvasBox(restored.boxes[0]?.id ?? null);
        history.current = { undo: [], redo: [] };
      },
      onNewSource: () => {
        // 新来源保留当前版式作为草稿，但不得沿用另一来源的“已保存”标记或修订号。
        setTemplateRevision(null);
        setSavedStamp("");
      },
    });
  const stageBundle = useMemo(
    () =>
      !bundle?.template.backgroundFieldId
        ? bundle
        : rowBackground?.key === backgroundKey && sourceKey === backgroundKey && rowBackground.asset
          ? withRecordBackground(bundle, rowBackground.asset)
          : null,
    [bundle, rowBackground, backgroundKey, sourceKey],
  );
  const fontAssets = assets.filter((asset) => template?.fontIds.includes(asset.id));
  const templateStamp = useMemo(() => JSON.stringify(template), [template]);
  const dirty = template
    ? templateStamp !== savedStamp || outputFieldId !== savedOutputFieldId
    : false;
  const sourcePending =
    sourceLoading ||
    Boolean(template?.backgroundFieldId && sourceKey !== backgroundKey && !sourceError);
  const actions = resolvePosterActionState({
    busy,
    sourceLoading: sourcePending,
    sourceError,
    hasTemplate: Boolean(template && context),
    usesRecordBackground: Boolean(template?.backgroundFieldId),
    hasRecord: Boolean(record),
    hasOutputField: attachmentFields.some((field) => field.id === outputFieldId),
    recordCount: context?.records.length ?? 0,
  });
  const editorDisabled = actions.editorDisabled;
  const controlsDisabled = Boolean(busy || sourcePending);

  useEffect(() => observeSemiA11y(), []);

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
    await run("open-table", async () => {
      // 业务表和配置表分别指定；只有用户明确选择"新建"才允许创建配置表。
      const storage = await repository.initializeStorage(
        configTableId === "__new__" ? undefined : configTableId,
      );
      repository.invalidate?.();
      const [metadata, saved] = await Promise.all([
        repository.loadContext(tableId, false),
        repository.listTemplates(),
      ]);
      const [firstPage, settings] = await Promise.all([
        repository.listRecords(tableId),
        repository.loadSettings(tableId),
      ]);
      const workspace = {
        ...metadata,
        records: firstPage.records,
        selectedRecordId: firstPage.records[0]?.id ?? null,
      };
      // 首屏记录与素材下载解耦，字体或底图较慢时仍可阅读业务字段。
      setContext(workspace);
      setTemplate(null);
      setAssets([]);
      setOutputFieldId("");
      setTemplates(saved);
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
      const savedTemplate =
        settings?.templateId && saved.some((item) => item.id === settings.templateId)
          ? settings.templateId
          : undefined;
      const initial = await withPresetFonts(
        savedTemplate ? await repository.loadTemplate(savedTemplate) : await loadDefaultBundle(),
      );
      if (!savedTemplate) initial.template.id = `recruitment-${workspace.tableId}`;
      if (repository.mode === "feishu" && !savedTemplate) {
        initial.template.backgroundFieldId =
          workspace.fields.find(
            (field) => field.name === "模板底图" && ["attachment", "lookup"].includes(field.kind),
          )?.id ?? null;
        initial.template.boxes = initial.template.boxes.map((box) => ({
          ...box,
          fieldId: workspace.fields.find((field) => field.name === box.label)?.id ?? null,
        }));
      }
      if (settings?.backgroundFieldId !== undefined)
        initial.template.backgroundFieldId = settings.backgroundFieldId;
      const targets = workspace.fields.filter(
        (field) => field.kind === "attachment" && field.id !== initial.template.backgroundFieldId,
      );
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
            backgroundFieldId: initial.template.backgroundFieldId ?? null,
          },
          null,
        ));
      if (!restoring)
        await repository.saveWorkspaceBinding({
          schemaVersion: 1,
          tableId: workspace.tableId,
          storageTableId: storage.tableId,
        });
      setTemplate(initial.template);
      setAssets(initial.assets);
      setSelectedId(initial.template.boxes[0]?.id ?? null);
      setOutputFieldId(output);
      setSavedOutputFieldId(output);
      setTemplateRevision(initial.revision ?? null);
      settingsRevision.current = currentSettings?.updatedAt ?? (currentSettings ? 0 : null);
      setSavedStamp(savedTemplate ? JSON.stringify(initial.template) : "");
      history.current = { undo: [], redo: [] };
      setSelectedLayerIds(new Set());
      setOutputRevision((value) => value + 1);
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
    if (remember) checkpoint();
    setTemplate(change(template));
  }
  function changeBox(id: string, updates: Partial<TextBox>, remember = false) {
    if (template?.boxes.find((box) => box.id === id)?.locked) return;
    edit(
      (current) => ({
        ...current,
        boxes: current.boxes.map((box) => {
          if (box.id !== id) return box;
          const next = { ...box, ...updates };
          next.minFontSize = Math.min(next.minFontSize, next.fontSize);
          const sized = resizeTextBox(next, next.width, next.height, current);
          return moveTextBox(sized, 0, 0, current);
        }),
      }),
      remember,
    );
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
      if (bundle.template.backgroundFieldId) {
        if (!templateSource || sourceKey !== backgroundKey)
          throw new Error(sourceError || "底图来源还未就绪，请等待或刷新记录");
        const revision = await repository.saveSourceTemplate(
          templateSource,
          bundle,
          templateRevision,
        );
        setTemplateRevision(revision);
      } else {
        const summary = await repository.saveTemplate(bundle, templateRevision);
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
          backgroundFieldId: bundle.template.backgroundFieldId ?? null,
        },
        settingsRevision.current,
      );
      settingsRevision.current = savedSettings.updatedAt ?? 0;
      setSavedOutputFieldId(outputFieldId);
      setSavedStamp(JSON.stringify(bundle.template));
      setNotice({
        kind: "success",
        text: bundle.template.backgroundFieldId
          ? "模板和字体已保存到底图来源记录"
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
          backgroundFieldId: next.template.backgroundFieldId ?? null,
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
    if (!template || !context || template.backgroundFieldId) return;
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
            backgroundFieldId: null,
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
        checkpoint();
        setTemplate((current) =>
          current
            ? {
                ...current,
                fontIds: Array.from(new Set([...current.fontIds, asset.id])),
                boxes: current.boxes.map((box) =>
                  box.id === selectedId ? { ...box, fontId: asset.id } : box,
                ),
              }
            : current,
        );
      } else {
        const bitmap = await createImageBitmap(asset.blob);
        const width = bitmap.width,
          height = bitmap.height;
        bitmap.close();
        if (width * height > MAX_IMAGE_PIXELS || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
          throw new Error("底图尺寸过大");
        checkpoint();
        if (template.backgroundFieldId)
          setTemplateRevision(templates.find((item) => item.id === template.id)?.updatedAt ?? null);
        const sx = width / template.width,
          sy = height / template.height;
        setTemplate((current) =>
          current
            ? {
                ...current,
                width,
                height,
                backgroundId: asset.id,
                backgroundFieldId: null,
                boxes: current.boxes.map((box) => ({
                  ...box,
                  x: box.x * sx,
                  y: box.y * sy,
                  width: box.width * sx,
                  height: box.height * sy,
                  fontSize: Math.max(8, box.fontSize * sx),
                  minFontSize: Math.max(8, box.minFontSize * sx),
                })),
              }
            : current,
        );
      }
      setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      setNotice({ kind: "success", text: kind === "font" ? "字体已加载" : "底图已更新" });
    });
  }

  async function exportTemplate() {
    if (!bundle) return;
    await run("export-template", async () => {
      const { createTemplatePackage } = await import("./application/template-package");
      const packed = await createTemplatePackage(bundle);
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
      setTemplateRevision(null);
      setSavedStamp("");
      selectCanvasBox(next.boxes[0]?.id ?? null);
      history.current = { undo: [], redo: [] };
      setNotice({ kind: "success", text: "模板包已导入并生成新模板，请检查后保存" });
    });
  }

  async function previewPng(download = false) {
    if (!bundle) return;
    await run("preview", async () => {
      if (bundle.template.backgroundFieldId && (!templateSource || sourceKey !== backgroundKey))
        throw new Error(sourceError || "底图模板正在读取，请稍后重试");
      if (bundle.template.backgroundFieldId && !record) throw new Error("请先选择一条有底图的记录");
      if (!stageBundle) throw new Error("底图尚未就绪");
      const blob = await renderer.png(stageBundle, values);
      if (download) downloadBlob(blob, `${safeFilename(template!.name)}.png`);
      else setPreview({ url: URL.createObjectURL(blob), blob });
    });
  }
  async function write(rows: DataRecord[], emptyOnly = false) {
    if (!bundle || !context || !rows.length) return;
    await run("write", async ({ details }) => {
      details.rowCount = rows.length;
      if (bundle.template.backgroundFieldId && (!templateSource || sourceKey !== backgroundKey))
        throw new Error(sourceError || "底图来源还未就绪，请等待或刷新记录");
      // 记录和字段按不可变方式更新，任务只需固定本轮输入引用。
      const requestedRows = rows;
      lastTask.current = { rows, tableId: context.tableId, fieldId: outputFieldId, emptyOnly };
      const taskContext = { ...context, records: requestedRows };
      const writtenNames = new Map<string, string>();
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
          prepareBundle: async (row) => {
            if (!snapshot.template.backgroundFieldId) return snapshot;
            const source = await repository.getTemplateSource(
              row.id,
              snapshot.template.backgroundFieldId,
              taskContext.tableId,
            );
            // 当前来源使用正在编辑的版式；其他来源读取其各自保存的模板。
            if (
              currentSource &&
              source.recordId === currentSource.recordId &&
              source.tableId === currentSource.tableId
            )
              return snapshot;
            const saved = await repository.loadSourceTemplate(source);
            if (!saved)
              throw new Error(`底图"${source.recordName}"尚未保存模板，请先选择对应记录配置`);
            return {
              ...saved,
              template: {
                ...saved.template,
                backgroundFieldId: snapshot.template.backgroundFieldId,
              },
            };
          },
          resolveBundle: (row, rowTemplate) =>
            resolveRecordBundle(rowTemplate, row.id, taskContext, repository),
          readOutputVersion: (row) =>
            repository.readOutputVersion(row.id, targetFieldId, taskContext.tableId),
          render: (row, resolved, signal) => renderer.png(resolved, row.values, signal),
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
    if (template?.backgroundFieldId) guardTemplateReplacement("切换记录", () => setRecordId(id));
    else setRecordId(id);
  }

  function requestBackgroundFieldChange(value: string) {
    const fieldId = value === "__template__" ? null : value;
    if (fieldId === (template?.backgroundFieldId ?? null)) return;
    guardTemplateReplacement("切换底图来源", () => {
      edit((current) => ({ ...current, backgroundFieldId: fieldId }));
      setTemplateRevision(
        fieldId ? null : (templates.find((item) => item.id === template?.id)?.updatedAt ?? null),
      );
      if (outputFieldId === fieldId)
        setOutputFieldId(attachmentFields.find((field) => field.id !== fieldId)?.id ?? "");
    });
  }

  async function refreshRecords() {
    if (!context) return;
    await run("refresh", async () => {
      repository.invalidate?.();
      const metadata = await repository.loadContext(context.tableId, false);
      const firstPage = await repository.listRecords(context.tableId);
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
        setOutputFieldId(
          settings?.outputFieldId ??
            next.fields.find((field) => field.kind === "attachment")?.id ??
            "",
        );
        setTemplate((current) =>
          current
            ? { ...current, backgroundFieldId: settings?.backgroundFieldId ?? null }
            : current,
        );
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
        }
      }
    });
  }
  function requestRefresh() {
    if (template?.backgroundFieldId) guardTemplateReplacement("刷新记录", refreshRecords);
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
      const page = await repository.listRecords(context.tableId, recordPageToken);
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

  const savedOptions = templates.map((item) => ({ label: item.name, value: item.id }));
  if (template && !savedOptions.some((item) => item.value === template.id))
    savedOptions.unshift({ label: template.name, value: template.id });
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
        {workspacePage === "records" && (
          <div className="record-header-main">
            <span>当前主记录</span>
            <strong>{record?.label ?? "未选择记录"}</strong>
          </div>
        )}
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
              <Button
                disabled={!template || Boolean(busy)}
                onClick={() => {
                  setPropertyPopup(null);
                  setMobileTab("canvas");
                  setWorkspacePage("template");
                }}
              >
                高级编辑
              </Button>
            </>
          ) : workspacePage === "template" ? (
            <>
              <Button
                disabled={Boolean(busy)}
                onClick={() => {
                  setPropertyPopup(null);
                  setWorkspacePage("records");
                }}
              >
                返回记录
              </Button>
              <Button
                aria-label="保存模板"
                icon={<IconSave />}
                disabled={!actions.canSave}
                loading={busy === "save"}
                onClick={save}
              >
                保存模板
              </Button>
              <Button
                disabled={controlsDisabled}
                onClick={() => {
                  setPropertyPopup(null);
                  setWorkspacePage("mapping");
                }}
              >
                字段映射
              </Button>
            </>
          ) : (
            <>
              <Button disabled={Boolean(busy)} onClick={() => setWorkspacePage("template")}>
                返回高级编辑
              </Button>
              <Button
                aria-label="保存模板"
                icon={<IconSave />}
                disabled={!actions.canSave}
                loading={busy === "save"}
                onClick={save}
              >
                保存模板
              </Button>
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
            record={record}
            fields={context.fields}
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
                    bundle={record ? stageBundle : null}
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
                    <Button size="small" onClick={() => setWorkspacePage("mapping")}>
                      去配置
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
                      onClick={() => setWorkspacePage("template")}
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
          <main className={`workspace mobile-${mobileTab}`}>
            <aside className="left-panel" id="panel-layers" aria-labelledby="tab-layers">
              <section className="panel-section business-table-section">
                <div className="section-heading">
                  <h2>业务数据表</h2>
                  <Button size="small" disabled={controlsDisabled} onClick={requestTableSwitch}>
                    切换数据表
                  </Button>
                </div>
                <strong>{context.tableName}</strong>
                <p className="source-template-note">
                  配置表：{storageStatus?.name ?? "未初始化"}
                  {storageStatus ? " · 已就绪" : ""}
                </p>
              </section>
              <section className="panel-section">
                <div className="section-heading">
                  <h2 id="template-selector-label">模板</h2>
                  <div className="template-heading-actions">
                    <span className="save-state">{dirty ? "未保存" : "已保存"}</span>
                    {!template.backgroundFieldId &&
                      templates.some((item) => item.id === template.id) && (
                        <Button
                          theme="borderless"
                          type="danger"
                          icon={<IconDelete />}
                          aria-label="删除模板"
                          disabled={controlsDisabled}
                          onClick={() => setDeletingTemplate(true)}
                        />
                      )}
                    <Button
                      theme="borderless"
                      icon={<IconPlus />}
                      aria-label="新建模板"
                      disabled={controlsDisabled}
                      onClick={requestCopyTemplate}
                    />
                  </div>
                </div>
                {!template.backgroundFieldId && (
                  <Select
                    aria-labelledby="template-selector-label"
                    value={template.id}
                    optionList={savedOptions}
                    onChange={(value) => {
                      if (value !== template.id) requestLoad(String(value));
                    }}
                    disabled={controlsDisabled}
                    style={{ width: "100%" }}
                  />
                )}
                <Input
                  aria-label="模板名称"
                  value={template.name}
                  onChange={(name) => edit((current) => ({ ...current, name }))}
                  disabled={controlsDisabled}
                  className="template-name"
                />
                <div className="advanced-mapping-summary">
                  <span>数据映射</span>
                  <strong>
                    {template.backgroundFieldId
                      ? `底图：${context.fields.find((field) => field.id === template.backgroundFieldId)?.name ?? "字段已失效"}`
                      : "模板固定底图"}
                  </strong>
                  {template.backgroundFieldId && (
                    <p className="source-template-note" role="status">
                      {sourceError ||
                        (templateSource
                          ? `模板来源：${templateSource.tableName} · ${templateSource.recordName}`
                          : "正在定位底图来源记录…")}
                    </p>
                  )}
                  <Button
                    size="small"
                    onClick={() => {
                      setPropertyPopup(null);
                      setWorkspacePage("mapping");
                    }}
                  >
                    修改字段映射
                  </Button>
                </div>
                <div className="asset-buttons">
                  <Button
                    icon={<IconImage />}
                    onClick={() => backgroundInput.current?.click()}
                    disabled={controlsDisabled}
                  >
                    更换底图
                  </Button>
                  <Button
                    icon={<IconFont />}
                    onClick={() => fontInput.current?.click()}
                    disabled={controlsDisabled}
                  >
                    上传字体
                  </Button>
                </div>
                <div className="asset-buttons">
                  <Button onClick={() => packageInput.current?.click()} disabled={controlsDisabled}>
                    导入模板
                  </Button>
                  <Button onClick={exportTemplate} disabled={controlsDisabled}>
                    导出模板
                  </Button>
                </div>
              </section>
              <LayerPanel
                boxes={template.boxes}
                fields={context.fields}
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
              <section className="panel-section advanced-record-selector">
                <label className="control-label">
                  <span id="advanced-record-label">预览记录</span>
                  <Select
                    aria-labelledby="advanced-record-label"
                    value={recordId ?? undefined}
                    optionList={context.records.map((row) => ({ label: row.label, value: row.id }))}
                    onChange={(value) => requestRecordChange(String(value))}
                    disabled={controlsDisabled}
                    style={{ width: "100%" }}
                  />
                </label>
              </section>
            </aside>
            <div className="canvas-column" id="panel-canvas" aria-labelledby="tab-canvas">
              <div className="document-bar">
                <div>
                  <span className="document-dot" />
                  <strong>{template.name}</strong>
                  <span className="document-record">{record?.label ?? "未选择记录"}</span>
                </div>
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
                  {sourceError || (rowBackground?.key === backgroundKey && rowBackground.error)
                    ? sourceError || rowBackground?.error
                    : recordId
                      ? "正在读取当前行底图…"
                      : "请选择一条有底图的记录"}
                </div>
              )}
            </div>
            <PropertyPanel
              panelRef={propertyPanel}
              popup={propertyPopup}
              selected={selected}
              values={values}
              fields={context.fields}
              fontAssets={fontAssets}
              presetFont={PRESET_FONT}
              disabled={controlsDisabled || Boolean(selected?.locked)}
              canDownload={actions.canPreview}
              onClose={closeProperties}
              onCopy={copyBox}
              onDelete={deleteBox}
              onAdd={addBox}
              onChange={changeBox}
              onDownload={() => previewPng(true)}
              onEditMapping={() => {
                setPropertyPopup(null);
                setWorkspacePage("mapping");
              }}
            />
          </main>
        ) : (
          <FieldMappingPanel
            template={template}
            fields={context.fields}
            selected={selected}
            selectedId={selectedId}
            values={values}
            outputFieldId={outputFieldId}
            disabled={controlsDisabled}
            sourceStatus={
              sourceError ||
              (template.backgroundFieldId
                ? templateSource
                  ? `模板来源：${templateSource.tableName} · ${templateSource.recordName}`
                  : "正在定位底图来源记录…"
                : "模板固定底图")
            }
            onSelectLayer={selectCanvasBox}
            onChange={changeBox}
            onBackgroundFieldChange={requestBackgroundFieldChange}
            onOutputFieldChange={(id) => {
              setOutputFieldId(id);
              setBatchResults([]);
              setProgress(null);
              lastTask.current = null;
            }}
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
