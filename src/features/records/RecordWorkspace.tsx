import type { ReactNode } from "react";
import { Button } from "../../ui/semi";

interface Props {
  tableName: string;
  disabled: boolean;
  browser: ReactNode;
  preview: ReactNode;
  extras?: ReactNode;
  onSwitchTable(): void;
}

/** 默认记录工作台：左侧记录选择，右侧只读海报预览。 */
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
      <div className="records-preview-column">
        {props.preview}
        {props.extras}
      </div>
    </main>
  );
}
