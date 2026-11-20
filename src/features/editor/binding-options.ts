import { bindingKey, isBindableField, parseBinding } from "../../domain/field-binding";
import type { TableField, TextBox } from "../../domain/types";

export interface BindingOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface BindingSource {
  /** 数据表字段。 */
  fields: TableField[];
  /** 模板表字段；为空表示没有启用模板表定位。 */
  templateFields: TableField[];
  templateTableId: string | null;
}

const FIXED_VALUE = "__fixed__";

/** 可绑定的文字字段：附件和未知类型不能作为文字内容。 */
export function textFieldsOf(fields: TableField[]) {
  return fields.filter(isBindableField);
}

/** 图层当前的绑定键；未绑字段时是固定文字的占位值。 */
export function bindingValueOf(box: TextBox): string {
  return box.fieldId ? bindingKey(box.fieldTableId, box.fieldId) : FIXED_VALUE;
}

/** 解析图层绑定的字段，字段已被删除时返回 null。 */
export function boundFieldOf(box: TextBox, source: BindingSource): TableField | null {
  if (!box.fieldId) return null;
  const pool = box.fieldTableId ? source.templateFields : source.fields;
  return pool.find((field) => field.id === box.fieldId) ?? null;
}

/** 绑定键对应的字段；用于判断下拉里的值是否还有效。 */
export function fieldOfBinding(value: string, source: BindingSource): TableField | null {
  const { fieldTableId, fieldId } = parseBinding(value);
  const pool = fieldTableId ? source.templateFields : source.fields;
  return pool.find((field) => field.id === fieldId) ?? null;
}

/**
 * 绑定下拉的选项：固定文字、失效的旧绑定占位、模板表字段和数据表字段。
 * 两个入口（映射页、属性面板）共用一份，避免选项顺序和分组漂移。
 */
export function bindingOptionsOf(source: BindingSource, current: string): BindingOption[] {
  const templateTextFields = textFieldsOf(source.templateFields);
  const textFields = textFieldsOf(source.fields);
  return [
    { label: "固定文字", value: FIXED_VALUE },
    ...(fieldOfBinding(current, source)
      ? []
      : [{ label: "已失效字段，请重新绑定", value: current }]),
    ...(templateTextFields.length
      ? [
          {
            label: `模板表（${templateTextFields.length} 个字段）`,
            value: "__template_group__",
            disabled: true,
          },
          ...templateTextFields.map((field) => ({
            label: field.name,
            value: bindingKey(source.templateTableId, field.id),
          })),
        ]
      : []),
    { label: `数据表（${textFields.length} 个字段）`, value: "__data_group__", disabled: true },
    ...textFields.map((field) => ({ label: field.name, value: field.id })),
  ];
}

/** 下拉变更要写回的两列；分组标题不是可选项，返回 null 表示不写入。 */
export function bindingPatchOf(
  value: string,
): { fieldTableId: string | null; fieldId: string | null } | null {
  if (value.endsWith("_group__")) return null;
  if (value === FIXED_VALUE) return { fieldTableId: null, fieldId: null };
  return parseBinding(value);
}
