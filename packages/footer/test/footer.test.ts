import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import footerExtension, {
	AGENT_TIME_ENTRY,
	alignRightReserved,
	boldCyan,
	boldGreen,
	boldPurple,
	boldRed,
	boldYellow,
	clearRuntimeCache,
	CODEX_COLOR,
	color,
	DEFAULT_CONFIG,
	detectRuntime,
	extractRuntimeVersion,
	formatDuration,
	formatGitMetrics,
	formatModelIdentifier,
	formatStarshipIdentity,
	formatStarshipStatus,
	formatThinkingLevel,
	formatTokens,
	formatTokensWhole,
	getFooterConfigPath,
	hexColor,
	loadConfig,
	parseGitNumstat,
	rainbow,
	saveConfig,
	summarizeGitStatus,
	THINKING_THEME_TOKENS,
} from "../extensions/footer.js";

type Handler = (event: any, ctx?: any) => Promise<any> | any;
type FooterFactory = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string },
	data: {
		getGitBranch(): string | undefined;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	},
) => { render(width: number): string[]; dispose(): void };

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function setupFooter(
	opts: {
		appendEntry?: (customType: string, data: unknown) => void;
		exec?: (command: string, args: string[], options?: any) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
		notify?: (message: string, type: string) => void;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();

	const appendEntry = opts.appendEntry ?? vi.fn();
	const exec = opts.exec ?? (async () => ({ stdout: "", stderr: "", code: 1, killed: false }));
	const notify = opts.notify ?? vi.fn();

	footerExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		appendEntry,
		exec,
	} as unknown as ExtensionAPI);

	return {
		handlers,
		commands,
		appendEntry,
		notify,
		async start(ctx: Partial<ExtensionContext>): Promise<FooterFactory> {
			let capturedFooterFactory: FooterFactory | undefined;
			const context = {
				mode: "tui",
				cwd: "/mock-cwd",
				model: { id: "gpt-5.6-sol", provider: "openai" },
				thinkingLevel: "high",
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10.0 }),
				ui: {
					setFooter(factory: FooterFactory) {
						capturedFooterFactory = factory;
					},
					notify,
				},
				...ctx,
			} as unknown as ExtensionContext;

			const sessionStart = handlers.get("session_start");
			if (sessionStart) {
				await sessionStart({}, context);
			}
			return capturedFooterFactory!;
		},
	};
}

