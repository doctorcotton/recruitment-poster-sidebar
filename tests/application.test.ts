import assert from "node:assert/strict";
import test from "node:test";
import { OperationLock } from "../src/application/operation-lock";
import { resolvePosterActionState } from "../src/application/action-state";
import {
  runBatchWrite,
  retryableBatchRows,
  summarizeBatch,
  type BatchRowResult,
  type BatchWriteOperations,
} from "../src/application/batch-write";
import { assertRevisionUnchanged } from "../src/data/revisions";
import type { DataRecord, TemplateBundle, WorkspaceContext } from "../src/domain/types";
import { PosterError } from "../src/domain/types";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";

const rows: DataRecord[] = [
  { id: "r1", label: "第一条", values: {} },
  { id: "r2", label: "第二条", values: {} },
  { id: "r3", label: "第三条", values: {} },
];
const context: WorkspaceContext = {
  tableId: "jobs",
  tableName: "岗位",
  fields: [{ id: "out", name: "海报", kind: "attachment" }],
  records: rows,
  selectedRecordId: "r1",
};
const bundle: TemplateBundle = {
  template: { ...DEFAULT_TEMPLATE, backgroundFieldId: null, boxes: [] },
  assets: [],
};

function operations(overrides: Partial<BatchWriteOperations> = {}): BatchWriteOperations {
  return {
    prepareBundle: async () => bundle,
    resolveBundle: async () => bundle,
    readOutputVersion: async () => "empty",
    render: async () => new Blob(["png"], { type: "image/png" }),
    write: async () => undefined,
    onChange: () => undefined,
    ...overrides,
  };
}

test("同步操作锁阻止同渲染周期重复操作，释放后可再次执行", () => {
  const lock = new OperationLock();
  const release = lock.tryAcquire();
  assert.ok(release);
  assert.equal(lock.tryAcquire(), null);
  release!();
  release!();
  assert.ok(lock.tryAcquire());
});

test("动作状态集中返回来源加载、输出字段与记录数阻断原因", () => {
  const base = {
    busy: null,
    sourceLoading: false,
    hasTemplate: true,
    usesRecordBackground: true,
    hasRecord: true,
    hasOutputField: true,
    recordCount: 3,
  };
  assert.equal(resolvePosterActionState(base).canWriteBatch, true);
  assert.equal(resolvePosterActionState({ ...base, sourceLoading: true }).canSave, false);
  assert.match(
    resolvePosterActionState({ ...base, hasOutputField: false }).writeBlockerText,
    /附件字段/,
  );
  assert.match(resolvePosterActionState({ ...base, recordCount: 0 }).writeBlockerText, /没有记录/);
  const noRecord = resolvePosterActionState({
    ...base,
    usesRecordBackground: false,
    hasRecord: false,
  });
  assert.equal(noRecord.canPreview, false);
  assert.equal(noRecord.canWriteCurrent, false);
  assert.match(noRecord.writeBlockerText, /主记录/);
});

test("乐观版本检查接受未变更和旧版零号修订，拒绝覆盖新修订", () => {
  assertRevisionUnchanged(null, undefined, "模板");
  assertRevisionUnchanged(0, undefined, "模板");
  assertRevisionUnchanged(12, 12, "模板");
  assert.throws(() => assertRevisionUnchanged(12, 13, "模板"), /其他窗口或设备/);
  assert.throws(() => assertRevisionUnchanged(null, 13, "模板"), /其他窗口或设备/);
});

test("批量预检失败不写入该行，其他行继续且汇总完整", async () => {
  const written: string[] = [];
  const results = await runBatchWrite(
    rows,
    context,
    "out",
    new AbortController().signal,
    operations({
      prepareBundle: async (row) => {
        if (row.id === "r1") throw new Error("缺少来源模板");
        return bundle;
      },
      write: async (row) => {
        written.push(row.id);
      },
    }),
  );
  assert.deepEqual(written, ["r2", "r3"]);
  assert.deepEqual(summarizeBatch(results), {
    total: 3,
    done: 3,
    succeeded: 2,
    failed: 1,
    unknown: 0,
    conflict: 0,
    stopped: 0,
  });
  assert.deepEqual(
    retryableBatchRows(results).map((row) => row.id),
    ["r1"],
  );
});

