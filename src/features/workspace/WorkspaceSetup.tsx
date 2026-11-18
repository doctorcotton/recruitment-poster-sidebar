import { Button, Select, Spin } from "../../ui/semi";
import type { TableSummary } from "../../domain/types";

interface Props {
  tables: TableSummary[] | null;
  storageTables: TableSummary[] | null;
  tableChoice: string;
  storageChoice: string;
  mode: "local" | "feishu";
  busy: string | null;
  hasContext: boolean;
  dirty: boolean;
  notice: string | null;
  onTableChoice(id: string): void;
  onStorageChoice(id: string): void;
  onEnter(): void;
  onCancel(): void;
  onRefresh(): void;
}

/** 首次连接与修复连接共用同一双表选择界面。 */
export function WorkspaceSetup(props: Props) {
  const {
    tables,
    storageTables,
    tableChoice,
    storageChoice,
    mode,
    busy,
    hasContext,
    dirty,
    notice,
  } = props;
  return (
    <div className="boot-screen">
      <div className="table-setup">
        <h1>连接数据表</h1>
        <p>首次选择后会自动记住，重开时直接读取。文字绑定、底图和输出附件来自业务表。</p>
        {tables === null ? (
          <Spin size="large" />
        ) : (
          <>
            <label className="control-label">
              <span id="setup-table-label">业务数据表</span>
              <Select
                aria-labelledby="setup-table-label"
                value={tableChoice || undefined}
                placeholder="请选择数据表"
                optionList={tables.map((table) => ({ label: table.name, value: table.id }))}
                onChange={(value) => {
                  const id = String(value);
                  props.onTableChoice(id);
                  if (storageChoice === id) props.onStorageChoice("");
                }}
                disabled={Boolean(busy)}
                style={{ width: "100%" }}
              />
            </label>
            <label className="control-label">
              <span id="setup-storage-label">配置数据表</span>
              <Select
                aria-labelledby="setup-storage-label"
                value={storageChoice || undefined}
                placeholder="选择已有配置表，或新建"
                optionList={[
                  ...(storageTables ?? [])
                    .filter((table) => table.id !== tableChoice)
                    .map((table) => ({ label: table.name, value: table.id })),
                  { label: "新建“招聘海报配置”", value: "__new__" },
                ]}
                onChange={(value) => props.onStorageChoice(String(value))}
                disabled={Boolean(busy)}
                style={{ width: "100%" }}
              />
            </label>
            <p className="setup-config-note">
              {mode === "local"
                ? "本地示例使用 IndexedDB 模拟配置存储。"
                : storageChoice === "__new__"
                  ? "将新建“招聘海报配置”数据表。"
                  : storageChoice
                    ? "复用所选配置表，补齐“配置键”和“配置值”字段。"
                    : "请选择已有配置表，或明确选择新建。"}
              业务读取范围为所选表全部记录。
            </p>
            {hasContext && dirty && <p>切换数据表前，请先保存当前编辑。</p>}
            {notice && (
              <p role="alert" className="setup-error">
                {notice}
              </p>
            )}
            <div className="setup-actions">
              <Button
                theme="solid"
                loading={busy === "open-table"}
                disabled={
                  Boolean(busy) || !tableChoice || !storageChoice || tableChoice === storageChoice
                }
                onClick={props.onEnter}
              >
                查看记录
              </Button>
              {hasContext && (
                <Button disabled={Boolean(busy)} onClick={props.onCancel}>
                  取消
                </Button>
              )}
              <Button disabled={Boolean(busy)} onClick={props.onRefresh}>
                刷新列表
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
