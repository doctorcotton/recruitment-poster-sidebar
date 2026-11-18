import { PosterError } from "./types";

interface Page<T> {
  records: T[];
  hasMore: boolean;
  pageToken?: number;
}

export function requireScanActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PosterError("CANCELLED", "已停止扫描");
}

/** 串行翻页，只有消费完当前页后才发起下一次请求。 */
export async function* recordPages<T>(
  read: (token?: number) => Promise<Page<T>>,
  signal?: AbortSignal,
): AsyncGenerator<Page<T>> {
  let token: number | undefined;
  const seen = new Set<number>([0]);
  for (let count = 0; count < 100; count++) {
    requireScanActive(signal);
    const page = await read(token);
    requireScanActive(signal);
    if (page.hasMore) {
      const next = page.pageToken;
      if (next === undefined || !Number.isSafeInteger(next) || next < 0 || seen.has(next))
        throw new PosterError("PLATFORM_ERROR", "飞书返回无效的分页标记。");
      seen.add(next);
      token = next;
    }
    yield page;
    if (!page.hasMore) return;
  }
  throw new PosterError("PLATFORM_ERROR", "当前数据超过 100 页，请缩小处理范围后重试。");
}
