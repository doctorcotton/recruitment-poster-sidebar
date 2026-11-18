import type { DataRecord, FieldKind, TableField } from "../../domain/types";

export interface RecordFieldRow {
  id: string;
  name: string;
  kind: FieldKind;
  value: string;
  empty: boolean;
}

/** 字段元数据数组是主记录详情的唯一顺序来源。 */
export function buildRecordFieldRows(
  fields: TableField[],
  record: DataRecord | null,
): RecordFieldRow[] {
  return fields.map((field) => {
    const value = record?.displayValues?.[field.id] ?? record?.values[field.id] ?? "";
    return {
      id: field.id,
      name: field.name,
      kind: field.kind,
      value,
      empty: value.trim().length === 0,
    };
  });
}
