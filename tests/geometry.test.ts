import test from "node:test";
import assert from "node:assert/strict";
import { fitCanvasScale, moveTextBox, resizeTextBox } from "../src/domain/geometry";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";

const canvas = { width: 100, height: 200 };
const box = { ...DEFAULT_TEMPLATE.boxes[0], x: 10, y: 20, width: 30, height: 40 };

test("视口按宽高较小比例缩放并预留两侧 padding", () => {
  assert.equal(fitCanvasScale(100, 200, 164, 264), 1);
  assert.equal(fitCanvasScale(100, 200, 164, 164), 0.5);
  assert.equal(fitCanvasScale(100, 200, 500, 500), 1);
  assert.equal(fitCanvasScale(100, 200, 20, 20), 0);
});

test("视口缩放不改变文档坐标", () => {
  const before = structuredClone(box);
  fitCanvasScale(canvas.width, canvas.height, 100, 100);
  assert.deepEqual(box, before);
});

test("拖动在画布四边截断，且不修改原对象", () => {
  const before = structuredClone(box);
  assert.deepEqual(
    [moveTextBox(box, -100, -100, canvas).x, moveTextBox(box, -100, -100, canvas).y],
    [0, 0],
  );
  const moved = moveTextBox(box, 1000, 1000, canvas);
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height], [70, 160, 30, 40]);
  assert.deepEqual(box, before);
});

test("调整大小受当前位置和画布边界约束", () => {
  const resized = resizeTextBox(box, 1000, 1000, canvas);
  assert.deepEqual([resized.x, resized.y, resized.width, resized.height], [10, 20, 90, 180]);
  const tiny = resizeTextBox(box, -1, 0, canvas);
  assert.deepEqual([tiny.width, tiny.height], [1, 1]);
});

test("画布缩小后移动可把原先过大的文本框收回画布", () => {
  const moved = moveTextBox({ ...box, width: 500, height: 500 }, 0, 0, canvas);
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height], [0, 0, 100, 200]);
});

test("非有限输入与无效视口快速失败", () => {
  assert.throws(() => fitCanvasScale(0, 100, 100, 100), RangeError);
  assert.throws(() => fitCanvasScale(100, 100, 100, 100, -1), RangeError);
  assert.throws(() => moveTextBox(box, NaN, 0, canvas), RangeError);
  assert.throws(() => resizeTextBox(box, Infinity, 20, canvas), RangeError);
});
