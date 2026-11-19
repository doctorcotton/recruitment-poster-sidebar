import { Button, Input } from "../../ui/semi";
import { IconFont, IconImage } from "@douyinfe/semi-icons";
import type { PosterAsset, PosterTemplate, TemplateSource } from "../../domain/types";

interface Props {
  template: PosterTemplate;
  source: TemplateSource | null;
  fontAssets: PosterAsset[];
  backgroundFieldName: string;
  disabled: boolean;
  /** 未启用模板表时，独立模板库仍需要新建副本与删除入口。 */
  showLibraryActions: boolean;
  canDelete: boolean;
  onNameChange(name: string): void;
  onEditMapping(): void;
  onUploadBackground(): void;
  onUploadFont(): void;
  onImport(): void;
  onExport(): void;
  onCopyTemplate(): void;
  onDeleteTemplate(): void;
}

/**
 * 模板页右栏的「模板设置」分区：只放当前模板自身的设置。
 * 数据源、模板定位字段、模板底图字段属于工作区级配置，留在「设置」页。
 */
export function TemplateSettingsPanel(props: Props) {
  const { template, source, fontAssets } = props;
  return (
    <section className="panel-section template-settings" aria-label="模板设置">
      <label className="control-label">
        <span>模板名称</span>
        <Input
          aria-label="模板名称"
          value={template.name}
          onChange={(name) => props.onNameChange(name)}
          disabled={props.disabled}
        />
      </label>
      <dl className="settings-source template-source-summary">
        <div>
          <dt>模板行</dt>
          <dd>{source ? `${source.tableName} · ${source.recordName}` : "未定位"}</dd>
        </div>
        <div>
          <dt>底图字段</dt>
          <dd>{props.backgroundFieldName || "未选择"}</dd>
        </div>
      </dl>
      <div className="asset-buttons">
        <Button icon={<IconImage />} onClick={props.onUploadBackground} disabled={props.disabled}>
          更换底图
        </Button>
        <Button icon={<IconFont />} onClick={props.onUploadFont} disabled={props.disabled}>
          上传字体
        </Button>
      </div>
      <div className="template-font-list" aria-label="模板字体">
        <span>字体</span>
        {fontAssets.length ? (
          fontAssets.map((asset) => (
            <span key={asset.id} className="template-font-item">
              {asset.name}
            </span>
          ))
        ) : (
          <span className="template-font-item">使用内置字体</span>
        )}
      </div>
      <div className="asset-buttons">
        <Button onClick={props.onImport} disabled={props.disabled}>
          导入模板
        </Button>
        <Button onClick={props.onExport} disabled={props.disabled}>
          导出模板
        </Button>
      </div>
      <Button size="small" onClick={props.onEditMapping} disabled={props.disabled}>
        修改字段映射
      </Button>
      {props.showLibraryActions && (
        <div className="asset-buttons">
          <Button onClick={props.onCopyTemplate} disabled={props.disabled}>
            新建副本
          </Button>
          <Button
            theme="borderless"
            type="danger"
            onClick={props.onDeleteTemplate}
            disabled={props.disabled || !props.canDelete}
          >
            删除模板
          </Button>
        </div>
      )}
    </section>
  );
}
