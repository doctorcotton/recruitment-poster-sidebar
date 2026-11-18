import { useEffect, useState } from "react";
import type { OutputFile, PosterRepository } from "../../domain/types";

/** 附件列表独立于工作区初始化；只有当前记录的结果可以展示。 */
export function useOutputFiles(
  repository: PosterRepository,
  tableId: string | undefined,
  recordId: string | null,
  fieldId: string,
  revision: number,
) {
  const local = repository.mode === "local";
  const targetRecord = local ? null : recordId;
  const targetField = local ? "" : fieldId;
  const [result, setResult] = useState<{ key: string; files: OutputFile[]; error?: string }>();
  const key = JSON.stringify([tableId, targetRecord, targetField, revision]);
  useEffect(() => {
    if (!tableId) return;
    let active = true;
    async function list(): Promise<OutputFile[]> {
      if (local) {
        const outputs = await repository.listOutputs?.();
        return (outputs ?? []).map((file) => ({
          id: JSON.stringify([file.recordId, file.fieldId]),
          name: file.name,
          loadBlob: async () => file.blob,
        }));
      }
      return targetRecord && targetField && repository.listOutputFiles
        ? repository.listOutputFiles(targetRecord, targetField, tableId!)
        : [];
    }
    void list().then(
      (files) => {
        if (active) setResult({ key, files });
      },
      (error) => {
        if (active)
          setResult({
            key,
            files: [],
            error: error instanceof Error ? error.message : "读取附件列表失败",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [repository, tableId, local, targetRecord, targetField, key]);
  return result?.key === key ? result : undefined;
}
