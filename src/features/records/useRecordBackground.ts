import { useEffect, useRef, useState } from "react";
import { withSourceBackground } from "../../application/source-background";
import type {
  PosterRepository,
  TemplateBundle,
  TemplateRecordValues,
  TemplateSource,
  WorkspaceContext,
} from "../../domain/types";

interface Options {
  repository: PosterRepository;
  context: WorkspaceContext | null;
  recordId: string | null;
  /** 数据表上指向模板表的查找引用字段。 */
  locatorFieldId: string | null | undefined;
  /** 模板表上存底图的附件字段。 */
  backgroundFieldId: string | null | undefined;
  backgroundKey: string;
  prepareBundle(bundle: TemplateBundle): Promise<TemplateBundle>;
  onRestore(bundle: TemplateBundle, source: TemplateSource): void;
  /** 未保存配置的模板行也要贴真实底图；bundle 为 null 表示沿用当前画布。 */
  onNewSource(bundle: TemplateBundle | null, warning: string): void;
  /** 当前画布草稿，作为未配置模板行替换底图的基底。 */
  draftBundle(): TemplateBundle | null;
}

/** 数据行经查找引用定位模板行；底图、配置和文案都跟着模板行走，共享一个请求代际。 */
export function useRecordBackground(options: Options) {
  const { repository, context, recordId, locatorFieldId, backgroundFieldId, backgroundKey } =
    options;
  const fields = context?.fields;
  const tableId = context?.tableId;
  const [templateSource, setTemplateSource] = useState<TemplateSource | null>(null);
  const [templateRecord, setTemplateRecord] = useState<TemplateRecordValues | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceRequestSeq = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;

  useEffect(() => {
    const requestSeq = ++sourceRequestSeq.current;
    if (!locatorFieldId || !backgroundFieldId || !recordId || !fields || !tableId) {
      setSourceLoading(false);
      setTemplateSource(null);
      setTemplateRecord(null);
      setSourceKey("");
      setSourceError("");
      return;
    }
    let disposed = false;
    const current = () => !disposed && sourceRequestSeq.current === requestSeq;
    setSourceLoading(true);
    setTemplateSource(null);
    setTemplateRecord(null);
    setSourceKey("");
    setSourceError("");
    const locator = fields.find((item) => item.id === locatorFieldId);
    const pending = (async () => {
      if (!locator || locator.kind !== "lookup" || !locator.refTableId)
        throw new Error("模板定位字段已失效，请重新选择查找引用字段");
      const source = await repository.getTemplateSource(
        recordId,
        locatorFieldId,
        tableId,
        backgroundFieldId,
      );
      if (!current()) return;
      setTemplateSource(source);
      const recordValues = await repository.loadTemplateRecord(source);
      if (!current()) return;
      setTemplateRecord(recordValues);
      const saved = await repository.loadSourceTemplate(source);
      if (!current()) return;
      if (saved) {
        const loaded = await callbacks.current.prepareBundle(saved);
        if (!current()) return;
        callbacks.current.onRestore(loaded, source);
      } else {
        // 没有已保存配置时版式沿用草稿，但底图必须换成模板行附件里的真实图。
        const draft = callbacks.current.draftBundle();
        if (!draft) {
          callbacks.current.onNewSource(null, "");
        } else {
          const result = await withSourceBackground(repository, draft, source);
          if (!current()) return;
          callbacks.current.onNewSource(result.bundle, result.warning);
        }
      }
      setSourceKey(backgroundKey);
    })();
    void pending
      .catch((error) => {
        if (current()) setSourceError(error instanceof Error ? error.message : "模板来源读取失败");
      })
      .finally(() => {
        if (current()) setSourceLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [repository, tableId, fields, recordId, locatorFieldId, backgroundFieldId, backgroundKey]);

  return { templateSource, templateRecord, sourceKey, sourceError, sourceLoading };
}
