import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex } from "@noble/hashes/utils";
import { PosterError, type PosterAsset } from "../domain/types";
import { MAX_ASSET_BYTES } from "../domain/limits";

export { MAX_ASSET_BYTES } from "../domain/limits";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

function hashBytes(bytes: ArrayBuffer): string {
  return bytesToHex(blake2b(new Uint8Array(bytes), { dkLen: 32 }));
}

async function hashInWorker(blob: Blob): Promise<string> {
  const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const bytes = await blob.arrayBuffer();
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("哈希 Worker 超时")), 20_000);
      worker.onmessage = (event) => {
        const data = event.data as { hash?: string; error?: string };
        if (data.hash) resolve(data.hash);
        else reject(new Error(data.error || "哈希 Worker 失败"));
      };
      worker.onerror = (event) => reject(new Error(event.message || "哈希 Worker 启动失败"));
      worker.postMessage(bytes, [bytes]);
    });
  } finally {
    clearTimeout(timer!);
    worker.terminate();
  }
}

/** 以内容生成稳定标识；相同字节改名后仍能复用远端附件。 */
export async function hashBlob(blob: Blob): Promise<string> {
  if (typeof Worker === "function") {
    try {
      return await hashInWorker(blob);
    } catch (error) {
      console.warn({
        event: "poster.hash.worker_fallback",
        message: error instanceof Error ? error.message : "Worker 不可用",
      });
    }
  }
  return hashBytes(await blob.arrayBuffer());
}

export async function createPosterAsset(file: File): Promise<PosterAsset> {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeType = MIME_TYPES[extension];
  if (!mimeType || file.size === 0 || file.size > MAX_ASSET_BYTES) {
    throw new PosterError(
      "INVALID_ASSET",
      "请选择不超过 20 MB 的 PNG、JPEG、WebP、AVIF 位图或 OTF、TTF、WOFF 字体。",
    );
  }
  // 扩展名只做入口检查，实际图片、字体能否解码由渲染层验证。
  return {
    id: `asset-${await hashBlob(file)}`,
    name: file.name,
    mimeType,
    blob: file.slice(0, file.size, mimeType),
  };
}

export function validatePng(file: File): void {
  if (file.type !== "image/png" || !file.size)
    throw new PosterError("INVALID_ASSET", "写回文件必须是非空 PNG。");
}
