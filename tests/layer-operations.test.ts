import assert from "node:assert/strict";
import test from "node:test";
import { alignLayers, moveLayer } from "../src/domain/layer-operations";
import { validateTemplate } from "../src/domain/validation";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { PosterTemplate, TextBox } from "../src/domain/types";

function box(id: string, x: number, y: number, width = 50, height = 20): TextBox {
  return { ...DEFAULT_TEMPLATE.boxes[0], id, x, y, width, height };
}
function template(): PosterTemplate {
  return {
    ...DEFAULT_TEMPLATE,
    width: 500,
    height: 500,
    boxes: [box("a", 10, 20), box("b", 100, 80, 60, 30), box("c", 250, 160)],
  };
}

test("多选对齐以联合边界为基准且不改变原模板", () => {
  const input = template();
  const aligned = alignLayers(input, new Set(["a", "b"]), "centerX");
  assert.equal(aligned.boxes[0].x, 60);
  assert.equal(aligned.boxes[1].x, 55);
  assert.equal(input.boxes[0].x, 10);
  assert.equal(aligned.boxes[2].x, 250);
});

test("右对齐时保留旧模板的小数宽度并收拢到画布内", () => {
  const input = { ...template(), boxes: [box("a", 10, 20, 50.25), box("b", 450, 80)] };
  const aligned = alignLayers(input, new Set(["a", "b"]), "right");
  assert.equal(aligned.boxes[0].width, 50.25);
  assert.equal(aligned.boxes[0].x + aligned.boxes[0].width, input.width);
  assert.doesNotThrow(() => validateTemplate(aligned));
});

test("横向分布保持顺序并计算等间距，锁定图层不参与", () => {
  const input = template();
  const distributed = alignLayers(input, new Set(["a", "b", "c"]), "distributeX");
  assert.deepEqual(
    distributed.boxes.map((box) => Math.round(box.x)),
    [10, 125, 250],
  );
  const locked = { ...input, boxes: input.boxes.map((box) => ({ ...box, locked: true })) };
  assert.equal(alignLayers(locked, new Set(["a", "b", "c"]), "left"), locked);
});

test("图层数组顺序可上下调整并限制边界", () => {
  const input = template();
  assert.deepEqual(
    moveLayer(input, "a", 1).boxes.map((box) => box.id),
    ["b", "a", "c"],
  );
  assert.equal(moveLayer(input, "a", -1), input);
  assert.equal(moveLayer(input, "c", 1), input);
});

test("锁定是可选声明式属性并拒绝非布尔值", () => {
  const input = template();
  input.boxes[0].locked = true;
  assert.equal(validateTemplate(input).boxes[0].locked, true);
  assert.equal(validateTemplate(template()).boxes[0].locked, undefined);
  assert.throws(
    () => validateTemplate({ ...input, boxes: [{ ...input.boxes[0], locked: "yes" }] }),
    /布尔值/,
  );
});
