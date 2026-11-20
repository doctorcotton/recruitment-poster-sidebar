import { layoutText, type TextLayout } from "../domain/layout";
import { bindingKey } from "../domain/field-binding";
import { validateTemplate } from "../domain/validation";
import {
  PosterError,
  type PosterAsset,
  type PosterTemplate,
  type TemplateBundle,
} from "../domain/types";
import { createRenderAssets } from "./assets";
import { abortable, cancelled, forwardAbort } from "./cancellation";

export interface DrawOptions {
  preview?: boolean;
  /** 预览位图长边上限；编辑区按显示尺寸传入，避免超采样浪费每帧填充。 */
  maxSide?: number;
  signal?: AbortSignal;
}
export interface DrawResult {
  overflowBoxIds: string[];
}
export interface PosterRenderer {
  draw(
    canvas: HTMLCanvasElement,
    bundle: TemplateBundle,
    values: Record<string, string>,
    options?: DrawOptions,
  ): Promise<DrawResult>;
  png(bundle: TemplateBundle, values: Record<string, string>, signal?: AbortSignal): Promise<Blob>;
  dispose(): void;
}

const MAX_PREVIEW_SIDE = 2048;
const MIN_PREVIEW_SIDE = 320;

/** 预览位图长边：编辑区按显示像素传入，缺省仍按 2048 上限。 */
function previewSide(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return MAX_PREVIEW_SIDE;
  return Math.min(MAX_PREVIEW_SIDE, Math.max(MIN_PREVIEW_SIDE, Math.round(requested)));
}

/** 尺寸未变时不赋值；给 width/height 赋值会重建整块像素缓冲。 */
function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function resolveAssets(bundle: TemplateBundle, template: PosterTemplate) {
  const assets = new Map<string, PosterAsset>();
  for (const asset of bundle.assets) {
    if (!asset.id || assets.has(asset.id) || !(asset.blob instanceof Blob) || !asset.blob.size)
      throw new PosterError("INVALID_ASSET", "素材标识重复、内容为空或格式无效");
    assets.set(asset.id, asset);
  }
  const getAsset = (id: string) => {
    const asset = assets.get(id);
    if (!asset) throw new PosterError("INVALID_ASSET", `缺少素材：${id}`);
    return asset;
  };
  return { background: getAsset(template.backgroundId), fonts: template.fontIds.map(getAsset) };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new PosterError("RENDER_FAILED", "浏览器无法创建 Canvas 2D 上下文");
  return context;
}

