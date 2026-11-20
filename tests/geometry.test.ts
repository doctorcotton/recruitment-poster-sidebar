import test from "node:test";
import assert from "node:assert/strict";
import {
  fitCanvasScale,
  moveTextBox,
  normalizeTextBox,
  resizeTextBox,
} from "../src/domain/geometry";
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

test("归一化把浮点噪声收成面板精度，同时保住最小正尺寸", () => {
  const normalized = normalizeTextBox({
    ...box,
    x: 10.2345,
    y: -3,
    width: 30.06,
    height: 0.04,
    fontSize: 36.6,
    minFontSize: 40.4,
    lineHeight: 1.23456,
    maxLines: 2.6,
  });
  assert.deepEqual(
    [normalized.x, normalized.y, normalized.width, normalized.height],
    [10.2, 0, 30.1, 1],
  );
  assert.deepEqual(
    [normalized.fontSize, normalized.minFontSize, normalized.lineHeight, normalized.maxLines],
    [37, 37, 1.23, 3],
  );
});

test("归一化不改写原对象、文本和绑定", () => {
  const before = structuredClone(box);
  const normalized = normalizeTextBox({ ...box, x: 10.2345 });
  assert.deepEqual(box, before);
  assert.equal(normalized.label, box.label);
  assert.equal(normalized.text, box.text);
  assert.equal(normalized.fieldId, box.fieldId);
});
