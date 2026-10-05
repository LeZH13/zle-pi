/*
 * Terminal-safe text handling and presentation: glyph/color tables, task
 * line formatters for the overlay and /todos, and the tool render hooks.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 * Modified by zle13: i18n removed — English labels only.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { selectTaskSubjectById } from "./selectors.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskState, TaskStatus } from "./tasks.js";

/**
 * Remove terminal control characters from model-controlled task text before
 * it reaches Pi's renderer. CSI/OSC escape sequences are dropped whole,
 * newlines/tabs become spaces, and bidi controls are removed.
 */
export function sanitizeTerminalText(value: string): string {
	return (
		value
			// CSI sequences, via both ESC-[ and the C1 single-byte introducer.
			.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
			// OSC sequences with their payload; an unterminated OSC swallows the rest.
			.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
			// Any remaining two-character ESC sequence.
			.replace(/\u001b./g, "")
			// Unicode line/paragraph separators join lines like \n does below.
			.replace(/[\u2028\u2029]/g, " ")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
				character === "\n" || character === "\r" || character === "\t" ? " " : "",
			)
			// Bidi embedding/override/isolate controls and LRM/RLM marks.
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
	deleted: "deleted",
};

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/** Per-action prefix glyph for renderCall. */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

/** Glyph for the persistent overlay's per-task row. */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/** One task row for the expanded overlay panel. */
export function formatOverlayTaskLine(task: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(task.status, theme);
	const subjectColor =
		task.status === "in_progress" ? "accent" : task.status === "completed" || task.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitizeTerminalText(task.subject));
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("dim", `#${task.id}`)}`;
	line += ` ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitizeTerminalText(task.activeForm)})`)}`;
	}
	if (task.blockedBy && task.blockedBy.length > 0) {
		line += ` ${theme.fg("muted", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/** One task line for the /todos report (plain, indented bullet). */
export function formatCommandTaskLine(task: Task, glyph: string): string {
	const form = task.status === "in_progress" && task.activeForm ? ` (${sanitizeTerminalText(task.activeForm)})` : "";
	const block = task.blockedBy?.length ? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${task.id} ${sanitizeTerminalText(task.subject)}${form}${block}`;
}

/** renderCall body: action glyph plus a short label for the call arguments. */
export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	const glyph = ACTION_GLYPH[args.action] ?? args.action;
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
	} else if ((args.action === "update" || args.action === "get" || args.action === "delete") && args.id !== undefined) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", STATUS_LABEL[args.status])}`;
	}
	return new Text(text, 0, 0);
}

/** renderResult body: failures (context.isError) render as a clear error; success echoes status. */
export function renderTodoResult(
	result: { content?: unknown; details?: unknown },
	theme: Theme,
	context: { isError?: boolean } = {},
): Text {
	if (context.isError) {
		const text = (result.content as Array<{ type: string; text?: string }> | undefined)
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join(" ");
		return new Text(theme.fg("error", `✗ ${text || "Failed"}`), 0, 0);
	}
	const details = result.details as TaskDetails | undefined;
	let status: TaskStatus | undefined;
	if (details) {
		const params = details.params as TaskMutationParams;
		switch (details.action) {
			case "create":
				status = details.tasks[details.tasks.length - 1]?.status;
				break;
			case "update":
				status = params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "delete":
				status = details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "list":
			case "get":
			case "clear":
				break;
		}
	}
	if (status) {
		return new Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${STATUS_LABEL[status]}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}
