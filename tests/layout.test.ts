import test from "node:test";
import assert from "node:assert/strict";
import { layoutText, splitGraphemes, wrapText } from "../src/domain/layout";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { TextBox } from "../src/domain/types";

const measure = (text: string, size: number) => splitGraphemes(text).length * size;
const box = (overrides: Partial<TextBox> = {}): TextBox => ({
  ...DEFAULT_TEMPLATE.boxes[0],
  width: 40,
  height: 100,
  fontSize: 10,
  minFontSize: 5,
  lineHeight: 1.2,
  maxLines: 10,
  ...overrides,
});

test("按注入的实际测量宽度自动换行", () => {
  assert.deepEqual(wrapText("招聘前端工程师", 40, 10, measure), ["招聘前端", "工程师"]);
});

test("保留显式换行、空行并统一 CRLF", () => {
  assert.deepEqual(wrapText("前端\r\n\r\n招聘\n", 40, 10, measure), ["前端", "", "招聘", ""]);
});

test("组合 emoji、旗帜、肤色和组合字符不拆分", () => {
  const graphemes = ["👩🏽‍💻", "🇨🇳", "e\u0301", "👨‍👩‍👧‍👦"];
  assert.deepEqual(splitGraphemes(graphemes.join("")), graphemes);
  assert.deepEqual(wrapText(graphemes.join(""), 10, 10, measure), graphemes);
});

test("字号缩小到同时满足宽度、最大行数和文本框高度", () => {
  const target = box({ width: 40, height: 24, maxLines: 2 });
  const result = layoutText("招聘前端工程师人员", target, measure);
  assert.equal(result.overflow, false);
  assert.ok(result.fontSize < 10 && result.fontSize >= 5);
  assert.ok(result.lines.length <= 2);
  assert.ok(result.lines.length * result.lineHeight <= target.height + 1e-7);
  assert.ok(result.lines.every((line) => measure(line, result.fontSize) <= target.width));
});

test("原字号能放下时不做额外缩小", () => {
  const target = box();
  const before = structuredClone(target);
  assert.equal(layoutText("前端", target, measure).fontSize, 10);
  assert.deepEqual(target, before);
});

test("达到最小字号仍超出最大行数时报告溢出", () => {
  const result = layoutText("一二三四五六七八九十", box({ width: 10, maxLines: 1 }), measure);
  assert.equal(result.fontSize, 5);
  assert.equal(result.overflow, true);
});

test("单个字素超宽和单行超高都报告溢出", () => {
  assert.equal(layoutText("👩🏽‍💻", box({ width: 4 }), measure).overflow, true);
  assert.equal(layoutText("人", box({ height: 4 }), measure).overflow, true);
});

test("空内容不占一行，显式空行仍占高度", () => {
  assert.deepEqual(layoutText("", box(), measure).lines, []);
  assert.equal(layoutText("\n", box({ height: 6, maxLines: 1 }), measure).overflow, true);
});

test("测量整行以保留字距和连字效果", () => {
  const kerning = (text: string, size: number) => (text === "AV" ? 1.5 * size : text.length * size);
  assert.deepEqual(wrapText("AVA", 15, 10, kerning), ["AV", "A"]);
});
