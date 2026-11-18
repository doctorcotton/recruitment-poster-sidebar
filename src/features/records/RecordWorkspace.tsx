import type { ReactNode } from "react";
import { Button } from "../../ui/semi";
import type { DataRecord, TableField } from "../../domain/types";
import { RecordFieldsPanel } from "./RecordFieldsPanel";

interface Props {
  tableName: string;
  record: DataRecord | null;
  fields: TableField[];
  disabled: boolean;
  browser: ReactNode;
  preview: ReactNode;
  extras?: ReactNode;
  onSwitchTable(): void;
}

/** 默认记录工作台：记录选择、主记录字段、只读海报三个清晰区域。 */
export function RecordWorkspace(props: Props) {
  return (
    <main className="records-workspace">
      <aside className="records-browser">
        <section className="record-table-card">
          <span className="record-eyebrow">业务数据表</span>
          <strong>{props.tableName}</strong>
          <Button size="small" disabled={props.disabled} onClick={props.onSwitchTable}>
            切换数据表
          </Button>
        </section>
        {props.browser}
      </aside>
      <RecordFieldsPanel record={props.record} fields={props.fields}>
        {props.extras}
      </RecordFieldsPanel>
      <div className="records-preview-column">{props.preview}</div>
    </main>
  );
}
