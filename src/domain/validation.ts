import { PosterError, type PosterTemplate, type TextBox } from "./types";

/** 限制浏览器位图内存占用，同时保持常用高分辨率海报可导出。 */
export const MAX_CANVAS_PIXELS = 40_000_000;
export const MAX_CANVAS_SIDE = 16_384;

function fail(message: string): never {
  throw new PosterError("INVALID_TEMPLATE", message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}必须为对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    fail(`${label}必须为${allowEmpty ? "" : "非空"}字符串`);
  return value;
}
function number(value: unknown, label: string, minimum: number, maximum = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    fail(`${label}超出有效范围`);
  return value;
}

/** 仅按已知契约复制数据；字符串只作为内容，不解释为表达式或脚本。 */
export function validateTemplate(value: unknown): PosterTemplate {
  const source = object(value, "模板");
  if (source.schemaVersion !== 1) fail("模板版本必须为 1");
  const width = number(source.width, "画布宽度", 1, MAX_CANVAS_SIDE);
  const height = number(source.height, "画布高度", 1, MAX_CANVAS_SIDE);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > MAX_CANVAS_PIXELS)
    fail("画布必须为整数像素且不超过像素上限");
  const id = string(source.id, "模板标识");
  const name = string(source.name, "模板名称");
  const backgroundId = string(source.backgroundId, "底图标识");
  if (!Array.isArray(source.fontIds)) fail("字体标识必须为数组");
  const fontIds = source.fontIds.map((value) => string(value, "字体标识"));
  if (new Set(fontIds).size !== fontIds.length || fontIds.includes(backgroundId))
    fail("资源标识不得重复");
  if (!Array.isArray(source.boxes)) fail("文本框必须为数组");
  const ids = new Set<string>();
  const boxes: TextBox[] = source.boxes.map((value) => {
    const item = object(value, "文本框");
    const boxId = string(item.id, "文本框标识");
    if (ids.has(boxId)) fail("文本框标识不得重复");
    ids.add(boxId);
    const x = number(item.x, "文本框横坐标", 0, width);
    const y = number(item.y, "文本框纵坐标", 0, height);
    const boxWidth = number(item.width, "文本框宽度", Number.MIN_VALUE, width);
    const boxHeight = number(item.height, "文本框高度", Number.MIN_VALUE, height);
    if (x + boxWidth > width || y + boxHeight > height) fail("文本框不得超出画布");
    const fontId = string(item.fontId, "文本框字体");
    if (!fontIds.includes(fontId)) fail("文本框引用了未声明的字体");
    const fontSize = number(item.fontSize, "字号", 1, 4096);
    const minFontSize = number(item.minFontSize, "最小字号", 1, fontSize);
    const color = string(item.color, "颜色");
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))
      fail("颜色必须为十六进制 CSS 颜色");
    if (item.align !== "left" && item.align !== "center" && item.align !== "right")
      fail("文本对齐方式无效");
    const maxLines = number(item.maxLines, "最大行数", 1, 10000);
    if (!Number.isInteger(maxLines)) fail("最大行数必须为整数");
    if (item.locked !== undefined && typeof item.locked !== "boolean")
      fail("图层锁定状态必须为布尔值");
    return {
      id: boxId,
      label: string(item.label, "文本框名称"),
      fieldId: item.fieldId === null ? null : string(item.fieldId, "字段标识"),
      ...(item.fieldTableId === undefined
        ? {}
        : {
            fieldTableId: item.fieldTableId === null ? null : string(item.fieldTableId, "绑定表"),
          }),
      text: string(item.text, "文本内容", true),
      x,
      y,
      width: boxWidth,
      height: boxHeight,
      fontId,
      fontSize,
      minFontSize,
      color,
      align: item.align,
      lineHeight: number(item.lineHeight, "行距", 1, 10),
      maxLines,
      ...(item.locked === undefined ? {} : { locked: item.locked === true }),
    };
  });
  const backgroundFieldId =
    source.backgroundFieldId === undefined
      ? undefined
      : source.backgroundFieldId === null
        ? null
        : string(source.backgroundFieldId, "底图字段");
  return {
    schemaVersion: 1,
    id,
    name,
    width,
    height,
    backgroundId,
    ...(backgroundFieldId !== undefined ? { backgroundFieldId } : {}),
    fontIds,
    boxes,
  };
}
