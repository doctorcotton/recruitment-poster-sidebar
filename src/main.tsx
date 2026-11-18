import React from "react";
import ReactDOM from "react-dom/client";
import "@douyinfe/semi-ui/lib/es/_base/base.css";
import App from "./App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { installFrameResizeObserver } from "./app/frame-resize-observer";
import "./styles.css";

installFrameResizeObserver();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