describe("pi-footer extension", () => {
	const testDir = join(tmpdir(), `pi-footer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const piHome = join(testDir, ".pi", "agent");

	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = piHome;
		mkdirSync(piHome, { recursive: true });
		clearRuntimeCache();
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(testDir, { recursive: true, force: true });
		clearRuntimeCache();
	});
	describe("formatting helpers", () => {
		it("formats token counts properly", () => {
			expect(formatTokens(500)).toBe("500");
			expect(formatTokens(1_200)).toBe("1.2k");
			expect(formatTokens(250_400)).toBe("250.4k");
			expect(formatTokens(1_500_000)).toBe("1.5M");
		});

		it("formats context window tokens in whole units", () => {
			expect(formatTokensWhole(500)).toBe("500");
			expect(formatTokensWhole(100_000)).toBe("100k");
			expect(formatTokensWhole(1_500_000)).toBe("2M");
		});

		it("formats durations properly", () => {
			expect(formatDuration(45_000)).toBe("45s");
			expect(formatDuration(135_000)).toBe("2m 15s");
			expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
		});

		it("aligns right-reserved content safely", () => {
			const aligned = alignRightReserved("left content", "right", 30, "…");
			expect(stripTerminalSequences(aligned).length).toBeLessThanOrEqual(30);
			expect(aligned).toContain("right");
			expect(aligned).toContain("left content");

			// Truncates left when width is narrow
			const narrow = alignRightReserved("very long left content that overflows", "right", 15, "…");
			expect(stripTerminalSequences(narrow).length).toBeLessThanOrEqual(15);
			expect(narrow).toContain("right");
		});

		it("formats rainbow text correctly", () => {
			const text = rainbow("ultra");
			expect(stripTerminalSequences(text)).toBe("ultra");
			expect(text).toContain("\x1b[38;5;196mu");
		});

		it("formats hexColor to 24-bit ANSI escape codes", () => {
			const colored = hexColor(CODEX_COLOR, "test");
			expect(colored).toBe("\x1b[38;2;181;189;104mtest\x1b[39m");
			expect(stripTerminalSequences(colored)).toBe("test");
		});

		it("formats model identifier with provider prefix when available", () => {
			expect(formatModelIdentifier({ id: "gemini-2.5-pro", provider: "cliproxy" })).toBe("cliproxy/gemini-2.5-pro");
			expect(formatModelIdentifier({ id: "gpt-5.6-sol", provider: "openai" })).toBe("openai/gpt-5.6-sol");
			expect(formatModelIdentifier({ id: "cliproxy/gemini-2.5-pro", provider: "cliproxy" })).toBe("cliproxy/gemini-2.5-pro");
			expect(formatModelIdentifier({ id: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
			expect(formatModelIdentifier(undefined)).toBe("no-model");
		});

		it("formats thinking level using theme getThinkingBorderColor and fallbacks", () => {
			const mockThemeWithBorder = {
				fg: (col: string, text: string) => `[${col}]${text}[/${col}]`,
				getThinkingBorderColor: (level: string) => (text: string) => `[border:${level}]${text}[/border]`,
			};

			expect(formatThinkingLevel("high", mockThemeWithBorder)).toBe("[border:high]high[/border]");
			expect(formatThinkingLevel("off", mockThemeWithBorder)).toBe("[border:off]off[/border]");

			// ultra always gets special rainbow treatment
			const ultraResult = formatThinkingLevel("ultra", mockThemeWithBorder);
			expect(stripTerminalSequences(ultraResult)).toBe("ultra");
			expect(ultraResult).toContain("\x1b[38;5;196mu");

			// Fallback when getThinkingBorderColor is not implemented on theme
			const mockThemeWithoutBorder = {
				fg: (col: string, text: string) => `[${col}]${text}[/${col}]`,
			};
			expect(formatThinkingLevel("minimal", mockThemeWithoutBorder)).toBe("[thinkingMinimal]minimal[/thinkingMinimal]");
			expect(formatThinkingLevel("xhigh", mockThemeWithoutBorder)).toBe("[thinkingXhigh]xhigh[/thinkingXhigh]");
			expect(formatThinkingLevel("unknown", mockThemeWithoutBorder)).toBe("[thinkingOff]unknown[/thinkingOff]");
		});
	});

	describe("git status badges parsing", () => {
		it("parses porcelain v2 output and active operations", () => {
			const output = [
				"# branch.oid abcdef1234567890",
				"# branch.head feature",
				"# branch.upstream origin/feature",
				"# branch.ab +3 -1",
				"1 M. N... staged.txt",
				"1 .M N... modified.txt",
				"u UU N... conflict.txt",
				"? untracked.txt",
			].join("\n");

			const summary = summarizeGitStatus(output, "REBASE 2/5");
			expect(summary.badges).toBe("[REBASE 2/5 !1+1~1?1↑3↓1]");
			expect(summary.detachedOid).toBe("abcdef1");
		});

		it("returns empty badges for clean and synced git status", () => {
			const output = [
				"# branch.oid abcdef1234567890",
				"# branch.head main",
				"# branch.upstream origin/main",
				"# branch.ab +0 -0",
			].join("\n");

			const summary = summarizeGitStatus(output);
			expect(summary.badges).toBe("");
		});

		it("identifies detached HEAD commit hash", () => {
			const output = [
				"# branch.oid 1234567890abcdef",
				"# branch.head (detached)",
			].join("\n");

			const summary = summarizeGitStatus(output);
			expect(summary.detachedOid).toBe("1234567");
		});
	});

	describe("footer rendering and layout", () => {
		it("renders complete 3-line footer with codex-auth, metrics, and runtime", async () => {
			const entries = [
				{ type: "message", message: { role: "assistant", usage: usage(1_000, 200, 500, 0.05) } },
				{ type: "message", message: { role: "toolResult", usage: usage(100, 50, 0, 0.01) } },
				{ type: "compaction", usage: usage(1_200, 100, 0, 0.02) },
				{
					type: "custom_message",
					customType: "subagent-background-result",
					details: { usage: usage(500, 100, 0, 0.02) },
				},
			];

			const gitOutput = "/Users/test/repo\n/Users/test/repo/.git\n/Users/test/repo/.git\n";
			const { start } = setupFooter({
				exec: async () => ({ stdout: gitOutput, stderr: "", code: 0, killed: false }),
			});

			const factory = await start({
				cwd: "/Users/test/repo",
				sessionManager: { getEntries: () => entries as any } as any,
				getContextUsage: () => ({ tokens: 45_000, contextWindow: 100_000, percent: 45.0 }),
			});

			const extensionStatuses = new Map([
				["codex-auth", "codex #1 · 5h 95% · 7d 99%"],
				["another-ext", "custom-status-text"],
			]);

			const theme = { fg: (_c: string, text: string) => text };
			const footer = factory(
				{ requestRender() {} },
				theme,
				{
					getGitBranch: () => "worktree/feature-branch",
					getExtensionStatuses: () => extensionStatuses,
					onBranchChange: () => () => {},
				},
			);

			const rendered = footer.render(100);
			expect(rendered).toHaveLength(3);

			const [line1, line2, line3] = rendered.map((l) => stripTerminalSequences(l));

			// Line 1: repo · branch and codex status on right
			expect(line1).toContain("repo ·  feature-branch");
			expect(line1).toContain("codex #1 · 5h 95% · 7d 99%");
			expect(rendered[0]).toContain("\x1b[38;2;181;189;104m"); // Colors codex footer with #b5bd68

			// Line 2: usage metrics and model/thinking on right
			expect(line2).toContain("↑ 2.8k ↓ 450 · ◔ 45.0k/100k · ↺ 33.3%"); // Context sits right after tokens
			expect(line2).toContain("$ 0.100"); // 0.05 + 0.01 + 0.02 + 0.02
			expect(line2.indexOf("$ 0.100")).toBeGreaterThan(line2.indexOf("◔")); // Cost renders last
			expect(line2).toContain("openai/gpt-5.6-sol • high");

			// Line 3: external statuses on left, runtime on right
			expect(line3).toContain("custom-status-text");
			expect(line3).toContain("◷ 0s");

			footer.dispose();
		});

		it("renders the window size even when used tokens are unknown after compaction", async () => {
			const { start } = setupFooter();
			const factory = await start({
				getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }),
			});

			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			expect(stripTerminalSequences(footer.render(100)[1]!)).toContain("◔ —/100k");
			footer.dispose();
		});

		it("renders an em dash context segment when no model context window is available", async () => {
			const { start } = setupFooter();
			const factory = await start({
				getContextUsage: () => undefined,
			});

			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			expect(stripTerminalSequences(footer.render(100)[1]!)).toContain("◔ —");
			footer.dispose();
		});

		it("renders thinking levels following Pi editor colors and handles ultra rainbow", async () => {
			const { start } = setupFooter();
			const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "off"] as const;

			for (const level of levels) {
				const factory = await start({
					thinkingLevel: level as any,
				});

				const footer = factory(
					{ requestRender() {} },
					{
						fg: (c: string, text: string) => `[fg:${c}:${text}]`,
						getThinkingBorderColor: (lvl: string) => (text: string) => `[editor-thinking:${lvl}:${text}]`,
					} as any,
					{
						getGitBranch: () => "main",
						getExtensionStatuses: () => new Map(),
						onBranchChange: () => () => {},
					},
				);

				const line2 = footer.render(100)[1]!;
				if (level === "ultra") {
					expect(line2).toContain("\x1b[38;5;196mu");
				} else {
					expect(line2).toContain(`[editor-thinking:${level}:${level}]`);
				}

				footer.dispose();
			}
		});

		it("handles detached HEAD and renders @<short-oid>", async () => {
			const { start } = setupFooter({
				exec: async (_cmd, args) => {
					if (args[0] === "rev-parse") {
						return { stdout: "/mock/repo\n/mock/repo/.git\n/mock/repo/.git\n", stderr: "", code: 0, killed: false };
					}
					return {
						stdout: "# branch.oid a1b2c3d4e5f6\n# branch.head (detached)\n",
						stderr: "",
						code: 0,
						killed: false,
					};
				},
			});

			const factory = await start({
				cwd: "/mock/repo",
			});

			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "detached",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			const line1 = stripTerminalSequences(footer.render(100)[0]!);
			expect(line1).toContain(" @a1b2c3d");
			footer.dispose();
		});

		it("omits codex info when codex-auth footer status is not published", async () => {
			const { start } = setupFooter({
				exec: async () => ({ stdout: "/mock/repo\n/mock/repo/.git\n/mock/repo/.git\n", stderr: "", code: 0, killed: false }),
			});
			const factory = await start({ cwd: "/mock/repo" });
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(), // No codex status published
					onBranchChange: () => () => {},
				},
			);

			const line1 = stripTerminalSequences(footer.render(100)[0]!);
			expect(line1).toBe("repo ·  main");
			expect(line1).not.toContain("codex");
			footer.dispose();
		});
	});

	describe("agent runtime tracking and prompt pauses", () => {
		let originalNow: () => number;
		let mockNow = 0;

		beforeEach(() => {
			originalNow = performance.now;
			mockNow = 1_000;
			performance.now = () => mockNow;
		});

		afterEach(() => {
			performance.now = originalNow;
		});

		it("measures active agent runtime and pauses during ui prompts", async () => {
			const appendEntry = vi.fn();
			const { handlers, start } = setupFooter({ appendEntry });

			const factory = await start({});
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			// Start agent run
			handlers.get("agent_start")!({});
			mockNow += 5_000; // 5 seconds active

			expect(footer.render(100)[2]!).toContain("◷ 5s");

			// UI Prompt start (pauses timer)
			handlers.get("ui_prompt_start")!({});
			mockNow += 10_000; // 10 seconds waiting for user (should NOT count)

			expect(footer.render(100)[2]!).toContain("◷ 5s");

			// UI Prompt end (resumes timer)
			handlers.get("ui_prompt_end")!({});
			mockNow += 3_000; // 3 more seconds active

			expect(footer.render(100)[2]!).toContain("◷ 8s");

			// Agent settled
			await handlers.get("agent_settled")!({}, { isIdle: () => true });

			expect(appendEntry).toHaveBeenCalledWith(AGENT_TIME_ENTRY, 8_000);
			expect(footer.render(100)[2]!).toContain("◷ 8s");

			footer.dispose();
		});

		it("restores persisted agent work time across sessions", async () => {
			const persistedEntries = [
				{ type: "custom", customType: AGENT_TIME_ENTRY, data: 120_000 }, // 2 minutes
			];

			const { start } = setupFooter();
			const factory = await start({
				sessionManager: { getEntries: () => persistedEntries as any } as any,
			});

			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			expect(footer.render(100)[2]!).toContain("◷ 2m 0s");
			footer.dispose();
		});
	});

	describe("tokens per second (TPS) tracking", () => {
		let originalNow: () => number;
		let mockNow = 0;

		beforeEach(() => {
			originalNow = performance.now;
			mockNow = 1_000;
			performance.now = () => mockNow;
		});

		afterEach(() => {
			performance.now = originalNow;
		});

		it("calculates average TPS across assistant turns in a prompt and preserves value on finish", async () => {
			const { handlers, start } = setupFooter();
			const factory = await start({});
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			// Initial state
			expect(footer.render(100)[1]!).toContain(" —");

			// Start prompt / run
			handlers.get("agent_start")!({});

			// First assistant response (e.g. tool call: 40 tokens in 1s -> 40 t/s)
			await handlers.get("message_start")!({ message: { role: "assistant" } });
			mockNow += 1_000;
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 40 } } });
			expect(footer.render(100)[1]!).toContain(" 40.0 t/s");

			// Tool execution happens here (e.g. 5 seconds, should NOT count toward generation TPS)
			mockNow += 5_000;

			// Second assistant response (e.g. final response: 160 tokens in 3s)
			// Total output = 40 + 160 = 200 tokens; Total gen time = 1s + 3s = 4s -> Average TPS = 50.0 t/s
			await handlers.get("message_start")!({ message: { role: "assistant" } });
			mockNow += 3_000;
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 160 } } });
			expect(footer.render(100)[1]!).toContain(" 50.0 t/s");

			// Agent finishes and settles
			await handlers.get("agent_settled")!({}, { isIdle: () => true });

			// The TPS number must NOT disappear or reset to '—' when the model finishes!
			expect(footer.render(100)[1]!).toContain(" 50.0 t/s");

			// Stray message_end without message_start must NOT wipe TPS
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 0 } } });
			expect(footer.render(100)[1]!).toContain(" 50.0 t/s");

			footer.dispose();
		});

		it("isolates TTFT when message_update is received during streaming", async () => {
			const { handlers, start } = setupFooter();
			const factory = await start({});
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			handlers.get("agent_start")!({});

			// TTFT: 600ms waiting for first token
			await handlers.get("message_start")!({ message: { role: "assistant" } });
			mockNow += 600;

			// First token arrives
			await handlers.get("message_update")!({ message: { role: "assistant" } });

			// Pure decode generation: 200 tokens over 2.0s (100 tok/s)
			mockNow += 2_000;
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 200 } } });

			// If TTFT was erroneously included, rate would be 200 / 2.6 = 76.9 t/s.
			// With TTFT properly isolated, rate is 200 / 2.0 = 100.0 t/s.
			expect(footer.render(100)[1]!).toContain(" 100.0 t/s");

			footer.dispose();
		});

		it("bounds extreme bursts (e.g. 100 tokens in 30ms) to physical limits rather than spiking to thousands of t/s", async () => {
			const { handlers, start } = setupFooter();
			const factory = await start({});
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			handlers.get("agent_start")!({});

			// Fast tool call or unstreamed burst: 100 tokens in 30ms (unclamped would be 3,333 t/s!)
			await handlers.get("message_start")!({ message: { role: "assistant" } });
			mockNow += 30;
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 100 } } });

			// Clamped to MAX_PLAUSIBLE_TPS (500 t/s)
			expect(footer.render(100)[1]!).toContain(" 500.0 t/s");

			footer.dispose();
		});

		it("falls back to total turn elapsed time when proxy buffers stream and dumps all deltas in milliseconds", async () => {
			const { handlers, start } = setupFooter();
			const factory = await start({});
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			handlers.get("agent_start")!({});

			// Server spent 800ms generating
			await handlers.get("message_start")!({ message: { role: "assistant" } });
			mockNow += 800;

			// Proxy flushes buffer all at once: first delta arrives at 800ms
			await handlers.get("message_update")!({ message: { role: "assistant" } });

			// Socket dump completes 20ms later (total turn = 820ms, decode span = 20ms)
			mockNow += 20;
			await handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 60 } } });

			// Pure decode span (60 / 0.02 = 3000 t/s) is rejected as an artifact;
			// falls back to actual total turn time: 60 / 0.82s = 73.2 t/s!
			expect(footer.render(100)[1]!).toContain(" 73.2 t/s");

			footer.dispose();
		});
	});

	describe("concurrency & stale git refresh prevention", () => {
		it("ensures newer git status replaces older overlapping calls", async () => {
			const resolvers: Array<(val: any) => void> = [];
			let statusCallCount = 0;

			const { handlers, start } = setupFooter({
				exec: async (_cmd, args) => {
					if (args[0] === "rev-parse") {
						return { stdout: "/repo\n/repo/.git\n/repo/.git\n", stderr: "", code: 0, killed: false };
					}
					if (statusCallCount++ === 0) {
						return { stdout: "# branch.oid 111\n# branch.head main\n", stderr: "", code: 0, killed: false };
					}
					return new Promise((resolve) => {
						resolvers.push(resolve);
					});
				},
			});

			const factory = await start({ cwd: "/repo" });
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);

			const idleCtx = { isIdle: () => true };
			const refresh1 = handlers.get("agent_settled")!(undefined, idleCtx);
			const refresh2 = handlers.get("agent_settled")!(undefined, idleCtx);

			expect(resolvers).toHaveLength(2);

			// Resolve second refresh first with ?2
			resolvers[1]!({
				stdout: "# branch.oid 111\n# branch.head main\n? file1\n? file2\n",
				stderr: "",
				code: 0,
				killed: false,
			});
			await refresh2;
			expect(stripTerminalSequences(footer.render(100)[0]!)).toContain("[?2]");

			// Stale first refresh resolves with ?1 (should NOT overwrite ?2)
			resolvers[0]!({
				stdout: "# branch.oid 111\n# branch.head main\n? file1\n",
				stderr: "",
				code: 0,
				killed: false,
			});
			await refresh1;
			expect(stripTerminalSequences(footer.render(100)[0]!)).toContain("[?2]");

			footer.dispose();
		});
	});

	describe("/footer toggle command", () => {
		it("toggles custom footer and restores default footer", async () => {
			let currentFooter: any = null;
			const notify = vi.fn();
			const mockCtx = {
				mode: "tui",
				cwd: "/repo",
				ui: {
					setFooter: vi.fn((f) => {
						currentFooter = f;
					}),
					notify,
				},
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
			};

			const { commands, start } = setupFooter({ notify });
			await start(mockCtx as any);
			expect(mockCtx.ui.setFooter).toHaveBeenCalledTimes(1);

			const footerCmd = commands.get("footer");
			expect(footerCmd).toBeDefined();

			// Toggle off
			await footerCmd.handler("", mockCtx);
			expect(mockCtx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
			expect(notify).toHaveBeenCalledWith("Default footer restored", "info");

			// Toggle on
			await footerCmd.handler("", mockCtx);
			expect(mockCtx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
			expect(notify).toHaveBeenCalledWith("Custom footer enabled", "info");
		});

		it("switches styles via command arguments and persists configuration", async () => {
			const notify = vi.fn();
			const mockCtx = {
				mode: "tui",
				cwd: "/repo",
				ui: {
					setFooter: vi.fn(),
					notify,
				},
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
			};

			const { commands, start } = setupFooter({ notify });
			await start(mockCtx as any);

			const footerCmd = commands.get("footer");

			// Set to starship
			await footerCmd.handler("starship", mockCtx);
			expect(notify).toHaveBeenCalledWith("Footer style: starship", "info");
			let cfg = loadConfig();
			expect(cfg.style).toBe("starship");
			expect(cfg.enabled).toBe(true);

			// Set to classic
			await footerCmd.handler("style classic", mockCtx);
			expect(notify).toHaveBeenCalledWith("Footer style: classic", "info");
			cfg = loadConfig();
			expect(cfg.style).toBe("classic");

			// Subcommands on and off
			await footerCmd.handler("off", mockCtx);
			expect(notify).toHaveBeenCalledWith("Custom footer disabled (default footer restored)", "info");
			expect(loadConfig().enabled).toBe(false);

			await footerCmd.handler("on", mockCtx);
			expect(notify).toHaveBeenCalledWith("Custom footer enabled", "info");
			expect(loadConfig().enabled).toBe(true);
		});

		it("provides an interactive selector when ctx.ui.select is available", async () => {
			const notify = vi.fn();
			let selectedChoice: string | undefined;
			const mockCtx = {
				mode: "tui",
				cwd: "/repo",
				ui: {
					setFooter: vi.fn(),
					notify,
					select: vi.fn(async (_title: string, _options: string[]) => selectedChoice),
				},
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
			};

			const { commands, start } = setupFooter({ notify });
			await start(mockCtx as any);
			const footerCmd = commands.get("footer");

			// 1. Select Starship style from menu
			selectedChoice = "Style: Starship";
			await footerCmd.handler("", mockCtx);
			expect(mockCtx.ui.select).toHaveBeenCalledWith("Footer Configuration", expect.any(Array));
			expect(notify).toHaveBeenCalledWith("Footer style: starship", "info");
			expect(loadConfig().style).toBe("starship");

			// 2. Select Classic style from menu
			selectedChoice = "Style: Classic";
			await footerCmd.handler("", mockCtx);
			expect(notify).toHaveBeenCalledWith("Footer style: classic", "info");
			expect(loadConfig().style).toBe("classic");

			// 3. Select Toggle from menu
			selectedChoice = "Footer: Enabled (click to disable)";
			await footerCmd.handler("", mockCtx);
			expect(notify).toHaveBeenCalledWith("Default footer restored", "info");
			expect(loadConfig().enabled).toBe(false);

			// 4. Cancel selector (returns undefined)
			notify.mockClear();
			selectedChoice = undefined;
			await footerCmd.handler("", mockCtx);
			expect(notify).not.toHaveBeenCalled();

			// 5. Select Style via /footer style submenu
			selectedChoice = "starship";
			await footerCmd.handler("style", mockCtx);
			expect(mockCtx.ui.select).toHaveBeenCalledWith("Select Footer Style", expect.any(Array));
			expect(notify).toHaveBeenCalledWith("Footer style: starship", "info");
			expect(loadConfig().style).toBe("starship");
		});
	});

	describe("starship style formatting & helpers", () => {
		it("formats ANSI styled colors cleanly", () => {
			const cyan = boldCyan("my-repo");
			expect(cyan).toContain("\x1b[1;36m");
			expect(stripTerminalSequences(cyan)).toBe("my-repo");

			const purple = boldPurple(" main");
			expect(purple).toContain("\x1b[1;35m");
			expect(stripTerminalSequences(purple)).toBe(" main");

			const red = boldRed("[!?]");
			expect(red).toContain("\x1b[1;31m");
			expect(stripTerminalSequences(red)).toBe("[!?]");

			const green = boldGreen("+10");
			expect(green).toContain("\x1b[1;32m");
			expect(stripTerminalSequences(green)).toBe("+10");

			const yellow = boldYellow("v3.12");
			expect(yellow).toContain("\x1b[1;33m");
			expect(stripTerminalSequences(yellow)).toBe("v3.12");
		});

		it("parses git diff numstat output properly", () => {
			const numstat = [
				"1460\t682\tpackage-lock.json",
				"4\t4\tpackage.json",
				"33\t7\tui.ts",
				"30\t0\ttest.ts",
				"-\t-\timage.png", // binary skipped
				"invalid line",
			].join("\n");

			const metrics = parseGitNumstat(numstat);
			expect(metrics.added).toBe(1527);
			expect(metrics.deleted).toBe(693);
		});

		it("formats git diff metrics properly", () => {
			const formatted = formatGitMetrics({ added: 1527, deleted: 693 });
			expect(stripTerminalSequences(formatted)).toBe("+1527 -693");
			expect(formatted).toContain("\x1b[1;32m+1527");
			expect(formatted).toContain("\x1b[1;31m-693");

			expect(stripTerminalSequences(formatGitMetrics({ added: 10, deleted: 0 }))).toBe("+10");
			expect(stripTerminalSequences(formatGitMetrics({ added: 0, deleted: 5 }))).toBe("-5");
			expect(formatGitMetrics({ added: 0, deleted: 0 })).toBe("");
		});

		it("formats starship status badges with glyphs and operations", () => {
			// modified and untracked -> [!?]
			const status1 = formatStarshipStatus({
				conflicts: 0,
				staged: 0,
				unstaged: 2,
				untracked: 1,
				ahead: 0,
				behind: 0,
			});
			expect(stripTerminalSequences(status1)).toBe("[!?]");
			expect(status1).toContain("\x1b[1;31m");

			// staged + unstaged + untracked + ahead -> [!+?↑]
			const status2 = formatStarshipStatus({
				conflicts: 0,
				staged: 1,
				unstaged: 1,
				untracked: 1,
				ahead: 2,
				behind: 0,
			});
			expect(stripTerminalSequences(status2)).toBe("[!+?↑]");

			// with active rebase operation
			const status3 = formatStarshipStatus({
				conflicts: 1,
				staged: 0,
				unstaged: 1,
				untracked: 0,
				ahead: 0,
				behind: 0,
				operation: "REBASING 1/3",
			});
			expect(stripTerminalSequences(status3)).toBe("REBASING 1/3 [=!]");

			// clean
			const clean = formatStarshipStatus({
				conflicts: 0,
				staged: 0,
				unstaged: 0,
				untracked: 0,
				ahead: 0,
				behind: 0,
			});
			expect(clean).toBe("");
		});

		it("extracts runtime versions from command outputs", () => {
			expect(extractRuntimeVersion("v26.7.0\n")).toBe("v26.7.0");
			expect(extractRuntimeVersion("Python 3.12.2")).toBe("v3.12.2");
			expect(extractRuntimeVersion("rustc 1.76.0 (07dca489a 2024-02-04)")).toBe("v1.76.0");
			expect(extractRuntimeVersion("go version go1.22.0 darwin/arm64")).toBe("v1.22.0");
			expect(extractRuntimeVersion("deno 1.40.0")).toBe("v1.40.0");
			expect(extractRuntimeVersion("1.1.20")).toBe("v1.1.20");
			expect(extractRuntimeVersion("")).toBeUndefined();
		});

		it("detects runtime from markers and caches the result", async () => {
			const projectDir = join(tmpdir(), `pi-footer-runtime-${Date.now()}`);
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "package.json"), "{}");

			let execCalls = 0;
			const mockExec = async (cmd: string) => {
				execCalls++;
				if (cmd === "node") return { stdout: "v26.7.0\n", stderr: "", code: 0 };
				return { stdout: "", stderr: "", code: 1 };
			};

			const runtime = await detectRuntime(projectDir, mockExec);
			expect(runtime).toBeDefined();
			expect(runtime?.name).toBe("nodejs");
			expect(runtime?.symbol).toBe("");
			expect(runtime?.version).toBe("v26.7.0");
			expect(execCalls).toBe(1);

			// Calling again should use cache
			const cached = await detectRuntime(projectDir, mockExec);
			expect(cached).toEqual(runtime);
			expect(execCalls).toBe(1);

			// Clearing cache allows re-execution
			clearRuntimeCache();
			await detectRuntime(projectDir, mockExec);
			expect(execCalls).toBe(2);

			rmSync(projectDir, { recursive: true, force: true });
		});

		it("formats full starship identity line identically to starship style", () => {
			const theme = {
				fg: (_col: string, text: string) => text,
			};

			const formatted = formatStarshipIdentity({
				repo: "zle-pi",
				branch: "main",
				starshipBadges: boldRed("[!?]"),
				metrics: { added: 1527, deleted: 693 },
				runtime: {
					name: "nodejs",
					symbol: "",
					version: "v26.7.0",
					style: boldGreen,
				},
				theme,
			});

			expect(stripTerminalSequences(formatted)).toBe("zle-pi on  main [!?] +1527 -693 via  v26.7.0");
		});

		it("renders Starship Line 1 when style is set to starship", async () => {
			saveConfig({ enabled: true, style: "starship" });

			const { start } = setupFooter({
				exec: async (_cmd, args) => {
					if (args[0] === "rev-parse") {
						return { stdout: "/repo\n/repo/.git\n/repo/.git\n", stderr: "", code: 0, killed: false };
					}
					if (args[0] === "status") {
						return {
							stdout: "# branch.oid 1234567\n# branch.head main\n1 .M N... modified.txt\n? untracked.txt\n",
							stderr: "",
							code: 0,
							killed: false,
						};
					}
					if (args[0] === "diff") {
						return {
							stdout: "1527\t693\tfile.ts\n",
							stderr: "",
							code: 0,
							killed: false,
						};
					}
					return { stdout: "", stderr: "", code: 1, killed: false };
				},
			});

			const factory = await start({ cwd: "/repo" });
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map([["codex-auth", "codex #1 · 5h 95%"]]),
					onBranchChange: () => () => {},
				},
			);

			const line1 = stripTerminalSequences(footer.render(120)[0]!);
			expect(line1).toContain("repo on  main");
			expect(line1).toContain("[!?]");
			expect(line1).toContain("+1527 -693");
			expect(line1).toContain("codex #1 · 5h 95%");

			footer.dispose();
		});
	});
});
