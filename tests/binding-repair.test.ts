import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingState,
  describeRepairs,
  repairStaleBindings,
} from "../src/application/binding-repair";
import type { PosterTemplate, TableField, WorkspaceContext } from "../src/domain/types";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";

const baseBox = DEFAULT_TEMPLATE.boxes[0];
const baseTemplate: PosterTemplate = { ...DEFAULT_TEMPLATE, boxes: [] };
const context: WorkspaceContext = {
  tableId: "data",
  tableName: "业务表",
  fields: [{ id: "place", name: "地点", kind: "text" }],
  records: [],
  selectedRecordId: null,
};
const templateTable = {
  tableId: "tpl",
  fields: [{ id: "duty-new", name: "职责", kind: "text" as const }],
};
const withBoxes = (boxes: PosterTemplate["boxes"]): PosterTemplate => ({
  ...baseTemplate,
  boxes,
});

test("绑定的字段还在时保持原样，不产生修复记录", () => {
  const template = withBoxes([{ ...baseBox, id: "a", fieldId: "duty-new", fieldTableId: "tpl" }]);
  assert.equal(bindingState(template.boxes[0], context, templateTable), "ok");
  const result = repairStaleBindings(template, context, templateTable);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.template, template);
});

test("失效绑定按唯一同名字段回绑，换成新字段标识", () => {
  const template = withBoxes([
    { ...baseBox, id: "a", label: "职责", fieldId: "duty-old", fieldTableId: "tpl" },
  ]);
  assert.equal(bindingState(template.boxes[0], context, templateTable), "stale");
  const { template: repaired, repairs } = repairStaleBindings(template, context, templateTable);
  assert.deepEqual(
    repairs.map((item) => [item.label, item.action, item.fieldName]),
    [["职责", "rebound", "职责"]],
  );
  assert.equal(repaired.boxes[0].fieldId, "duty-new");
  assert.equal(repaired.boxes[0].fieldTableId, "tpl");
  // 原模板不被就地修改。
  assert.equal(template.boxes[0].fieldId, "duty-old");
});

test("没有同名字段时退回固定文字并保留原文字快照", () => {
  const template = withBoxes([
    {
      ...baseBox,
      id: "a",
      label: "待遇",
      text: "六险一金",
      fieldId: "pay-old",
      fieldTableId: "tpl",
    },
  ]);
  const { template: repaired, repairs } = repairStaleBindings(template, context, templateTable);
  assert.deepEqual(
    repairs.map((item) => [item.label, item.action]),
    [["待遇", "unbound"]],
  );
  assert.equal(repaired.boxes[0].fieldId, null);
  assert.equal(repaired.boxes[0].fieldTableId, null);
  assert.equal(repaired.boxes[0].text, "六险一金");
});

test("多个同名字段时不猜，交回用户重绑", () => {
  const ambiguous = {
    tableId: "tpl",
    fields: [
      { id: "d1", name: "职责", kind: "text" as const },
      { id: "d2", name: "职 责", kind: "text" as const },
    ],
  };
  const template = withBoxes([
    { ...baseBox, id: "a", label: "职责", fieldId: "duty-old", fieldTableId: "tpl" },
  ]);
  const { template: repaired, repairs } = repairStaleBindings(template, context, ambiguous);
  assert.equal(repairs[0].action, "unbound");
  assert.equal(repaired.boxes[0].fieldId, null);
});

test("模板表字段池没读到时报未知，既不判失效也不自动改绑定", () => {
  const template = withBoxes([
    { ...baseBox, id: "a", label: "职责", fieldId: "duty-old", fieldTableId: "tpl" },
  ]);
  for (const missing of [null, { tableId: "tpl", fields: [] as TableField[] }]) {
    assert.equal(bindingState(template.boxes[0], context, missing), "unknown");
    const { repairs } = repairStaleBindings(template, context, missing);
    assert.equal(repairs.length, 0);
  }
});

test("数据表字段被删除同样算失效，并可回绑到同名字段", () => {
  const template = withBoxes([{ ...baseBox, id: "a", label: "地点", fieldId: "place-old" }]);
  assert.equal(bindingState(template.boxes[0], context, templateTable), "stale");
  const { template: repaired, repairs } = repairStaleBindings(template, context, templateTable);
  assert.equal(repairs[0].action, "rebound");
  assert.equal(repaired.boxes[0].fieldId, "place");
  assert.equal(repaired.boxes[0].fieldTableId, null);
});

test("修复说明用最短形式区分回绑与转固定文字", () => {
  assert.equal(
    describeRepairs([
      { boxId: "a", label: "职责", action: "rebound", fieldName: "职责" },
      { boxId: "b", label: "待遇", action: "unbound" },
    ]),
    "职责 回绑，待遇 转固定文字",
  );
});
