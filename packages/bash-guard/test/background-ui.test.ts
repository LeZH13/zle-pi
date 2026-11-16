import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import bashGuard from "../extensions/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const theme = { fg: (_kind: string, text: string) => text };

/** A UI context that records widget mounts and forces a redraw on demand. */
function fakeUi() {
	const widgets = new Map<string, (tui: unknown, theme: unknown) => {
		render(width: number): string[];
		handleMouse(event: { type: string; button?: string; y: number }): { handled: boolean } | undefined;
	}>();
	const renders = { count: 0 };
	const confirms: unknown[][] = [];
	const state = { confirmAnswer: true, selectAnswer: undefined as string | undefined };
	const tui = { requestRender: () => { renders.count++; } };
	const statuses: string[] = [];
	const ui = {
		theme,
		confirm: async (...args: unknown[]) => { confirms.push(args); return state.confirmAnswer; },
		select: async () => state.selectAnswer,
		setStatus: (_key: string, value: string | undefined) => { if (value) statuses.push(value); },
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content as never);
		},
		notify: vi.fn(),
	};
	return { ui, widgets, renders, tui, statuses, confirms, state };
}

async function harness(options: { after?: string; animation?: string; ui?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "bash-guard-ui-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "bash-guard.json"), JSON.stringify({ watchdog: { enabled: false } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_BASH_GUARD_APPROVAL_MODE", "deny");
	const flags = new Map<string, unknown>([
		["bash-background-after", options.after ?? "60"],
		["bash-bg-animation", options.animation ?? "clock"],
	]);
	const tools = new Map<string, ToolDefinition>();
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
	const handlers = new Map<string, Handler[]>();
	let resolver: ToolRendererResolver | undefined;
	const fake = fakeUi();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		registerFlag: (name: string, config: { default: unknown }) => { if (!flags.has(name)) flags.set(name, config.default); },
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
		registerCommand: (name: string, config: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, config.handler); },
		registerShortcut: (shortcut: string, config: { handler: (ctx: ExtensionContext) => Promise<void> }) => { shortcuts.set(shortcut, config.handler); },
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name, sourceInfo: { path: "/pi-bash-guard/extensions/index.ts" } })),
		sendMessage: vi.fn(), sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	bashGuard(pi);
	const ctx = {
		cwd, hasUI: options.ui ?? true, mode: "tui", ui: fake.ui,
		sessionManager: { getBranch: () => [], getSessionId: () => "ui-test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	async function emit(name: string, event = {}) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	}
	cleanup.push(async () => {
		await emit("session_shutdown");
		rmSync(cwd, { recursive: true, force: true });
	});
	await emit("session_start");
	let nextId = 0;
	async function call(name: string, params: Record<string, unknown>) {
		const tool = tools.get(name)!;
		return tool.execute(`call-${++nextId}`, params, undefined, undefined, ctx as never);
	}
	/** Render the block for a background acknowledgement through the real resolver. */
	function renderBlock(toolCallId: string, result: { content: never[]; details: undefined; structuredContent?: unknown }, state = {}) {
		const base = { renderCall: () => ({ render: () => [] }), renderResult: () => ({ render: () => [] }) };
		const renderers = resolver!("bash", () => base as never)!;
		const invalidate = vi.fn();
		const component = renderers.renderResult!(
			result as never,
			{ expanded: false, isPartial: false },
			theme as never,
			{ toolCallId, state, invalidate, executionStarted: true } as never,
		) as { render(width: number): string[] };
		return { component, invalidate, lines: () => component.render(200).map((line) => line.trim()).filter(Boolean) };
	}
	return { call, emit, fake, renderBlock, tools, ctx, commands, shortcuts, messages: pi.sendMessage as ReturnType<typeof vi.fn>, resolver: () => resolver! };
}

it("toggles the job dropdown on header clicks and through the keyboard command", async () => {
	const h = await harness();
	await h.call("bash", { command: idle, background: true });
	await h.call("bash", { command: idle, background: true });
	const widget = h.fake.widgets.get("bash-guard-background")!(h.fake.tui, theme);
	expect(widget.render(200)).toHaveLength(1);
	for (const event of [
		{ type: "click", button: "right", y: 0 },
		{ type: "press", button: "left", y: 0 },
		{ type: "wheel", y: 0 },
		{ type: "click", button: "left", y: 1 },
	]) expect(widget.handleMouse(event)).toBeUndefined();
	expect(widget.render(200)).toHaveLength(1);
	expect(widget.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({ handled: true });
	expect(widget.render(200)).toHaveLength(3);
	expect(widget.render(200)[0]).toContain("▾ 2 bg");
	expect(widget.render(200)[1]).toContain("running");
	expect(widget.render(200)[1]).toContain("setInterval");
	widget.handleMouse({ type: "click", button: "left", y: 0 });
	expect(widget.render(200)).toHaveLength(1);
	await h.commands.get("bash-jobs")!("toggle", h.ctx);
	expect(widget.render(200)).toHaveLength(3);
	await h.emit("session_before_switch");
	await h.call("bash", { command: idle, background: true });
	expect(h.fake.widgets.get("bash-guard-background")!(h.fake.tui, theme).render(200)).toHaveLength(1);
});

it.each([60, 20000])("reports truncated output honestly for %i lines", async (count) => {
	const h = await harness();
	const command = `${JSON.stringify(process.execPath)} -e 'for(let i=0;i<${count};i++) console.log("line "+i)'`;
	await h.call("bash", { command, background: true });
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	expect(message.details.truncated).toBe(true);
	if (count === 60) {
		expect(message.details.full_output_path).toBeUndefined();
		expect(message.content).toContain("earlier output omitted");
		expect(message.content).not.toContain("full_output_path");
		expect(message.content).not.toContain("Full output:");
	} else {
		expect(message.details.full_output_path).toBeTruthy();
		expect(message.content).toContain(`Full output: ${message.details.full_output_path}`);
		expect(message.content).toContain("read the full output file below");
	}
});

const idle = `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`;

it("mounts one aggregate widget row with the newest command while a job runs", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const widget = h.fake.widgets.get("bash-guard-background");
	expect(widget).toBeDefined();
	const rows = widget!(h.fake.tui, theme).render(200);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatch(/▸ 1 bg · 0:0\d/);
	expect(rows[0]).toContain("setInterval");
	expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(200);
	await h.call("bash_jobs", { action: "cancel", job_id: (ack.structuredContent as { job_id: string }).job_id });
});

it("keeps a running block's clock live and settles it in place", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const result = { content: [], details: undefined, structuredContent: { status: "running", job_id: jobId } };
	const block = h.renderBlock("call-1", result as never);
	expect(block.lines().join("\n")).toBe(`● running · 0:00 · ${jobId}`);

	// The shared ticker advances the clock without any new tool result.
	await new Promise((resolve) => setTimeout(resolve, 1100));
	expect(block.lines().join("\n")).toMatch(/● running · 0:0[12]/);
	expect(block.invalidate).toHaveBeenCalled();

	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	await vi.waitFor(() => expect(block.lines().join("\n")).toContain("cancelled"));
	expect(block.lines().join("\n")).not.toContain("running");
});

