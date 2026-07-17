import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import {
  processAgentStreamEvent,
  processAgentStreamEvents,
  type AgentStreamReducerEvent,
  type TimelineCursor,
} from "../src/timeline/session-stream-reducers";
import type { StreamItem } from "../src/types/stream";

const CHUNK_BYTES = 512;
const WARMUP_PAIRS = 5;
const MEASURED_PAIRS = 30;

type BenchmarkVariant = "baseline" | "coalesced";

interface BenchmarkCase {
  messageBytes: number;
  chunksPerFlush: number;
  repetitionsPerSample: number;
}

const BENCHMARK_CASES: BenchmarkCase[] = [
  { messageBytes: 64 * 1024, chunksPerFlush: 8, repetitionsPerSample: 64 },
  { messageBytes: 256 * 1024, chunksPerFlush: 8, repetitionsPerSample: 8 },
  { messageBytes: 1024 * 1024, chunksPerFlush: 8, repetitionsPerSample: 1 },
  { messageBytes: 256 * 1024, chunksPerFlush: 1, repetitionsPerSample: 8 },
  { messageBytes: 256 * 1024, chunksPerFlush: 2, repetitionsPerSample: 8 },
  { messageBytes: 256 * 1024, chunksPerFlush: 4, repetitionsPerSample: 8 },
];

interface VariantSummary {
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
}

interface PairedReductionSummary {
  p05Percent: number;
  p50Percent: number;
  p95Percent: number;
  samplesPercent: number[];
}

interface BenchmarkResult extends BenchmarkCase {
  chunkBytes: number;
  chunkCount: number;
  warmupPairs: number;
  measuredPairs: number;
  baseline: VariantSummary;
  coalesced: VariantSummary;
  pairedReduction: PairedReductionSummary;
  p50ReductionPercent: number;
  p95ReductionPercent: number;
}

interface Workload {
  batches: AgentStreamReducerEvent[][];
  expectedText: string;
}

interface ReducerState {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | undefined;
}

interface WorkloadResult extends ReducerState {
  changedTail: boolean;
  changedHead: boolean;
  cursorChanged: boolean;
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  const index = Math.ceil((percentileValue / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, index)] ?? 0;
}

function summarizeSamples(samples: number[]): VariantSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    samplesMs: sorted,
  };
}

function buildWorkload(input: BenchmarkCase): Workload {
  if (input.messageBytes % CHUNK_BYTES !== 0) {
    throw new Error(`messageBytes must be divisible by ${CHUNK_BYTES}`);
  }

  const chunkCount = input.messageBytes / CHUNK_BYTES;
  const events = Array.from({ length: chunkCount }, (_, index): AgentStreamReducerEvent => {
    const seq = index + 1;
    const marker = `${index.toString(36).padStart(8, "0")}:`;
    const text = `${marker}${"x".repeat(CHUNK_BYTES - marker.length)}`;
    return {
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "benchmark-message",
          text,
        },
      } satisfies AgentStreamEventPayload,
      seq,
      epoch: "benchmark-epoch",
      timestamp: new Date(seq),
    };
  });

  const batches: AgentStreamReducerEvent[][] = [];
  for (let index = 0; index < events.length; index += input.chunksPerFlush) {
    batches.push(events.slice(index, index + input.chunksPerFlush));
  }
  return {
    batches,
    expectedText: events
      .map((entry) => {
        if (entry.event.type !== "timeline" || entry.event.item.type !== "assistant_message") {
          throw new Error("benchmark built a non-assistant event");
        }
        return entry.event.item.text;
      })
      .join(""),
  };
}

function runBaselineBatch(events: AgentStreamReducerEvent[], state: ReducerState): WorkloadResult {
  let { tail, head, cursor } = state;
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  let agentChanged = false;
  const sideEffects: unknown[] = [];
  for (const reducerEvent of events) {
    const result = processAgentStreamEvent({
      event: reducerEvent.event,
      seq: reducerEvent.seq,
      epoch: reducerEvent.epoch,
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      currentAgent: null,
      timestamp: reducerEvent.timestamp,
    });
    tail = result.tail;
    head = result.head;
    changedTail = changedTail || result.changedTail;
    changedHead = changedHead || result.changedHead;
    sideEffects.push(...result.sideEffects);
    if (result.cursorChanged) {
      cursor = result.cursor ?? undefined;
      cursorChanged = true;
    }
    agentChanged = agentChanged || result.agentChanged;
  }
  if (agentChanged || sideEffects.length > 0) {
    throw new Error("assistant-only baseline unexpectedly produced an agent patch or side effect");
  }
  return { tail, head, cursor, changedTail, changedHead, cursorChanged };
}

