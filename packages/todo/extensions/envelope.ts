/*
 * LLM-facing tool result envelope: per-action content formatting plus the
 * details snapshot that persistence/replay consumes.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 */
import { deriveBlocks } from "./tasks.js";
import { sanitizeTerminalText } from "./format.js";
import type { TaskState } from "./tasks.js";
import type { Op } from "./tasks.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./tasks.js";

/** One task line for the list action's content branch. */
function formatListLine(task: Task): string {
	const block = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = task.status === "in_progress" && task.activeForm ? ` (${sanitizeTerminalText(task.activeForm)})` : "";
	return `[${task.status}] #${task.id} ${sanitizeTerminalText(task.subject)}${form}${block}`;
}

/** Multi-line presentation for the get action. */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines.join("\n");
}

/** Pure formatter: (op, state) → content text. Closed switch on op.kind. */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const task = state.tasks.find((x) => x.id === op.taskId);
			if (!task) return `Created #${op.taskId}`;
			return `Created #${task.id}: ${sanitizeTerminalText(task.subject)} (pending)`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing envelope after the store commits the reducer's state.
 * `details` is the persistence + replay snapshot.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
