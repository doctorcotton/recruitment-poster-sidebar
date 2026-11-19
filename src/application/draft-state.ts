export interface UnsavedChangeInput {
  /** 当前版式快照。 */
  templateStamp: string;
  /** 当前来源的基线快照：已保存内容，或进入该来源时的草稿快照。 */
  baselineStamp: string;
  outputFieldId: string;
  savedOutputFieldId: string;
}

/**
 * 只有相对基线真的改过才算未保存。
 * 切换记录、切换数据表这类浏览动作会重设基线，因此本身不会触发未保存校验。
 */
export function hasUnsavedChanges(input: UnsavedChangeInput): boolean {
  if (!input.templateStamp) return false;
  return (
    input.templateStamp !== input.baselineStamp || input.outputFieldId !== input.savedOutputFieldId
  );
}
