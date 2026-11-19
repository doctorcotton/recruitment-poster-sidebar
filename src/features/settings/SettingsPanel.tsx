import { Button, Select } from "../../ui/semi";
import type { TableField } from "../../domain/types";

interface Props {
  tableName: string;
  storageName: string | null;
  storageReady: boolean;
  /** 数据表字段：决定模板定位字段和写入附件字段。 */
  fields: TableField[];
  /** 模板表字段：由定位字段的引用表推导。 */
  templateFields: TableField[];
  templateFieldId: string;
  templateBackgroundFieldId: string;
  outputFieldId: string;
  dirty: boolean;
  disabled: boolean;
  sourceError: string;
  onTemplateFieldChange(value: string): void;
  onTemplateBackgroundFieldChange(value: string): void;
  onOutputFieldChange(value: string): void;
  onSwitchTable(): void;
}

/** 插件级设置独立成页：只放跨记录生效的字段绑定，文字图层绑定留在模板模块。 */
export function SettingsPanel(props: Props) {
  const { fields, templateFields } = props;
  const locatorFields = fields.filter((field) => field.kind === "lookup" && field.refTableId);
  const backgroundFields = templateFields.filter((field) => field.kind === "attachment");
  const outputFields = fields.filter((field) => field.kind === "attachment");
  return (
    <main className="settings-workspace">
      <header className="settings-heading">
        <h1>插件设置</h1>
      </header>
      <section className="settings-card" aria-labelledby="settings-source-title">
        <div className="settings-card-heading">
          <h2 id="settings-source-title">数据源</h2>
          <Button size="small" disabled={props.disabled} onClick={props.onSwitchTable}>
            切换数据表
          </Button>
        </div>
        <dl className="settings-source">
          <div>
            <dt>业务数据表</dt>
            <dd>{props.tableName}</dd>
          </div>
          <div>
            <dt>配置表</dt>
            <dd>
              {props.storageName ?? "未初始化"}
              {props.storageReady ? " · 已就绪" : ""}
            </dd>
          </div>
        </dl>
      </section>
      <section className="settings-card" aria-labelledby="settings-fields-title">
        <div className="settings-card-heading">
          <h2 id="settings-fields-title">字段绑定</h2>
          <span className="save-state">{props.dirty ? "未保存" : "已保存"}</span>
        </div>
        <div className="settings-field-row" data-setting-key="template">
          <strong id="settings-template-label">模板定位字段</strong>
          <Select
            aria-labelledby="settings-template-label"
            value={props.templateFieldId || "__none__"}
            optionList={[
              { label: "不启用模板表", value: "__none__" },
              ...locatorFields.map((field) => ({ label: field.name, value: field.id })),
            ]}
            onChange={(value) => props.onTemplateFieldChange(String(value))}
            disabled={props.disabled}
            style={{ width: "100%" }}
          />
          <p className="settings-hint">
            数据表里指向模板表的查找引用字段；每行通过它决定使用哪一条模板。
          </p>
        </div>
        <div className="settings-field-row" data-setting-key="template-background">
          <strong id="settings-template-background-label">模板底图字段</strong>
          <Select
            aria-labelledby="settings-template-background-label"
            value={props.templateBackgroundFieldId || "__none__"}
            placeholder={props.templateFieldId ? "选择模板表的附件字段" : "请先选择模板定位字段"}
            optionList={[
              { label: "未选择", value: "__none__" },
              ...backgroundFields.map((field) => ({ label: field.name, value: field.id })),
            ]}
            onChange={(value) => props.onTemplateBackgroundFieldChange(String(value))}
            disabled={props.disabled || !props.templateFieldId}
            style={{ width: "100%" }}
          />
          <p className="settings-hint">模板表里存底图的附件字段，每张海报都从这个字段取图。</p>
        </div>
        <div className="settings-field-row" data-setting-key="output">
          <strong id="settings-output-label">写入附件字段</strong>
          <Select
            aria-labelledby="settings-output-label"
            value={props.outputFieldId || undefined}
            placeholder="选择附件字段"
            optionList={outputFields.map((field) => ({ label: field.name, value: field.id }))}
            onChange={(value) => props.onOutputFieldChange(String(value))}
            disabled={props.disabled}
            style={{ width: "100%" }}
          />
        </div>
        {props.sourceError && (
          <p className="settings-error" role="alert">
            {props.sourceError}
          </p>
        )}
      </section>
    </main>
  );
}
