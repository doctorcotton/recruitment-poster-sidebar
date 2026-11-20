import assert from "node:assert/strict";
import test from "node:test";
import {
  countRecordOutputs,
  filterRecordsByOutput,
  recordOutputState,
  selectAllState,
  toggleSelectAll,
} from "../src/application/record-filter";
import type { DataRecord } from "../src/domain/types";

const records: DataRecord[] = [
  { id: "a", label: "A", values: {}, displayValues: { out: "" } },
  { id: "b", label: "B", values: {}, displayValues: { out: "已有.png" } },
  { id: "c", label: "C", values: {} },
  { id: "d", label: "D", values: {}, displayValues: { out: "  " } },
];

test("输出附件状态按展示值判断，缺展示值不算空", () => {
  assert.equal(recordOutputState(records[0], "out"), "unwritten");
  assert.equal(recordOutputState(records[1], "out"), "written");
  // 展示值缺失时不能猜“空”：猜错会让全选覆盖已生成的海报。
  assert.equal(recordOutputState(records[2], "out"), "unknown");
  assert.equal(recordOutputState(records[3], "out"), "unwritten");
  assert.equal(recordOutputState(records[1], ""), "unknown");
});

test("计数把未知状态单独统计", () => {
  assert.deepEqual(countRecordOutputs(records, "out"), {
    all: 4,
    unwritten: 2,
    written: 1,
    unknown: 1,
  });
});

test("筛选只返回命中的状态，未知记录只出现在全部里", () => {
  assert.deepEqual(
    filterRecordsByOutput(records, "out", "unwritten").map((row) => row.id),
    ["a", "d"],
  );
  assert.deepEqual(
    filterRecordsByOutput(records, "out", "written").map((row) => row.id),
    ["b"],
  );
  assert.equal(filterRecordsByOutput(records, "out", "all").length, 4);
});

test("全选状态区分全选、部分选中与未选", () => {
  assert.equal(selectAllState(["a", "b"], new Set()), "none");
  assert.equal(selectAllState(["a", "b"], new Set(["a"])), "some");
  assert.equal(selectAllState(["a", "b"], new Set(["a", "b"])), "all");
  assert.equal(selectAllState([], new Set(["a"])), "none");
});

test("全选只改可见行，筛选外的已选项保留", () => {
  const filled = toggleSelectAll(new Set(["x"]), ["a", "b"]);
  assert.deepEqual([...filled].sort(), ["a", "b", "x"]);
  // 可见行已全选时再点一次只取消可见部分。
  const cleared = toggleSelectAll(filled, ["a", "b"]);
  assert.deepEqual([...cleared], ["x"]);
});

test("可见行部分选中时全选补齐为全选", () => {
  assert.deepEqual([...toggleSelectAll(new Set(["a"]), ["a", "b"])].sort(), ["a", "b"]);
});
