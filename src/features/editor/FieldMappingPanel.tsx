import { Select } from "../../ui/semi";
import type { PosterTemplate, TableField, TextBox } from "../../domain/types";
import {
  bindingOptionsOf,
  bindingPatchOf,
  bindingValueOf,
  boundFieldOf,
  fieldOfBinding,
} from "./binding-options";

interface Props {
  template: PosterTemplate;
  /** 数据表字段。 */
  fields: TableField[];
  /** 模板表字段；为空表示没有启用模板表定位。 */
  templateFields: TableField[];
  templateTableId: string | null;
  values: Record<string, string>;
  disabled: boolean;
  onChange(id: string, updates: Partial<TextBox>, remember?: boolean): void;
}

/** 第二层高级设置：每个文字图层一行，直接在此页改绑定，不再二次选择图层。 */
export function FieldMappingPanel(props: Props) {
  const { template, fields, templateFields, templateTableId, values, disabled } = props;
  const source = { fields, templateFields, templateTableId };
  const invalidCount = template.boxes.filter(
    (box) => box.fieldId && !fieldOfBinding(bindingValueOf(box), source),
  ).length;
  return (
    <main className="mapping-workspace">
      <header className="mapping-heading">
        <h1>文字字段映射</h1>
        <p className="mapping-hint">
          文字图层可绑数据表的行变量，也可绑模板表的固定文案；不绑字段即为固定文字。写入附件等插件级设置见「设置」。
        </p>
      </header>
      <section className="mapping-card" aria-labelledby="mapping-card-title">
        <div className="mapping-card-heading">
          <h2 id="mapping-card-title">
            文字图层<span className="mapping-count">{template.boxes.length}</span>
          </h2>
          {invalidCount ? (
            <span className="mapping-tag is-invalid">{invalidCount} 个待修复</span>
          ) : (
            <span className="mapping-tag is-ok">映射正常</span>
          )}
        </div>
        {template.boxes.length ? (
          <div className="mapping-grid">
            {template.boxes.map((box) => {
              const bound = boundFieldOf(box, source);
              const value = bindingValueOf(box);
              const invalid = Boolean(box.fieldId && !bound);
              const current = bound ? (values[value] ?? "") : (box.text ?? "");
              const labelId = `mapping-label-${box.id}`;
              return (
                <div
                  key={box.id}
                  className={`mapping-item${invalid ? " invalid" : ""}`}
                  data-mapping-box-id={box.id}
                >
                  <div className="mapping-item-label">
                    <strong id={labelId}>{box.label}</strong>
                    {invalid ? (
                      <span className="mapping-tag is-invalid">已失效</span>
                    ) : box.fieldId ? (
                      box.fieldTableId && <span className="mapping-tag is-template">模板表</span>
                    ) : box.locked ? (
                      <span className="mapping-tag">已锁定</span>
                    ) : null}
                  </div>
                  <Select
                    aria-labelledby={labelId}
                    value={value}
                    optionList={bindingOptionsOf(source, value)}
                    filter
                    onChange={(next) => {
                      const patch = bindingPatchOf(String(next));
                      if (patch) props.onChange(box.id, patch, true);
                    }}
                    disabled={disabled || Boolean(box.locked)}
                    style={{ width: "100%" }}
                  />
                  <p className="mapping-item-value" title={current}>
                    {invalid ? (
                      <span className="is-invalid">原字段已删除，请重新选择</span>
                    ) : bound ? (
                      <>
                        <span>{box.fieldTableId ? "模板行值" : "当前值"}</span>
                        {current || "（空）"}
                      </>
                    ) : (
                      <>
                        <span>固定文字</span>
                        {current || "（空）"}
                      </>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mapping-empty">模板里还没有文字图层，先在「模板」添加文字框。</p>
        )}
      </section>
    </main>
  );
}
