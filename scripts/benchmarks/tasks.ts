export interface BenchmarkTaskDefinition {
  id: string;
  description: string;
  command: string;
  args: string[];
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

export const benchmarkTasks: BenchmarkTaskDefinition[] = [
  {
    id: "agent-stream-reducer",
    description: "Measure assistant chunk reduction across scheduled client reducer flushes",
    command: npxCommand,
    args: [
      "--no-install",
      "tsx",
      "--tsconfig",
      "packages/app/tsconfig.json",
      "packages/app/scripts/benchmark-agent-stream-reducer.ts",
    ],
  },
];
