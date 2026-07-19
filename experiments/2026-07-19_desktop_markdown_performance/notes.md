# Notes: desktop_markdown_performance

## 已有基线证据

- 生产安装包 v0.1.110 与当前分支的 Markdown 相关文件无差异，因此下面的代码短板适用于
  本机高占用版本；观测期间没有停止或重启生产 daemon。
- 已接受的 recent-window 优化在 8 个 tab、176 条 history 下，将正文一致 p50/p95 从
  151/280ms 降到 92/175ms，inactive DOM 从 4,404 降到 886，post-GC heap 从
  220.7MB 降到 156.8MB。挂载量与布局已被证实是第一层根因。
- 现有 1MiB 纯文本流式基线中，reducer p50/p95 仅 9.8/12.0ms，但 Long Task 总时长
  p50/p95 达 1,265/1,741ms，反馈延迟为 80/89ms。下一阶段应测 renderer，不应继续只看
  reducer microbenchmark。
- 真实队列中 chunks-per-flush 中位数为 1-2、p95 为 3；这限制了连续 chunk reducer 合并
  对端到端体验的上限。

## 定向诊断（不是正式候选 benchmark）

| 诊断                                           |                         结果 | 含义                         |
| ---------------------------------------------- | ---------------------------: | ---------------------------- |
| 1MiB 纯文本、47 次前缀的 `splitMarkdownBlocks` |                  累计 0.42ms | 不是当前优先项               |
| 同一负载的 MarkdownIt parse                    |                   累计 131ms | 有成本，但小于布局           |
| 同一负载的 block height 全量 hash              |                    累计 25ms | 可优化，非主导               |
| raw Chromium 单个不换行文本块并强制布局        |                 累计 1,178ms | 超大单块布局是明确短板       |
| raw Chromium 可换行文本块并强制布局            |                   累计 863ms | 即便可换行，布局仍占主导     |
| 约 2,089 个稳定段落、只追加末块                |                    累计 75ms | block memo 对稳定块有效      |
| 100KiB TypeScript 单次高亮                     |          25ms、37,843 tokens | 后续 RN Web 节点构建风险很高 |
| 100KiB TypeScript 20 次增长前缀高亮            |                   累计 264ms | 未闭合 fence 重复做全量工作  |
| 50 个增长前缀的高亮缓存                        | 12MiB、188,515 token objects | entry-count LRU 没有内存上界 |
| 1,000 个 MarkdownIt 实例                       |    170ms、约 221MiB retained | 每消息一个实例存在乘法浪费   |

这些数字用于选择消融变量，不作为产品验收数字。正式结论必须来自冻结的
`desktop_markdown_rendering@v1` Electron/Chromium benchmark。

## 当前代码短板

1. 每条挂载的 assistant message 创建一个配置相同的 MarkdownIt 实例。
2. 流式未闭合 fence 会在每个变化前缀上重新高亮完整代码，并产生新的内容缓存 key。
3. 高亮缓存只限制 200 个 entry，不按 bytes、token 数或完成状态设上限。
4. 100KiB code 可产生四万量级的 TokenSpan/换行组件；消息内部没有节点上限或虚拟化。
5. 稳定 block 的正文被 memo，但外层 block container、keyed projection 和每 block 样式边界
   仍可能在每次更新参与 React/RN Web 工作。
6. Markdown/file link 路径会创建额外 query observer、tooltip、Pressable 和 JS hover 树，
   link-dense history 需要独立 workload 才能定量。
7. 隐藏 retained tab 虽冻结 stream 数组，外层 shell 仍可能随 stream head identity 更新；
   这是多会话 CPU 问题，不应误判为 Markdown parse 本身。

## 决策规则

- 每次只改一个主要变量，保存 before/after/rollback run。
- 纯文本 ablation 若不能让目标 workload 的 p95 改善至少 20%，Markdown 路径不算主要瓶颈。
- Streamdown 只有在 web-only 完整候选相对当前 renderer 的 p95 改善至少 15%、Long Task
  明显下降、heap 增幅不超过 10% 时才进入迁移讨论。
- React profiler duration 是嵌套 profiler 的求和，可能重复计时；决策以反馈延迟、Long Task、
  frame gap、DOM/AX、post-GC heap 和端到端完成时间为主。
