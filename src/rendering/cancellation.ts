import { PosterError } from "../domain/types";

export function cancelled(): PosterError {
  return new PosterError("CANCELLED", "绘制已取消或已被新请求替代");
}

export function forwardAbort(
  controller: AbortController,
  sources: (AbortSignal | undefined)[],
): () => void {
  const abort = () => controller.abort();
  for (const source of sources) {
    if (source?.aborted) abort();
    else source?.addEventListener("abort", abort, { once: true });
  }
  return () => {
    for (const source of sources) source?.removeEventListener("abort", abort);
  };
}

/** 取消当前等待，仍处理共享资源的最终结果。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
