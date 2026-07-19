import { writeFile } from "node:fs/promises";
import type { BrowserContext, Page } from "@playwright/test";
import { summarizeSamples } from "../../../scripts/benchmarks/stats";
import type {
  BenchmarkCaseResult,
  BenchmarkMetricResult,
  BenchmarkTaskResult,
} from "../../../scripts/benchmarks/types";
import { test } from "./fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "./helpers/daemon-registry";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { buildAgentRoute } from "./helpers/mock-agent";
import { getServerId } from "./helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

const MESSAGE_SIZES_BYTES = [64 * 1024, 256 * 1024, 1024 * 1024] as const;
const CHUNK_BYTES = 512;
const MEASURED_RUNS = 5;
const FEEDBACK_TARGET_DELAY_MS = 25;
const VIEWPORT = { width: 1440, height: 900 };

interface FlushProfileSample {
  agentId: string;
  eventCount: number;
  assistantChunkCount: number;
  assistantBytes: number;
  maxContiguousAssistantRun: number;
  reducerDurationMs: number;
  completedAt: number;
}

interface RenderProfileSample {
  actualDuration: number;
  commitTime: number;
}

interface StreamProbe {
  startedAt: number;
  feedbackTargetAt: number;
  feedbackAt: number | null;
  frameHandle: number;
  previousFrameAt: number;
  frameGaps: number[];
  longTasks: PerformanceEntry[];
  observer: PerformanceObserver | null;
  feedbackButton: HTMLButtonElement;
}

interface BrowserMemory {
  usedJSHeapSize?: number;
}

interface BenchmarkWindow extends Window {
  __PASEO_AGENT_STREAM_FLUSH_PROFILE__?: FlushProfileSample[];
  __PASEO_RENDER_PROFILE__?: RenderProfileSample[];
  __PASEO_RESET_RENDER_PROFILE__?: () => void;
  __PASEO_STREAM_BENCHMARK_PROBE__?: StreamProbe;
}

interface StreamRunSample {
  endToEndMs: number;
  reducerTotalMs: number;
  reducerFlushDurationsMs: number[];
  chunksPerFlush: number[];
  bytesPerFlush: number[];
  maxContiguousRunPerFlush: number[];
  flushCount: number;
  clientChunkCount: number;
  reactCommits: number;
  reactDurationMs: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  droppedFrameCount: number;
  maxFrameGapMs: number;
  feedbackDelayMs: number;
  heapDeltaBytes: number;
  markdownBytes: number;
}

function durationMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "ms",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

function countMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "count",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

function bytesMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "bytes",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

async function seedBenchmarkStorage(context: BrowserContext): Promise<void> {
  const serverId = getServerId();
  const daemon = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    nowIso: new Date().toISOString(),
  });
  const preferences = buildCreateAgentPreferences(serverId);
  await context.addInitScript(
    ({ seededDaemon, seededPreferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
      localStorage.removeItem("@paseo:settings");
      (window as BenchmarkWindow).__PASEO_AGENT_STREAM_FLUSH_PROFILE__ = [];
    },
    { seededDaemon: daemon, seededPreferences: preferences },
  );
}

