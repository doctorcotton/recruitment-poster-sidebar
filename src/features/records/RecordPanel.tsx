import { useEffect, useRef, type ReactNode } from "react";
import { Button, Input } from "../../ui/semi";
import { IconRefresh } from "@douyinfe/semi-icons";
import type { DataRecord } from "../../domain/types";
import type {
  RecordOutputCounts,
  RecordOutputFilter,
  SelectAllState,
} from "../../application/record-filter";

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
  /** 输出字段未选定时整块筛选与批量能力都无意义。 */
  canFilter: boolean;
  filter: RecordOutputFilter;
  counts: RecordOutputCounts;
  selectAll: SelectAllState;
  blockerText: string;
  children: ReactNode;
  onSearch(value: string): void;
  onSelectRecord(id: string): void;
  onToggleRecord(id: string): void;
  onToggleAll(): void;
  onClearSelection(): void;
  onFilter(value: RecordOutputFilter): void;
  onToggleBatch(): void;
  onLoadMore(): void;
  onRefresh(): void;
  onWriteSelected(): void;
  onRequestAll(): void;
  onWriteUnwritten(): void;
}

const FILTERS: { value: RecordOutputFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "unwritten", label: "未生成" },
  { value: "written", label: "已生成" },
];

/** 默认只选主记录；复选与任务操作在次级批量区域展开。 */
export function RecordPanel(props: Props) {
  const selectAllRef = useRef<HTMLInputElement>(null);
  // 部分选中要显示成横杠，原生 indeterminate 只能命令式赋值。
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = props.selectAll === "some";
  }, [props.selectAll]);

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
      {props.canFilter && (
        <div className="record-filter-row" role="group" aria-label="按输出附件筛选记录">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`record-filter-chip ${props.filter === item.value ? "is-active" : ""}`}
              aria-pressed={props.filter === item.value}
              onClick={() => props.onFilter(item.value)}
            >
              {item.label}
              <span className="record-filter-count">{props.counts[item.value]}</span>
            </button>
          ))}
        </div>
      )}
      {props.batchOpen && (
        <div className="record-select-all">
          <label>
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={props.selectAll === "all"}
              onChange={props.onToggleAll}
              disabled={props.disabled || !props.records.length}
            />
            <span>全选{props.filter === "all" ? "本页" : "筛选结果"}</span>
          </label>
          <span className="record-select-summary">
            {props.selectedCount ? `已选 ${props.selectedCount} 条` : "未选择"}
            {props.selectedCount > 0 && (
              <button type="button" className="record-link" onClick={props.onClearSelection}>
                清空
              </button>
            )}
          </span>
        </div>
      )}
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
          {props.search
            ? "已加载记录中没有匹配项"
            : props.filter === "unwritten"
              ? "已加载记录都已生成，没有待补的记录"
              : props.filter === "written"
                ? "已加载记录都还没有生成过海报"
                : "当前数据表没有已加载记录"}
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
          <div className="record-batch-actions">
            <Button
              block
              theme="solid"
              type="primary"
              disabled={!props.canGenerate || !props.selectedCount}
              title={
                props.blockerText ||
                (props.selectedCount ? "生成并替换已选记录的输出附件" : "先勾选要生成的记录")
              }
              onClick={props.onWriteSelected}
            >
              生成已选 · {props.selectedCount}
            </Button>
            <Button
              block
              disabled={!props.canGenerate}
              title={props.blockerText || "扫描全表，只写输出附件为空的记录"}
              onClick={props.onWriteUnwritten}
            >
              补齐未生成记录
            </Button>
            <Button
              block
              type="danger"
              disabled={!props.canGenerate}
              title={props.blockerText || "读取全表并覆盖已有输出附件，操作前会再次确认"}
              onClick={props.onRequestAll}
            >
              全表重新生成
            </Button>
          </div>
          <p>补齐只写空附件；生成已选与全表会替换已有附件。</p>
          {props.children}
        </div>
      )}
    </section>
  );
}
