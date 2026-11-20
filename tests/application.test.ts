import assert from "node:assert/strict";
import test from "node:test";
import { OperationLock } from "../src/application/operation-lock";
import { resolvePosterActionState } from "../src/application/action-state";
import { hasUnsavedChanges } from "../src/application/draft-state";
import {
  runBatchWrite,
  retryableBatchRows,
  summarizeBatch,
  describeBatchSummary,
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
  // 保存阻断文案与写入阻断文案各自独立成链，busy 与来源错误要有各自的提示。
  const busySave = resolvePosterActionState({ ...base, busy: "写入中" });
  assert.equal(busySave.canSave, false);
  assert.equal(busySave.saveBlockerText, "另一项操作正在执行");
  const sourceFail = resolvePosterActionState({ ...base, sourceError: "底图读取失败" });
  assert.equal(sourceFail.canSave, false);
  assert.equal(sourceFail.saveBlockerText, "底图读取失败");
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

test("跨表绑定的预检按绑定表判断字段有效性", async () => {
  const fields = [...context.fields, { id: "job", name: "岗位", kind: "text" as const }];
  const scopedContext: WorkspaceContext = { ...context, fields };
  const templateTable = {
    tableId: "tpl",
    fields: [{ id: "duty", name: "职责", kind: "text" as const }],
  };
  const box = DEFAULT_TEMPLATE.boxes[0];
  const crossBundle: TemplateBundle = {
    ...bundle,
    template: {
      ...bundle.template,
      boxes: [
        { ...box, id: "data", fieldId: "job", fieldTableId: null },
        { ...box, id: "template", fieldId: "duty", fieldTableId: "tpl" },
      ],
    },
  };
  const run = (template: TemplateBundle) =>
    runBatchWrite(
      [rows[0]],
      scopedContext,
      "out",
      new AbortController().signal,
      operations({ templateTable, prepareBundle: async () => template }),
    );
  assert.equal((await run(crossBundle))[0].status, "succeeded");
  // 模板表字段失效：只有把模板表字段集算进来才会被发现。
  const staleTemplate = {
    ...crossBundle,
    template: {
      ...crossBundle.template,
      boxes: [{ ...box, id: "template", fieldId: "missing", fieldTableId: "tpl" }],
    },
  };
  const [stale] = await run(staleTemplate);
  assert.equal(stale.status, "preflight_failed");
  assert.match(stale.message ?? "", /已失效字段/);
  // 绑定表与预期模板表不一致，同样不能放过。
  const wrongTable = {
    ...crossBundle,
    template: {
      ...crossBundle.template,
      boxes: [{ ...box, id: "template", fieldId: "duty", fieldTableId: "other" }],
    },
  };
  assert.equal((await run(wrongTable))[0].status, "preflight_failed");
});

test("模板表字段池没读到时报读取问题，不把正常图层引导成重绑", async () => {
  const box = DEFAULT_TEMPLATE.boxes[0];
  const templateBound: TemplateBundle = {
    ...bundle,
    template: {
      ...bundle.template,
      boxes: [{ ...box, id: "template", fieldId: "duty", fieldTableId: "tpl" }],
    },
  };
  const run = (templateTable: BatchWriteOperations["templateTable"]) =>
    runBatchWrite(
      [rows[0]],
      context,
      "out",
      new AbortController().signal,
      operations({ templateTable, prepareBundle: async () => templateBound }),
    );
  // 没有模板表配置、或字段列表为空，都属于“没读到”，不能断言字段已失效。
  for (const templateTable of [null, { tableId: "tpl", fields: [] }]) {
    const [result] = await run(templateTable);
    assert.equal(result.status, "preflight_failed");
    assert.match(result.message ?? "", /模板表字段未读取完成/);
    assert.doesNotMatch(result.message ?? "", /已失效字段/);
  }
  // 字段池读到了，缺字段才是真的需要重新绑定。
  const [missing] = await run({
    tableId: "tpl",
    fields: [{ id: "other", name: "其他", kind: "text" }],
  });
  assert.equal(missing.status, "preflight_failed");
  assert.match(missing.message ?? "", /已失效字段/);
});

test("浏览动作重设基线后不算未保存，只有真实编辑才拦截", () => {
  const base = {
    templateStamp: "snap",
    baselineStamp: "snap",
    outputFieldId: "out",
    savedOutputFieldId: "out",
  };
  assert.equal(hasUnsavedChanges(base), false);
  // 切换记录/数据表这类浏览动作：版式原样保留，基线重设为当前快照。
  assert.equal(hasUnsavedChanges({ ...base, baselineStamp: "snap" }), false);
  // 模板真的改过。
  assert.equal(hasUnsavedChanges({ ...base, templateStamp: "edited" }), true);
  // 输出字段改过。
  assert.equal(hasUnsavedChanges({ ...base, outputFieldId: "other" }), true);
  // 没有版式时不参与判定，避免挡住首屏。
  assert.equal(
    hasUnsavedChanges({
      templateStamp: "",
      baselineStamp: "",
      outputFieldId: "a",
      savedOutputFieldId: "b",
    }),
    false,
  );
});

test("结果摘要只列非零项，全成功时不堆一串 0", () => {
  const base = {
    total: 2,
    done: 2,
    succeeded: 2,
    failed: 0,
    conflict: 0,
    unknown: 0,
    stopped: 0,
  };
  assert.equal(describeBatchSummary(base), "成功 2");
  assert.equal(describeBatchSummary({ ...base, succeeded: 1, failed: 1 }), "成功 1，失败 1");
  assert.equal(
    describeBatchSummary({ ...base, succeeded: 0, stopped: 5, conflict: 1 }),
    "成功 0，冲突 1，停止 5",
  );
});
