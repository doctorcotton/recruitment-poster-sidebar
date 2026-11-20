/**
 * 图层绑定键：业务表字段沿用裸字段 ID，模板表字段带上表维度。
 * 这样同一个模板既能绑数据行变量，也能绑模板行文案，而渲染值仍是一张扁平表。
 */
export function bindingKey(fieldTableId: string | null | undefined, fieldId: string): string {
  return fieldTableId ? `${fieldTableId}::${fieldId}` : fieldId;
}

/** 可绑定为文字内容的字段类型：附件和未知类型不参与文字绑定。 */
export function isBindableField(field: { kind: string }): boolean {
  return field.kind !== "attachment" && field.kind !== "other";
}

/** 把模板行字段值整体加上表维度，供渲染值和 UI 预览共用。 */
export function scopeValues(
  fieldTableId: string,
  values: Record<string, string>,
): Record<string, string> {
  const scoped: Record<string, string> = {};
  for (const [fieldId, value] of Object.entries(values))
    scoped[bindingKey(fieldTableId, fieldId)] = value;
  return scoped;
}

/** 还原绑定键，供绑定下拉框回显。 */
export function parseBinding(binding: string): { fieldTableId: string | null; fieldId: string } {
  const index = binding.indexOf("::");
  return index < 0
    ? { fieldTableId: null, fieldId: binding }
    : { fieldTableId: binding.slice(0, index), fieldId: binding.slice(index + 2) };
}