it("drops the widget and stops ticking once the last job settles", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const before = h.fake.renders.count;
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	await vi.waitFor(() => expect(h.fake.widgets.has("bash-guard-background")).toBe(false));
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(h.fake.renders.count).toBe(before);
});

it("renders a static block when --bash-bg-animation is off", async () => {
	const h = await harness({ animation: "off" });
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const block = h.renderBlock("call-1", { content: [], details: undefined, structuredContent: { status: "running", job_id: jobId } } as never);
	const first = block.lines().join("\n");
	expect(first).toContain("running · 0:00");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(block.lines().join("\n")).toBe(first);
	expect(block.invalidate).not.toHaveBeenCalled();
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
});

it("leaves ordinary foreground results to the native renderer", async () => {
	const h = await harness();
	const base = { renderCall: () => ({ render: () => [] }), renderResult: vi.fn(() => ({ render: () => ["native"] })) };
	const decorated = h.resolver()("bash", () => base as never)!;
	const component = decorated.renderResult!(
		{ content: [], details: undefined, structuredContent: { output: "hi", exit_code: 0 } } as never,
		{ expanded: false, isPartial: false },
		theme as never,
		{ toolCallId: "plain", state: {}, invalidate: vi.fn(), executionStarted: true } as never,
	);
	expect(base.renderResult).toHaveBeenCalledOnce();
	expect((component as { render(width: number): string[] }).render(80)).toEqual(["native"]);
});

