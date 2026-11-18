import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** 隔离渲染期异常，保留明确的重新加载入口。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error({
      event: "poster.boundary",
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="boot-screen" role="alert">
        <h1>编辑器暂时无法显示</h1>
        <p>{this.state.error.message || "页面渲染失败，请重新加载。"}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    );
  }
}
