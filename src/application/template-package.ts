import { PosterError, type TemplateBundle } from "../domain/types";
import type { PackageRequest, PackageResponse } from "./template-package.worker";

async function runPackageJob(request: PackageRequest): Promise<Blob | TemplateBundle> {
  if (typeof Worker !== "function") {
    const { processPackage } = await import("./template-package.worker");
    return processPackage(request);
  }

  const worker = new Worker(new URL("./template-package.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<Blob | TemplateBundle>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<PackageResponse>) => {
        if (data.ok) resolve(data.result);
        else reject(new PosterError(data.code, data.message));
      };
      worker.onerror = () =>
        reject(new PosterError("INVALID_TEMPLATE", "模板包 Worker 加载失败。"));
      worker.onmessageerror = () =>
        reject(new PosterError("INVALID_TEMPLATE", "无法读取模板包 Worker 的结果。"));
      // Blob 可结构化克隆，主线程无需先读出素材或归档字节。
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

export async function createTemplatePackage(bundle: TemplateBundle): Promise<Blob> {
  return (await runPackageJob({ kind: "create", bundle })) as Blob;
}

export async function parseTemplatePackage(file: Blob): Promise<TemplateBundle> {
  return (await runPackageJob({ kind: "parse", file })) as TemplateBundle;
}
