import type { ReactNode } from "react";
import { Button, Input } from "../../ui/semi";
import { IconRefresh } from "@douyinfe/semi-icons";
import type { DataRecord } from "../../domain/types";

interface Props {
  records: DataRecord[];
  loadedCount: number;
  hasMore: boolean;
  search: string;
  recordId: string | null;
  selectedIds: Set<string>;
  selectedCount: number;
  batchOpen: boolean;
  disabled: boolean;
  canGenerate: boolean;
  blockerText: string;
  children: ReactNode;
  onSearch(value: string): void;
  onSelectRecord(id: string): void;
  onToggleRecord(id: string): void;
  onToggleBatch(): void;
  onLoadMore(): void;
  onRefresh(): void;
  onWriteSelected(): void;
  onRequestAll(): void;
  onWriteUnwritten(): void;
}

/** 默认只选主记录；复选与任务操作在次级批量区域展开。 */
export function RecordPanel(props: Props) {
  return (
    <section className="record-section">
      <h2 className="record-list-heading">多维表记录</h2>
      <div className="record-list-controls">
        <Input
          aria-label="搜索已加载记录"
          placeholder="搜索已加载记录"
          value={props.search}
          onChange={props.onSearch}
          disabled={props.disabled}
          className="record-search"
        />
        <Button
          theme="borderless"
          icon={<IconRefresh />}
          aria-label="刷新记录"
          disabled={props.disabled}
          onClick={props.onRefresh}
        />
      </div>
      <div className="record-list">
        {props.records.map((row) => (
          <div className="record-item" key={row.id}>
            {props.batchOpen && (
              <input
                type="checkbox"
                aria-label={`选择批量记录 ${row.label}`}
                checked={props.selectedIds.has(row.id)}
                onChange={() => props.onToggleRecord(row.id)}
                disabled={props.disabled}
              />
            )}
            <button
              onClick={() => props.onSelectRecord(row.id)}
              disabled={props.disabled}
              aria-pressed={props.recordId === row.id}
              className={`record-row ${props.recordId === row.id ? "selected" : ""}`}
            >
              <span className="radio-dot" />
              <span>{row.label}</span>
            </button>
          </div>
        ))}
      </div>
      {!props.records.length && (
        <p className="empty-copy">
          {props.search ? "已加载记录中没有匹配项" : "当前数据表没有已加载记录"}
        </p>
      )}
      {props.hasMore && (
        <Button block size="small" disabled={props.disabled} onClick={props.onLoadMore}>
          加载更多（已加载 {props.loadedCount} 条）
        </Button>
      )}
      <Button
        block
        theme="borderless"
        className="batch-toggle"
        aria-expanded={props.batchOpen}
        onClick={props.onToggleBatch}
        disabled={props.disabled && props.batchOpen}
      >
        {props.batchOpen
          ? "收起批量生成"
          : `批量生成${props.selectedCount ? ` · 已选 ${props.selectedCount}` : ""}`}
      </Button>
      {props.batchOpen && (
        <div className="record-batch-panel">
          <p>一键生成写回只处理输出附件为空的记录，已有附件自动跳过。</p>
          <div className="record-batch-actions">
            <Button
              block
              theme="solid"
              type="primary"
              disabled={!props.canGenerate}
              title={props.blockerText || "扫描全表，仅写回未生成记录"}
              onClick={props.onWriteUnwritten}
            >
              一键生成写回
            </Button>
            <Button
              block
              disabled={!props.canGenerate || !props.selectedCount}
              title={props.blockerText || "请先勾选记录"}
              onClick={props.onWriteSelected}
            >
              生成已选记录 · {props.selectedCount}
            </Button>
            <Button
              block
              disabled={!props.canGenerate}
              title={props.blockerText || undefined}
              onClick={props.onRequestAll}
            >
              读取全表并生成
            </Button>
          </div>
          {props.children}
        </div>
      )}
    </section>
  );
}
