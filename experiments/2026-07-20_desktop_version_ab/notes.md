# Notes

- GIF 是视觉证据，不参与数值统计；指标 pass 不截图。
- fixture 的 mock timeline 主要驻留 daemon 内存，A/B 期间不得重启 `17677`。
- `6767` 是生产 daemon，harness 和人工检查都必须确认其 PID 未变化。
- H176 history Agent 的确定性 prompt 为 `desktop-version-h176-a{1..8}-turn-{1..88}`。
- 官方仓库 remote 是 `origin=getpaseo/paseo`，用户 fork 是
  `fork=BetterAndBetterII/paseo-1`；本实验的 main 对照必须取 `origin/main`。
- 新 profile 会默认启动内置 daemon。A/B profile 都预置
  `manageBuiltInDaemon: false`，并在每次正式 run 前确认 6768 没有 Paseo listener。
- Command Center 打开 H176 后会自动挂载同 workspace 的 Markdown 和大 diff Agent。
  正式 workload 在第一次 history Agent 就绪后关闭这两个非 history tab，只保留 8 个
  H176 history Agent（另有一个固定 terminal tab）。
- 1 MiB Markdown 冷开使用从未访问的 `Perf Light 01` workspace 中专用 Agent
  `e7dbcbb7-187a-4128-abdc-d973a62b00b3`，避免 H176 inactive tab 预渲染污染。
- 最终 main run：`20260720_015914__latest_main__2a0ee8`，commit
  `3d86c738ff70a9815cdd86c5602c9a5c420df619`。
- 最终优化版 run：`20260720_020120__optimized_p0__e229c4`，commit
  `4f8e19403f67f7c517654b0319d4971feb55bab2`。
- eager-inactive ablation：main `20260720_014836__latest_main__2a0ee8`，优化版
  `20260720_014450__optimized_p0__e229c4`。这两组说明 main 会提前渲染隐藏 Markdown，
  因此之后的 tab 点击变快，但不作为冷开 Markdown 的最终结论。
