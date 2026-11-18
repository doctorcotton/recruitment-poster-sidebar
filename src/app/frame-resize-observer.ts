let installed = false;

/** 将同步测量移到宏任务，合并同一元素的最新尺寸，同时保留其他元素的通知。 */
export function installFrameResizeObserver(): void {
  if (installed || typeof ResizeObserver === "undefined") return;
  installed = true;
  const NativeObserver = window.ResizeObserver;
  window.ResizeObserver = class {
    private readonly observer: ResizeObserver;
    private readonly pending = new Map<Element, ResizeObserverEntry>();
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(callback: ResizeObserverCallback) {
      this.observer = new NativeObserver((entries) => {
        for (const entry of entries) this.pending.set(entry.target, entry);
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          const latest = Array.from(this.pending.values());
          this.pending.clear();
          if (latest.length) callback(latest, this);
        }, 0);
      });
    }
    observe(target: Element, options?: ResizeObserverOptions): void {
      this.observer.observe(target, options);
    }
    unobserve(target: Element): void {
      this.pending.delete(target);
      this.observer.unobserve(target);
    }
    disconnect(): void {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pending.clear();
      this.observer.disconnect();
    }
  };
}
