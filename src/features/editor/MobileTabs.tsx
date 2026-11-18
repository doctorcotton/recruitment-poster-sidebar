const TABS = [
  { id: "layers", label: "模板" },
  { id: "canvas", label: "画布" },
  { id: "properties", label: "文字属性" },
] as const;

interface Props {
  value: string;
  onChange(value: string): void;
}

/** 窄屏页签支持方向键、Home、End 和完整的 tab 语义。 */
export function MobileTabs({ value, onChange }: Props) {
  return (
    <nav className="mobile-tabs" aria-label="编辑面板" role="tablist">
      {TABS.map((tab, index) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          role="tab"
          aria-selected={value === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={value === tab.id ? 0 : -1}
          className={value === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
            else if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = TABS.length - 1;
            else return;
            event.preventDefault();
            const target = TABS[next];
            onChange(target.id);
            requestAnimationFrame(() => document.getElementById(`tab-${target.id}`)?.focus());
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
