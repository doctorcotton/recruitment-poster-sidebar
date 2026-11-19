import type { RefObject } from "react";
import { Button, Input, InputNumber, Select, TextArea } from "../../ui/semi";
import { IconCopy, IconDelete, IconDownload, IconPlus } from "@douyinfe/semi-icons";
import type { PosterAsset, TableField, TextBox } from "../../domain/types";
import { bindingOptionsOf, bindingPatchOf, bindingValueOf, boundFieldOf } from "./binding-options";
import { FontHexInput } from "../../ui/FontHexInput";

interface Props {
  panelRef: RefObject<HTMLElement | null>;
  popup: { x: number; y: number } | null;
  selected: TextBox | null;
  values: Record<string, string>;
  fields: TableField[];
  templateFields: TableField[];
  templateTableId: string | null;
  fontAssets: PosterAsset[];
  presetFont: { id: string; label: string };
  disabled: boolean;
  canDownload: boolean;
  /** 嵌在模板页右栏 tab 内时为 true。 */
  embedded?: boolean;
  onClose(): void;
  onCopy(): void;
  onDelete(): void;
  onAdd(): void;
  onChange(id: string, updates: Partial<TextBox>, remember?: boolean): void;
  onDownload(): void;
}

/** 固定侧栏与右键浮窗共用一份文字属性控件。 */
export function PropertyPanel(props: Props) {
  const { panelRef, popup, selected, values, fields, fontAssets, presetFont, disabled } = props;
  // 绑定下拉与映射页共用同一份选项；这里只改当前图层的绑定。
  const bindingSource = {
    fields,
    templateFields: props.templateFields,
    templateTableId: props.templateTableId,
  };
  const bindingValue = selected ? bindingValueOf(selected) : "__fixed__";
  const bindingOptions = bindingOptionsOf(bindingSource, bindingValue);
  const boundField = selected ? boundFieldOf(selected, bindingSource) : null;
  const currentValue = values[bindingValue] ?? "";
  // 右栏与浮窗可能同屏，锚点 id 要区分开，避免重复 id。
  const bindingLabelId = popup ? "popup-binding-label" : "property-binding-label";
  // 嵌在右栏 tab 里时不带栅格列 class，也不占用 tab 的锚点 id。
  const className = popup
    ? "right-panel context-properties"
    : props.embedded
      ? "right-panel-body"
      : "right-panel";
  return (
    <aside
      id={props.embedded ? undefined : "panel-properties"}
      aria-labelledby={popup || props.embedded ? undefined : "tab-properties"}
      ref={panelRef}
      tabIndex={-1}
      role={popup ? "dialog" : undefined}
      aria-modal={popup ? false : undefined}
      aria-label={popup ? "文字框属性" : undefined}
      className={className}
      style={popup ? { left: popup.x, top: popup.y } : undefined}
    >
      <div className="panel-section properties-heading">
        <h2>文字属性</h2>
        {popup && (
          <Button theme="borderless" aria-label="关闭属性浮窗" onClick={props.onClose}>
            ×
          </Button>
        )}
        {selected && (
          <div>
            <Button
              theme="borderless"
              icon={<IconCopy />}
              aria-label="复制文字框"
              disabled={disabled}
              onClick={props.onCopy}
            />
            <Button
              theme="borderless"
              type="danger"
              icon={<IconDelete />}
              aria-label="删除文字框"
              disabled={disabled}
              onClick={props.onDelete}
            />
          </div>
        )}
      </div>
      {selected?.locked && (
        <p className="source-template-note locked-note" role="status">
          图层已锁定，请在图层列表解锁后编辑。
        </p>
      )}
      {selected ? (
        <>
          <section className="panel-section">
            <label className="control-label">
              图层名称
              <Input
                aria-label="图层名称"
                value={selected.label}
                onChange={(value) => props.onChange(selected.id, { label: value }, true)}
                disabled={disabled}
              />
            </label>
            {/* 绑定下拉常驻：固定文字图层也能在这里直接绑字段。 */}
            <label className="control-label">
              <span id={bindingLabelId}>绑定字段</span>
              <Select
                aria-labelledby={bindingLabelId}
                value={bindingValue}
                optionList={bindingOptions}
                filter
                onChange={(next) => {
                  const patch = bindingPatchOf(String(next));
                  if (patch) props.onChange(selected.id, patch, true);
                }}
                disabled={disabled || selected.locked}
                style={{ width: "100%" }}
              />
            </label>
            {selected.fieldId ? (
              <p className={`bound-field-value${boundField ? "" : " is-invalid"}`}>
                {boundField ? (
                  <>
                    <span>{selected.fieldTableId ? "模板行值" : "当前值"}</span>
                    {currentValue || "（空）"}
                  </>
                ) : (
                  "原字段已删除，请重新选择"
                )}
              </p>
            ) : (
              <label className="control-label">
                内容
                <TextArea
                  autosize={{ minRows: 2, maxRows: 6 }}
                  aria-label="固定文字内容"
                  value={selected.text}
                  onChange={(text) => props.onChange(selected.id, { text }, true)}
                  disabled={disabled}
                />
              </label>
            )}
          </section>
          <section className="panel-section">
            <h3>位置与大小</h3>
            <div className="number-grid">
              {(
                [
                  ["x", "X"],
                  ["y", "Y"],
                  ["width", "宽度"],
                  ["height", "高度"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="control-label">
                  {label}
                  <InputNumber
                    aria-label={`文字框${label}`}
                    value={Math.round(selected[key] * 10) / 10}
                    precision={1}
                    step={0.1}
                    min={key === "width" || key === "height" ? 24 : 0}
                    onChange={(value) =>
                      typeof value === "number" &&
                      value !== Math.round(selected[key] * 10) / 10 &&
                      props.onChange(selected.id, { [key]: value }, true)
                    }
                    disabled={disabled}
                    hideButtons
                    style={{ width: "100%" }}
                  />
                </label>
              ))}
            </div>
          </section>
          <section className="panel-section">
            <h3>字体与排版</h3>
            <label className="control-label">
              <span id="font-field-label">字体</span>
              <Select
                aria-labelledby="font-field-label"
                value={selected.fontId}
                optionList={fontAssets.map((asset) => ({
                  label:
                    asset.id === presetFont.id
                      ? presetFont.label
                      : asset.name.replace(/\.(otf|ttf|woff2?)$/i, ""),
                  value: asset.id,
                }))}
                onChange={(fontId) => props.onChange(selected.id, { fontId: String(fontId) }, true)}
                disabled={disabled}
                style={{ width: "100%" }}
              />
            </label>
            <div className="number-grid">
              <label className="control-label">
                字号
                <InputNumber
                  aria-label="文字字号"
                  value={Math.round(selected.fontSize)}
                  min={8}
                  max={300}
                  disabled={disabled}
                  onChange={(value) =>
                    typeof value === "number" &&
                    props.onChange(selected.id, { fontSize: value }, true)
                  }
                  hideButtons
                  style={{ width: "100%" }}
                />
              </label>
              <label className="control-label">
                最小字号
                <InputNumber
                  aria-label="最小字号"
                  value={Math.round(selected.minFontSize)}
                  min={8}
                  max={selected.fontSize}
                  disabled={disabled}
                  onChange={(value) =>
                    typeof value === "number" &&
                    props.onChange(selected.id, { minFontSize: value }, true)
                  }
                  hideButtons
                  style={{ width: "100%" }}
                />
              </label>
              <label className="control-label">
                行数上限
                <InputNumber
                  aria-label="行数上限"
                  value={Math.round(selected.maxLines)}
                  min={1}
                  max={20}
                  disabled={disabled}
                  onChange={(value) =>
                    typeof value === "number" &&
                    props.onChange(selected.id, { maxLines: Math.round(value) }, true)
                  }
                  hideButtons
                  style={{ width: "100%" }}
                />
              </label>
              <label className="control-label">
                行距
                <InputNumber
                  aria-label="文字行距"
                  value={selected.lineHeight}
                  min={1}
                  max={3}
                  step={0.1}
                  disabled={disabled}
                  onChange={(value) =>
                    typeof value === "number" &&
                    props.onChange(selected.id, { lineHeight: value }, true)
                  }
                  hideButtons
                  style={{ width: "100%" }}
                />
              </label>
            </div>
            <div className="color-align">
              <label className="control-label">
                字体颜色
                <input
                  aria-label="文字颜色"
                  type="color"
                  value={selected.color}
                  disabled={disabled}
                  onChange={(event) =>
                    props.onChange(selected.id, { color: event.target.value }, true)
                  }
                />
              </label>
              <label className="control-label">
                <span id="align-field-label">对齐</span>
                <Select
                  aria-labelledby="align-field-label"
                  value={selected.align}
                  optionList={[
                    { value: "left", label: "左对齐" },
                    { value: "center", label: "居中" },
                    { value: "right", label: "右对齐" },
                  ]}
                  onChange={(value) =>
                    props.onChange(selected.id, { align: value as TextBox["align"] }, true)
                  }
                  disabled={disabled}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
            <div className="font-color-settings">
              <FontHexInput
                value={selected.color}
                onChange={(value) => props.onChange(selected.id, { color: value }, true)}
                disabled={disabled}
              />
              <Button
                size="small"
                disabled={disabled}
                onClick={() => props.onChange(selected.id, { color: "#000000" }, true)}
              >
                黑色
              </Button>
              <Button
                size="small"
                disabled={disabled}
                onClick={() => props.onChange(selected.id, { color: "#ffffff" }, true)}
              >
                白色
              </Button>
            </div>
          </section>
        </>
      ) : (
        <div className="empty-properties">
          <span>T</span>
          <p>选择或添加一个文字框</p>
          <Button icon={<IconPlus />} onClick={props.onAdd}>
            添加文字
          </Button>
        </div>
      )}
      <div className="panel-section download-section">
        <Button
          aria-label="下载 PNG"
          block
          icon={<IconDownload />}
          disabled={!props.canDownload}
          onClick={props.onDownload}
        >
          下载 PNG
        </Button>
      </div>
    </aside>
  );
}
