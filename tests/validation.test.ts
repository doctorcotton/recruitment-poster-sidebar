import test from "node:test";
import assert from "node:assert/strict";
import { validateTemplate, MAX_CANVAS_PIXELS } from "../src/domain/validation";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import { PosterError } from "../src/domain/types";

function invalid(change: (value: any) => void): void {
  const value = structuredClone(DEFAULT_TEMPLATE);
  change(value);
  assert.throws(
    () => validateTemplate(value),
    (error: unknown) => error instanceof PosterError && error.code === "INVALID_TEMPLATE",
  );
}

test("默认模板有效，校验返回独立的已知字段副本", () => {
  const value = { ...structuredClone(DEFAULT_TEMPLATE), unsupported: "ignored" };
  const result = validateTemplate(value);
  assert.deepEqual(result, DEFAULT_TEMPLATE);
  assert.notEqual(result, value);
  assert.notEqual(result.boxes[0], value.boxes[0]);
  assert.equal("unsupported" in result, false);
});

test("拒绝非对象、错误版本与空标识名称", () => {
  for (const value of [null, [], "{}", 1]) assert.throws(() => validateTemplate(value));
  invalid((value) => {
    value.schemaVersion = 2;
  });
  invalid((value) => {
    value.id = " ";
  });
  invalid((value) => {
    value.name = "";
  });
  invalid((value) => {
    value.backgroundId = null;
  });
});

test("拒绝无穷、NaN、非整数画布及超像素画布", () => {
  invalid((value) => {
    value.width = NaN;
  });
  invalid((value) => {
    value.height = Infinity;
  });
  invalid((value) => {
    value.width = 900.5;
  });
  invalid((value) => {
    value.height = 0;
  });
  assert.ok(10000 * 10000 > MAX_CANVAS_PIXELS);
  invalid((value) => {
    value.width = 10000;
    value.height = 10000;
  });
});

test("文本框必须完整处于画布内且尺寸为正数", () => {
  invalid((value) => {
    value.boxes[0].x = -1;
  });
  invalid((value) => {
    value.boxes[0].width = 0;
  });
  invalid((value) => {
    value.boxes[0].x = value.width;
  });
  invalid((value) => {
    value.boxes[0].height = Infinity;
  });
  invalid((value) => {
    value.boxes[0].y = value.height;
  });
});

test("字体引用必须存在，资源与文本框标识不得重复", () => {
  invalid((value) => {
    value.fontIds = [];
  });
  invalid((value) => {
    value.fontIds.push(value.fontIds[0]);
  });
  invalid((value) => {
    value.fontIds.push(value.backgroundId);
  });
  invalid((value) => {
    value.boxes[0].fontId = "missing";
  });
  invalid((value) => {
    value.boxes[1].id = value.boxes[0].id;
  });
});

test("字段只能为非空字符串或 null，静态内容不会执行", () => {
  invalid((value) => {
    value.boxes[0].fieldId = 1;
  });
  invalid((value) => {
    value.boxes[0].fieldId = "";
  });
  const value = structuredClone(DEFAULT_TEMPLATE);
  value.boxes[0].fieldId = null;
  value.boxes[0].text = "${globalThis.dangerous()}<script>alert(1)</script>";
  assert.equal(validateTemplate(value).boxes[0].text, value.boxes[0].text);
});

test("图层可声明绑定表；缺省沿用数据表，非法值拒绝", () => {
  invalid((value) => {
    value.boxes[0].fieldTableId = 1;
  });
  invalid((value) => {
    value.boxes[0].fieldTableId = "";
  });
  const scoped = structuredClone(DEFAULT_TEMPLATE);
  scoped.boxes[0].fieldTableId = "tpl-table";
  assert.equal(validateTemplate(scoped).boxes[0].fieldTableId, "tpl-table");
  // 旧模板没有该字段仍然通过，也不会凭空补一个 null。
  const legacy = structuredClone(DEFAULT_TEMPLATE);
  assert.equal("fieldTableId" in validateTemplate(legacy).boxes[0], false);
});

test("字号、行高、最大行数和对齐均校验", () => {
  invalid((value) => {
    value.boxes[0].minFontSize = value.boxes[0].fontSize + 1;
  });
  invalid((value) => {
    value.boxes[0].fontSize = "20";
  });
  invalid((value) => {
    value.boxes[0].lineHeight = 0;
  });
  invalid((value) => {
    value.boxes[0].maxLines = 1.5;
  });
  invalid((value) => {
    value.boxes[0].maxLines = 0;
  });
  invalid((value) => {
    value.boxes[0].align = "justify";
  });
});

test("颜色仅接受三、四、六、八位十六进制 CSS 颜色", () => {
  invalid((value) => {
    value.boxes[0].color = "url(https://example.com)";
  });
  invalid((value) => {
    value.boxes[0].color = "#12345";
  });
  for (const color of ["#abc", "#abcd", "#12ABcd", "#12ABcd80"]) {
    const value = structuredClone(DEFAULT_TEMPLATE);
    value.boxes[0].color = color;
    assert.equal(validateTemplate(value).boxes[0].color, color);
  }
});
