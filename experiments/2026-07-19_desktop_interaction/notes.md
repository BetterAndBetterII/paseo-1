# Notes: desktop_interaction

- Production v0.1.110 observation (not touched by the harness): worst supplied Agent switch 4.49s;
  title changed while old body remained; renderer physical footprint 3.2-3.3GB (3.7GB peak).
- Current source retains up to three workspaces and three tabs per pane with `display:none` roots.
  Inactive Agent streams freeze their arrays, but retain the rendered timeline/Markdown DOM.
- Deterministic benchmark uses a temporary daemon and Metro port and blocks `:6767` in Chromium.
- Chromium-overlay heap/DOM/AX results are the repeatable CI-grade signal. A separate isolated
  real-Electron CDP run is required for RSS, physical footprint, swap/page-in, and GPU metrics.
- Early calibration runs only opened the newest projected timeline page. The authoritative runs
  below scroll to the oldest stored prompt, verify it is visible, return to the newest prompt, and
  report both pre-GC allocation pressure and post-GC live heap.

## Authoritative full-history runs

| Policy (threshold/recent) | Run ID                                                                     | 8x100 body p50/p95 | 8x176 body p50/p95 | 8x176 long task p50/p95 | 8x176 DOM / inactive DOM | 8x176 live heap |
| ------------------------- | -------------------------------------------------------------------------- | -----------------: | -----------------: | ----------------------: | -----------------------: | --------------: |
| 100 / 50                  | `20260719_181254__baseline_full_history_gc__b876c8`                        |       149 / 241 ms |       151 / 280 ms |            150 / 279 ms |            7,595 / 4,404 |        220.7 MB |
| 50 / 50                   | `20260719_181507__web_virtualization_threshold_50_full_history_gc__f9ea38` |       179 / 291 ms |       127 / 216 ms |            110 / 192 ms |            4,511 / 2,206 |        184.1 MB |
| 50 / 20                   | `20260719_181814__web_recent_window_20_full_history_gc__2d9347`            |        89 / 156 ms |        84 / 154 ms |              0 / 132 ms |              2,531 / 886 |        156.6 MB |

The threshold-only result establishes the DOM/live-heap reduction but is noisy in the 4-tab and
100-item timing cells. With threshold fixed at 50, reducing only the recent window to 20 improves
the heavy 8-tab timing cells and cuts inactive timeline DOM by another 60%. The 50-item cases do
not virtualize and therefore serve as the no-op control. Pre-GC heap varies with collection timing;
post-GC live heap, per-switch allocation deltas, DOM, and interaction latency are the decision
signals.
