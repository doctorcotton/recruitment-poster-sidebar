import { moveTextBox } from "./geometry";
import type { PosterTemplate, TextBox } from "./types";

export type LayerAlignment =
  "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distributeX" | "distributeY";

function positioned(box: TextBox, x: number, y: number, template: PosterTemplate): TextBox {
  return moveTextBox(box, x - box.x, y - box.y, template);
}

/** 对齐以所选图层的联合边界为基准；锁定图层不参与，图层数组顺序即渲染顺序。 */
export function alignLayers(
  template: PosterTemplate,
  selectedIds: Set<string>,
  operation: LayerAlignment,
): PosterTemplate {
  const selected = template.boxes.filter((box) => selectedIds.has(box.id) && !box.locked);
  const required = operation.startsWith("distribute") ? 3 : 2;
  if (selected.length < required) return template;
  const minX = Math.min(...selected.map((box) => box.x)),
    maxX = Math.max(...selected.map((box) => box.x + box.width));
  const minY = Math.min(...selected.map((box) => box.y)),
    maxY = Math.max(...selected.map((box) => box.y + box.height));
  const updates = new Map<string, TextBox>();
  if (operation === "distributeX" || operation === "distributeY") {
    const horizontal = operation === "distributeX";
    const sorted = [...selected].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const start = horizontal ? minX : minY,
      end = horizontal ? maxX : maxY;
    const sizes = sorted.reduce((sum, box) => sum + (horizontal ? box.width : box.height), 0);
    const gap = (end - start - sizes) / (sorted.length - 1);
    let cursor = start;
    for (const box of sorted) {
      updates.set(
        box.id,
        positioned(box, horizontal ? cursor : box.x, horizontal ? box.y : cursor, template),
      );
      cursor += (horizontal ? box.width : box.height) + gap;
    }
  } else {
    for (const box of selected) {
      const x =
        operation === "left"
          ? minX
          : operation === "right"
            ? maxX - box.width
            : operation === "centerX"
              ? minX + (maxX - minX - box.width) / 2
              : box.x;
      const y =
        operation === "top"
          ? minY
          : operation === "bottom"
            ? maxY - box.height
            : operation === "centerY"
              ? minY + (maxY - minY - box.height) / 2
              : box.y;
      updates.set(box.id, positioned(box, x, y, template));
    }
  }
  return { ...template, boxes: template.boxes.map((box) => updates.get(box.id) ?? box) };
}

export function moveLayer(template: PosterTemplate, id: string, direction: -1 | 1): PosterTemplate {
  const index = template.boxes.findIndex((box) => box.id === id),
    target = index + direction;
  if (index < 0 || target < 0 || target >= template.boxes.length) return template;
  const boxes = [...template.boxes],
    [box] = boxes.splice(index, 1);
  boxes.splice(target, 0, box);
  return { ...template, boxes };
}
