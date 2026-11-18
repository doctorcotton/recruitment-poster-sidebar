import { PosterError, type DataRecord, type RecordPage, type TableField } from "../../domain/types";
import { recordPages } from "../../domain/record-pages";
import type { SdkRecord, SdkTable } from "./sdk";
import { cellText } from "./values";

export function formatRecordDisplayValue(value: unknown, field: TableField): string {
  if (field.kind === "attachment") {
    if (!Array.isArray(value) || !value.length) return "";
    const names = value.map((item) => cellText(item)).filter(Boolean);
    return names.length ? names.join("、") : `${value.length} 个附件`;
  }
  if (field.kind === "lookup" && Array.isArray(value)) {
    return value
      .map((item) => cellText(item))
      .filter(Boolean)
      .join("、");
  }
  return cellText(value, field.kind);
}

export function toDataRecord(record: SdkRecord, fields: TableField[]): DataRecord {
  const values: Record<string, string> = {};
  const displayValues: Record<string, string> = {};
  for (const field of fields) {
    displayValues[field.id] = formatRecordDisplayValue(record.fields[field.id], field);
    if (field.kind !== "attachment") values[field.id] = displayValues[field.id];
  }
  return {
    id: record.recordId,
    label:
      fields
        .filter((field) => field.kind !== "attachment")
        .map((field) => values[field.id])
        .find(Boolean) ?? record.recordId,
    values,
    displayValues,
  };
}

export async function readRecordPage(
  table: SdkTable,
  fields: TableField[],
  pageToken?: number,
  pageSize = 50,
): Promise<RecordPage> {
  const result = await table.getRecordsByPage({
    pageSize,
    ...(pageToken !== undefined ? { pageToken } : {}),
  });
  return {
    records: result.records.map((record) => toDataRecord(record, fields)),
    hasMore: result.hasMore,
    pageToken: result.hasMore ? nextPageToken(result.pageToken, pageToken) : undefined,
    total: result.total,
  };
}

function nextPageToken(next: number | undefined, current?: number): number {
  if (next === undefined || !Number.isSafeInteger(next) || next < 0 || next === (current ?? 0))
    throw new PosterError("PLATFORM_ERROR", "飞书返回无效的分页标记。");
  return next;
}

export async function readAllRecords(table: SdkTable, viewId?: string): Promise<SdkRecord[]> {
  const records: SdkRecord[] = [];
  for await (const page of recordPages((pageToken) =>
    table.getRecordsByPage({
      pageSize: 200,
      ...(viewId ? { viewId } : {}),
      ...(pageToken !== undefined ? { pageToken } : {}),
    }),
  )) {
    records.push(...page.records);
  }
  return records;
}
