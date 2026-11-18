import type { IOpenTextSegment } from "@lark-base-open/js-sdk";
import { PosterError, type FieldKind } from "../../domain/types";
import { MAX_ASSET_BYTES } from "../assets";
import type { SdkAttachment } from "./sdk";

export const FIELD_TYPES = {
  text: 1,
  number: 2,
  singleSelect: 3,
  multiSelect: 4,
  phone: 13,
  url: 15,
  attachment: 17,
  lookup: 19,
} as const;

export function cellText(value: unknown, kind: FieldKind = "text"): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value
      .map((item) => cellText(item, kind))
      .filter(Boolean)
      .join(kind === "select" ? "、" : "");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return cellText(
      item.text ?? item.name ?? item.phone ?? item.link ?? item.url ?? item.value,
      kind,
    );
  }
  return "";
}

export function fieldKind(type: number): FieldKind {
  switch (type) {
    case FIELD_TYPES.text:
      return "text";
    case FIELD_TYPES.number:
      return "number";
    case FIELD_TYPES.singleSelect:
    case FIELD_TYPES.multiSelect:
      return "select";
    case FIELD_TYPES.phone:
      return "phone";
    case FIELD_TYPES.url:
      return "url";
    case FIELD_TYPES.attachment:
      return "attachment";
    case FIELD_TYPES.lookup:
      return "lookup";
    default:
      return "other";
  }
}

/** 输出附件只用附件元数据形成乐观快照，临时 URL 不参与版本。 */
export function attachmentVersion(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) return "empty";
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const entry = item as Record<string, unknown>;
      return [entry.token, entry.name, entry.size, entry.timeStamp, entry.lastModified]
        .map((part) => String(part ?? ""))
        .join(":");
    })
    .sort()
    .join("|");
}

export function backgroundAttachment(value: unknown): SdkAttachment {
  // SDK 的 LookupTransformVal 使用扁平数组表达附件引用，不是附件字段实例或带 value 的包装对象。
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new PosterError("INVALID_ASSET", "当前行底图附件为空，请添加一张 PNG 或 JPEG 图片。");
  }
  if (!Array.isArray(value) || value.length !== 1)
    throw new PosterError("INVALID_ASSET", "当前行底图必须且只能有一张 PNG 或 JPEG 图片。");
  const attachment = value[0] as Partial<SdkAttachment> | null;
  if (
    !attachment ||
    typeof attachment !== "object" ||
    typeof attachment.token !== "string" ||
    !attachment.token ||
    typeof attachment.name !== "string" ||
    !["image/png", "image/jpeg"].includes(attachment.type ?? "")
  ) {
    throw new PosterError("INVALID_ASSET", "当前行底图不是有效的 PNG 或 JPEG 图片附件。");
  }
  if (
    !Number.isFinite(attachment.size) ||
    attachment.size! <= 0 ||
    attachment.size! > MAX_ASSET_BYTES
  ) {
    throw new PosterError("INVALID_ASSET", "底图必须是非空且不超过 20 MB 的图片。");
  }
  return attachment as SdkAttachment;
}

export const richText = (text: string): IOpenTextSegment[] => [
  { type: "text" as IOpenTextSegment["type"], text },
];
