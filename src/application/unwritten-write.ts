import { requireScanActive } from "../domain/record-pages";
import type { DataRecord } from "../domain/types";

export interface UnwrittenPlan {
  total: number;
  skipped: number;
  rows: DataRecord[];
}

/** 先用记录附件摘要跳过非空单元格，再对候选行读取实时版本，串行保护平台流量。 */
export async function findUnwrittenRows(
  records: DataRecord[],
  outputFieldId: string,
  readOutputVersion: (row: DataRecord) => Promise<string>,
  signal?: AbortSignal,
  onScanned?: () => void,
): Promise<UnwrittenPlan> {
  const rows: DataRecord[] = [];
  let skipped = 0;
  for (const row of records) {
    requireScanActive(signal);
    const displayValue = row.displayValues?.[outputFieldId];
    if (displayValue !== undefined && displayValue.trim()) {
      skipped++;
    } else if ((await readOutputVersion(row)) === "empty") rows.push(row);
    else skipped++;
    onScanned?.();
  }
  requireScanActive(signal);
  return { total: records.length, skipped, rows };
}
