import { basename, resolve } from "node:path";

import {
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  generateWorkspaceId,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
}

export interface WorkspaceProvisioningService {
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(input: ResolveOrCreateWorkspaceIdInput): Promise<string>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

export function createWorkspaceProvisioningService(deps: {
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout">;
}): WorkspaceProvisioningService {
  const { workspaceRegistry, projectRegistry, workspaceGitService } = deps;

  async function findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const rootPath = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    const timestamp = new Date().toISOString();
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      timestamp,
    });
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const project = projectId
      ? await requireActiveProject(projectId)
      : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
        await findOrCreateProjectForDirectory(normalizedCwd);
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: generateWorkspaceId(),
      projectId: project.projectId,
      cwd: normalizedCwd,
      kind: deriveWorkspaceKind(checkout),
      displayName: deriveWorkspaceDisplayName({ cwd: normalizedCwd, checkout }),
      branch:
        checkout.currentBranch && checkout.currentBranch.toUpperCase() !== "HEAD"
          ? checkout.currentBranch
          : null,
      title: title?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await workspaceRegistry.upsert(workspace);
    return workspace;
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const workspaces = await workspaceRegistry.list();
    const active = workspaces
      .filter((workspace) => !workspace.archivedAt && workspace.cwd === normalizedCwd)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (active) return active;
    const archived = workspaces
      .filter((workspace) => workspace.archivedAt && workspace.cwd === normalizedCwd)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (archived) {
      const project = await projectRegistry.get(archived.projectId);
      if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
    }
    return createWorkspaceForDirectory(normalizedCwd);
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<string> {
    if (input.createdWorktree) return input.createdWorktree.workspace.workspaceId;
    if (input.requestedWorkspaceId) return input.requestedWorkspaceId;
    return (await createWorkspaceForDirectory(input.cwd, input.initialTitle)).workspaceId;
  }

  async function ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await projectRegistry.get(workspace.projectId);
    if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
    const timestamp = new Date().toISOString();
    let next: PersistedWorkspaceRecord | null = null;
    if (workspace.archivedAt) {
      const checkout = await workspaceGitService.getCheckout(workspace.cwd);
      next = {
        ...workspace,
        kind: deriveWorkspaceKind(checkout),
        branch:
          checkout.currentBranch && checkout.currentBranch.toUpperCase() !== "HEAD"
            ? checkout.currentBranch
            : null,
        archivedAt: null,
        updatedAt: timestamp,
      };
    }
    if (project.archivedAt) {
      await projectRegistry.upsert({ ...project, archivedAt: null, updatedAt: timestamp });
    }
    if (!next) return workspace;
    await workspaceRegistry.upsert(next);
    return next;
  }

  return {
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    createWorkspaceForDirectory,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
