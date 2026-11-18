import { useEffect, useRef, useState } from "react";
import type {
  PosterAsset,
  PosterRepository,
  TemplateBundle,
  TemplateSource,
  WorkspaceContext,
} from "../../domain/types";

interface Options {
  repository: PosterRepository;
  context: WorkspaceContext | null;
  recordId: string | null;
  backgroundFieldId: string | null | undefined;
  backgroundKey: string;
  prepareBundle(bundle: TemplateBundle): Promise<TemplateBundle>;
  onRestore(bundle: TemplateBundle, backgroundFieldId: string): void;
  onNewSource(): void;
}

/** 逐行底图和来源模板共享一个请求代际，旧记录不得覆盖新记录草稿。 */
export function useRecordBackground(options: Options) {
  const { repository, context, recordId, backgroundFieldId, backgroundKey } = options;
  const fields = context?.fields;
  const tableId = context?.tableId;
  const [rowBackground, setRowBackground] = useState<{
    key: string;
    asset?: PosterAsset;
    error?: string;
  } | null>(null);
  const [templateSource, setTemplateSource] = useState<TemplateSource | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceRequestSeq = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;

  useEffect(() => {
    const fieldId = backgroundFieldId;
    const requestSeq = ++sourceRequestSeq.current;
    if (!fieldId || !recordId || !fields || !tableId) {
      setSourceLoading(false);
      setRowBackground(null);
      setTemplateSource(null);
      setSourceKey("");
      setSourceError("");
      return;
    }
    let disposed = false;
    const current = () => !disposed && sourceRequestSeq.current === requestSeq;
    setSourceLoading(true);
    setRowBackground(null);
    setTemplateSource(null);
    setSourceKey("");
    setSourceError("");
    const field = fields.find((item) => item.id === fieldId);
    const pending = (async () => {
      if (!field || !["attachment", "lookup"].includes(field.kind))
        throw new Error("底图字段已失效，请重新绑定");
      const asset = await repository.loadBackground(recordId, fieldId, tableId);
      if (!current()) return;
      setRowBackground({ key: backgroundKey, asset });
      const source = await repository.getTemplateSource(recordId, fieldId, tableId);
      if (!current()) return;
      const saved = await repository.loadSourceTemplate(source);
      if (!current()) return;
      setTemplateSource(source);
      if (saved) {
        const loaded = await callbacks.current.prepareBundle(saved);
        if (!current()) return;
        callbacks.current.onRestore(loaded, fieldId);
      } else callbacks.current.onNewSource();
      setSourceKey(backgroundKey);
    })();
    void pending
      .catch((error) => {
        if (current()) {
          setSourceError(error instanceof Error ? error.message : "底图来源读取失败");
          setRowBackground((currentRow) =>
            currentRow?.key === backgroundKey && currentRow.asset
              ? currentRow
              : {
                  key: backgroundKey,
                  error: error instanceof Error ? error.message : "底图读取失败",
                },
          );
        }
      })
      .finally(() => {
        if (current()) setSourceLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [repository, tableId, fields, recordId, backgroundFieldId, backgroundKey]);

  return { rowBackground, templateSource, sourceKey, sourceError, sourceLoading };
}
