import { isBindableField } from "../domain/field-binding";
import type {
  PosterTemplate,
  TableField,
  TemplateBundle,
  TextBox,
  WorkspaceContext,
} from "../domain/types";

/** 模板表引用：批量预检与绑定修复共用同一份表维度。 */
export interface TemplateTableRef {
  tableId: string;
  fields: TableField[];
}

export interface BindingRepair {
  boxId: string;
  label: string;
  /** rebound：按唯一同名字段回绑；unbound：没有同名字段，退回固定文字。 */
  action: "rebound" | "unbound";
  fieldName?: string;
}

/**
 * 绑定三态：ok 可直接出图；stale 绑定的字段已不存在；unknown 是字段池没读到、无法判定。
 * 判定只有这一处，批量预检与自动修复共用，避免出现“预检说失效、渲染却能取值”的分叉。
 */
export type BindingState = "ok" | "stale" | "unknown";

function compact(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

export function bindingState(
  box: TextBox,
  context: WorkspaceContext,
  templateTable: TemplateTableRef | null,
): BindingState {
  if (!box.fieldId) return "ok";
  if (!box.fieldTableId)
    return context.fields.some((field) => field.id === box.fieldId) ? "ok" : "stale";
  // 模板表字段池没读到时报未知，不能因此要求用户重绑。
  if (!templateTable || !templateTable.fields.length) return "unknown";
  const usable =
    box.fieldTableId === templateTable.tableId &&
    templateTable.fields.some((field) => field.id === box.fieldId);
  return usable ? "ok" : "stale";
}

/**
 * 修复失效绑定：先按图层名称回绑到唯一同名字段，找不到同名字段就退回固定文字。
 * 渲染在取不到键时本来就在用 box.text 快照，退回固定文字不改变出图结果，只解除预检阻断。
 */
export function repairStaleBindings(
  template: PosterTemplate,
  context: WorkspaceContext,
  templateTable: TemplateTableRef | null,
): { template: PosterTemplate; repairs: BindingRepair[] } {
  const repairs: BindingRepair[] = [];
  const candidates = [
    ...(templateTable?.fields ?? [])
      .filter(isBindableField)
      .map((field) => ({ tableId: templateTable!.tableId, field })),
    ...context.fields
      .filter(isBindableField)
      .map((field) => ({ tableId: null as string | null, field })),
  ];
  const boxes = template.boxes.map((box) => {
    if (bindingState(box, context, templateTable) !== "stale") return box;
    const target = compact(box.label);
    const matches = candidates.filter((item) => compact(item.field.name) === target);
    // 只有唯一同名才自动回绑：多个同名字段时交回用户判断，避免绑错列。
    if (matches.length === 1) {
      const [{ tableId, field }] = matches;
      repairs.push({ boxId: box.id, label: box.label, action: "rebound", fieldName: field.name });
      return { ...box, fieldId: field.id, fieldTableId: tableId };
    }
    repairs.push({ boxId: box.id, label: box.label, action: "unbound" });
    return { ...box, fieldId: null, fieldTableId: null };
  });
  return repairs.length ? { template: { ...template, boxes }, repairs } : { template, repairs };
}

/** 修复结果只用于本轮出图，不改用户已保存的模板。 */
export function repairBundle(
  bundle: TemplateBundle,
  context: WorkspaceContext,
  templateTable: TemplateTableRef | null,
): { bundle: TemplateBundle; repairs: BindingRepair[] } {
  const { template, repairs } = repairStaleBindings(bundle.template, context, templateTable);
  return repairs.length ? { bundle: { ...bundle, template }, repairs } : { bundle, repairs };
}

/** 给用户看的修复说明：回绑与退回固定文字分开说。 */
export function describeRepairs(repairs: BindingRepair[]): string {
  const rebound = repairs.filter((item) => item.action === "rebound");
  const unbound = repairs.filter((item) => item.action === "unbound");
  return [
    rebound.length ? `${rebound.map((item) => item.label).join("、")} 回绑` : "",
    unbound.length ? `${unbound.map((item) => item.label).join("、")} 转固定文字` : "",
  ]
    .filter(Boolean)
    .join("，");
}
