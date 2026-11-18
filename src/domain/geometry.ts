import type { PosterTemplate, TextBox } from "./types";

type CanvasSize = Pick<PosterTemplate, "width" | "height">;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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
