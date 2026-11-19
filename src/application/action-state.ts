export interface PosterActionStateInput {
  busy: string | null;
  sourceLoading: boolean;
  sourceError?: string;
  hasTemplate: boolean;
  usesRecordBackground: boolean;
  hasRecord: boolean;
  hasOutputField: boolean;
  recordCount: number;
}

/** 按钮状态与阻断原因只有一份，JSX 不重复拼业务条件。 */
export function resolvePosterActionState(input: PosterActionStateInput) {
  const ready = !input.busy && !input.sourceLoading && input.hasTemplate;
  const recordReady = input.hasRecord;
  const sourceError = input.usesRecordBackground ? input.sourceError : undefined;
  const canPreview = ready && recordReady && !sourceError;
  const canWriteCurrent = canPreview && input.hasOutputField;
  const blocker = !input.hasTemplate
    ? "模板尚未就绪"
    : input.sourceLoading
      ? "正在读取底图来源模板"
      : input.busy
        ? "另一项操作正在执行"
        : sourceError
          ? sourceError
          : !recordReady
            ? "请先选择一条主记录"
            : !input.hasOutputField
              ? "请选择要写入的附件字段"
              : "";
  const canSave = ready && !sourceError && (!input.usesRecordBackground || input.hasRecord);
  return {
    editorDisabled: !ready,
    canSave,
    saveBlockerText: canSave
      ? ""
      : !input.hasTemplate
        ? "模板尚未就绪"
        : input.sourceLoading
          ? "正在读取底图来源模板"
          : input.busy
            ? "另一项操作正在执行"
            : sourceError
              ? sourceError
              : "请先选择一条主记录",
    canPreview,
    canWriteCurrent,
    canWriteBatch: canWriteCurrent && input.recordCount > 0,
    writeBlockerText: blocker || (!input.recordCount ? "当前数据表没有记录" : ""),
  };
}
