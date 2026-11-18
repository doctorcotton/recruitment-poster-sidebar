/** 同步互斥：在 React 重新渲染前阻止同一事件循环中的重复操作。 */
export class OperationLock {
  private held = false;

  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = false;
    };
  }
}