test("写入结果未知与版本冲突不进入安全重试集合", async () => {
  const results = await runBatchWrite(
    rows.slice(0, 2),
    context,
    "out",
    new AbortController().signal,
    operations({
      write: async (row) => {
        throw row.id === "r1"
          ? new PosterError("WRITE_OUTCOME_UNKNOWN", "超时")
          : new PosterError("WRITE_CONFLICT", "附件已变化");
      },
    }),
  );
  assert.deepEqual(
    results.map((row) => row.status),
    ["write_unknown", "conflict"],
  );
  assert.equal(retryableBatchRows(results).length, 0);
  assert.equal(summarizeBatch(results).unknown, 1);
  assert.equal(summarizeBatch(results).conflict, 1);
});

test("停止只影响后续行，已确认写入仍记成功", async () => {
  const controller = new AbortController();
  let snapshots: BatchRowResult[][] = [];
  const results = await runBatchWrite(
    rows,
    context,
    "out",
    controller.signal,
    operations({
      write: async (row) => {
        if (row.id === "r1") controller.abort();
      },
      onChange: (value) => {
        snapshots.push(value);
      },
    }),
  );
  assert.deepEqual(
    results.map((row) => row.status),
    ["succeeded", "stopped", "stopped"],
  );
  assert.equal(summarizeBatch(results).succeeded, 1);
  assert.equal(summarizeBatch(results).stopped, 2);
  assert.ok(snapshots.at(-1)!.every((row) => row.status !== "writing"));
});

test("每行使用预检时的输出附件版本，不随任务启动后的编辑改变", async () => {
  const versions: string[] = [];
  const observed: string[] = [];
  await runBatchWrite(
    rows.slice(0, 1),
    context,
    "out",
    new AbortController().signal,
    operations({
      readOutputVersion: async () => {
        versions.push("token-v1");
        return "token-v1";
      },
      write: async (_row, _bundle, _blob, expected) => {
        observed.push(expected);
      },
    }),
  );
  assert.deepEqual(versions, ["token-v1"]);
  assert.deepEqual(observed, ["token-v1"]);
});

test("补空任务与重试沿用已确认的空版本，扫描后他人写入的附件保留", async () => {
  let expected = "";
  const results = await runBatchWrite(
    rows.slice(0, 1),
    context,
    "out",
    new AbortController().signal,
    operations({
      readOutputVersion: async () => {
        throw new Error("不应采纳确认后的新版本");
      },
      write: async (_row, _bundle, _blob, version) => {
        expected = version;
        if (version !== "other-attachment") throw new PosterError("WRITE_CONFLICT", "已有附件");
      },
    }),
    true,
  );
  assert.equal(expected, "empty");
  assert.equal(results[0].status, "conflict");
  assert.deepEqual(retryableBatchRows(results), []);
});

test("批量先固定附件版本，逐行取用素材；初始进度快照不会被修改", async () => {
  const prepared: string[] = [],
    versions: string[] = [],
    rendered: string[] = [];
  const snapshots: BatchRowResult[][] = [];
  await runBatchWrite(
    rows,
    context,
    "out",
    new AbortController().signal,
    operations({
      readOutputVersion: async (row) => {
        versions.push(row.id);
        return "empty";
      },
      prepareBundle: async (row) => {
        assert.equal(versions.length, rows.length);
        assert.equal(prepared.length, rendered.length);
        prepared.push(row.id);
        return bundle;
      },
      render: async (row) => {
        rendered.push(row.id);
        return new Blob(["png"]);
      },
      onChange: (value) => {
        snapshots.push(value);
      },
    }),
  );
  assert.deepEqual(
    prepared,
    rows.map((row) => row.id),
  );
  assert.ok(snapshots[0].every((row) => row.status === "pending"));
  assert.ok(snapshots.at(-1)!.every((row) => row.status === "succeeded"));
});
