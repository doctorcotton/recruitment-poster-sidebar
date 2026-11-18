# 现有项目复用调研

本轮只读参考本机项目，参考仓库均未修改。取舍以当前纯前端招聘海报为边界；Mock SDK 和浏览器示例不等于参考项目或飞书生产验收。

| 来源 | 采用的经验 | 当前落点 |
| --- | --- | --- |
| TDS Studio SVG 编辑器 | 原稿坐标与视口分离、屏幕矩阵反算、缩放锚点与选区 | `src/ui/EditorStage.tsx`、`src/domain/geometry.ts` |
| BaseDocEditor 标准 PDF | 浏览器生成 Blob/File，SDK 直接写附件，声明式模板 | `src/data/feishu/*`、Canvas PNG |
| 三点检验 | 模块门面、同步操作锁、请求代际、有界缓存、静态预算与架构检查 | `application/operation-lock.ts`、`data/request-cache.ts`、`scripts/check-*` |
| PackVista | 纯动作状态、不可变任务快照、逐项结果、结构化 trace、分层测试 | `application/action-state.ts`、`application/batch-write.ts`、Playwright trace |

## 明确采用

- 单应用分层，不复制大型 monorepo、完整 QueryRuntime、RBAC、Hash Router 或服务端渲染队列。
- 同键请求合并、TTL、失败淘汰和代际失效之上，增加 LRU 与 Blob 字节预算。
- 读取可并行；模板、配置、建表、附件上传与单元格写入共享串行边界。PNG 写回不逐行失效来源模板缓存。
- 批量任务固化表、记录、字段、模板和素材快照，逐行返回结果，未知写入不自动重试。
- 素材按真实字节的 BLAKE2b 摘要复用，临时 URL 每次重新获取；不执行 `new Function` 或模板脚本。
- 保存后回读，权限/平台错误保留错误码，飞书失败不静默回退本地示例。

## 明确未照搬

- 不复制参考项目超大的 App、双写设计 token、旧配置回退和不确定写入自动重试。
- 不把 PackVista 的 base64 输出、3D 任务、OAuth、PostgreSQL 或 Vercel 服务引入当前项目。
- 不用 sessionStorage 再建一份模板真相；当前持久化仍以多维表和 IndexedDB 为准。
- 不把 SVG 覆盖层误称为 SVG 海报渲染器；当前正式输出由 Canvas 生成 PNG。

## 代码依据

读取时参考版本：TDS Studio `79bea761`、三点检验 `89b4441`、PackVista `d82ae69`。参考工作树存在各自未提交变更，本轮只读。

- TDS Studio：`apps/svg-text-editor/src/lib/canvas-viewport.ts`、`src/app/use-editor-viewport.ts`。
- BaseDocEditor：`src/components/TemplatePage/TemplatePage.tsx`、`src/hooks/useTemplateStorage.ts`。
- 三点检验：`packages/query-runtime/src/index.ts`、`src/modules/project-material/api-implementation.ts`、`scripts/check-frontend-budget.mjs`、`scripts/check-architecture.mjs`。
- PackVista：`apps/sidebar-plugin/src/render-flow.ts`、`render-trace.ts`、`fixed-view-batch-polling.ts`、`apps/field-shortcut/src/field-shortcut-result.ts`。

## 当前验证边界

单元测试验证缓存代际、素材复用、共享写入队列、附件快照、修订冲突和目标表隔离；浏览器测试验证 Canvas、FontFace、PNG、编辑、模板包、批量和 WebKit 持久化。真实平台权限、附件 CORS、字体解码、CSP iframe 与实际写回仍需在多维表宿主确认。
