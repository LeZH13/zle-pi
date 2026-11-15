/*
 * The `todo` tool and the `/todos` command.
 *
 * Enablement is per session and starts off; bare `/todos` toggles it,
 * `/todos status` reports, `collapse`/`expand` set the overlay view.
 * Toggling never launches an agent turn.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 * Modified by zle13: session-scoped enablement, view control, an execution
 * guard, less eager guidance; i18n and config overrides removed.
 */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { buildToolResult } from "./envelope.js";
import { STATUS_LABEL, formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./format.js";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET } from "./guidance.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./selectors.js";
import { commitState, getRenderState, getState, sid } from "./store.js";
import {
	COMMAND_NAME,
	SNAPSHOT_ENTRY_TYPE,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
	applyTaskMutation,
	type TaskMutationParams,
} from "./tasks.js";

/** Per-session enablement and global view state, owned by the extension factory. */
export interface TodosControl {
	/** Whether tracking is enabled for the given session (new sessions: off). */
	isEnabled(sessionId: string): boolean;
	/** Toggle enablement for a session; returns the new state. */
	toggleEnabled(sessionId: string): boolean;
	isCollapsed(): boolean;
	/** Collapse/expand the overlay: persists the global preference and updates the overlay. */
	setCollapsed(collapsed: boolean): void;
}

const DISABLED_MESSAGE = "Todo tracking is disabled for this session; run /todos to enable it.";

export function registerTodoTool(pi: ExtensionAPI, control: TodosControl): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		// New sessions start with tracking off; lifecycle reconciliation activates
		// the tool for sessions that recorded enablement on their branch.
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			// Guard every path, including indirect calls via ctx.executeTool().
			if (!control.isEnabled(sid(ctx))) throw new Error(DISABLED_MESSAGE);
			const result = applyTaskMutation(getState(sid(ctx)), params.action, params as TaskMutationParams);
			// Invalid mutations fail loudly at the execution boundary instead of
			// returning a success-shaped envelope the renderer would ignore.
			if (result.op.kind === "error") throw new Error(result.op.message);
			commitState(sid(ctx), result.state);
			const envelope = buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
			// Persist the post-mutation snapshot at execution time for every
			// successful mutation, direct or indirect (nested `ctx.executeTool`):
			// in a parallel batch a direct tool result can be recorded AFTER another
			// call's snapshot, so snapshots are the authoritative replay source, in
			// execution order.
			pi.appendEntry(SNAPSHOT_ENTRY_TYPE, envelope.details);
			return envelope;
		},

		renderCall(args, theme, _context) {
			return renderTodoCall(args, theme, getRenderState());
		},

		renderResult(result, _opts, theme, context) {
			return renderTodoResult(result, theme, context);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos command
// ---------------------------------------------------------------------------

const SECTION_GLYPHS: Record<"pending" | "inProgress" | "completed", string> = {
	pending: "○",
	inProgress: "◐",
	completed: "✓",
};

const SECTIONS: Array<{ key: "pending" | "inProgress" | "completed"; title: string }> = [
	{ key: "pending", title: "── Pending ──" },
	{ key: "inProgress", title: "── In Progress ──" },
	{ key: "completed", title: "── Completed ──" },
];

export const TODOS_USAGE = "/todos [status|collapse|expand]";

const COMPLETIONS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Report tracking state and tasks" },
	{ value: "collapse", label: "collapse", description: "Collapse the overlay" },
	{ value: "expand", label: "expand", description: "Expand the overlay" },
];

/** Prefix-filtered argument completions; null when nothing matches. */
export function todoArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const matches = COMPLETIONS.filter((item) => item.value.startsWith(argumentPrefix));
	return matches.length > 0 ? matches : null;
}

/** Full grouped listing of the session's tasks, with a tracking status line. */
export function todoReportLines(
	state: ReturnType<typeof getState>,
	session: { enabled: boolean; collapsed: boolean },
): string[] {
	const lines: string[] = [
		`Todo tracking: ${session.enabled ? "on" : "off"} · view: ${session.collapsed ? "collapsed" : "expanded"}`,
	];
	const visible = selectVisibleTasks(state);
	if (visible.length === 0) {
		lines.push("No todos yet. Ask the agent to add some!");
		return lines;
	}
	const counts = selectTodoCounts(state);
	const header: string[] = [];
	if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${STATUS_LABEL.completed}`);
	if (counts.inProgress > 0) header.push(`${counts.inProgress} ${STATUS_LABEL.in_progress}`);
	if (counts.pending > 0) header.push(`${counts.pending} ${STATUS_LABEL.pending}`);
	lines.push(header.join(" · "));

	const groups = selectTasksByStatus(state);
	for (const section of SECTIONS) {
		const tasks = groups[section.key];
		if (tasks.length === 0) continue;
		lines.push(section.title);
		for (const task of tasks) lines.push(formatCommandTaskLine(task, SECTION_GLYPHS[section.key]));
	}
	return lines;
}

export function registerTodosCommand(pi: ExtensionAPI, control: TodosControl): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "/todos toggles tracking; /todos status reports; collapse|expand set the view",
		getArgumentCompletions: todoArgumentCompletions,
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sessionId = sid(ctx);
			const arg = args.trim().toLowerCase();
			switch (arg) {
				case "": {
					const on = control.toggleEnabled(sessionId);
					ctx.ui.notify(
						on ? "Todo tracking enabled for this session" : "Todo tracking disabled — tasks are preserved (/todos to re-enable)",
						"info",
					);
					return;
				}
				case "status": {
					ctx.ui.notify(
						todoReportLines(getState(sessionId), {
							enabled: control.isEnabled(sessionId),
							collapsed: control.isCollapsed(),
						}).join("\n"),
						"info",
					);
					return;
				}
				case "collapse": {
					control.setCollapsed(true);
					ctx.ui.notify("Todos collapsed", "info");
					return;
				}
				case "expand": {
					control.setCollapsed(false);
					ctx.ui.notify("Todos expanded", "info");
					return;
				}
				default: {
					ctx.ui.notify(`Usage: ${TODOS_USAGE}`, "warning");
				}
			}
		},
	});
}
