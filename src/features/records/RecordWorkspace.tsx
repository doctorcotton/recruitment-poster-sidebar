import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Button } from "../../ui/semi";

interface Props {
  tableName: string;
  disabled: boolean;
  browser: ReactNode;
  preview: ReactNode;
  extras?: ReactNode;
  onSwitchTable(): void;
}

const STORAGE_KEY = "recruitment-poster.browser-width";
const MIN_WIDTH = 120;
const MAX_WIDTH = 560;
/** 与样式表里 --browser-width 的默认值保持一致，避免首帧读数偏差。 */
const DEFAULT_WIDTH = 200;
/** 左栏最多占容器 60%，右侧海报永远保留可读宽度。 */
const MAX_RATIO = 0.6;
const KEYBOARD_STEP = 16;

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // 隐私模式下 localStorage 可能直接抛错，退回默认宽度即可。
    return null;
  }
}

function persistWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // 持久化失败不影响本次拖动。
  }
}

/** 默认记录工作台：左侧记录选择，右侧只读海报预览，中间分隔条可拖动改比例。 */
export function RecordWorkspace(props: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const browserRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [width, setWidth] = useState<number | null>(readStoredWidth);
  const [dragging, setDragging] = useState(false);

  const clampWidth = useCallback((next: number) => {
    const total = containerRef.current?.getBoundingClientRect().width ?? 0;
    const limit = total > 0 ? Math.min(MAX_WIDTH, total * MAX_RATIO) : MAX_WIDTH;
    return Math.round(Math.min(Math.max(next, MIN_WIDTH), Math.max(MIN_WIDTH, limit)));
  }, []);

  const commitWidth = useCallback(
    (next: number) => {
      const value = clampWidth(next);
      setWidth(value);
      persistWidth(value);
      return value;
    },
    [clampWidth],
  );

  const currentWidth = useCallback(
    () => width ?? browserRef.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH,
    [width],
  );

  // 容器变窄时旧宽度可能越界，收敛回允许区间；不改动未越界的用户设置。
  useEffect(() => {
    if (width === null) return;
    function onResize() {
      const next = clampWidth(width!);
      if (next !== width) setWidth(next);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampWidth, width]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const value = clampWidth(drag.startWidth + (event.clientX - drag.startX));
    setWidth(value);
    persistWidth(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0;
    if (step) {
      event.preventDefault();
      commitWidth(currentWidth() + step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      commitWidth(MIN_WIDTH);
    }
    if (event.key === "End") {
      event.preventDefault();
      commitWidth(MAX_WIDTH);
    }
  }

  function resetWidth() {
    setWidth(null);
    persistWidth(null);
  }

  const style = width === null ? undefined : ({ "--browser-width": `${width}px` } as CSSProperties);
  return (
    <main
      ref={containerRef}
      className={`records-workspace${dragging ? " is-resizing" : ""}`}
      style={style}
    >
      <aside className="records-browser" ref={browserRef}>
        <section className="record-table-card">
          <span className="record-eyebrow">业务数据表</span>
          <strong title={props.tableName}>{props.tableName}</strong>
          <Button size="small" disabled={props.disabled} onClick={props.onSwitchTable}>
            切换数据表
          </Button>
        </section>
        {props.browser}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整记录栏宽度"
        aria-valuenow={Math.round(currentWidth())}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="records-resize-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={resetWidth}
        title="拖动调整记录栏宽度，双击恢复默认"
      >
        <span className="records-resize-grip" aria-hidden="true" />
      </div>
      <div className="records-preview-column">
        {props.preview}
        {props.extras}
      </div>
    </main>
  );
}
