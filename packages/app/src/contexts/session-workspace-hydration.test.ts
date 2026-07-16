import { describe, expect, it } from "vitest";

import { createProjectHydrationBuffer } from "./session-workspace-hydration";

type ProjectUpdate =
  | { kind: "upsert"; projectId: string; name: string }
  | { kind: "remove"; projectId: string };

function applyProjectUpdate(projects: Map<string, string>, update: ProjectUpdate): void {
  if (update.kind === "remove") projects.delete(update.projectId);
  else projects.set(update.projectId, update.name);
}

describe("workspace hydration project updates", () => {
  it("replays project updates after replacing the stale hydration snapshot", () => {
    const projects = new Map<string, string>([["project-1", "before hydration"]]);
    const hydration = createProjectHydrationBuffer<ProjectUpdate>();
    const lease = hydration.begin();

    hydration.buffer({ kind: "upsert", projectId: "project-2", name: "arrived live" });
    hydration.buffer({ kind: "remove", projectId: "project-1" });

    hydration.commit(
      lease,
      () => {
        projects.clear();
        projects.set("project-1", "stale snapshot");
      },
      (update) => applyProjectUpdate(projects, update),
    );

    expect(projects).toEqual(new Map([["project-2", "arrived live"]]));
  });

  it("does not let an older hydration overwrite the current one", () => {
    const projects = new Map<string, string>();
    const hydration = createProjectHydrationBuffer<ProjectUpdate>();
    const older = hydration.begin();
    const current = hydration.begin();
    hydration.buffer({ kind: "upsert", projectId: "project-2", name: "current" });

    expect(
      hydration.commit(
        older,
        () => projects.set("project-1", "stale"),
        () => {},
      ),
    ).toBe(false);
    expect(
      hydration.commit(
        current,
        () => projects.set("project-1", "current snapshot"),
        (update) => applyProjectUpdate(projects, update),
      ),
    ).toBe(true);
    expect(projects).toEqual(
      new Map([
        ["project-1", "current snapshot"],
        ["project-2", "current"],
      ]),
    );
  });
});
