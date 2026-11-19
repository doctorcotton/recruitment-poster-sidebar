import { Button } from "../../ui/semi";
import type { TemplateRowSummary } from "../../domain/types";

interface Props {
  rows: TemplateRowSummary[];
  selectedRecordId: string | null;
  loading: boolean;
  error: string;
  disabled: boolean;
  tableName: string;
  storageName: string | null;
  storageReady: boolean;
  onSelect(recordId: string): void;
  onSwitchTable(): void;
}

/**
 * 模板页左栏：模板表每一行就是一个模板，点一行即切换正在编辑的模板。
 * 列表只显示主字段文本，不下底图缩略图，避免一次拉多张大图。
 */
export function TemplateListPanel(props: Props) {
  const { rows, selectedRecordId } = props;
  return (
    <aside
      className="left-panel template-list-panel"
      id="panel-templates"
      aria-labelledby="template-list-title"
    >
      <section className="panel-section business-table-section">
        <div className="section-heading">
          <h2>业务数据表</h2>
          <Button size="small" disabled={props.disabled} onClick={props.onSwitchTable}>
            切换数据表
          </Button>
        </div>
        <strong>{props.tableName}</strong>
        <p className="source-template-note">
          配置表：{props.storageName ?? "未初始化"}
          {props.storageReady ? " · 已就绪" : ""}
        </p>
      </section>
      <section className="panel-section">
        <div className="section-heading">
          <h2 id="template-list-title">模板</h2>
          <span>{rows.length}</span>
        </div>
        {props.error && (
          <p className="settings-error" role="alert">
            {props.error}
          </p>
        )}
        {rows.length ? (
          <ul className="template-row-list" aria-label="模板列表">
            {rows.map((row) => {
              const active = row.recordId === selectedRecordId;
              return (
                <li key={row.recordId}>
                  <button
                    type="button"
                    className={`template-row ${active ? "is-active" : ""}`}
                    aria-current={active ? "true" : undefined}
                    disabled={props.disabled}
                    data-template-row={row.recordId}
                    onClick={() => props.onSelect(row.recordId)}
                  >
                    <span className="template-row-label">{row.label}</span>
                    <span className={`template-row-state ${row.configured ? "is-configured" : ""}`}>
                      {row.configured ? "已配置" : "未配置"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-copy">
            {props.loading ? "正在读取模板行…" : "模板表里还没有可用的行。"}
          </p>
        )}
      </section>
    </aside>
  );
}
