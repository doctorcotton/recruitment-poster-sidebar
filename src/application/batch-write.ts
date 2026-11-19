import {
  PosterError,
  type DataRecord,
  type TableField,
  type TemplateBundle,
  type WorkspaceContext,
} from "../domain/types";

export type BatchRowStatus =
  | "pending"
  | "validating"
  | "preflight_failed"
  | "rendering"
  | "render_failed"
  | "writing"
  | "write_failed"
  | "write_unknown"
  | "conflict"
  | "succeeded"
  | "stopped";
export interface BatchRowResult {
  recordId: string;
  label: string;
  status: BatchRowStatus;
  message?: string;
}

export interface BatchWriteOperations {
  /** 模板表字段集；跨表绑定的图层要靠它判断字段是否仍然有效。 */
  templateTable?: { tableId: string; fields: TableField[] } | null;
  prepareBundle(row: DataRecord): Promise<TemplateBundle>;
  resolveBundle(row: DataRecord, bundle: TemplateBundle): Promise<TemplateBundle>;
  readOutputVersion(row: DataRecord): Promise<string>;
  render(row: DataRecord, bundle: TemplateBundle, signal: AbortSignal): Promise<Blob>;
  write(
    row: DataRecord,
    bundle: TemplateBundle,
    blob: Blob,
    expectedVersion: string,
  ): Promise<void>;
  onChange(results: BatchRowResult[]): void;
}

export function validateWriteBundle(
  bundle: TemplateBundle,
  context: WorkspaceContext,
  outputFieldId: string,
  templateTable?: { tableId: string; fields: TableField[] } | null,
): void {
  const output = context.fields.find((field) => field.id === outputFieldId);
  if (!output || output.kind !== "attachment")
    throw new PosterError("INVALID_ASSET", "请选择有效的附件输出字段");
  // 图层可能绑数据表变量，也可能绑模板行文案，两张表的字段集都要参与失效判断。
  const missing = bundle.template.boxes.filter((box) => {
    if (!box.fieldId) return false;
    if (!box.fieldTableId) return !context.fields.some((field) => field.id === box.fieldId);
    if (box.fieldTableId !== templateTable?.tableId) return true;
    return !templateTable.fields.some((field) => field.id === box.fieldId);
  });
  if (missing.length)
    throw new PosterError(
      "INVALID_TEMPLATE",
      `请重新绑定已失效字段：${missing.map((box) => box.label).join("、")}`,
    );
}

export function canRetryBatchRow(status: BatchRowStatus): boolean {
  return (
    status === "preflight_failed" ||
    status === "render_failed" ||
    status === "write_failed" ||
    status === "stopped"
  );
}

export function retryableBatchRows(results: BatchRowResult[]): DataRecord[] {
  return results
    .filter((row) => canRetryBatchRow(row.status))
    .map((row) => ({ id: row.recordId, label: row.label, values: {} }));
}

export function summarizeBatch(results: BatchRowResult[]) {
  const summary = {
    total: results.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    conflict: 0,
    stopped: 0,
  };
  for (const { status } of results) {
    if (status === "succeeded") summary.succeeded++;
    else if (status === "conflict") summary.conflict++;
    else if (status === "write_unknown") summary.unknown++;
    else if (status === "stopped") summary.stopped++;
    else if (canRetryBatchRow(status)) summary.failed++;
    else continue;
    summary.done++;
  }
  return summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

/**
 * 非事务批处理：先完成所有轻量预检，再逐行渲染和写入。
 * 写阶段异常默认不可安全重试；只有明确的冲突和未知结果被单独标记。
 */
export async function runBatchWrite(
  rows: DataRecord[],
  context: WorkspaceContext,
  outputFieldId: string,
  signal: AbortSignal,
  operations: BatchWriteOperations,
  emptyOnly = false,
): Promise<BatchRowResult[]> {
  const results: BatchRowResult[] = rows.map((row) => ({
    recordId: row.id,
    label: row.label,
    status: "pending",
  }));
  const versions: (string | undefined)[] = [];
  let lastPublished = -Infinity;
  function publish(force = false) {
    const now = performance.now();
    if (!force && now - lastPublished < 100) return;
    lastPublished = now;
    // 行对象只替换、不就地修改；只在展示进度时复制数组。
    operations.onChange(results.slice());
  }
  const update = (index: number, status: BatchRowStatus, error?: unknown) => {
    results[index] = {
      ...results[index],
      status,
      ...(error === undefined ? {} : { message: message(error) }),
    };
    publish();
  };
  publish(true);

  for (let index = 0; index < rows.length; index++) {
    if (signal.aborted) break;
    const row = rows[index];
    update(index, "validating");
    try {
      // 仅补空时，沿用扫描确认的空版本，写前仍由仓储核对实时附件。
      versions[index] = emptyOnly ? "empty" : await operations.readOutputVersion(row);
    } catch (error) {
      if (signal.aborted) break;
      update(index, "preflight_failed", error);
    }
  }

  for (let index = 0; index < rows.length; index++) {
    if (signal.aborted) break;
    const row = rows[index];
    const expectedVersion = versions[index];
    if (expectedVersion === undefined) continue;
    // 全表只持有轻量附件版本；底图和字体随当前行使用完即可释放。
    let bundle: TemplateBundle;
    try {
      bundle = await operations.prepareBundle(row);
      validateWriteBundle(bundle, context, outputFieldId, operations.templateTable);
    } catch (error) {
      if (signal.aborted) break;
      update(index, "preflight_failed", error);
      continue;
    }
    if (signal.aborted) break;
    let blob: Blob;
    update(index, "rendering");
    try {
      const resolved = await operations.resolveBundle(row, bundle);
      if (signal.aborted) break;
      blob = await operations.render(row, resolved, signal);
    } catch (error) {
      if (signal.aborted) break;
      update(index, "render_failed", error);
      continue;
    }
    if (signal.aborted) break;
    update(index, "writing");
    try {
      await operations.write(row, bundle, blob, expectedVersion);
      // 即使等待写入期间收到停止，已确认完成的行也必须记为成功。
      update(index, "succeeded");
    } catch (error) {
      const code = error instanceof PosterError ? error.code : "";
      update(
        index,
        code === "WRITE_OUTCOME_UNKNOWN"
          ? "write_unknown"
          : code === "WRITE_CONFLICT"
            ? "conflict"
            : "write_failed",
        error,
      );
    }
  }
  if (signal.aborted) {
    results.forEach((row, index) => {
      if (row.status === "pending" || row.status === "validating" || row.status === "rendering")
        results[index] = { ...row, status: "stopped" };
    });
  }
  publish(true);
  return results;
}
