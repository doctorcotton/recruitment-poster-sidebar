import assert from "node:assert/strict";
import test from "node:test";
import { findUnwrittenRows } from "../src/application/unwritten-write";
import type { DataRecord } from "../src/domain/types";

const records: DataRecord[] = [
  { id: "a", label: "A", values: {}, displayValues: { out: "" } },
  { id: "b", label: "B", values: {}, displayValues: { out: "已有.png" } },
  { id: "c", label: "C", values: {} },
  { id: "d", label: "D", values: {}, displayValues: { out: "" } },
  { id: "e", label: "E", values: {} },
];

test("一键生成写回只保留实时输出为空的记录，已有附件直接跳过", async () => {
  const calls: string[] = [];
  const versions = { a: "empty", c: "token-new", d: "empty", e: "empty" };
  const plan = await findUnwrittenRows(records, "out", async (row) => {
    calls.push(row.id);
    return versions[row.id as keyof typeof versions];
  });
  assert.deepEqual(
    plan.rows.map((row) => row.id),
    ["a", "d", "e"],
  );
  assert.equal(plan.skipped, 2);
  assert.equal(plan.total, 5);
  assert.deepEqual(calls, ["a", "c", "d", "e"]);
});

test("未写回扫描串行读取且支持全部已完成", async () => {
  let active = 0,
    maxActive = 0;
  const plan = await findUnwrittenRows(records.slice(0, 1), "out", async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return "token-existing";
  });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.skipped, 1);
  assert.equal(maxActive, 1);
});

test("扫描中停止后不会再请求下一条记录", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(
    findUnwrittenRows(
      records,
      "out",
      async (row) => {
        calls.push(row.id);
        controller.abort();
        return "empty";
      },
      controller.signal,
    ),
    { code: "CANCELLED" },
  );
  assert.deepEqual(calls, ["a"]);
});
