import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import recapExtension from "../extensions/recap.js";
import { STATE_KEY } from "../lib/summary.js";

// Independent fixtures; no upstream implementation or assertions are copied.
export type Handler = (event: any, ctx: ExtensionContext) => unknown;
export type Response = { stopReason: string; content: unknown };
export const response = (text: string, stopReason = "stop"): Response => ({ stopReason, content: [{ type: "text", text }] });
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
// Drain the bounded name -> recap promise chain, not timer/poll-based waiting.
export async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
export const model = { provider: "test", id: "session" };
export function appendAssistant(manager: SessionManager, stopReason = "stop") {
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Completed feature work" }],
		api: "openai-responses", provider: "test", model: "session", timestamp: 2, stopReason,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as AssistantMessage);
}
export function setup(options: { settings?: unknown; manager?: SessionManager; mode?: string; hasUI?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	let manager = options.manager ?? SessionManager.inMemory("/recap-test");
	let settings: unknown = options.settings ?? {};
	let idle = true;
	const notify = vi.fn();
	const setWidget = vi.fn();
	const streamSimple = vi.fn(() => ({ result: () => Promise.resolve(response("Generated session summary")) }));
	const registry = { streamSimple, find: vi.fn(() => model), hasConfiguredAuth: vi.fn(() => true) };
	const ctx = {
		mode: options.mode ?? "tui", hasUI: options.hasUI ?? true,
		model, modelRegistry: registry, sessionManager: manager,
		isIdle: () => idle, ui: { notify, setWidget },
	} as unknown as ExtensionContext;
	const appendEntry = vi.fn((key: string, data: unknown) => manager.appendCustomEntry(key, data));
	const setSessionName = vi.fn((name: string) => {
		manager.appendSessionInfo(name);
		handlers.get("session_info_changed")?.({ name }, ctx);
	});
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getSettings: () => settings,
		getSessionName: () => manager.getSessionName(), setSessionName, appendEntry,
	} as unknown as ExtensionAPI;
	recapExtension(pi);
	const emit = async (name: string, event: any = {}) => { await handlers.get(name)?.(event, ctx); };
	return {
		ctx, pi, handlers, commands, notify, setWidget, streamSimple, registry, appendEntry, setSessionName,
		get manager() { return manager; },
		settings(value: unknown) { settings = value; },
		idle(value: boolean) { idle = value; },
		switchManager(value: SessionManager) { manager = value; ctx.sessionManager = value; },
		emit,
		start: (reason = "startup") => emit("session_start", { reason }),
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
		user(text = "Build a coding feature") { return manager.appendMessage({ role: "user", content: text, timestamp: 1 }); },
		assistant(stopReason = "stop") { appendAssistant(manager, stopReason); },
		async run(outcome = "completed") {
			await emit("agent_start");
			if (outcome === "completed" && manager.buildSessionProjection().messages.at(-1)?.role !== "assistant") appendAssistant(manager);
			await emit("agent_before_settle", { outcome });
			await emit("agent_settled");
			await flush();
		},
		state() {
			const entries = manager.getBranch().filter(e => e.type === "custom" && e.customType === STATE_KEY);
			return (entries.at(-1) as any)?.data;
		},
		answer(text: string, stopReason = "stop") { streamSimple.mockImplementationOnce(() => ({ result: () => Promise.resolve(response(text, stopReason)) })); },
		pending() {
			const result = deferred<Response>();
			streamSimple.mockImplementationOnce(() => ({ result: () => result.promise }));
			return result;
		},
	};
}
export type Harness = ReturnType<typeof setup>;
