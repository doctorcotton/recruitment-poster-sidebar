import assert from "node:assert/strict";
import test from "node:test";
import { bindingKey, parseBinding, scopeValues } from "../src/domain/field-binding";

test("数据表字段沿用裸 ID，模板表字段带表维度", () => {
  assert.equal(bindingKey(null, "job"), "job");
  assert.equal(bindingKey(undefined, "job"), "job");
  assert.equal(bindingKey("", "job"), "job");
  assert.equal(bindingKey("tpl-table", "job"), "tpl-table::job");
});

test("模板行值整体加表维度，不改动原对象", () => {
  const source = { responsibilities: "职责", benefits: "待遇" };
  const scoped = scopeValues("tpl-table", source);
  assert.deepEqual(scoped, {
    "tpl-table::responsibilities": "职责",
    "tpl-table::benefits": "待遇",
  });
  assert.deepEqual(source, { responsibilities: "职责", benefits: "待遇" });
  assert.deepEqual(scopeValues("tpl-table", {}), {});
});

test("绑定键可还原，未被前缀化的键视为数据表字段", () => {
  assert.deepEqual(parseBinding("job"), { fieldTableId: null, fieldId: "job" });
  assert.deepEqual(parseBinding("tpl-table::job"), {
    fieldTableId: "tpl-table",
    fieldId: "job",
  });
  // 只在第一个分隔符处切分，字段 ID 自带双冒号时仍可往返。
  const parsed = parseBinding("a::b::c");
  assert.deepEqual(parsed, { fieldTableId: "a", fieldId: "b::c" });
  assert.equal(bindingKey(parsed.fieldTableId, parsed.fieldId), "a::b::c");
});