async function openEmptyAgent(
  page: Page,
  workspace: SeededWorkspace,
  agentId: string,
): Promise<void> {
  const route = buildAgentRoute(workspace.workspaceId, agentId);
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}renderProfile=1`);
  await page.waitForURL(
    (url) =>
      url.pathname.includes("/workspace/") &&
      !url.searchParams.has("open") &&
      url.searchParams.get("renderProfile") === "1",
    { timeout: 60_000 },
  );
  await page.getByTestId(`workspace-tab-agent_${agentId}`).waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="agent-chat-scroll"]:visible').waitFor({ timeout: 60_000 });
}

async function readHeap(page: Page): Promise<number> {
  return page.evaluate(
    () => (performance as Performance & { memory?: BrowserMemory }).memory?.usedJSHeapSize ?? 0,
  );
}

async function armStreamProbe(page: Page): Promise<void> {
  await page.evaluate((feedbackTargetDelayMs) => {
    const state = window as BenchmarkWindow;
    state.__PASEO_AGENT_STREAM_FLUSH_PROFILE__ = [];
    state.__PASEO_RESET_RENDER_PROFILE__?.();

    const startedAt = performance.now();
    const longTasks: PerformanceEntry[] = [];
    const observer =
      typeof PerformanceObserver === "undefined"
        ? null
        : new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
    try {
      observer?.observe({ type: "longtask" });
    } catch {
      observer?.disconnect();
    }

    const feedbackButton = document.createElement("button");
    feedbackButton.type = "button";
    feedbackButton.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none";
    document.body.appendChild(feedbackButton);

    const probe: StreamProbe = {
      startedAt,
      feedbackTargetAt: startedAt + feedbackTargetDelayMs,
      feedbackAt: null,
      frameHandle: 0,
      previousFrameAt: startedAt,
      frameGaps: [],
      longTasks,
      observer,
      feedbackButton,
    };
    feedbackButton.addEventListener(
      "click",
      () => {
        probe.feedbackAt = performance.now();
      },
      { once: true },
    );
    window.setTimeout(() => feedbackButton.click(), feedbackTargetDelayMs);

    const recordFrame = () => {
      const now = performance.now();
      probe.frameGaps.push(now - probe.previousFrameAt);
      probe.previousFrameAt = now;
      probe.frameHandle = window.requestAnimationFrame(recordFrame);
    };
    probe.frameHandle = window.requestAnimationFrame(recordFrame);
    state.__PASEO_STREAM_BENCHMARK_PROBE__ = probe;
  }, FEEDBACK_TARGET_DELAY_MS);
}

async function waitForAssistantBytes(page: Page, expectedBytes: number): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      ((window as BenchmarkWindow).__PASEO_AGENT_STREAM_FLUSH_PROFILE__ ?? []).reduce(
        (sum, sample) => sum + sample.assistantBytes,
        0,
      ) >= expected,
    expectedBytes,
    { timeout: 60_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function finishStreamProbe(
  page: Page,
  input: { expectedBytes: number; heapBefore: number },
): Promise<StreamRunSample> {
  const heapAfter = await readHeap(page);
  return page.evaluate(
    ({ expectedBytes, heapBefore, heapAfterValue }) => {
      const state = window as BenchmarkWindow;
      const probe = state.__PASEO_STREAM_BENCHMARK_PROBE__;
      if (!probe) throw new Error("stream benchmark probe was not armed");
      probe.observer?.disconnect();
      window.cancelAnimationFrame(probe.frameHandle);
      probe.feedbackButton.remove();

      const flushes = (state.__PASEO_AGENT_STREAM_FLUSH_PROFILE__ ?? []).filter(
        (sample) => sample.assistantChunkCount > 0,
      );
      const renderSamples = state.__PASEO_RENDER_PROFILE__ ?? [];
      const lastCommitAt = Math.max(
        probe.startedAt,
        ...renderSamples.map((sample) => sample.commitTime),
      );
      const feedbackAt = probe.feedbackAt ?? performance.now();
      const assistantMessages = document.querySelectorAll<HTMLElement>(
        '[data-testid="assistant-message"]',
      );
      const latestAssistant = assistantMessages.item(assistantMessages.length - 1);
      const markdownText = latestAssistant?.textContent ?? "";
      let markdownBytes = 0;
      while (markdownText.charCodeAt(markdownBytes) === 120) markdownBytes += 1;
      if (markdownBytes !== expectedBytes) {
        throw new Error(
          `assistant Markdown has ${markdownBytes} streamed bytes, expected ${expectedBytes}`,
        );
      }

      const commitTimes = new Set(renderSamples.map((sample) => sample.commitTime));
      return {
        endToEndMs: lastCommitAt - probe.startedAt,
        reducerTotalMs: flushes.reduce((sum, sample) => sum + sample.reducerDurationMs, 0),
        reducerFlushDurationsMs: flushes.map((sample) => sample.reducerDurationMs),
        chunksPerFlush: flushes.map((sample) => sample.assistantChunkCount),
        bytesPerFlush: flushes.map((sample) => sample.assistantBytes),
        maxContiguousRunPerFlush: flushes.map((sample) => sample.maxContiguousAssistantRun),
        flushCount: flushes.length,
        clientChunkCount: flushes.reduce((sum, sample) => sum + sample.assistantChunkCount, 0),
        reactCommits: commitTimes.size,
        reactDurationMs: renderSamples.reduce((sum, sample) => sum + sample.actualDuration, 0),
        longTaskCount: probe.longTasks.length,
        longTaskDurationMs: probe.longTasks.reduce((sum, entry) => sum + entry.duration, 0),
        droppedFrameCount: probe.frameGaps.filter((gap) => gap > 20).length,
        maxFrameGapMs: Math.max(0, ...probe.frameGaps),
        feedbackDelayMs: Math.max(0, feedbackAt - probe.feedbackTargetAt),
        heapDeltaBytes: heapAfterValue - heapBefore,
        markdownBytes,
      };
    },
    { expectedBytes: input.expectedBytes, heapBefore: input.heapBefore, heapAfterValue: heapAfter },
  );
}

function buildCase(messageBytes: number, samples: StreamRunSample[]): BenchmarkCaseResult {
  const reducerFlushDurations = samples.flatMap((sample) => sample.reducerFlushDurationsMs);
  const chunksPerFlush = samples.flatMap((sample) => sample.chunksPerFlush);
  const bytesPerFlush = samples.flatMap((sample) => sample.bytesPerFlush);
  const maxRuns = samples.flatMap((sample) => sample.maxContiguousRunPerFlush);
  return {
    id: `${messageBytes}-bytes`,
    dimensions: {
      messageBytes,
      chunkBytes: CHUNK_BYTES,
      providerChunkCount: Math.ceil(messageBytes / CHUNK_BYTES),
      measuredRuns: samples.length,
    },
    metrics: {
      endToEnd: durationMetric(samples.map((sample) => sample.endToEndMs)),
      reducerTotal: durationMetric(samples.map((sample) => sample.reducerTotalMs)),
      reducerPerFlush: durationMetric(reducerFlushDurations),
      chunksPerFlush: countMetric(chunksPerFlush),
      bytesPerFlush: bytesMetric(bytesPerFlush),
      maxContiguousRunPerFlush: countMetric(maxRuns),
      flushCount: countMetric(samples.map((sample) => sample.flushCount)),
      clientChunkCount: countMetric(samples.map((sample) => sample.clientChunkCount)),
      reactCommits: countMetric(samples.map((sample) => sample.reactCommits)),
      reactDuration: durationMetric(samples.map((sample) => sample.reactDurationMs)),
      longTaskCount: countMetric(samples.map((sample) => sample.longTaskCount)),
      longTaskDuration: durationMetric(samples.map((sample) => sample.longTaskDurationMs)),
      droppedFrames: countMetric(samples.map((sample) => sample.droppedFrameCount)),
      maxFrameGap: durationMetric(samples.map((sample) => sample.maxFrameGapMs)),
      feedbackDelay: durationMetric(samples.map((sample) => sample.feedbackDelayMs)),
      heapDelta: bytesMetric(samples.map((sample) => sample.heapDeltaBytes)),
      markdownBytes: bytesMetric(samples.map((sample) => sample.markdownBytes)),
    },
  };
}

test("benchmarks live assistant streaming through reducer, React, and Markdown", async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  let workspace: SeededWorkspace | null = null;
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await seedBenchmarkStorage(context);
    const page = await context.newPage();
    await page.route(/:(6767)\b/, (route) => route.abort());
    await page.routeWebSocket(/:(6767)\b/, async (ws) => {
      await ws.close({ code: 1008, reason: "Desktop stream benchmark blocks production daemon." });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    workspace = await seedWorkspace({ repoPrefix: "desktop-streaming-benchmark-" });

    const cases: BenchmarkCaseResult[] = [];
    for (const messageBytes of MESSAGE_SIZES_BYTES) {
      const samples: StreamRunSample[] = [];
      for (let run = 0; run < MEASURED_RUNS; run += 1) {
        const created = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: `Desktop stream ${messageBytes} run ${run}`,
          modeId: "load-test",
          model: "ten-second-stream",
        });
        await openEmptyAgent(page, workspace, created.id);
        await cdp.send("HeapProfiler.collectGarbage");
        const heapBefore = await readHeap(page);
        await armStreamProbe(page);
        await workspace.client.sendAgentMessage(
          created.id,
          `emit ${messageBytes} byte coalesced assistant stream in ${CHUNK_BYTES} byte chunks every 1 ms`,
        );
        const result = await workspace.client.waitForFinish(created.id, 60_000);
        if (result.status !== "idle") {
          throw new Error(`stream benchmark agent ${created.id} finished as ${result.status}`);
        }
        await waitForAssistantBytes(page, messageBytes);
        samples.push(await finishStreamProbe(page, { expectedBytes: messageBytes, heapBefore }));
        await workspace.client.archiveAgent(created.id);
        await page.getByTestId(`workspace-tab-agent_${created.id}`).waitFor({
          state: "detached",
          timeout: 30_000,
        });
      }
      cases.push(buildCase(messageBytes, samples));
    }
    await cdp.detach();

    const result = {
      schemaVersion: 1,
      taskId: "desktop-streaming",
      generatedAt: new Date().toISOString(),
      metadata: {
        runtime: "chromium-electron-overlay",
        measuredRuns: MEASURED_RUNS,
        chunkBytes: CHUNK_BYTES,
        feedbackTargetDelayMs: FEEDBACK_TARGET_DELAY_MS,
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
      },
      cases,
    } satisfies BenchmarkTaskResult;
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
    if (!outputPath) throw new Error("PASEO_BENCHMARK_OUTPUT is required");
    await writeFile(outputPath, serialized);
    if (process.env.PASEO_BENCHMARK_QUIET !== "1") process.stdout.write(serialized);
  } finally {
    await context.close();
    await workspace?.cleanup();
  }
});
