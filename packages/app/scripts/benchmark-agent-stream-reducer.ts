import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import {
  processAgentStreamEvents,
  type AgentStreamReducerEvent,
  type TimelineCursor,
} from "../src/timeline/session-stream-reducers";
import type { StreamItem } from "../src/types/stream";

const CHUNK_BYTES = 512;
const CHUNKS_PER_FLUSH = 8;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
const MESSAGE_SIZES_BYTES = [64 * 1024, 256 * 1024, 1024 * 1024] as const;

interface BenchmarkResult {
  messageBytes: number;
  chunkBytes: number;
  chunksPerFlush: number;
  chunkCount: number;
  warmupRuns: number;
  measuredRuns: number;
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  const index = Math.ceil((percentileValue / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, index)] ?? 0;
}

function buildEventBatches(messageBytes: number): AgentStreamReducerEvent[][] {
  if (messageBytes % CHUNK_BYTES !== 0) {
    throw new Error(`messageBytes must be divisible by ${CHUNK_BYTES}`);
  }

  const chunk = "x".repeat(CHUNK_BYTES);
  const chunkCount = messageBytes / CHUNK_BYTES;
  const events = Array.from({ length: chunkCount }, (_, index): AgentStreamReducerEvent => {
    const seq = index + 1;
    return {
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "benchmark-message",
          text: chunk,
        },
      } satisfies AgentStreamEventPayload,
      seq,
      epoch: "benchmark-epoch",
      timestamp: new Date(seq),
    };
  });

  const batches: AgentStreamReducerEvent[][] = [];
  for (let index = 0; index < events.length; index += CHUNKS_PER_FLUSH) {
    batches.push(events.slice(index, index + CHUNKS_PER_FLUSH));
  }
  return batches;
}

function runWorkload(messageBytes: number, batches: AgentStreamReducerEvent[][]): void {
  let tail: StreamItem[] = [];
  let head: StreamItem[] = [];
  let cursor: TimelineCursor | undefined;

  for (const events of batches) {
    const result = processAgentStreamEvents({
      events,
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      currentAgent: null,
    });
    tail = result.tail;
    head = result.head;
    cursor = result.cursor ?? undefined;
  }

  const assistantItems = [...tail, ...head].filter(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
  const expectedEndSeq = messageBytes / CHUNK_BYTES;
  if (
    assistantItems.length !== 1 ||
    assistantItems[0]?.text.length !== messageBytes ||
    assistantItems[0]?.text !== "x".repeat(messageBytes) ||
    cursor?.epoch !== "benchmark-epoch" ||
    cursor.startSeq !== 1 ||
    cursor.endSeq !== expectedEndSeq
  ) {
    throw new Error("agent stream reducer benchmark produced an invalid result");
  }
}

function benchmark(messageBytes: number): BenchmarkResult {
  const batches = buildEventBatches(messageBytes);
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    runWorkload(messageBytes, batches);
  }

  const samplesMs: number[] = [];
  for (let index = 0; index < MEASURED_RUNS; index += 1) {
    const start = performance.now();
    runWorkload(messageBytes, batches);
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((left, right) => left - right);

  return {
    messageBytes,
    chunkBytes: CHUNK_BYTES,
    chunksPerFlush: CHUNKS_PER_FLUSH,
    chunkCount: messageBytes / CHUNK_BYTES,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    p50Ms: percentile(samplesMs, 50),
    p95Ms: percentile(samplesMs, 95),
    samplesMs,
  };
}

const output = {
  benchmark: "agent-stream-reducer",
  generatedAt: new Date().toISOString(),
  results: MESSAGE_SIZES_BYTES.map(benchmark),
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = process.env.PASEO_PERF_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, serialized);
}
process.stdout.write(serialized);
