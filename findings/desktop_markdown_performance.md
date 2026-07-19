# Finding: desktop_markdown_performance

Benchmark: `desktop_markdown_rendering@v2`

Scorer: `desktop_markdown_metrics_v2`

## Current decisions

- `BENCH-MD-01`: v2 released. Representative payloads and final-render hashes are frozen.
- `MD-TAIL-01` first candidate: rejected. It cut one MiB Long Task p95 by 52%, but did not meet
  the end-to-end/feedback/frame-gap promotion gate.
- Next ablation: `MD-CODE-01`, because 64KiB open TypeScript code already creates 29k DOM and 58k
  non-ignored AX nodes while Markdown parsing itself is only about 1.5ms p95.

Only v2 runs may promote subsequent candidates. v1 runs remain calibration evidence because their
single early feedback sample missed later main-thread stalls.