/** 预览按原稿坐标排版，限制位图尺寸；PNG 直接在全尺寸导出画布上绘制。 */
export function createPosterRenderer(): PosterRenderer {
  const lifetime = new AbortController();
  const assets = createRenderAssets(lifetime.signal);
  const layouts = new Map<string, TextLayout>();
  const latestDraw = new WeakMap<HTMLCanvasElement, AbortController>();
  // 拖拽每帧都要用离屏画布合成，复用同一块缓冲，避免逐帧新建 2K 画布。
  let stagingCanvas: HTMLCanvasElement | undefined;
  const staging = () => (stagingCanvas ??= document.createElement("canvas"));

  async function paint(
    canvas: HTMLCanvasElement,
    bundle: TemplateBundle,
    values: Record<string, string>,
    maxSide: number | null,
    signal: AbortSignal,
    copyFrame?: () => void,
  ): Promise<DrawResult> {
    const template = validateTemplate(bundle.template);
    const { background, fonts } = resolveAssets(bundle, template);
    const usedFontIds = new Set(template.boxes.map((box) => box.fontId));
    const usedFonts = fonts.filter((asset) => usedFontIds.has(asset.id));
    const [image, faces] = await abortable(
      Promise.all([assets.background(background), Promise.all(usedFonts.map(assets.font))]),
      signal,
    );
    if (signal.aborted) throw cancelled();
    const families = new Map(usedFonts.map((asset, index) => [asset.id, faces[index].family]));
    const { width, height } = template;
    const scale = maxSide === null ? 1 : Math.min(1, maxSide / Math.max(width, height));
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    resizeCanvas(canvas, pixelWidth, pixelHeight);
    const context = context2d(canvas);
    // 复用画布时必须显式复位变换并清空，否则上一帧的缩放和像素会残留。
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.scale(pixelWidth / width, pixelHeight / height);
    const backgroundScale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const backgroundWidth = image.naturalWidth * backgroundScale;
    const backgroundHeight = image.naturalHeight * backgroundScale;
    context.drawImage(
      image,
      (width - backgroundWidth) / 2,
      (height - backgroundHeight) / 2,
      backgroundWidth,
      backgroundHeight,
    );
    const overflowBoxIds: string[] = [];
    try {
      assets.registerFonts(faces);
      for (const box of template.boxes) {
        const family = families.get(box.fontId)!;
        const key = box.fieldId === null ? null : bindingKey(box.fieldTableId, box.fieldId);
        const text = key !== null && Object.hasOwn(values, key) ? values[key] : box.text;
        let currentSize = 0;
        // 内置字体只有常规面，斜体由浏览器合成倾斜；测量与绘制必须共用同一个字体串。
        const fontStyle = box.italic === true ? "italic " : "";
        const setFont = (size: number) => {
          if (currentSize === size) return;
          // 带 sans-serif 兜底：子集字体缺字时由系统字体渲染，不会画成空白方块。
          context.font = `${fontStyle}${size}px "${family}", sans-serif`;
          currentSize = size;
        };
        const layoutKey =
          text.length <= 1024 &&
          JSON.stringify([
            family,
            fontStyle,
            text,
            box.width,
            box.height,
            box.fontSize,
            box.minFontSize,
            box.maxLines,
            box.lineHeight,
          ]);
        let layout = layoutKey ? layouts.get(layoutKey) : undefined;
        if (!layout) {
          layout = layoutText(text, box, (line, size) => {
            setFont(size);
            return context.measureText(line).width;
          });
        }
        if (layoutKey) {
          layouts.delete(layoutKey);
          layouts.set(layoutKey, layout);
          if (layouts.size > 256) layouts.delete(layouts.keys().next().value!);
        }
        if (layout.overflow) {
          overflowBoxIds.push(box.id);
          if (maxSide === null)
            throw new PosterError(
              "TEXT_OVERFLOW",
              `文本框“${box.label}”在最小字号下仍溢出，请扩大文本框或缩短内容`,
            );
        }
        context.save();
        context.beginPath();
        context.rect(box.x, box.y, box.width, box.height);
        context.clip();
        context.fillStyle = box.color;
        context.textAlign = box.align;
        context.textBaseline = "alphabetic";
        setFont(layout.fontSize);
        const x =
          box.x + (box.align === "center" ? box.width / 2 : box.align === "right" ? box.width : 0);
        // 以实际字形居中，避免汉字底部超出行框。
        for (let index = 0; index < Math.min(layout.lines.length, box.maxLines); index++) {
          if (index * layout.lineHeight >= box.height) break;
          const line = layout.lines[index];
          const { actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent } =
            context.measureText(line);
          const y =
            box.y + index * layout.lineHeight + (layout.lineHeight - ascent - descent) / 2 + ascent;
          context.fillText(line, x, y);
        }
        context.restore();
      }
    } finally {
      assets.trimFonts();
    }
    // 绘制和复制之间不让出执行权，避免另一次预览覆盖共享缓冲。
    copyFrame?.();
    return { overflowBoxIds };
  }

  async function run<T>(
    controller: AbortController,
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const unlink = forwardAbort(controller, [lifetime.signal, callerSignal]);
    try {
      if (controller.signal.aborted) throw cancelled();
      return await work(controller.signal);
    } catch (error) {
      if (error instanceof PosterError) throw error;
      throw new PosterError(
        "RENDER_FAILED",
        error instanceof Error ? error.message : "海报绘制失败",
      );
    } finally {
      unlink();
    }
  }

  return {
    async draw(canvas, bundle, values, options = {}) {
      if (lifetime.signal.aborted || options.signal?.aborted) throw cancelled();
      latestDraw.get(canvas)?.abort();
      const controller = new AbortController();
      latestDraw.set(canvas, controller);
      try {
        return await run(controller, options.signal, (signal) => {
          const buffer = staging();
          return paint(
            buffer,
            bundle,
            values,
            options.preview === true ? previewSide(options.maxSide) : null,
            signal,
            () => {
              if (signal.aborted) throw cancelled();
              // 完整绘制后再替换，失败或取消时保留当前画面。
              const target = context2d(canvas);
              resizeCanvas(canvas, buffer.width, buffer.height);
              target.clearRect(0, 0, canvas.width, canvas.height);
              target.drawImage(buffer, 0, 0);
            },
          );
        });
      } finally {
        if (latestDraw.get(canvas) === controller) latestDraw.delete(canvas);
      }
    },
    png(bundle, values, callerSignal) {
      return run(new AbortController(), callerSignal, async (signal) => {
        const canvas = document.createElement("canvas");
        try {
          await paint(canvas, bundle, values, null, signal);
          if (signal.aborted) throw cancelled();
          const encoded = new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob?.size) resolve(blob);
              else
                reject(
                  new PosterError("RENDER_FAILED", "PNG 编码失败，画布尺寸可能超过浏览器上限"),
                );
            }, "image/png");
          });
          const blob = await abortable(encoded, signal);
          if (signal.aborted) throw cancelled();
          return blob;
        } finally {
          canvas.width = canvas.height = 0;
        }
      });
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      assets.dispose();
      layouts.clear();
      if (stagingCanvas) stagingCanvas.width = stagingCanvas.height = 0;
    },
  };
}
