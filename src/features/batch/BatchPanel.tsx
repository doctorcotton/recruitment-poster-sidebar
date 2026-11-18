import { useState } from "react";
import { Button } from "../../ui/semi";
import { canRetryBatchRow, type BatchRowResult } from "../../application/batch-write";

const LABELS: Record<BatchRowResult["status"], string> = {
  pending: "待处理",
  validating: "预检中",
  preflight_failed: "预检失败",
  rendering: "渲染中",
  render_failed: "渲染失败",
  writing: "写入中",
  write_failed: "写入失败",
  write_unknown: "结果未知",
  conflict: "附件冲突",
  succeeded: "成功",
  stopped: "已停止",
};
const RESULTS_PER_PAGE = 20;

interface Props {
  progress: { done: number; total: number } | null;
  results: BatchRowResult[];
  busy: string | null;
  onStop(): void;
  onRetry(): void;
}

/** 批量结束后保留逐行收据；冲突与未知结果没有自动重试入口。 */
export function BatchPanel({ progress, results, busy, onStop, onRetry }: Props) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(results.length / RESULTS_PER_PAGE) - 1);
  const currentPage = Math.min(page, lastPage);
  if (page !== currentPage) setPage(currentPage);
  const start = currentPage * RESULTS_PER_PAGE;
  const end = Math.min(start + RESULTS_PER_PAGE, results.length);

  if (!progress && !results.length) return null;
  return (
    <>
      {progress && (
        <div className="batch-progress">
          <progress aria-label="批量生成进度" max={progress.total} value={progress.done} />
          <span>
            {progress.done}/{progress.total}
          </span>
          {busy === "write" && (
            <Button size="small" onClick={onStop}>
              停止后续
            </Button>
          )}
        </div>
      )}
      {results.length > 0 && (
        <section className="batch-results" aria-label="批量生成结果">
          {lastPage > 0 && (
            <div className="batch-pagination">
              <Button
                size="small"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </Button>
              <span role="status">
                {start + 1}–{end} / {results.length}
              </span>
              <Button
                size="small"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
            </div>
          )}
          <ul
            className="batch-result-list"
            key={currentPage}
            role="list"
            tabIndex={0}
            aria-label="本页结果"
          >
            {results.slice(start, end).map((row) => (
              <li key={row.recordId} className={`batch-result-row status-${row.status}`}>
                <strong>{row.label}</strong>
                <span>{LABELS[row.status]}</span>
                {row.message && <small>{row.message}</small>}
              </li>
            ))}
          </ul>
          {!busy && results.some((row) => canRetryBatchRow(row.status)) && (
            <Button size="small" onClick={onRetry}>
              仅重试可安全重试的记录
            </Button>
          )}
        </section>
      )}
    </>
  );
}
