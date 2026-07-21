export interface BenchmarkTaskDefinition {
  id: string;
  description: string;
  command: string;
  args: string[];
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function appBenchmarkScript(script: string): Pick<BenchmarkTaskDefinition, "command" | "args"> {
  return {
    command: npmCommand,
    args: ["run", script, "--workspace=@getpaseo/app"],
  };
}

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
  {
    id: "draft-attachment-gc",
    description: "Measure the full-session attachment GC scan paid by repeated draft changes",
    ...appBenchmarkScript("benchmark:draft-attachment-gc"),
  },
  {
    id: "desktop-interaction",
    description: "Measure heavy Desktop tab switching, retained DOM/AX nodes, React, and heap",
    ...appBenchmarkScript("benchmark:desktop-interaction"),
  },
  {
    id: "desktop-streaming",
    description: "Measure 64KiB to 1MiB live streams through reducer, React, and browser feedback",
    ...appBenchmarkScript("benchmark:desktop-streaming"),
  },
  {
    id: "desktop-markdown",
    description: "Measure deterministic Markdown parsing, highlighting, rendering, and feedback",
    ...appBenchmarkScript("benchmark:desktop-markdown"),
  },
  {
    id: "desktop-css-interactions",
    description: "Measure Desktop tab hover feedback, React commits, frames, DOM, and AX nodes",
    ...appBenchmarkScript("benchmark:desktop-css-interactions"),
  },
  {
    id: "desktop-css-interaction-audit",
    description: "Count JS-driven hover and press interaction debt by Desktop UI area",
    ...appBenchmarkScript("benchmark:desktop-css-audit"),
  },
];
