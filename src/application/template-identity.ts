import type { PosterTemplate } from "../domain/types";
import { validateTemplate } from "../domain/validation";

/** 同一内容可能有多个旧素材 ID，重绑定后必须去重，避免资源 ID 冲突。 */
export function rebindTemplateAssetIds(
  template: PosterTemplate,
  idMap: Map<string, string>,
  id: string,
  name: string,
): PosterTemplate {
  const importedId = (value: string) => idMap.get(value) ?? value;
  return validateTemplate({
    ...template,
    id,
    name,
    backgroundId: importedId(template.backgroundId),
    fontIds: [...new Set(template.fontIds.map(importedId))],
    boxes: template.boxes.map((box) => ({ ...box, fontId: importedId(box.fontId) })),
  });
}
