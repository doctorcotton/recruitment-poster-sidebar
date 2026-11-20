import type { RefObject } from "react";
import { Button, Input, Select, TextArea } from "../../ui/semi";
import { IconCopy, IconDelete, IconDownload, IconPlus } from "@douyinfe/semi-icons";
import type { TableField, TextBox } from "../../domain/types";
import { BOX_PRECISION } from "../../domain/geometry";
import { bindingOptionsOf, bindingPatchOf, bindingValueOf, boundFieldOf } from "./binding-options";
import { FontHexInput } from "../../ui/FontHexInput";
import { NumberField } from "../../ui/NumberField";

interface Props {
  panelRef: RefObject<HTMLElement | null>;
  popup: { x: number; y: number } | null;
  selected: TextBox | null;
  values: Record<string, string>;
  fields: TableField[];
  templateFields: TableField[];
  templateTableId: string | null;
  fontOptions: { value: string; label: string }[];
  disabled: boolean;
  canDownload: boolean;
  /** 嵌在模板页右栏 tab 内时为 true。 */
  embedded?: boolean;
  onClose(): void;
  onCopy(): void;
  onDelete(): void;
  onAdd(): void;
  onChange(id: string, updates: Partial<TextBox>, remember?: boolean): void;
  onFontChange(boxId: string, fontId: string): void;
  onDownload(): void;
}

/** 固定侧栏与右键浮窗共用一份文字属性控件。 */
export function PropertyPanel(props: Props) {
  const { panelRef, popup, selected, values, fields, fontOptions, disabled } = props;
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
                  ["x", "X", 0],
                  ["y", "Y", 0],
                  ["width", "宽度", 1],
                  ["height", "高度", 1],
                ] as const
              ).map(([key, label, min]) => (
                <label key={key} className="control-label">
                  {label}
                  <NumberField
                    label={`文字框${label}`}
                    // 步进按 1px 走，允许保留 0.1px 小数，与画布内拖拽一致。
                    step={1}
                    precision={BOX_PRECISION.position}
                    min={min}
                    value={selected[key]}
                    onChange={(value) => props.onChange(selected.id, { [key]: value }, true)}
                    disabled={disabled}
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
                optionList={fontOptions}
                onChange={(fontId) => props.onFontChange(selected.id, String(fontId))}
                disabled={disabled}
                style={{ width: "100%" }}
              />
            </label>
            <div className="text-style-row">
              {/* 字体文件只有常规面，斜体由渲染层合成倾斜。 */}
              <Button
                size="small"
                theme={selected.italic === true ? "solid" : "light"}
                aria-pressed={selected.italic === true}
                disabled={disabled}
                onClick={() =>
                  props.onChange(selected.id, { italic: selected.italic !== true }, true)
                }
              >
                斜体
              </Button>
            </div>
            <div className="number-grid">
              <label className="control-label">
                字号
                <NumberField
                  label="文字字号"
                  step={1}
                  precision={BOX_PRECISION.fontSize}
                  min={8}
                  max={300}
                  value={selected.fontSize}
                  onChange={(value) => props.onChange(selected.id, { fontSize: value }, true)}
                  disabled={disabled}
                />
              </label>
              <label className="control-label">
                最小字号
                <NumberField
                  label="最小字号"
                  step={1}
                  precision={BOX_PRECISION.fontSize}
                  min={8}
                  // 最小字号不能超过当前字号，避免排版搜索区间反向。
                  max={Math.max(8, selected.fontSize)}
                  value={selected.minFontSize}
                  onChange={(value) => props.onChange(selected.id, { minFontSize: value }, true)}
                  disabled={disabled}
                />
              </label>
              <label className="control-label">
                行数上限
                <NumberField
                  label="行数上限"
                  step={1}
                  precision={0}
                  min={1}
                  max={20}
                  value={selected.maxLines}
                  onChange={(value) => props.onChange(selected.id, { maxLines: value }, true)}
                  disabled={disabled}
                />
              </label>
              <label className="control-label">
                行距
                <NumberField
                  label="文字行距"
                  step={0.1}
                  precision={BOX_PRECISION.lineHeight}
                  min={1}
                  max={3}
                  value={selected.lineHeight}
                  onChange={(value) => props.onChange(selected.id, { lineHeight: value }, true)}
                  disabled={disabled}
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
