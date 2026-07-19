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

| Policy (threshold/recent)  | Run ID                                                                     | 8x100 body p50/p95 | 8x176 body p50/p95 | 8x176 long task p50/p95 | 8x176 DOM / inactive DOM | 8x176 live heap |
| -------------------------- | -------------------------------------------------------------------------- | -----------------: | -----------------: | ----------------------: | -----------------------: | --------------: |
| 100 / 50                   | `20260719_181254__baseline_full_history_gc__b876c8`                        |       149 / 241 ms |       151 / 280 ms |            150 / 279 ms |            7,595 / 4,404 |        220.7 MB |
| 50 / 50                    | `20260719_181507__web_virtualization_threshold_50_full_history_gc__f9ea38` |       179 / 291 ms |       127 / 216 ms |            110 / 192 ms |            4,511 / 2,206 |        184.1 MB |
| 50 / 20                    | `20260719_181814__web_recent_window_20_full_history_gc__2d9347`            |        89 / 156 ms |        84 / 154 ms |              0 / 132 ms |              2,531 / 886 |        156.6 MB |
| 50 / 20 (product defaults) | `20260719_182525__product_defaults_after__ff5af2`                          |        97 / 174 ms |        92 / 175 ms |              0 / 152 ms |              2,531 / 886 |        156.8 MB |

The threshold-only result establishes the DOM/live-heap reduction but is noisy in the 4-tab and
100-item timing cells. With threshold fixed at 50, reducing only the recent window to 20 improves
the heavy 8-tab timing cells and cuts inactive timeline DOM by another 60%. The 50-item cases do
not virtualize and therefore serve as the no-op control. Pre-GC heap varies with collection timing;
post-GC live heap, per-switch allocation deltas, DOM, and interaction latency are the decision
signals.

Relative to the authoritative 100/50 baseline, the committed product defaults reduce the 8x176
body-consistency p50/p95 from 151/280ms to 92/175ms, DOM from 7,595 to 2,531 nodes, inactive DOM
from 4,404 to 886 nodes, and post-GC live heap from 220.7MB to 156.8MB. React commit count remains
8/9 p50/p95, while summed nested-profiler duration falls from 601/1,307ms to 349/789ms. The 50-item
control does not virtualize: DOM and live heap remain flat; its isolated timing sample is noisy and
regressed from 90/163ms to 124/213ms, so the change is justified by the 100/176-item cases rather
than that control cell.

## Live stream workload calibration

The `desktop-streaming` task sends exact 512-byte provider chunks every 1ms through the temporary
daemon and the visible web/Electron rendering path. Five fresh agents are measured per size. The
daemon/protocol coalescer substantially reduces the provider event count before the app queue, and
the queue profile records the actual remaining chunks rather than assuming a fixed batch size.

| Payload | Provider chunks | Client chunks p50/p95 | Chunks/flush p50/p95 | Reducer total p50/p95 | End-to-end p50/p95 | React commits p50/p95 | Long-task time p50/p95 | Feedback delay p50/p95 |
| ------- | --------------: | --------------------: | -------------------: | --------------------: | -----------------: | --------------------: | ---------------------: | ---------------------: |
| 64KiB   |             128 |                   3/3 |                  1/2 |             1.6/2.6ms |          358/369ms |                 10/10 |              192/208ms |                89/95ms |
| 256KiB  |             512 |                 11/12 |                  2/2 |             3.0/3.1ms |          844/914ms |                 20/22 |              188/203ms |                81/88ms |
| 1MiB    |           2,048 |                 40/47 |                  2/3 |            9.8/12.0ms |      2,769/3,422ms |                 48/54 |          1,265/1,741ms |                80/89ms |

The PR #2167 reducer coalescing workload is present, but the real median batch is only one or two
client chunks per flush (p95 tops out at three). At 1MiB, reducer work is 9.8ms median versus 1.61s
of summed nested React profiler duration and 1.27s of long tasks. This makes React/Markdown update
frequency the next evidence-supported optimization target; another reducer-only optimization is
unlikely to move the end-to-end result by the same order of magnitude.