it("stops refreshing a block once it settles, so no idle repaint loop remains", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const block = h.renderBlock("call-1", { content: [], details: undefined, structuredContent: { status: "running", job_id: jobId } } as never);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	expect(block.invalidate).toHaveBeenCalled();
	// Settle, then confirm no further invalidation and another job still refreshes.
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	await vi.waitFor(() => expect(block.lines().join("\n")).toContain("cancelled"));
	const settled = block.invalidate.mock.calls.length;
	const second = await h.call("bash", { command: idle, background: true });
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(block.invalidate.mock.calls.length).toBe(settled);
	await h.call("bash_jobs", { action: "cancel", job_id: (second.structuredContent as { job_id: string }).job_id });
});

it("renders no widget outside a TUI", async () => {
	const h = await harness({ ui: false });
	const ack = await h.call("bash", { command: idle, background: true });
	expect(h.fake.widgets.size).toBe(0);
	// The job still exists and stays discoverable through bash_jobs.
	const status = await h.call("bash_jobs", { action: "status", job_id: (ack.structuredContent as { job_id: string }).job_id });
	expect((status.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toBe("running");
	await h.call("bash_jobs", { action: "cancel", job_id: (ack.structuredContent as { job_id: string }).job_id });
});

describe("operator cancellation", () => {
	it("cancels a single running job from the keyboard after confirmation", async () => {
		const h = await harness();
		const ack = await h.call("bash", { command: idle, background: true });
		const jobId = (ack.structuredContent as { job_id: string }).job_id;
		const shortcut = h.shortcuts.get("ctrl+shift+k");
		expect(shortcut).toBeDefined();
		await shortcut!(h.ctx);
		expect(h.fake.confirms).toHaveLength(1);
		expect(h.fake.confirms[0]![0]).toContain("Cancel background job?");
		await vi.waitFor(async () => {
			await expect(h.call("bash_jobs", { action: "status", job_id: jobId })).resolves.toMatchObject({ structuredContent: { jobs: [{ state: expect.stringMatching(/cancel/) }] } });
		});
	});

	it("leaves the job running when the confirmation is declined", async () => {
		const h = await harness();
		const ack = await h.call("bash", { command: idle, background: true });
		const jobId = (ack.structuredContent as { job_id: string }).job_id;
		h.fake.state.confirmAnswer = false;
		await h.commands.get("bash-jobs")!("", h.ctx);
		const status = await h.call("bash_jobs", { action: "status", job_id: jobId });
		expect((status.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toBe("running");
		await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	});

	it("offers a picker when several jobs run and cancels the chosen one", async () => {
		const h = await harness();
		const first = await h.call("bash", { command: idle, background: true });
		const second = await h.call("bash", { command: "sleep 60", background: true });
		const firstId = (first.structuredContent as { job_id: string }).job_id;
		const secondId = (second.structuredContent as { job_id: string }).job_id;
		let offered: string[] = [];
		(h.fake.ui as { select: unknown }).select = async (_title: string, options: string[]) => {
			offered = options;
			return options.find((option) => option.includes("sleep 60"));
		};
		await h.commands.get("bash-jobs")!("", h.ctx);
		expect(offered).toHaveLength(2);
		expect(h.fake.confirms).toHaveLength(0);
		const secondState = await h.call("bash_jobs", { action: "status", job_id: secondId });
		expect((secondState.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toMatch(/cancel/);
		const firstState = await h.call("bash_jobs", { action: "status", job_id: firstId });
		expect((firstState.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toBe("running");
		await h.call("bash_jobs", { action: "cancel", job_id: firstId });
	});

	it("reports when nothing is running instead of opening a dialog", async () => {
		const h = await harness();
		await h.commands.get("bash-jobs")!("", h.ctx);
		expect(h.fake.confirms).toHaveLength(0);
	});
});
