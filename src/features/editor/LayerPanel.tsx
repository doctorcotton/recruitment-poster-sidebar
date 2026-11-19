import { Button, Select } from "../../ui/semi";
import { IconPlus } from "@douyinfe/semi-icons";
import type { TableField, TextBox } from "../../domain/types";
import type { LayerAlignment } from "../../domain/layer-operations";

interface Props {
  boxes: TextBox[];
  fields: TableField[];
  templateFields: TableField[];
  selectedId: string | null;
  selectedIds: Set<string>;
  overflowIds: string[];
  disabled: boolean;
  onAdd(): void;
  onSelect(id: string): void;
  onToggle(id: string): void;
  onToggleLock(id: string): void;
  onMove(id: string, direction: -1 | 1): void;
  onAlign(operation: LayerAlignment): void;
}

/** 图层副标题区分模板表文案、数据表变量和固定文字，失效字段不再显示成“固定文字”。 */
function layerFieldLabel(box: TextBox, fields: TableField[], templateFields: TableField[]): string {
  if (!box.fieldId) return "固定文字";
  const source = box.fieldTableId ? templateFields : fields;
  const field = source.find((item) => item.id === box.fieldId);
  if (!field) return "字段已失效";
  return box.fieldTableId ? `模板表 · ${field.name}` : field.name;
}

const ALIGNMENTS: { value: LayerAlignment; label: string }[] = [
  { value: "left", label: "左对齐" },
  { value: "centerX", label: "水平居中" },
  { value: "right", label: "右对齐" },
  { value: "top", label: "顶对齐" },
  { value: "centerY", label: "垂直居中" },
  { value: "bottom", label: "底对齐" },
  { value: "distributeX", label: "横向分布" },
  { value: "distributeY", label: "纵向分布" },
];

export function LayerPanel(props: Props) {
  return (
    <section className="panel-section layers-section">
      <div className="section-heading">
        <h2>文字图层</h2>
        <Button
          theme="borderless"
          icon={<IconPlus />}
          aria-label="添加文字框"
          onClick={props.onAdd}
          disabled={props.disabled}
        />
      </div>
      <div className="layer-tools">
        <span id="layer-align-label" className="sr-only">
          对齐所选图层
        </span>
        <Select
          aria-labelledby="layer-align-label"
          placeholder={`对齐所选（${props.selectedIds.size}）`}
          value={undefined}
          optionList={ALIGNMENTS.filter(
            (item) => !item.value.startsWith("distribute") || props.selectedIds.size >= 3,
          )}
          onChange={(value) => props.onAlign(String(value) as LayerAlignment)}
          disabled={props.disabled || props.selectedIds.size < 2}
        />
        <Button
          size="small"
          disabled={props.disabled || !props.selectedId}
          onClick={() => props.selectedId && props.onMove(props.selectedId, -1)}
        >
          上移
        </Button>
        <Button
          size="small"
          disabled={props.disabled || !props.selectedId}
          onClick={() => props.selectedId && props.onMove(props.selectedId, 1)}
        >
          下移
        </Button>
      </div>
      <div className="layer-list">
        {props.boxes.map((box, index) => (
          <div className="layer-item" key={box.id}>
            <input
              type="checkbox"
              aria-label={`选择图层 ${box.label}`}
              checked={props.selectedIds.has(box.id)}
              onChange={() => props.onToggle(box.id)}
              disabled={props.disabled}
            />
            <button
              className={`layer-row ${box.id === props.selectedId ? "selected" : ""}`}
              onClick={() => props.onSelect(box.id)}
              aria-pressed={box.id === props.selectedId}
            >
              <span className="layer-letter">T</span>
              <span className="layer-copy">
                <strong>{box.label}</strong>
                <small>{layerFieldLabel(box, props.fields, props.templateFields)}</small>
              </span>
              {box.locked ? (
                <span className="layer-number" title="已锁定">
                  锁
                </span>
              ) : props.overflowIds.includes(box.id) ? (
                <span className="overflow-indicator" title="内容放不下">
                  !
                </span>
              ) : (
                <span className="layer-number">{String(index + 1).padStart(2, "0")}</span>
              )}
            </button>
            <Button
              theme="borderless"
              size="small"
              aria-label={box.locked ? `解锁图层 ${box.label}` : `锁定图层 ${box.label}`}
              disabled={props.disabled}
              onClick={() => props.onToggleLock(box.id)}
            >
              {box.locked ? "解锁" : "锁定"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
