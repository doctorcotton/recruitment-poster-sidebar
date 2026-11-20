import { PosterError, type PosterAsset } from "../domain/types";
import { hashBlob, MAX_ASSET_BYTES } from "./assets";
import { platformError } from "./errors";

/** 下载截止时间覆盖响应头和响应体，避免占住 SDK 串行队列。 */
export const BACKGROUND_TIMEOUT_MS = 20_000;

export async function downloadAttachment(
  url: string,
  fetcher: typeof fetch = fetch,
  action = "下载附件",
): Promise<Blob> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(platformError({ code: "TIMEOUT", message: "附件下载超过 20 秒，请重试。" }, action));
    }, BACKGROUND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok)
          throw platformError({ status: response.status, message: response.statusText }, action);
        if (Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) {
          throw new PosterError("INVALID_ASSET", "附件不能超过 20 MB。");
        }
        if (!response.body) throw new PosterError("INVALID_ASSET", "附件内容为空。");
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let size = 0;
        try {
          // 对实际传输字节计数，不信任附件元数据或响应头给出的大小。
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_ASSET_BYTES)
              throw new PosterError("INVALID_ASSET", "附件不能超过 20 MB。");
            chunks.push(new Uint8Array(value));
          }
        } finally {
          reader.releaseLock();
        }
        if (!size) throw new PosterError("INVALID_ASSET", "附件内容为空。");
        return new Blob(chunks);
      })(),
    ]);
  } catch (error) {
    controller.abort();
    throw platformError(error, action);
  } finally {
    clearTimeout(timer!);
  }
}

export async function downloadBackground(
  url: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<PosterAsset> {
  const raw = await downloadAttachment(url, fetcher);
  const head = new Uint8Array(await raw.slice(0, 12).arrayBuffer());
  const png =
    head.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => head[index] === byte);
  const jpeg = head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255;
  // WebP 容器：RIFF....WEBP，示例底图用它，比同画面 PNG 小一个数量级。
  const webp =
    head.length >= 12 &&
    [82, 73, 70, 70].every((byte, index) => head[index] === byte) &&
    [87, 69, 66, 80].every((byte, index) => head[index + 8] === byte);
  if (!png && !jpeg && !webp)
    throw new PosterError(
      "INVALID_ASSET",
      "底图附件必须是非空 PNG、JPEG 或 WebP 图片，文件内容与图片格式不符。",
    );
  const mimeType = png ? "image/png" : jpeg ? "image/jpeg" : "image/webp";
  const blob = raw.slice(0, raw.size, mimeType);
  // 标识只由图片字节生成；返回值和缓存均不携带附件 token 或临时 URL。
  return { id: `asset-${await hashBlob(blob)}`, name, mimeType, blob };
}
