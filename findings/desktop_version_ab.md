# Desktop version A/B（2026-07-20）

## 结论

在同一台 Mac、同一 Electron dev 配置、同一 17677 fixture daemon 和同一 24 次切换
trace 下，`perf/desktop-markdown-p0@4f8e19403` 相比
`origin/main@3d86c738f`：

- H176 8-Agent tab 切换正文一致 p50/p95 改善 37.1% / 36.2%。
- 1 MiB 未闭合 TypeScript Markdown 冷开改善 90.0%（约 10 倍）。
- Markdown 最大单次 Long Task 从 2384ms 降到 110ms，改善 95.4%。
- GC 后 DOM 节点减少 43.0%，inactive timeline DOM 节点减少 59.8%。
- renderer physical footprint 减少 28.0%，峰值减少 37.7%。
- workload 内 renderer CPU time 减少 47.5%。

## 最终严格场景

| 指标                        | 最新 main |   优化版 |     改善 |
| --------------------------- | --------: | -------: | -------: |
| 切换正文一致 p50            |   130.1ms |   81.8ms |    37.1% |
| 切换正文一致 p95            |   226.0ms |  144.3ms |    36.2% |
| 切换 Long Task p95          |     203ms |    119ms |    41.4% |
| 最大 frame gap p95          |   226.0ms |  144.3ms |    36.2% |
| React commit 数 p50 / p95   |     9 / 9 |    8 / 9 | p95 持平 |
| React duration p50          |   496.6ms |  297.8ms |    40.0% |
| React duration p95          |  1036.9ms |  642.7ms |    38.0% |
| 单次切换 heap 增量 p50      |    23.2MB |   12.7MB |    45.3% |
| 单次切换 heap 增量 p95      |    29.3MB |   23.9MB |    18.4% |
| 1 MiB Markdown 冷开         |  2858.7ms |  286.5ms |    90.0% |
| Markdown Long Task 总时长   |    2635ms |    254ms |    90.4% |
| Markdown 最大 Long Task     |    2384ms |    110ms |    95.4% |
| Markdown 打开后 heap        |   243.6MB |  205.1MB |    15.8% |
| GC 后 DOM 节点              |      4609 |     2628 |    43.0% |
| active timeline DOM 节点    |      1316 |      656 |    50.2% |
| inactive timeline DOM 节点  |      2206 |      886 |    59.8% |
| AX 节点                     |      2110 |     1464 |    30.6% |
| GC 后 JS heap               |   206.7MB |  172.1MB |    16.7% |
| renderer RSS 峰值           |  1172.7MB | 1008.4MB |    14.0% |
| renderer physical footprint |   636.9MB |  458.3MB |    28.0% |
| physical footprint 峰值     |  1433.6MB |  893.0MB |    37.7% |
| renderer CPU time           |    9.346s |   4.905s |    47.5% |

两组的 title/body mismatch p50/p95 都是 0ms；每次切换的标题、选中态和正文在同一
animation frame 达到一致。掉帧计数 p50/p95 都是 1，没有改善；但对应最大 frame gap
p95 从 226.0ms 降至 144.3ms。

## 方法

1. H176 workspace 的 8 个 Agent 各有 176 条 projected timeline item。
2. 逐个加载到 turn 1，再回到底部 turn 88；随后循环 3 轮，共 24 次真实 tab 点击。
3. 点击前同步挂载 Long Task、rAF、React Profiler 和 title/body 一致性探针。
4. 数字 pass 结束后再录 GIF，截图/压缩不进入延迟与 CPU 指标。
5. Markdown 使用从未访问过的 Light workspace 专用 Agent，从 Command Center 行点击开始
   计时，到 1 MiB prompt 和代码正文同时可见为止。
6. 两个版本使用同一 fixture daemon PID 84875；生产 6767 daemon PID 5275 全程未重启。

绝对数字来自 Electron dev build（日志明确显示 Performance optimizations: OFF），适合
同机 A/B，不应直接当作 packaged release 的绝对 SLA。

## Run 与视觉证据

- main：`20260720_015914__latest_main__2a0ee8`
- 优化版：`20260720_020120__optimized_p0__e229c4`
- main GIF：`runs/2026-07-20/20260720_015914__latest_main__2a0ee8/artifacts/latest_main-desktop-version-ab.gif`
- 优化版 GIF：`runs/2026-07-20/20260720_020120__optimized_p0__e229c4/artifacts/optimized_p0-desktop-version-ab.gif`

## 解释与剩余短板

- React commit p95 仍是 9，说明收益主要来自每次 commit 的工作量下降，而不是 commit
  数量消失。下一步仍可减少切换时的同步 store/layout 更新。
- 优化版切换 p95 144ms、Long Task p95 119ms，仍明显高于 60fps 预算；timeline layout 与
  RN Web 视图构建仍是下一层瓶颈。
- 1 MiB Markdown 最大 Long Task 已降到 110ms，但仍超过 50ms。下一步应继续切分首个可见
  code block 的同步工作，或把剩余 token tree 构建放到 idle/worker。
- renderer RSS p50 几乎持平（983.5MB 对 981.6MB），但 GC heap、physical footprint 和峰值
  明显下降；macOS Chromium 的 RSS 包含可回收/共享页，physical footprint 更能反映实际压力。
- sampled CPU p95 受多核瞬时调度影响，优化版反而更高（213.4% 对 180.3%）；完整 workload
  CPU time 从 9.346s 降到 4.905s，后者是更稳定的总成本指标。

## Eager inactive ablation

未关闭 H176 自带 Markdown tab 时，main 会先在后台构建完整隐藏内容，因此之后点击只需
200.5ms；对应 DOM 为 4638。优化版保留更小 inactive window（DOM 2659），之后激活原
H176 Markdown tab 需要 2605.4ms。这不是冷开 renderer 对比，而是“后台预付成本 vs 激活时
付成本”的产品策略差异。最终严格场景用独立、从未访问的 Markdown workspace 消除了该污染。
