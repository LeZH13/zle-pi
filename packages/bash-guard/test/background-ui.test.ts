import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolRendererResolver, MessageRenderer } from "@earendil-works/pi-coding-agent";
import bashGuard from "../extensions/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text };

/** A UI context that records widget mounts and forces a redraw on demand. */
function fakeUi() {
	const widgets = new Map<string, (tui: unknown, theme: unknown) => {
		render(width: number): string[];
		handleMouse(event: { type: string; button?: string; x?: number; y: number }): { handled: boolean } | undefined;
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
	const messageRenderers = new Map<string, MessageRenderer>();
	const fake = fakeUi();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		registerFlag: (name: string, config: { default: unknown }) => { if (!flags.has(name)) flags.set(name, config.default); },
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
		registerMessageRenderer: (name: string, renderer: MessageRenderer) => messageRenderers.set(name, renderer),
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
	function renderBlock(toolCallId: string, result: { content: unknown; details: unknown }, state = {}, expanded = false) {
		const base = { renderCall: () => ({ render: () => [] }), renderResult: () => ({ render: () => [] }) };
		const renderers = resolver!("bash", () => base as never)!;
		const invalidate = vi.fn();
		const component = renderers.renderResult!(
			{ content: result.content, details: result.details } as never,
			{ expanded, isPartial: false },
			theme as never,
			{ toolCallId, state, invalidate, executionStarted: true } as never,
		) as { render(width: number): string[] };
		return { component, invalidate, lines: () => component.render(200).map((line) => line.trim()).filter(Boolean) };
	}
	return { call, emit, fake, renderBlock, messageRenderers, tools, ctx, commands, shortcuts, messages: pi.sendMessage as ReturnType<typeof vi.fn>, resolver: () => resolver! };
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
	expect(widget.render(200)[0]).toContain("▾ 2 background jobs");
	expect(widget.render(200)[1]).toContain("#1 ●");
	expect(widget.render(200)[1]).toContain("setInterval");
	widget.handleMouse({ type: "click", button: "left", y: 0 });
	expect(widget.render(200)).toHaveLength(1);
	await h.commands.get("bash-jobs")!("toggle", h.ctx);
	expect(widget.render(200)).toHaveLength(3);
	await h.emit("session_before_switch");
	await h.call("bash", { command: idle, background: true });
	expect(h.fake.widgets.get("bash-guard-background")!(h.fake.tui, theme).render(200)).toHaveLength(1);
});

