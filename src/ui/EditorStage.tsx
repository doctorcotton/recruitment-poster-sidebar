import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./semi";
import type { TemplateBundle, TextBox } from "../domain/types";
import { fitCanvasScale, moveTextBox, resizeTextBox } from "../domain/geometry";
import type { PosterRenderer } from "../rendering";

interface Props {
  renderer: PosterRenderer;
  bundle: TemplateBundle;
  values: Record<string, string>;
  selectedId: string | null;
  disabled?: boolean;
  onSelect(id: string | null): void;
  onEditProperties(id: string, x: number, y: number): void;
  onChangeBox(id: string, updates: Partial<TextBox>): void;
  onCheckpoint(): void;
  onRenderError(message: string): void;
  onOverflow(ids: string[]): void;
}

function arrowDelta(event: React.KeyboardEvent): [number, number] | undefined {
  // Shift 大步移动，Alt 精调；距离始终按原稿像素计算。
  const step = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
  switch (event.key) {
    case "ArrowLeft":
      return [-step, 0];
    case "ArrowRight":
      return [step, 0];
    case "ArrowUp":
      return [0, -step];
    case "ArrowDown":
      return [0, step];
  }
}

export function EditorStage({
  renderer,
  bundle,
  values,
  selectedId,
  disabled = false,
  onSelect,
  onEditProperties,
  onChangeBox,
  onCheckpoint,
  onRenderError,
  onOverflow,
}: Props) {
  const { template } = bundle;
  const scroller = useRef<HTMLDivElement>(null);
  const artboard = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.34);
  const [rendering, setRendering] = useState(true);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  );
  const drawnBundle = useRef<TemplateBundle | null>(null);
  const fitRef = useRef(true);
  const fittedScale = useRef(scale);
  const zoomAnchor = useRef<{
    scale: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const drag = useRef<{
    pointerId: number;
    box: TextBox;
    start: { x: number; y: number };
    resize: boolean;
    last: TextBox;
  } | null>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(
    null,
  );
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const space = useRef(false);
  const latestScale = useRef(scale);
  latestScale.current = scale;

  const fit = useCallback(() => {
    if (!scroller.current) return;
    if (scroller.current.clientWidth <= 64 || scroller.current.clientHeight <= 64) return;
    fitRef.current = true;
    zoomAnchor.current = null;
    fittedScale.current = fitCanvasScale(
      template.width,
      template.height,
      scroller.current.clientWidth,
      scroller.current.clientHeight,
      32,
    );
    setScale(fittedScale.current);
  }, [template.width, template.height]);
  useLayoutEffect(() => {
    fitRef.current = true;
    let frame = 0;
    const resize = () => {
      if (!fitRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (fitRef.current) fit();
      });
    };
    const observer = new ResizeObserver(resize);
    if (scroller.current) observer.observe(scroller.current);
    fit();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit]);

  useEffect(() => {
    const update = () => setDevicePixelRatio(window.devicePixelRatio || 1);
    // 跨屏拖动或系统缩放会改变设备像素比，位图要跟着重建才不糊。
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // 只有换模板或换值才显示加载态；缩放重绘沿用当前画面，避免闪烁。
    const contentChanged = drawnBundle.current !== bundle;
    drawnBundle.current = bundle;
    if (contentChanged) setRendering(true);
    // 拖拽与键盘连发只绘制下一帧实际提交的版本。
    const frame = requestAnimationFrame(() => {
      if (!canvas.current) return;
      void renderer
        .draw(canvas.current, bundle, values, {
          preview: true,
          // 按画板显示像素请求位图：超采样只会让每帧多填充数倍像素。
          maxSide:
            Math.max(template.width, template.height) * scale * Math.min(devicePixelRatio, 2),
          signal: controller.signal,
        })
        .then((result) => {
          if (!controller.signal.aborted) {
            onOverflow(result.overflowBoxIds);
            onRenderError("");
            setRendering(false);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            onOverflow([]);
            onRenderError(error instanceof Error ? error.message : "海报绘制失败");
            setRendering(false);
          }
        });
    });
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [
    bundle,
    values,
    renderer,
    scale,
    devicePixelRatio,
    template.width,
    template.height,
    onOverflow,
    onRenderError,
  ]);

  const zoom = useCallback((next: number, client?: { x: number; y: number }) => {
    const container = scroller.current;
    const board = artboard.current;
    if (!container || !board) return;
    const bounds = board.getBoundingClientRect();
    const area = container.getBoundingClientRect();
    const { x, y } = client ?? { x: area.left + area.width / 2, y: area.top + area.height / 2 };
    const pending = zoomAnchor.current;
    const currentScale = pending?.scale ?? latestScale.current;
    const left = pending ? pending.x - pending.offsetX * currentScale : bounds.left;
    const top = pending ? pending.y - pending.offsetY * currentScale : bounds.top;
    const value = Math.min(3, Math.max(Math.min(0.1, fittedScale.current), next));
    if (value === currentScale) return;
    fitRef.current = false;
    if (value === latestScale.current) {
      zoomAnchor.current = null;
      setScale(value);
      return;
    }
    zoomAnchor.current = {
      scale: value,
      x,
      y,
      offsetX: (x - left) / currentScale,
      offsetY: (y - top) / currentScale,
    };
    setScale(value);
  }, []);

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const container = scroller.current;
    const bounds = artboard.current?.getBoundingClientRect();
    if (!anchor || !container || !bounds || anchor.scale !== scale) return;
    zoomAnchor.current = null;
    container.scrollLeft += bounds.left + anchor.offsetX * scale - anchor.x;
    container.scrollTop += bounds.top + anchor.offsetY * scale - anchor.y;
  }, [scale]);

  useEffect(() => {
    const element = scroller.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom((zoomAnchor.current?.scale ?? latestScale.current) * Math.exp(-event.deltaY * 0.003), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const keyup = (event: KeyboardEvent) => {
      if (event.code === "Space") space.current = false;
    };
    const blur = () => {
      space.current = false;
    };
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [zoom]);

  function point(event: React.PointerEvent) {
    // 借鉴 TDS Studio：通过 SVG 屏幕矩阵反算原稿坐标，缩放和平移不污染模板坐标。
    const matrix = svg.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
      : null;
  }
  function begin(event: React.PointerEvent<SVGElement>, box: TextBox, resize = false) {
    if (
      disabled ||
      space.current ||
      pinch.current ||
      drag.current ||
      event.button !== 0 ||
      box.locked
    )
      return;
    const start = point(event);
    if (!start || !scroller.current) return;
    event.preventDefault();
    event.stopPropagation();
    scroller.current.focus({ preventScroll: true });
    onSelect(box.id);
    drag.current = { pointerId: event.pointerId, box, start, resize, last: box };
    scroller.current.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch.current && pointers.current.size >= 2) {
        const [first, second] = [...pointers.current.values()];
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (distance > 0)
          zoom((pinch.current.scale * distance) / pinch.current.distance, {
            x: (first.x + second.x) / 2,
            y: (first.y + second.y) / 2,
          });
        return;
      }
    }
    if (pan.current?.pointerId === event.pointerId && scroller.current) {
      scroller.current.scrollLeft = pan.current.left - event.clientX + pan.current.x;
      scroller.current.scrollTop = pan.current.top - event.clientY + pan.current.y;
    }
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || disabled) return;
    const now = point(event);
    if (!now) return;
    const dx = now.x - current.start.x;
    const dy = now.y - current.start.y;
    const next = current.resize
      ? resizeTextBox(current.box, current.box.width + dx, current.box.height + dy, template)
      : moveTextBox(current.box, dx, dy, template);
    if (
      next.x === current.last.x &&
      next.y === current.last.y &&
      next.width === current.last.width &&
      next.height === current.last.height
    )
      return;
    if (current.last === current.box) onCheckpoint();
    current.last = next;
    onChangeBox(current.box.id, next);
  }
  function endPointer(event: React.PointerEvent) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
    if (pan.current?.pointerId === event.pointerId) pan.current = null;
    if (!pointers.current.delete(event.pointerId)) return;
    const wasPinching = pinch.current !== null;
    if (pointers.current.size < 2) pinch.current = null;
    if (wasPinching && pointers.current.size === 1 && scroller.current) {
      const [pointerId, remaining] = pointers.current.entries().next().value!;
      pan.current = {
        pointerId,
        x: remaining.x,
        y: remaining.y,
        left: scroller.current.scrollLeft,
        top: scroller.current.scrollTop,
      };
    }
  }

  return (
    <section className="stage-panel" aria-label="海报编辑区域">
      <div className="stage-toolbar">
        <span>
          {template.width} × {template.height}
        </span>
        <div>
          <Button
            theme="borderless"
            size="small"
            aria-label="缩小画布"
            onClick={() => zoom(scale / 1.2)}
          >
            −
          </Button>
          <span className="zoom-readout">{Math.round(scale * 100)}%</span>
          <Button
            theme="borderless"
            size="small"
            aria-label="放大画布"
            onClick={() => zoom(scale * 1.2)}
          >
            ＋
          </Button>
          <Button theme="borderless" size="small" onClick={fit}>
            适应画布
          </Button>
        </div>
      </div>
      <div
        ref={scroller}
        className="stage-scroller"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.code === "Space") {
            space.current = true;
            event.preventDefault();
          }
          const delta = arrowDelta(event);
          const box = template.boxes.find((item) => item.id === selectedId);
          if (!delta || !box || box.locked) return;
          event.preventDefault();
          onCheckpoint();
          onChangeBox(box.id, moveTextBox(box, ...delta, template));
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) space.current = false;
        }}
        onPointerDownCapture={(event) => {
          if (event.pointerType === "touch") {
            if (pointers.current.size >= 2) return;
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            event.currentTarget.setPointerCapture(event.pointerId);
            if (pointers.current.size === 2) {
              const [first, second] = [...pointers.current.values()];
              pinch.current = {
                distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
                scale: latestScale.current,
              };
              drag.current = null;
              pan.current = null;
            } else {
              const hitId = (event.target as Element)
                .closest("[data-box-id]")
                ?.getAttribute("data-box-id");
              if (!hitId || disabled || template.boxes.find((box) => box.id === hitId)?.locked) {
                pan.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  left: event.currentTarget.scrollLeft,
                  top: event.currentTarget.scrollTop,
                };
              }
            }
            event.preventDefault();
          } else if (space.current || event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            pan.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: event.currentTarget.scrollLeft,
              top: event.currentTarget.scrollTop,
            };
          }
        }}
        onPointerMove={move}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
      >
        <div className="stage-centering">
          <div
            ref={artboard}
            className="artboard"
            style={{ width: template.width * scale, height: template.height * scale }}
          >
            <canvas ref={canvas} className="poster-canvas" aria-label="海报预览" />
            <svg
              ref={svg}
              className="selection-overlay"
              viewBox={`0 0 ${template.width} ${template.height}`}
              aria-label="文字框画布"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget && event.button === 0 && !pinch.current) {
                  scroller.current?.focus({ preventScroll: true });
                  onSelect(null);
                }
              }}
            >
              {template.boxes.map((box) => (
                <g
                  key={box.id}
                  data-box-id={box.id}
                  tabIndex={-1}
                  onFocus={() => onSelect(box.id)}
                  onContextMenu={(event) => {
                    if (disabled) return;
                    event.preventDefault();
                    event.stopPropagation();
                    drag.current = null;
                    onEditProperties(box.id, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    if (
                      disabled ||
                      !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                    )
                      return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    onEditProperties(
                      box.id,
                      bounds.left + bounds.width / 2,
                      bounds.top + bounds.height / 2,
                    );
                  }}
                  onPointerDown={(event) => begin(event, box)}
                >
                  <rect
                    role="button"
                    tabIndex={0}
                    aria-label={`${box.label}文字框`}
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    className={`box-outline ${selectedId === box.id ? "selected" : ""}`}
                    strokeWidth={(selectedId === box.id ? 1.7 : 1) / scale}
                  />
                  {selectedId === box.id && (
                    <>
                      <rect
                        x={box.x}
                        y={box.y - 20 / scale}
                        width={Math.max(50, box.label.length * 12 + 16) / scale}
                        height={20 / scale}
                        rx={3 / scale}
                        fill="#007c83"
                      />
                      <text
                        x={box.x + 7 / scale}
                        y={box.y - 6 / scale}
                        fill="white"
                        fontSize={11 / scale}
                      >
                        {box.label}
                      </text>
                      {!box.locked && (
                        <rect
                          role="button"
                          tabIndex={0}
                          aria-label={`调整${box.label}大小`}
                          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                          x={box.x + box.width - 5 / scale}
                          y={box.y + box.height - 5 / scale}
                          width={10 / scale}
                          height={10 / scale}
                          fill="white"
                          stroke="#007c83"
                          strokeWidth={1.5 / scale}
                          className="resize-handle"
                          onPointerDown={(event) => begin(event, box, true)}
                          onKeyDown={(event) => {
                            const delta = arrowDelta(event);
                            if (disabled || !delta) return;
                            event.preventDefault();
                            event.stopPropagation();
                            onCheckpoint();
                            onChangeBox(
                              box.id,
                              resizeTextBox(
                                box,
                                box.width + delta[0],
                                box.height + delta[1],
                                template,
                              ),
                            );
                          }}
                        />
                      )}
                    </>
                  )}
                </g>
              ))}
            </svg>
          </div>
        </div>
        {rendering && (
          <span className="canvas-loading" role="status">
            正在绘制…
          </span>
        )}
      </div>
      <div className="stage-footnote">
        拖动文字框 · 方向键 1px · Shift 10px · Alt 0.1px · Ctrl / ⌘ + 滚轮缩放 · 空格拖动画布
      </div>
    </section>
  );
}
