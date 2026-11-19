import assert from "node:assert/strict";
import test from "node:test";
import { toDataRecord } from "../src/data/feishu/records";
import type { SdkRecord } from "../src/data/feishu/sdk";
import type { TableField } from "../src/domain/types";

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
});

test("记录名称只取主字段，主字段为空时显示未命名记录而非内部 ID", () => {
  const withPrimary: TableField[] = [
    { id: "job", name: "岗位", kind: "text" },
    { id: "title", name: "名称", kind: "text", isPrimary: true },
  ];
  const named = toDataRecord(
    { recordId: "rec001", fields: { job: "岗位值", title: "品牌设计师" } } as unknown as SdkRecord,
    withPrimary,
  );
  assert.equal(named.label, "品牌设计师");
  const blank = toDataRecord(
    { recordId: "rec002", fields: { job: "岗位值", title: "" } } as unknown as SdkRecord,
    withPrimary,
  );
  assert.equal(blank.label, "未命名记录");
  // 主字段为空时不得回退到同一条记录的其他字段或内部 recordId。
  assert.equal(blank.label.includes("rec002"), false);
});

test("附件值只进展示快照，不进可用于绑定的文本值", () => {
  const record = {
    recordId: "r1",
    fields: { files: [{ name: "底图.png" }], tags: "全职" },
  } as unknown as SdkRecord;
  const result = toDataRecord(record, fields);
  assert.equal("files" in result.values, false);
  assert.equal(result.displayValues?.files, "底图.png");
  assert.equal(result.values.tags, "全职");
});
