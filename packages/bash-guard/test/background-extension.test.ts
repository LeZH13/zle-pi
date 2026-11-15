import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

/** Real processes race the full suite; keep waits well above the 1s default. */
const WAIT = { timeout: 10_000, interval: 50 };
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import bashGuard from "../extensions/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	vi.unstubAllEnvs();
});

async function harness(options: { watchdog?: boolean; after?: string } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "bash-background-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "bash-guard.json"), JSON.stringify({
		watchdog: { enabled: options.watchdog ?? false, firstCheckSec: 5, agreeChecks: 1 },
		guard: { extraRiskyPatterns: ["background_risky"] },
	}));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_BASH_GUARD_APPROVAL_MODE", "deny");
	const flags = new Map<string, boolean | string>([["bash-background-after", options.after ?? "60"]]);
	const tools = new Map<string, ToolDefinition>();
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
	const handlers = new Map<string, Handler[]>();
	const sendMessage = vi.fn();
	const model = { provider: "typesafe", id: "jev-latest" };
	const registry = {
		getAvailableOfType: async () => options.watchdog ? [model] : [],
		getModelOfType: () => options.watchdog ? model : undefined,
		classify: vi.fn(async () => ({
			stopReason: "stop", provider: "typesafe", model: "jev-latest",
			answers: {
				irreversible: { type: "bool", probability: 1 },
				status: { type: "choice", choice: "stuck", probabilities: { stuck: 1 } },
				persistent: { type: "bool", probability: 0 },
			},
		})),
	};
	const ctx = {
		cwd, hasUI: false, mode: "rpc", modelRegistry: registry,
		sessionManager: { getBranch: () => [], getSessionId: () => "background-test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const pi = {
		registerFlag: (name: string, config: { default: string | boolean }) => { if (!flags.has(name)) flags.set(name, config.default); },
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerToolRenderer: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(),
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name, sourceInfo: { path: "/pi-bash-guard/extensions/index.ts" } })),
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		sendMessage, sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	bashGuard(pi);
	async function emit(name: string, event = {}) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	}
	cleanup.push(async () => {
		await emit("session_shutdown");
		rmSync(cwd, { recursive: true, force: true });
	});
	await emit("session_start");
	let nextId = 0;
	async function call(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
		const id = `call-${++nextId}`;
		const tool = tools.get(name)!;
		expect(Value.Check(tool.parameters, params)).toBe(true);
		for (const handler of handlers.get("tool_call") ?? []) {
			const outcome = await handler({ type: "tool_call", toolName: name, toolCallId: id, input: params }, ctx) as { block?: boolean; reason?: string } | undefined;
			if (outcome?.block) throw new Error(outcome.reason);
		}
		const result = await tool.execute(id, params, signal, undefined, ctx as Parameters<ToolDefinition["execute"]>[4]);
		if (tool.outputSchema && !result.isError) expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true);
		return result;
	}
	return { call, emit, sendMessage, tools, registry };
}

const command = (code: string) => `${JSON.stringify(process.execPath)} -e '${code}'`;
const idleCommand = command('console.log(process.pid); setInterval(() => {}, 1000)');

it("runs native bash in background with approval enforcement and schema-valid programmatic results", async () => {
	const h = await harness();
	await expect(h.call("bash", { command: "echo background_risky", background: true })).rejects.toThrow();
	expect(h.sendMessage).not.toHaveBeenCalled();
	const ack = await h.call("bash", { command: command('setTimeout(() => console.log("finished"), 100)'), background: true });
	expect(ack.structuredContent).toMatchObject({ status: "running", job_id: expect.any(String) });
	await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), WAIT);
	expect(h.sendMessage.mock.calls[0]![0]).toMatchObject({ details: { state: "completed", output: "finished\n", exit_code: 0 } });
	expect(h.sendMessage.mock.calls[0]![1]).toEqual({ deliverAs: "steer", triggerTurn: true });
	const job_id = (ack.structuredContent as { job_id: string }).job_id;
	const status = await h.call("bash_jobs", { action: "status", job_id });
	expect(status.structuredContent).toMatchObject({ jobs: [{ state: "completed", exit_code: 0 }] });
});

it("automatically backgrounds a native command, retains watchdog tracking, and enforces timeout", async () => {
	const h = await harness({ after: "0.01", watchdog: true });
	const ack = await h.call("bash", { command: idleCommand, timeout: 0.2 });
	expect(ack.structuredContent).toMatchObject({ status: "running" });
	await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), WAIT);
	expect(h.sendMessage.mock.calls[0]![0].details).toMatchObject({ state: "failed", output: expect.stringContaining("timed out") });
});

it("lets the watchdog terminate a background command after the original tool returns", async () => {
	const h = await harness({ watchdog: true });
	await h.call("bash", { command: idleCommand, background: true });
	await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), WAIT);
	expect(h.sendMessage.mock.calls[0]![0].details).toMatchObject({ state: "failed", output: expect.stringContaining("Jev judged") });
	expect(h.registry.classify).toHaveBeenCalled();
}, 20_000);

it("cancels a real process group through bash_jobs without killing it on turn abort", async () => {
	const h = await harness();
	const controller = new AbortController();
	const ack = await h.call("bash", { command: idleCommand, background: true }, controller.signal);
	const job_id = (ack.structuredContent as { job_id: string }).job_id;
	controller.abort();
	let pid: number;
	await vi.waitFor(async () => {
		const status = await h.call("bash_jobs", { action: "status", job_id });
		const job = (status.structuredContent as { jobs: { output: string; state: string }[] }).jobs[0]!;
		expect(job.state).toBe("running");
		pid = Number(job.output);
		expect(pid).toBeGreaterThan(0);
	}, WAIT);
	await h.call("bash_jobs", { action: "cancel", job_id });
	await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1), WAIT);
	expect(h.sendMessage.mock.calls[0]![0].details.state).toBe("cancelled");
	expect(() => process.kill(pid!, 0)).toThrow();
});

it.each(["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"])("cleans up real commands on %s without stale completion messages", async (event) => {
	const h = await harness();
	await h.call("bash", { command: idleCommand, background: true });
	await h.emit(event);
	expect(h.sendMessage).not.toHaveBeenCalled();
	expect((await h.call("bash_jobs", { action: "list" })).structuredContent).toEqual({ jobs: [] });
});

it("preserves native foreground output and nonzero-exit semantics", async () => {
	const h = await harness();
	const result = await h.call("bash", { command: command('console.log("foreground"); process.exit(3)'), background: false });
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({ exit_code: 3, output: "foreground\n" });
	expect(h.sendMessage).not.toHaveBeenCalled();
});
