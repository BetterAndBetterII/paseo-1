# Desktop Markdown performance

Paseo Desktop 在长历史和大体积流式回复下，Markdown 路径中的哪一层主导反馈延迟、
Long Task 与内存增长；哪个单变量改动能在不改变最终渲染语义的前提下取得最大收益？

本实验不预设更换渲染库。先分别测量解析、高亮、React/RN Web 节点构建、浏览器布局、
提交频率和缓存保留，再决定是优化现有 renderer，还是进入 Streamdown 的 web-only 消融。
