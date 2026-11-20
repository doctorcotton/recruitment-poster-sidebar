import type { DataRecord } from "../domain/types";

/** 记录的输出附件状态；本地展示值就能判断，不需要为筛选逐行读附件。 */
export type RecordOutputState = "unwritten" | "written" | "unknown";
export type RecordOutputFilter = "all" | "unwritten" | "written";

export interface RecordOutputCounts {
  all: number;
  unwritten: number;
  written: number;
  unknown: number;
}

export function recordOutputState(row: DataRecord, outputFieldId: string): RecordOutputState {
  if (!outputFieldId) return "unknown";
  const value = row.displayValues?.[outputFieldId];
  // 没有展示值的记录不能凭本地猜“空”：旧数据或分页未带附件信息时，
  // 猜空会让“全选 + 生成已选”覆盖掉真实已生成的附件。
  if (value === undefined) return "unknown";
  return value.trim() ? "written" : "unwritten";
}

export function countRecordOutputs(
  records: DataRecord[],
  outputFieldId: string,
): RecordOutputCounts {
  const counts: RecordOutputCounts = {
    all: records.length,
    unwritten: 0,
    written: 0,
    unknown: 0,
  };
  for (const row of records) counts[recordOutputState(row, outputFieldId)]++;
  return counts;
}

/** 未知状态的记录只出现在“全部”里，避免误判后被批量覆盖。 */
export function filterRecordsByOutput(
  records: DataRecord[],
  outputFieldId: string,
  filter: RecordOutputFilter,
): DataRecord[] {
  if (filter === "all") return records;
  return records.filter((row) => recordOutputState(row, outputFieldId) === filter);
}

export type SelectAllState = "all" | "some" | "none";

export function selectAllState(visibleIds: string[], selectedIds: Set<string>): SelectAllState {
  if (!visibleIds.length) return "none";
  let selected = 0;
  for (const id of visibleIds) if (selectedIds.has(id)) selected++;
  if (selected === 0) return "none";
  return selected === visibleIds.length ? "all" : "some";
}

/**
 * 全选只作用于当前可见（筛选后）的记录：
 * 已满则清空可见部分，未满则补齐可见部分，筛选之外的已选项保持不变。
 */
export function toggleSelectAll(selected: Set<string>, visibleIds: string[]): Set<string> {
  const next = new Set(selected);
  const full = selectAllState(visibleIds, selected) === "all";
  for (const id of visibleIds) {
    if (full) next.delete(id);
    else next.add(id);
  }
  return next;
}
