import test from "node:test";
import assert from "node:assert/strict";
import { resolveRecordBundle } from "../src/domain/record-background";
import { normalizeSettings } from "../src/data/validation";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import { validateTemplate } from "../src/domain/validation";
import type { TemplateBundle, WorkspaceContext } from "../src/domain/types";

const context: WorkspaceContext = {
  tableId: "jobs",
  tableName: "岗位",
  fields: [{ id: "bg", name: "模板底图", kind: "lookup" }],
  records: [],
  selectedRecordId: null,
};
const bundle: TemplateBundle = {
  template: { ...DEFAULT_TEMPLATE, backgroundFieldId: "bg" },
  assets: [
    {
      id: DEFAULT_TEMPLATE.backgroundId,
      name: "固定底图",
      mimeType: "image/png",
      blob: new Blob(["old"]),
    },
  ],
};

test("每条记录读取自己的底图，替换只影响渲染副本而不改变模板坐标", async () => {
  const calls: string[][] = [];
  const loader = {
    loadBackground: async (...args: string[]) => {
      calls.push(args);
      return { id: args[0], name: "逐行底图", mimeType: "image/png", blob: new Blob([args[0]]) };
    },
  };
  const first = await resolveRecordBundle(bundle, "row-1", context, loader);
  const second = await resolveRecordBundle(bundle, "row-2", context, loader);
  assert.deepEqual(calls, [
    ["row-1", "bg", "jobs"],
    ["row-2", "bg", "jobs"],
  ]);
  assert.equal(first.template.backgroundId, "row-1");
  assert.equal(second.template.backgroundId, "row-2");
  assert.deepEqual(first.template.boxes, bundle.template.boxes);
  assert.equal(bundle.template.backgroundId, DEFAULT_TEMPLATE.backgroundId);
  assert.equal(
    first.assets.some((asset) => asset.id === DEFAULT_TEMPLATE.backgroundId),
    false,
  );
});

test("固定底图不取行附件，失效字段和下载失败不会回退为旧底图", async () => {
  const loader = {
    loadBackground: async () => {
      throw new Error("附件不可用");
    },
  };
  const fixed = { ...bundle, template: { ...bundle.template, backgroundFieldId: null } };
  assert.equal(await resolveRecordBundle(fixed, "row", context, loader), fixed);
  await assert.rejects(
    resolveRecordBundle(bundle, "row", { ...context, fields: [] }, loader),
    /重新绑定/,
  );
  await assert.rejects(resolveRecordBundle(bundle, "row", context, loader), /附件不可用/);
});

test("底图字段是兼容旧模板的可选声明式配置", () => {
  assert.equal(validateTemplate(DEFAULT_TEMPLATE).backgroundFieldId, undefined);
  assert.equal(
    validateTemplate({ ...DEFAULT_TEMPLATE, backgroundFieldId: "bg" }).backgroundFieldId,
    "bg",
  );
  assert.throws(
    () => validateTemplate({ ...DEFAULT_TEMPLATE, backgroundFieldId: 123 }),
    /底图字段/,
  );
});

test("工作区配置保存底图字段绑定，旧配置保持兼容", () => {
  const previous = {
    schemaVersion: 1,
    tableId: "jobs",
    templateId: "template",
    outputFieldId: "png",
  };
  assert.deepEqual(normalizeSettings(previous), previous);
  assert.equal(normalizeSettings({ ...previous, backgroundFieldId: "bg" }).backgroundFieldId, "bg");
  assert.equal(normalizeSettings({ ...previous, backgroundFieldId: null }).backgroundFieldId, null);
});