it("expands a clicked job row for details and cancels via inline clickable confirm", async () => {
	const h = await harness();
	const first = await h.call("bash", { command: idle, background: true });
	const second = await h.call("bash", { command: `${JSON.stringify(process.execPath)} -e 'console.log("LIVE_ROW"); setInterval(() => {}, 1000)'`, background: true });
	const firstId = (first.structuredContent as { job_id: string }).job_id;
	const secondId = (second.structuredContent as { job_id: string }).job_id;
	const widget = h.fake.widgets.get("bash-guard-background")!(h.fake.tui, theme);

	// Expand the list, then wait briefly so the second job prints output.
	expect(widget.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({ handled: true });
	await vi.waitFor(async () => {
		const st = await h.call("bash_jobs", { action: "status", job_id: secondId });
		expect((st.structuredContent as { jobs: { output: string }[] }).jobs[0]!.output).toContain("LIVE_ROW");
	}, { timeout: 3000 });

	const listRows = widget.render(200);
	const secondRowIndex = listRows.findIndex((row) => row.includes(secondId));
	expect(secondRowIndex).toBeGreaterThan(0);

	// Clicking the row opens its inline detail drawer with live output and [Cancel job].
	expect(widget.handleMouse({ type: "click", button: "left", y: secondRowIndex })).toEqual({ handled: true });
	const detailRows = widget.render(200);
	expect(detailRows.some((row) => row.includes("$ "))).toBe(true);
	expect(detailRows.some((row) => row.includes("LIVE_ROW"))).toBe(true);
	const cancelIndex = detailRows.findIndex((row) => row.includes("[Cancel job]"));
	expect(cancelIndex).toBeGreaterThan(secondRowIndex);

	// Clicking inside non-interactive detail text does not toggle or cancel.
	expect(widget.handleMouse({ type: "click", button: "left", y: secondRowIndex + 1 })).toBeUndefined();

	// Clicking [Cancel job] switches inline to [Confirm cancel] [Keep] (no modal dialog).
	const requestX = detailRows[cancelIndex]!.indexOf("[Cancel job]");
	expect(widget.handleMouse({ type: "click", button: "left", x: requestX, y: cancelIndex })).toEqual({ handled: true });
	expect(h.fake.confirms).toHaveLength(0);
	const confirmRows = widget.render(200);
	const confirmLine = confirmRows[cancelIndex]!;
	expect(confirmLine).toContain(`Cancel ${secondId}?`);
	expect(confirmLine).toContain("[Confirm cancel]");
	expect(confirmLine).toContain("[Keep]");

	// At ultra-narrow widths where buttons clip to "...", clicking them does not cancel.
	const clippedRows = widget.render(10);
	const clippedConfirmRow = clippedRows.findIndex((row) => row.includes("OW")) + 1;
	expect(clippedConfirmRow).toBeGreaterThan(0);
	expect(stripTerminalSequences(clippedRows[clippedConfirmRow]!)).toBe("       ...");
	expect(widget.handleMouse({ type: "click", button: "left", x: 7, y: clippedConfirmRow })).toBeUndefined();

	// Clicking [Keep] dismisses the confirm prompt without cancelling.
	const renderedAgain = widget.render(200);
	const keepX = renderedAgain[cancelIndex]!.indexOf("[Keep]");
	expect(widget.handleMouse({ type: "click", button: "left", x: keepX, y: cancelIndex })).toEqual({ handled: true });
	expect(widget.render(200)[cancelIndex]).toContain("[Cancel job]");
	const stillRunning = await h.call("bash_jobs", { action: "status", job_id: secondId });
	expect((stillRunning.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toBe("running");

	// Clicking [Cancel job] then [Confirm cancel] cancels only that job.
	expect(widget.handleMouse({ type: "click", button: "left", x: requestX, y: cancelIndex })).toEqual({ handled: true });
	const confirmX = widget.render(200)[cancelIndex]!.indexOf("[Confirm cancel]");
	expect(widget.handleMouse({ type: "click", button: "left", x: confirmX, y: cancelIndex })).toEqual({ handled: true });
	await vi.waitFor(async () => {
		const cancelled = await h.call("bash_jobs", { action: "status", job_id: secondId });
		expect((cancelled.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toMatch(/cancel/);
	});
	expect(h.fake.confirms).toHaveLength(0);
	const firstState = await h.call("bash_jobs", { action: "status", job_id: firstId });
	expect((firstState.structuredContent as { jobs: { state: string }[] }).jobs[0]!.state).toBe("running");

	await h.call("bash_jobs", { action: "cancel", job_id: firstId });
});

it("auto-expands the sole job drawer when expanding a single-job widget", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const widget = h.fake.widgets.get("bash-guard-background")!(h.fake.tui, theme);
	expect(widget.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({ handled: true });
	const rows = widget.render(200);
	expect(rows.some((row) => row.includes("(no output yet)"))).toBe(true);
	expect(rows.some((row) => row.includes("[Cancel job]"))).toBe(true);
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
});

it.each([60, 20000])("preserves native output and truncation for %i lines", async (count) => {
	const h = await harness();
	const command = `${JSON.stringify(process.execPath)} -e 'for(let i=0;i<${count};i++) console.log("line "+i)'`;
	await h.call("bash", { command, background: true });
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	const complete = Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");
	expect(message.content).not.toContain("output is a bounded tail");
	if (count === 60) {
		expect(message.details.truncated).toBe(false);
		expect(message.details.output).toBe(complete);
		expect(message.content).toContain(complete);
		expect(message.details.full_output_path).toBeUndefined();
		expect(message.content).not.toContain("Full output:");
	} else {
		expect(message.details.truncated).toBe(true);
		expect(message.details.full_output_path).toBeTruthy();
		expect(message.content).toContain(`Full output: ${message.details.full_output_path}`);
		expect(message.content).toContain(`line ${count - 2000}\n`);
		expect(message.content).toContain(`line ${count - 1}\n`);
		expect(readFileSync(message.details.full_output_path, "utf8")).toBe(complete);
	}
});

it("collapses completion messages at narrow widths and expands their native output", async () => {
	initTheme("dark", false);
	const h = await harness();
	await h.call("bash", {
		command: `${JSON.stringify(process.execPath)} -e 'console.log("OUTPUT_MARKER".repeat(300))'`,
		background: true,
	});
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	const renderer = h.messageRenderers.get("bash-guard-background")!;
	const ansiTheme = {
		fg: (_kind: string, text: string) => `\x1b[90m${text}\x1b[39m`,
		bg: (_kind: string, text: string) => `\x1b[45m${text}\x1b[49m`,
	};
	const collapsed = renderer(message, { expanded: false, outputPad: 1 }, ansiTheme as never)!;
	for (const width of [40, 70]) {
		const lines = collapsed.render(width);
		expect(lines.length).toBeLessThanOrEqual(7);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const commandLine = lines[2]!;
		const ellipsis = commandLine.lastIndexOf("...");
		expect(ellipsis).toBeGreaterThan(0);
		const backgroundCodes = /\x1b\[(?:0|45|49)m/g;
		expect(commandLine.slice(0, ellipsis).match(backgroundCodes)?.at(-1)).toBe("\x1b[45m");
		expect(commandLine.slice(0, commandLine.lastIndexOf(" ")).match(backgroundCodes)?.at(-1)).toBe("\x1b[45m");
		expect(lines[1]).toContain("✓ Bash completed");
		expect(lines[1]).not.toContain(message.details.job_id);
		expect(commandLine).toContain("$ ");
		expect(lines.at(-2)).toContain("to expand output");
		expect(lines.join("\n")).not.toContain("OUTPUT_MARKER".repeat(20));
	}
	const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme as never)!;
	const expandedText = expanded.render(100).join("\n");
	expect(expandedText).toContain("✓ Bash completed");
	expect(expandedText).toContain(message.details.job_id);
	expect(expandedText).toContain("$ ");
	expect(expandedText).toContain("OUTPUT_MARKER".repeat(5));
	expect(message.content).toContain("OUTPUT_MARKER".repeat(5));
});

it("shows (no output) on collapsed completion cards when the command printed nothing", async () => {
	initTheme("dark", false);
	const h = await harness();
	await h.call("bash", { command: `${JSON.stringify(process.execPath)} -e ''`, background: true });
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	const renderer = h.messageRenderers.get("bash-guard-background")!;
	const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme as never)!;
	expect(collapsed.render(80).join("\n")).toContain("(no output)");
	expect(collapsed.render(80).join("\n")).not.toContain("to expand output");
});

it("previews up to 2 sanitized output lines when collapsed and preserves multiline commands when expanded", async () => {
	initTheme("dark", false);
	const h = await harness();
	await h.call("bash", {
		command: `${JSON.stringify(process.execPath)} -e 'console.log("OUT_"+1); console.log("OUT_"+2); console.log("\\x1b[32mOUT_"+3+"\\x1b[0m")'\necho OUT_4`,
		background: true,
	});
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	const renderer = h.messageRenderers.get("bash-guard-background")!;
	const collapsedText = renderer(message, { expanded: false, outputPad: 1 }, theme as never)!.render(100).join("\n");
	expect(collapsedText).not.toContain("OUT_1");
	expect(collapsedText).not.toContain("OUT_2");
	expect(collapsedText).toContain("  OUT_3");
	expect(collapsedText).toContain("  OUT_4");
	expect(collapsedText).not.toContain("\x1b[32m");
	expect(collapsedText).toContain("to expand output (4 lines)");

	const expandedText = renderer(message, { expanded: true, outputPad: 1 }, theme as never)!.render(100).join("\n");
	expect(expandedText).toContain("  echo OUT_4");
	expect(expandedText).toContain("OUT_1");
	expect(expandedText).toContain("OUT_2");
	expect(expandedText).not.toContain("\x1b[32m");
});

it("shows the full-output path once when expanded output is truncated", async () => {
	initTheme("dark", false);
	const h = await harness();
	await h.call("bash", {
		command: `${JSON.stringify(process.execPath)} -e 'for(let i=0;i<2500;i++) console.log("line "+i)'`,
		background: true,
	});
	await vi.waitFor(() => expect(h.messages).toHaveBeenCalled(), { timeout: 5000 });
	const message = h.messages.mock.calls[0]![0];
	const renderer = h.messageRenderers.get("bash-guard-background")!;
	const expandedText = renderer(message, { expanded: true, outputPad: 1 }, theme as never)!.render(200).join("\n");
	const fullPathMatches = expandedText.split(message.details.full_output_path).length - 1;
	expect(fullPathMatches).toBe(1);
});

const idle = `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`;

it("mounts one aggregate widget row with the command when one job runs", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const widget = h.fake.widgets.get("bash-guard-background");
	expect(widget).toBeDefined();
	const rows = widget!(h.fake.tui, theme).render(200);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatch(/▸ 1 background job │ 0:0\d/);
	expect(rows[0]).toContain("setInterval");
	expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(200);
	await h.call("bash_jobs", { action: "cancel", job_id: (ack.structuredContent as { job_id: string }).job_id });
});

it("keeps a running block's clock live and settles it in place", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const block = h.renderBlock("call-1", ack);
	expect(block.lines().join("\n")).toBe(`● Running in background · 0:00 · ${jobId}`);

	// The shared ticker advances the clock without any new tool result.
	await new Promise((resolve) => setTimeout(resolve, 1100));
	expect(block.lines().join("\n")).toMatch(/● Running in background · 0:0[12]/);
	expect(block.invalidate).toHaveBeenCalled();

	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	await vi.waitFor(() => expect(block.lines().join("\n")).toContain("Cancelled"));
	expect(block.lines().join("\n")).not.toContain("Running");
});

it("shows live output in expanded transcript blocks and an expand hint when collapsed with output", async () => {
	initTheme("dark", false);
	const h = await harness();
	const ack = await h.call("bash", {
		command: `${JSON.stringify(process.execPath)} -e 'console.log("STREAMED_LINE"); setInterval(() => {}, 1000)'`,
		background: true,
	});
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	await vi.waitFor(async () => {
		const st = await h.call("bash_jobs", { action: "status", job_id: jobId });
		expect((st.structuredContent as { jobs: { output: string }[] }).jobs[0]!.output).toContain("STREAMED_LINE");
	}, { timeout: 3000 });
	const collapsed = h.renderBlock("call-1", ack, {}, false);
	expect(collapsed.lines().join("\n")).toContain("to expand output (1 line)");
	const block = h.renderBlock("call-1", ack, {}, true);
	expect(block.lines().join("\n")).toContain("STREAMED_LINE");
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
});

it("tags background: true calls in renderCall without changing normal calls", async () => {
	const h = await harness();
	const base = {
		renderCall: (args: { command: string }) => ({ render: () => [`$ ${args.command}`] }),
		renderResult: () => ({ render: () => [] }),
	};
	const decorated = h.resolver()("bash", () => base as never)!;
	const bgLines = (decorated.renderCall!(
		{ command: "sleep 8", background: true } as never,
		theme as never,
		{ toolCallId: "c1", state: {}, executionStarted: false } as never,
	) as { render(width: number): string[] }).render(80);
	expect(bgLines).toEqual(["$ sleep 8 (background)"]);

	const fgLines = (decorated.renderCall!(
		{ command: "echo hi" } as never,
		theme as never,
		{ toolCallId: "c2", state: {}, executionStarted: false } as never,
	) as { render(width: number): string[] }).render(80);
	expect(fgLines).toEqual(["$ echo hi"]);
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
	const block = h.renderBlock("call-1", ack);
	const first = block.lines().join("\n");
	expect(first).toContain("Running in background · 0:00");
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

it.each([true, false, undefined])("preserves native output collapse regardless of background=%s", async (background) => {
	initTheme("dark", false);
	const h = await harness();
	const base = h.tools.get("bash")!;
	const decorated = h.resolver()("bash", () => base)!;
	const result = { content: [{ type: "text" as const, text: "output line\n".repeat(100) }], details: undefined };
	const context = { toolCallId: "native", args: { command: "test", background }, state: {}, invalidate: vi.fn(), executionStarted: false };
	const collapsed = decorated.renderResult!(result, { expanded: false, isPartial: false }, theme as never, context as never);
	const lines = collapsed.render(80);
	expect(lines.length).toBeLessThanOrEqual(8);
	expect(lines.join("\n")).toContain("to expand");
	const expanded = decorated.renderResult!(result, { expanded: true, isPartial: false }, theme as never, context as never);
	expect(expanded.render(80).length).toBeGreaterThanOrEqual(100);
});

it("stops refreshing a block once it settles, so no idle repaint loop remains", async () => {
	const h = await harness();
	const ack = await h.call("bash", { command: idle, background: true });
	const jobId = (ack.structuredContent as { job_id: string }).job_id;
	const block = h.renderBlock("call-1", ack);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	expect(block.invalidate).toHaveBeenCalled();
	// Settle, then confirm no further invalidation and another job still refreshes.
	await h.call("bash_jobs", { action: "cancel", job_id: jobId });
	await vi.waitFor(() => expect(block.lines().join("\n")).toContain("Cancelled"));
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
