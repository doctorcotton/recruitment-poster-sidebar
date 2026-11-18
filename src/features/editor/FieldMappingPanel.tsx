import { Select } from "../../ui/semi";
import type { PosterTemplate, TableField, TextBox } from "../../domain/types";

interface Props {
  template: PosterTemplate;
  fields: TableField[];
  selected: TextBox | null;
  selectedId: string | null;
  values: Record<string, string>;
  outputFieldId: string;
  disabled: boolean;
  sourceStatus: string;
  onSelectLayer(id: string): void;
  onChange(id: string, updates: Partial<TextBox>, remember?: boolean): void;
  onBackgroundFieldChange(value: string): void;
  onOutputFieldChange(value: string): void;
}

/** 第二层高级设置，只处理文字、底图和输出的数据映射。 */
export function FieldMappingPanel(props: Props) {
  const { template, fields, selected, values, disabled } = props;
  const textFields = fields.filter(
    (field) => field.kind !== "attachment" && field.kind !== "other",
  );
  const attachmentFields = fields.filter((field) => field.kind === "attachment");
  const backgroundFields = fields.filter(
    (field) => field.kind === "attachment" || field.kind === "lookup",
  );
  const selectedField = selected?.fieldId
    ? fields.find((field) => field.id === selected.fieldId)
    : null;
  const bindingOptions = [
    { label: "固定文字", value: "__fixed__" },
    ...(selected?.fieldId && !selectedField
      ? [{ label: "已失效字段，请重新绑定", value: selected.fieldId }]
      : []),
    ...textFields.map((field) => ({ label: field.name, value: field.id })),
  ];
  return (
    <main className="mapping-workspace">
      <header className="mapping-heading">
        <span className="record-eyebrow">高级编辑 / 字段映射</span>
        <h1>字段映射</h1>
        <p>只修改海报图层、底图和输出与多维表字段的关系。固定文字和样式请返回高级编辑。</p>
      </header>
      <section className="mapping-data-card" aria-labelledby="mapping-data-title">
        <div>
          <h2 id="mapping-data-title">数据与输出</h2>
          <p>{props.sourceStatus || "当前映射会用于记录页预览和生成。"}</p>
        </div>
        <div className="mapping-data-grid">
          <label className="control-label">
            <span id="mapping-background-label">底图字段</span>
            <Select
              aria-labelledby="mapping-background-label"
              value={template.backgroundFieldId ?? "__template__"}
              optionList={[
                { label: "模板固定底图", value: "__template__" },
                ...backgroundFields.map((field) => ({
                  label: `${field.name}${field.kind === "lookup" ? "（查找引用）" : ""}`,
                  value: field.id,
                })),
              ]}
              onChange={(value) => props.onBackgroundFieldChange(String(value))}
              disabled={disabled}
              style={{ width: "100%" }}
            />
          </label>
          <label className="control-label">
            <span id="mapping-output-label">写入附件字段</span>
            <Select
              aria-labelledby="mapping-output-label"
              value={props.outputFieldId || undefined}
              placeholder="选择附件字段"
              optionList={attachmentFields
                .filter((field) => field.id !== template.backgroundFieldId)
                .map((field) => ({ label: field.name, value: field.id }))}
              onChange={(value) => props.onOutputFieldChange(String(value))}
              disabled={disabled}
              style={{ width: "100%" }}
            />
          </label>
        </div>
      </section>
      <div className="mapping-layout">
        <aside className="mapping-layer-list" aria-label="文字图层映射">
          <div className="section-heading">
            <h2>文字图层</h2>
            <span>{template.boxes.length}</span>
          </div>
          {template.boxes.map((box) => {
            const field = box.fieldId ? fields.find((item) => item.id === box.fieldId) : null;
            const invalid = Boolean(box.fieldId && !field);
            return (
              <button
                key={box.id}
                className={`mapping-layer-row ${box.id === props.selectedId ? "selected" : ""}`}
                onClick={() => props.onSelectLayer(box.id)}
                aria-pressed={box.id === props.selectedId}
              >
                <strong>{box.label}</strong>
                <span className={invalid ? "mapping-invalid" : ""}>
                  {invalid ? "字段已失效" : (field?.name ?? "固定文字")}
                </span>
              </button>
            );
          })}
        </aside>
        <section className="mapping-editor-card" aria-labelledby="mapping-editor-title">
          {selected ? (
            <>
              <div className="mapping-selected-heading">
                <div>
                  <span className="record-eyebrow">当前图层</span>
                  <h2 id="mapping-editor-title">{selected.label}</h2>
                </div>
                <span>{selected.locked ? "已锁定" : "可修改映射"}</span>
              </div>
              <label className="control-label">
                <span id="mapping-binding-label">绑定字段</span>
                <Select
                  aria-labelledby="mapping-binding-label"
                  value={selected.fieldId ?? "__fixed__"}
                  optionList={bindingOptions}
                  filter
                  onChange={(value) =>
                    props.onChange(
                      selected.id,
                      { fieldId: value === "__fixed__" ? null : String(value) },
                      true,
                    )
                  }
                  disabled={disabled || selected.locked}
                  style={{ width: "100%" }}
                />
              </label>
              {selected.fieldId ? (
                <div className="mapping-current-value">
                  <span>当前主记录值</span>
                  <strong>{values[selected.fieldId] || "当前记录为空"}</strong>
                </div>
              ) : (
                <div className="mapping-fixed-note">
                  当前为固定文字。文字内容在高级编辑的属性面板中修改。
                </div>
              )}
            </>
          ) : (
            <div className="record-detail-empty">从左侧选择一个文字图层设置字段映射。</div>
          )}
        </section>
      </div>
    </main>
  );
}
