import type { PosterTemplate, TextBox } from "./types";

type CanvasSize = Pick<PosterTemplate, "width" | "height">;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** 位置与尺寸保留到 0.1px，字号与行数取整，行距保留到 0.01。 */
export const BOX_PRECISION = { position: 1, fontSize: 0, lineHeight: 2 } as const;

/** 按小数位四舍五入，消除 0.1 步进带来的浮点噪声。 */
export function quantize(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function positive(...values: number[]): void {
  if (values.some((value) => !Number.isFinite(value) || value <= 0))
    throw new RangeError("画布尺寸必须为正有限数值");
}

/** 缩放仅用于视口展示，文本框始终使用原始画布坐标。 */
export function fitCanvasScale(
  width: number,
  height: number,
  availableWidth: number,
  availableHeight: number,
  padding = 32,
): number {
  positive(width, height, availableWidth, availableHeight);
  if (!Number.isFinite(padding) || padding < 0) throw new RangeError("画布留白不能为负数");
  return Math.max(
    0,
    Math.min(1, (availableWidth - padding * 2) / width, (availableHeight - padding * 2) / height),
  );
}

export function moveTextBox(box: TextBox, dx: number, dy: number, canvas: CanvasSize): TextBox {
  positive(canvas.width, canvas.height);
  if (![dx, dy].every(Number.isFinite)) throw new RangeError("移动距离必须为有限数值");
  const width = Math.min(box.width, canvas.width);
  const height = Math.min(box.height, canvas.height);
  return {
    ...box,
    width,
    height,
    x: clamp(box.x + dx, 0, canvas.width - width),
    y: clamp(box.y + dy, 0, canvas.height - height),
  };
}

export function resizeTextBox(
  box: TextBox,
  width: number,
  height: number,
  canvas: CanvasSize,
): TextBox {
  positive(canvas.width, canvas.height);
  if (![width, height].every(Number.isFinite)) throw new RangeError("文本框尺寸必须为有限数值");
  const x = clamp(box.x, 0, Math.max(0, canvas.width - 1));
  const y = clamp(box.y, 0, Math.max(0, canvas.height - 1));
  return {
    ...box,
    x,
    y,
    width: clamp(width, Math.min(1, canvas.width), canvas.width - x),
    height: clamp(height, Math.min(1, canvas.height), canvas.height - y),
  };
}

/**
 * 面板输入、拖拽、缩放手柄和键盘微调共用同一量化规则：
 * 显示值、模板存储值和排版实际使用的值必须是同一个数。
 */
export function normalizeTextBox(box: TextBox): TextBox {
  const fontSize = Math.max(1, quantize(box.fontSize, BOX_PRECISION.fontSize));
  return {
    ...box,
    x: Math.max(0, quantize(box.x, BOX_PRECISION.position)),
    y: Math.max(0, quantize(box.y, BOX_PRECISION.position)),
    // 量化会把 0.04 这样的尺寸抹成 0，这里保住领域要求的最小正数。
    width: Math.max(1, quantize(box.width, BOX_PRECISION.position)),
    height: Math.max(1, quantize(box.height, BOX_PRECISION.position)),
    fontSize,
    // 最小字号永远不超过当前字号，避免排版时搜索区间反向。
    minFontSize: Math.min(fontSize, Math.max(1, quantize(box.minFontSize, BOX_PRECISION.fontSize))),
    lineHeight: quantize(box.lineHeight, BOX_PRECISION.lineHeight),
    maxLines: Math.max(1, Math.round(box.maxLines)),
  };
}
