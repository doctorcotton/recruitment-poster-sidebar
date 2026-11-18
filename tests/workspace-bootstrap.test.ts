import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkspaceBootstrap } from "../src/domain/workspace-bootstrap";

test("绑定损坏不清空真实业务表和配置表，保留修复入口", async () => {
  const result = await loadWorkspaceBootstrap({
    listTables: async () => [{ id: "jobs", name: "岗位" }],
    listStorageTables: async () => [{ id: "config", name: "插件配置表" }],
    loadWorkspaceBinding: async () => {
      throw new Error("绑定版本无效");
    },
  });
  assert.equal(result.tables[0].id, "jobs");
  assert.equal(result.storageTables[0].id, "config");
  assert.equal(result.binding, null);
  assert.match(result.errors[0], /自动恢复连接.*绑定版本无效/);
});

test("表读取权限失败单独报告，不能伪造表或启动默认连接", async () => {
  const result = await loadWorkspaceBootstrap({
    listTables: async () => {
      throw new Error("权限不足 10213997");
    },
    listStorageTables: async () => [{ id: "config", name: "配置表" }],
    loadWorkspaceBinding: async () => null,
  });
  assert.deepEqual(result.tables, []);
  assert.equal(result.storageTables.length, 1);
  assert.match(result.errors[0], /权限不足 10213997/);
  assert.equal(result.binding, null);
});
