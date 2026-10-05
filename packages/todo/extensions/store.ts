/*
 * Per-session live task state and branch replay.
 *
 * A Map keyed by session id keeps a detached/child session from reading or
 * clobbering another session's tasks. The Map is the only mutation seam; the
 * reducer stays pure. The foreground pointer decides which slot the ctx-less
 * readers (overlay render, tool renderCall) resolve to.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 */
import type { Task, TaskDetails, TaskState } from "./tasks.js";
import { EMPTY_STATE, ENABLED_ENTRY_TYPE, SNAPSHOT_ENTRY_TYPE } from "./tasks.js";

const sessions = new Map<string, TaskState>();

let activeRenderSession = "";

/** Session-id extractor; unknown/empty sessions resolve to "". */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Fresh, non-aliasing EMPTY_STATE copy. */
function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function slotFor(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

export function getState(sessionId: string): TaskState {
	return slotFor(sessionId);
}

/** Live tasks for a session (never the live slot itself). */
export function getTodos(sessionId: string): readonly Task[] {
	return slotFor(sessionId).tasks;
}

/** Publish a replayed snapshot on session lifecycle events. */
export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Publish the reducer's post-mutation state for live readers. */
export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Drop a session's slot on session_shutdown. No-op if absent. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** The slot the overlay / renderCall render (foreground, or empty). */
export function getRenderState(): TaskState {
	return slotFor(activeRenderSession);
}

export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/** Foreground teardown: clear the pointer so the next UI session claims it. */
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

/** Test reset: clears the session Map and the foreground pointer. */
export function __resetState(): void {
	sessions.clear();
	enabledBySession.clear();
	activeRenderSession = "";
}

// -------------------------------------------------------------------------
// Per-session tracking enablement (branch-recorded; new sessions default off)
// -------------------------------------------------------------------------

const enabledBySession = new Map<string, boolean>();

/** Whether tracking is enabled for a session; new sessions default to off. */
export function getSessionEnabled(sessionId: string): boolean {
	return enabledBySession.get(sessionId) ?? false;
}

/** Publish a session's enablement after a branch replay or a toggle. */
export function setSessionEnabled(sessionId: string, enabled: boolean): void {
	enabledBySession.set(sessionId, enabled);
}

/** Drop a session's enablement on session_shutdown. */
export function evictSessionEnabled(sessionId: string): void {
	enabledBySession.delete(sessionId);
}

/**
 * Enablement from the branch: the LAST zle-todo:enabled entry wins; a session
 * without any entry is a new session and defaults to off. Entries ride the
 * branch, so resume, reload, tree navigation, and forks inherit them.
 */
export function enabledFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type !== "custom" || e.customType !== ENABLED_ENTRY_TYPE) continue;
		const data = e.data as { enabled?: unknown } | undefined;
		if (typeof data?.enabled === "boolean") enabled = data.enabled;
	}
	return enabled;
}

/**
 * Discriminator for `details` envelopes matching the persisted TaskDetails
 * shape; corrupt/foreign entries are skipped during replay.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Walk the current branch chronologically and rebuild the state from the LAST
 * snapshot entry. Every successful mutation persists a snapshot at execution
 * time (see tool execute), so the last entry always matches the live state —
 * including parallel batches where transcript tool results are recorded in
 * call order after all executions. Tool results are deliberately not replayed:
 * their transcript order does not reflect execution order. Corrupt/foreign
 * entries are skipped. Pure of module state.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = freshState();
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type !== "custom" || e.customType !== SNAPSHOT_ENTRY_TYPE) continue;
		if (!isTaskDetails(e.data)) continue;
		result = { tasks: e.data.tasks.map((t) => ({ ...t })), nextId: e.data.nextId };
	}
	return result;
}
