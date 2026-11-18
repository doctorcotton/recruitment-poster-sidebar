# 原版契约与迁移记录（历史资料）

> 本文只记录早期 Python/Flask 来源和迁移依据，不是当前架构或当前验收报告。当前项目没有 Flask、HTTP 渲染 API、resvg、`backgroundImage.sourceFileUrl` 或无人值守任务；现行默认输出为 882×1783 PNG。当前架构与验收见 `docs/frontend-optimization.md`。下文中的“新服务”、基准文件路径及 1080×2069 均属于历史记录。

来源：`/Users/cottondog/Downloads/poster_web.zip`，隔离解包到 `.source-poster-web/poster_web/`，共十个文件。运行前已直接审阅 `renderer.py`、`app.py`、`requirements.txt`、`layout.json`。只运行离线 renderer 生成基准，没有启动原 Flask 服务；脚本和测试均放在隔离目录以外。

原版运行依赖为 Pillow 和 Flask。`app.py` 的新增记录接口要求 `location`、`contact`、`phone` 三项非空。离线 renderer 本身允许空值并跳过绘制；新接口遵循应用层的三项必填契约。

| 字段 | 坐标 x/y | 最大宽度 | 基准/最小字号 | 颜色 | 斜切 |
| --- | --- | --- | --- | --- | --- |
| location | 350 / 773 | 665 | 56 / 26 | #141414 | 0.18 |
| contact | 760 / 1600 | 290 | 32 / 20 | #FFFFFF | 0 |
| phone | 805 / 1665 | 255 | 32 / 18 | #FFFFFF | 0 |

画布为 1080×2069。三项均采用原配置的 `lm` 标记，但 renderer 实际先按字体 ascent/descent 计算整组高度，再用 `la` 绘制；迁移按这段真实代码保留基线。描边来自 `max(1, round(size * 0.02))`，原配置中的 `bold_stroke` 没有参与计算。

单行字号通过二分查找确定；小于基准的 75% 时才尝试双行，双行字号须比单行大 25% 才采用。最多两行，行高为 `int((ascent + descent) * 1.15)`；穷举断点时以最大行宽加多行惩罚择优。TypeScript 保留这一规则，并按 Unicode 字符切分，避免拆开代理对。

原包没有二维码生成代码。底图上的静态内容不单独识别或重画。原 renderer 支持额外 CLI scale 参数，但原应用没有暴露；新业务输出固定尺寸。

原 README 声称溢出后添加省略号，实际 renderer 没有实现。新服务在最小字号和双行仍放不下时返回 `TEXT_TOO_LONG`，不产出溢出图。输入中的显式换行最多支持两行。

原 `base.jpg` 只保留在测试样例中。新服务必须收到 `backgroundImage.sourceFileUrl`，以本次校验的真实文件字节渲染，并按字节内容复用背景对象。新底图与画布比例不同时居中等比裁切，不改变文本坐标。

基准图为 `artifacts/golden-normal.png`、`artifacts/golden-long.png`。新图由本地 HTTP 链路生成到 `artifacts/current-normal.png`、`artifacts/current-long.png`。普通样例的文字变化区域边界与原版各相差约 0–2 像素，属于自动数值对比记录，不构成视觉验收。唯一指定的 `documents:visual-judge` 当前不可用，状态保持 `NOT_RUN`。
