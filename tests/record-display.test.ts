import assert from "node:assert/strict";
import test from "node:test";
import { toDataRecord } from "../src/data/feishu/records";
import type { SdkRecord } from "../src/data/feishu/sdk";
import type { TableField } from "../src/domain/types";
import { buildRecordFieldRows } from "../src/features/records/record-field-rows";

const fields: TableField[] = [
  { id: "count", name: "人数", kind: "number" },
  { id: "tags", name: "标签", kind: "select" },
  { id: "empty", name: "空文本", kind: "text" },
  { id: "files", name: "附件", kind: "attachment" },
  { id: "lookup", name: "引用", kind: "lookup" },
];

test("主记录展示值保留 0、空值、多选、附件和 Lookup", () => {
  const record = {
    recordId: "r1",
    fields: {
      count: 0,
      tags: [{ text: "全职" }, { text: "双休" }],
      empty: "",
      files: [{ name: "一.png" }, { name: "二.png" }],
      lookup: ["甲", "乙"],
    },
  } as unknown as SdkRecord;
  const result = toDataRecord(record, fields);
  assert.equal(result.values.count, "0");
  assert.equal(result.displayValues?.tags, "全职、双休");
  assert.equal(result.displayValues?.files, "一.png、二.png");
  assert.equal(result.displayValues?.lookup, "甲、乙");
  assert.equal(result.displayValues?.empty, "");
  assert.equal("files" in result.values, false);
  assert.deepEqual(
    buildRecordFieldRows(fields, result).map((row) => [row.id, row.value, row.empty]),
    [
      ["count", "0", false],
      ["tags", "全职、双休", false],
      ["empty", "", true],
      ["files", "一.png、二.png", false],
      ["lookup", "甲、乙", false],
    ],
  );
});

test("主记录字段顺序只跟 fields，不跟值对象键序，旧记录可回退", () => {
  const record = { id: "old", label: "旧记录", values: { second: "B", first: "A" } };
  const rows = buildRecordFieldRows(
    [
      { id: "first", name: "第一", kind: "text" },
      { id: "second", name: "第二", kind: "text" },
      { id: "attachment", name: "附件", kind: "attachment" },
    ],
    record,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["first", "second", "attachment"],
  );
  assert.equal(rows[2].empty, true);
});
