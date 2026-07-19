# Finding: desktop_markdown_performance

Benchmark: `desktop_markdown_rendering@v2`

Scorer: `desktop_markdown_metrics_v2`

## Current decisions

- `BENCH-MD-01`: v2 released. Representative payloads and final-render hashes are frozen.
- `MD-TAIL-01` first candidate: rejected. It cut one MiB Long Task p95 by 52%, but did not meet
  the end-to-end/feedback/frame-gap promotion gate.
- `MD-CODE-01` incomplete-fence candidate: rejected as a standalone change. It cut open-fence
  end-to-end p95 by 25%, Long Task p95 by 33%, and highlight calls by 50%, but feedback p95
  regressed 8% because final highlighting still mounted 29k DOM / 58k non-ignored AX nodes.
- The failed incomplete-fence candidate promoted bounded code rendering to P0: tokenization is a
  secondary cost; unbounded token/span mounting and accessibility-tree construction are dominant.
- `MD-CODE-02` bounded token tree: accepted. Rendering code above 16KiB as complete plain
  monospace text cut 64KiB feedback p95 95.6%, end-to-end p95 80.6%, DOM 99.96%, AX 94.5%,
  and post-GC heap 46.2%; Long Task fell from 862ms to zero and final rendered text was identical.
- Long-message block virtualization is also promoted to P0: 256KiB mixed Markdown mounts 111k DOM
  / 133k non-ignored AX nodes, retains 2.37GB after GC, and blocks feedback for 5.84s p95.

Only v2 runs may promote subsequent candidates. v1 runs remain calibration evidence because their
single early feedback sample missed later main-thread stalls.