function runWorkload(workload: Workload, variant: BenchmarkVariant): WorkloadResult {
  let state: ReducerState = { tail: [], head: [], cursor: undefined };
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  for (const events of workload.batches) {
    let batchResult: WorkloadResult;
    if (variant === "baseline") {
      batchResult = runBaselineBatch(events, state);
    } else {
      const result = processAgentStreamEvents({
        events,
        currentTail: state.tail,
        currentHead: state.head,
        currentCursor: state.cursor,
        currentAgent: null,
      });
      if (result.agentChanged || result.sideEffects.length > 0) {
        throw new Error(
          "assistant-only candidate unexpectedly produced an agent patch or side effect",
        );
      }
      batchResult = {
        tail: result.tail,
        head: result.head,
        cursor: result.cursor ?? undefined,
        changedTail: result.changedTail,
        changedHead: result.changedHead,
        cursorChanged: result.cursorChanged,
      };
    }
    state = {
      tail: batchResult.tail,
      head: batchResult.head,
      cursor: batchResult.cursor,
    };
    changedTail = changedTail || batchResult.changedTail;
    changedHead = changedHead || batchResult.changedHead;
    cursorChanged = cursorChanged || batchResult.cursorChanged;
  }
  return { ...state, changedTail, changedHead, cursorChanged };
}

function validateWorkload(input: BenchmarkCase, workload: Workload, result: WorkloadResult): void {
  const assistantItems = [...result.tail, ...result.head].filter(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
  const expectedEndSeq = input.messageBytes / CHUNK_BYTES;
  if (
    assistantItems.length !== 1 ||
    assistantItems[0]?.text.length !== input.messageBytes ||
    assistantItems[0]?.text !== workload.expectedText ||
    result.cursor?.epoch !== "benchmark-epoch" ||
    result.cursor.startSeq !== 1 ||
    result.cursor.endSeq !== expectedEndSeq ||
    result.changedTail ||
    !result.changedHead ||
    !result.cursorChanged
  ) {
    throw new Error("agent stream reducer benchmark produced an invalid result");
  }
}

function measureSample(workload: Workload, variant: BenchmarkVariant, repetitions: number): number {
  const start = performance.now();
  for (let index = 0; index < repetitions; index += 1) {
    runWorkload(workload, variant);
  }
  return (performance.now() - start) / repetitions;
}

function benchmark(input: BenchmarkCase): BenchmarkResult {
  const workload = buildWorkload(input);
  const baselineValidation = runWorkload(workload, "baseline");
  const coalescedValidation = runWorkload(workload, "coalesced");
  validateWorkload(input, workload, baselineValidation);
  validateWorkload(input, workload, coalescedValidation);
  if (!isDeepStrictEqual(baselineValidation, coalescedValidation)) {
    throw new Error("baseline and coalesced reducers produced different final state");
  }

  for (let pair = 0; pair < WARMUP_PAIRS; pair += 1) {
    const variants: BenchmarkVariant[] =
      pair % 2 === 0 ? ["baseline", "coalesced"] : ["coalesced", "baseline"];
    for (const variant of variants) {
      measureSample(workload, variant, input.repetitionsPerSample);
    }
  }

  const samples: Record<BenchmarkVariant, number[]> = { baseline: [], coalesced: [] };
  for (let pair = 0; pair < MEASURED_PAIRS; pair += 1) {
    const variants: BenchmarkVariant[] =
      pair % 2 === 0 ? ["baseline", "coalesced"] : ["coalesced", "baseline"];
    for (const variant of variants) {
      samples[variant].push(measureSample(workload, variant, input.repetitionsPerSample));
    }
  }

  const baseline = summarizeSamples(samples.baseline);
  const coalesced = summarizeSamples(samples.coalesced);
  const pairedReductionSamples = samples.baseline
    .map((duration, index) => {
      const coalescedDuration = samples.coalesced[index];
      if (coalescedDuration === undefined) {
        throw new Error("paired benchmark samples are misaligned");
      }
      return (1 - coalescedDuration / duration) * 100;
    })
    .sort((left, right) => left - right);
  return {
    ...input,
    chunkBytes: CHUNK_BYTES,
    chunkCount: input.messageBytes / CHUNK_BYTES,
    warmupPairs: WARMUP_PAIRS,
    measuredPairs: MEASURED_PAIRS,
    baseline,
    coalesced,
    pairedReduction: {
      p05Percent: percentile(pairedReductionSamples, 5),
      p50Percent: percentile(pairedReductionSamples, 50),
      p95Percent: percentile(pairedReductionSamples, 95),
      samplesPercent: pairedReductionSamples,
    },
    p50ReductionPercent: (1 - coalesced.p50Ms / baseline.p50Ms) * 100,
    p95ReductionPercent: (1 - coalesced.p95Ms / baseline.p95Ms) * 100,
  };
}

const output = {
  benchmark: "agent-stream-reducer",
  methodology: "paired-interleaved-ab",
  generatedAt: new Date().toISOString(),
  results: BENCHMARK_CASES.map(benchmark),
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = process.env.PASEO_PERF_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, serialized);
}
process.stdout.write(serialized);
