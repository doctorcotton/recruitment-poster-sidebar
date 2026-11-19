export type WorkspaceTab = "records" | "template" | "settings";

const TABS: { id: WorkspaceTab; label: string; description: string }[] = [
  { id: "records", label: "记录", description: "主记录字段、预览与生成写回" },
  { id: "template", label: "模板", description: "版式、图层与文字字段映射" },
  { id: "settings", label: "设置", description: "底图字段与写入附件字段" },
];

interface Props {
  value: WorkspaceTab;
  disabled: boolean;
  onChange(tab: WorkspaceTab): void;
}

/** 顶层模块导航：记录、模板、设置并列，子页面只在所属模块内切换。 */
export function WorkspaceTabs({ value, disabled, onChange }: Props) {
  return (
    <nav className="workspace-tabs" aria-label="工作台模块">
      {TABS.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            className={`workspace-tab ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={tab.description}
            disabled={disabled}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
