import type { PosterRepository, TableSummary, WorkspaceBinding } from "./types";

export interface WorkspaceBootstrap {
  tables: TableSummary[];
  storageTables: TableSummary[];
  binding: WorkspaceBinding | null;
  errors: string[];
}

/** 三项读取互不依赖：旧连接失效时，真实表列表仍必须可选，才能修复连接。 */
export async function loadWorkspaceBootstrap(
  repository: Pick<PosterRepository, "listTables" | "listStorageTables" | "loadWorkspaceBinding">,
): Promise<WorkspaceBootstrap> {
  const results = await Promise.allSettled([
    repository.listTables(),
    repository.listStorageTables(),
    repository.loadWorkspaceBinding(),
  ]);
  const [tables, stores, binding] = results;
  return {
    tables: tables.status === "fulfilled" ? tables.value : [],
    storageTables: stores.status === "fulfilled" ? stores.value : [],
    binding: binding.status === "fulfilled" ? binding.value : null,
    errors: results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${["读取业务表", "读取配置表", "自动恢复连接"][index]}失败：${result.reason instanceof Error ? result.reason.message : "请重试"}`,
          ]
        : [],
    ),
  };
}
