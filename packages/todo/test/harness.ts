/*
 * Test harness: a fake ExtensionAPI/ExtensionContext wired around the real
 * extension factory, plus helpers for replaying tool results and rendering
 * the registered widget. Pattern follows packages/recap/test/harness.ts.
 */
import { SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import todoExtension from "../extensions/index.js";
import { __resetState } from "../extensions/store.js";
import type { Task, TaskDetails } from "../extensions/tasks.js";

export type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** Identity theme: plain strings, so width math in assertions is trivial. */
export const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

export function todoResultMessage(details: TaskDetails, error = false): ToolResultMessage {
	return {
		role: "toolResult" as const,
		toolCallId: `call-${Math.random().toString(36).slice(2)}`,
		toolName: "todo",
		content: [{ type: "text" as const, text: "ok" }],
		details,
		isError: error,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function taskDetails(tasks: Task[], nextId: number, action: TaskDetails["action"] = "create"): TaskDetails {
	return { action, params: {}, tasks, nextId };
}

export function setup(
	options: { hasUI?: boolean; activeTools?: string[]; prefsDir?: string; manager?: SessionManager } = {},
) {
	__resetState();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }>();
	const tools = new Map<string, any>();
	const manager = options.manager ?? SessionManager.inMemory("/todo-test");
	let activeTools = [...(options.activeTools ?? [])];
	const setActiveToolsCalls: string[][] = [];
	const notify = vi.fn();
	const setWidget = vi.fn();
	const appendEntry = vi.fn((customType: string, data: unknown) => manager.appendCustomEntry(customType, data));
	const sendUserMessage = vi.fn();
	const ui = { notify, setWidget, getToolsExpanded: () => false };
	const ctx = {
		mode: "tui",
		hasUI: options.hasUI ?? true,
		sessionManager: manager,
		ui,
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
			setActiveToolsCalls.push([...names]);
		},
		appendEntry,
		sendUserMessage,
	} as unknown as ExtensionAPI;

	const prefsDir = options.prefsDir ?? mkdtempSync(join(tmpdir(), "pi-todo-test-"));
	todoExtension(pi, { prefsDir });

	const emit = async (name: string, event: any = {}) => {
		await handlers.get(name)?.(event, ctx);
	};

	/** Render the currently registered widget (last non-undefined setWidget). */
	const renderWidget = (width = 80): string[] => {
		const call = setWidget.mock.calls.findLast(([, factory]) => typeof factory === "function");
		if (!call) return [];
		const component = (call[1] as (tui: any, theme: Theme) => any)({ requestRender: vi.fn() }, identityTheme);
		return component.render(width) as string[];
	};

	const harness: any = {
		ctx,
		pi,
		tools,
		notify,
		setWidget,
		setActiveToolsCalls,
		manager,
		prefsDir,
		appendEntry,
		sendUserMessage,
			emit,
		activeTools: () => [...activeTools],
		/** Overwrite the active tool set without going through the extension (simulates pi's loadout restore). */
		restoreActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		start: (reason = "startup") => emit("session_start", { reason }),
		command: (args = "") => commands.get("todos")!.handler(args, ctx),
		completions: (prefix: string) => commands.get("todos")!.getArgumentCompletions!(prefix),
		execute: (params: any) => tools.get("todo").execute("call-1", params, undefined, undefined, ctx),
		/** Run the real todo tool and emit tool_execution_end. */
		runTodo: async (params: any) => {
			await tools.get("todo").execute("call-1", params, undefined, undefined, ctx);
			await emit("tool_execution_end", { toolName: "todo", isError: false });
		},
		/** Run the tool as a nested (indirect) call: toolCallId looks like `<parent>/<n>`. */
		runTodoIndirect: async (params: any) => {
			await tools.get("todo").execute("parent-call/2", params, undefined, undefined, ctx);
			await emit("tool_execution_end", { toolName: "todo", isError: false, parentToolCallId: "parent-call" });
		},
		/** Append a todo tool result to the branch without running the tool. */
		appendTodoResult: (details: TaskDetails) => {
			manager.appendMessage(todoResultMessage(details));
		},
		renderWidget,
	};

	/** Start the session (reconciles enablement from the branch) and toggle tracking on. */
	harness.enable = async () => {
		await harness.start();
		await harness.command("");
	};
	/** Toggle tracking off via the bare command. */
	harness.disable = async () => {
		await harness.command("");
	};

	return harness;
}

export type Harness = ReturnType<typeof setup>;
