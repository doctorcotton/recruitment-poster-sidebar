import type { ReactNode } from "react";
import type { DataRecord, TableField } from "../../domain/types";
import { buildRecordFieldRows } from "./record-field-rows";

const KIND_LABELS = {
  text: "文本",
  number: "数字",
  select: "选择",
  phone: "电话",
  url: "链接",
  attachment: "附件",
  lookup: "查找引用",
  other: "其他",
} as const;

interface Props {
  record: DataRecord | null;
  fields: TableField[];
  children?: ReactNode;
}

/** 当前主记录的只读详情，字段顺序与多维表元数据一致。 */
export function RecordFieldsPanel({ record, fields, children }: Props) {
  const rows = buildRecordFieldRows(fields, record);
  return (
    <section className="record-fields-panel" aria-labelledby="record-fields-title">
      <header className="record-detail-header">
        <span className="record-eyebrow">当前主记录</span>
        <h2 id="record-fields-title">{record?.label ?? "请选择一条记录"}</h2>
        {record && <p>{fields.length} 个字段 · 按多维表字段顺序</p>}
      </header>
      {record ? (
        <dl className="record-field-list">
          {rows.map((row) => (
            <div
              className={`record-field-row ${row.empty ? "is-empty" : ""}`}
              key={row.id}
              data-field-id={row.id}
            >
              <dt>
                <span>{row.name}</span>
                <small>{KIND_LABELS[row.kind]}</small>
              </dt>
              <dd>{row.empty ? <span className="record-empty-value">空</span> : row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="record-detail-empty">选择记录后可查看完整字段和值。</div>
      )}
      {children}
    </section>
  );
}
