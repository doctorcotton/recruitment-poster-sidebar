import { useEffect, useRef, useState } from "react";
import type { TemplateBundle } from "../../domain/types";
import type { PosterRenderer } from "../../rendering";

interface Props {
  renderer: PosterRenderer;
  bundle: TemplateBundle | null;
  values: Record<string, string>;
  recordLabel: string;
  placeholder?: string;
}

/** 记录页只读实时海报，不包含 SVG 选框、拖拽或编辑快捷键。 */
export function ReadOnlyPosterPreview({
  renderer,
  bundle,
  values,
  recordLabel,
  placeholder,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [completed, setCompleted] = useState<{
    renderer: PosterRenderer;
    bundle: TemplateBundle;
    values: Record<string, string>;
    outcome: { overflowCount: number } | { error: string };
  } | null>(null);
  const outcome =
    completed?.renderer === renderer && completed.bundle === bundle && completed.values === values
      ? completed.outcome
      : null;
  const error = outcome && "error" in outcome ? outcome.error : "";
  const overflowCount = outcome && "overflowCount" in outcome ? outcome.overflowCount : 0;
  // 切换记录时先隐藏旧海报，直到新记录绘制成功。
  const showCanvas = outcome !== null && "overflowCount" in outcome;

  useEffect(() => {
    setCompleted(null);
    const target = canvas.current;
    if (!bundle || !target) return;
    const controller = new AbortController();
    const finish = (outcome: { overflowCount: number } | { error: string }) => {
      if (!controller.signal.aborted) setCompleted({ renderer, bundle, values, outcome });
    };
    const frame = requestAnimationFrame(() => {
      void renderer
        .draw(target, bundle, values, { preview: true, signal: controller.signal })
        .then((result) => finish({ overflowCount: result.overflowBoxIds.length }))
        .catch((reason: unknown) =>
          finish({ error: reason instanceof Error ? reason.message : "海报绘制失败" }),
        );
    });
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [renderer, bundle, values]);

  return (
    <section className="readonly-poster-card" aria-label="当前记录海报">
      <div className="readonly-poster-stage">
        {bundle ? (
          <>
            <canvas
              ref={canvas}
              className="readonly-poster-canvas"
              style={{
                aspectRatio: `${bundle.template.width} / ${bundle.template.height}`,
                visibility: showCanvas ? "visible" : "hidden",
              }}
              aria-label={`${recordLabel}海报预览`}
            />
            {!outcome && (
              <span className="canvas-loading" role="status">
                正在绘制…
              </span>
            )}
          </>
        ) : (
          <div className="record-preview-placeholder" role="status">
            {placeholder || "请选择一条记录"}
          </div>
        )}
      </div>
      {error && (
        <p className="record-preview-error" role="alert">
          {error}
        </p>
      )}
      {!error && overflowCount > 0 && (
        <p className="record-preview-warning" role="status">
          {overflowCount} 个文字框内容溢出，正式生成前请在高级编辑中调整。
        </p>
      )}
    </section>
  );
}
