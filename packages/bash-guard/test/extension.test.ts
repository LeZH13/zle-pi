/*
 * Extension lifecycle, tool_call gating, and the runtime capability marker.
 *
 * The SDK's real `createBashToolDefinition` is used end-to-end, but its inner
 * shell operations are mocked at module level, so no real shell is ever
 * spawned: guard denials block before execution, and allowed calls run against
 * a recording stub.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEventResult,
	ToolRenderers,
	ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_MODE_ENV, type GuardConfig, type JevConfig, type WatchdogConfig } from "../src/config.js";
import { BASH_GUARD_RUNTIME_SYMBOL, type BashGuardRuntime } from "../src/runtime.js";
import { ALLOW_ENTRY_TYPE, SETTINGS_ENTRY_TYPE } from "../src/state.js";
import bashGuardExtension from "../extensions/index.js";

const mocks = vi.hoisted(() => ({ shellCalls: [] as { command: string; cwd: string }[], agentDir: "/nonexistent-bash-guard-test-agent" }));
const tempProjects: string[] = [];

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		// Hermetic config lookup: never read the developer's ~/.pi/agent config.
		getAgentDir: () => mocks.agentDir,
		// Recorded shell backend: the wrapper under test delegates to it, so a
		// passing command proves wiring without spawning a real shell.
		createLocalBashOperations: () => ({
			exec: async (command: string, cwd: string) => {
				mocks.shellCalls.push({ command, cwd });
				return { exitCode: 0 };
			},
		}),
	};
});

function globalSymbols(): Record<symbol, unknown> {
	return globalThis as unknown as Record<symbol, unknown>;
}

function runtime(): BashGuardRuntime | undefined {
	return globalSymbols()[BASH_GUARD_RUNTIME_SYMBOL] as BashGuardRuntime | undefined;
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

interface Registry {
	classify: ReturnType<typeof vi.fn>;
	getModelOfType: () => unknown;
	getAvailableOfType: (type: string, provider: string) => Promise<unknown[]>;
}

function makeRegistry(jevP: number): Registry {
	const model = { provider: "typesafe", id: "jev-latest", contextWindow: 1000 };
	return {
		classify: vi.fn(async () => ({
			stopReason: "stop",
			provider: "typesafe",
			model: "jev-latest",
			answers: { irreversible: { type: "bool", probability: jevP } },
			usage: { input: 10, output: 5, totalTokens: 15, cost: 0.001 },
		})),
		getModelOfType: () => model,
		getAvailableOfType: async () => [model],
	};
}

type BashExecute = (
	toolCallId: string,
	params: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;

interface Harness {
	ui: {
		notify: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
	entries: { type: string; data: unknown }[];
	sessionStart(reason?: "startup" | "reload" | "new" | "resume" | "fork"): Promise<void>;
	tree(branch: unknown[]): Promise<void>;
	branch(): unknown[];
	completions(prefix: string): unknown;
	shutdown(): Promise<void>;
	toolCall(command: string, toolCallId?: string): Promise<ToolCallEventResult | undefined>;
	command(args: string): Promise<void>;
	registeredBashTool(): BashExecute | undefined;
	bashRenderers(decorate?: (base: ToolRenderers) => ToolRenderers): ToolRenderers;
	toolEnd(toolCallId: string): Promise<void>;
	registry: Registry | undefined;
}

function makeHarness(
	options: {
		flag?: boolean;
		hasUI?: boolean;
		jevP?: number;
		branch?: unknown[];
		branchThrows?: boolean;
		/** Trusted, user-level config written to a temp agent dir. */
		userConfig?: { guard?: Partial<GuardConfig>; watchdog?: Partial<WatchdogConfig>; jev?: Partial<JevConfig> };
		/** Untrusted, project-level config written to `<cwd>/.pi/bash-guard.json`. */
		config?: { guard?: Partial<GuardConfig>; watchdog?: Partial<WatchdogConfig>; jev?: Partial<JevConfig> };
	} = {},
): Harness {
	let cwd = "/proj";
	let agentDir = "/nonexistent-bash-guard-test-agent";
	if (options.userConfig) {
		agentDir = mkdtempSync(join(tmpdir(), "bash-guard-agent-"));
		tempProjects.push(agentDir);
		writeFileSync(join(agentDir, "bash-guard.json"), JSON.stringify(options.userConfig));
	}
	mocks.agentDir = agentDir;
	if (options.config) {
		cwd = mkdtempSync(join(tmpdir(), "bash-guard-config-"));
		tempProjects.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "bash-guard.json"), JSON.stringify(options.config));
	}
	let branch = [...(options.branch ?? [])];
	let complete: ((prefix: string) => unknown) | undefined;
	const flags = new Map<string, boolean | string>([["no-bash-guard", options.flag ?? false]]);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const shortcuts = new Map<string, () => void>();
	const tools: { name: string; definition: { name: string; execute: BashExecute } & ToolRenderers }[] = [];
	let rendererResolver: ToolRendererResolver;
	const entries: { type: string; data: unknown }[] = [];
	const ui = {
		notify: vi.fn(),
		select: vi.fn(async () => "Block"),
		setStatus: vi.fn(),
		theme: { fg: (_kind: string, text: string) => text },
	};
	const registry = options.jevP === undefined ? undefined : makeRegistry(options.jevP);

	const pi = {
		// Pre-seeded values (test overrides) survive the factory registration.
		registerFlag: (name: string, config: { default?: boolean }) => {
			if (!flags.has(name)) flags.set(name, config.default ?? false);
		},
		getFlag: (name: string) => flags.get(name),
		registerTool: (definition: { name: string; execute: BashExecute } & ToolRenderers) => tools.push({ name: definition.name, definition }),
		registerToolRenderer: (resolver: ToolRendererResolver) => { rendererResolver = resolver; },
		registerCommand: (name: string, config: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }) => {
			commands.set(name, config.handler);
			complete = config.getArgumentCompletions;
		},
		registerShortcut: (shortcut: string, config: { handler: () => void }) => {
			shortcuts.set(shortcut, config.handler);
		},
		on: (type: string, handler: Handler) => {
			handlers.set(type, [...(handlers.get(type) ?? []), handler]);
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
			branch.push({ type: "custom", customType: type, data });
		},
		sendUserMessage: vi.fn(),
		exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
		getAllTools: () =>
			tools.map((tool) => ({ name: tool.name, sourceInfo: { path: "/x/node_modules/@zle13/pi-bash-guard/extensions/index.ts" } })),
	} as unknown as ExtensionAPI;

	bashGuardExtension(pi);

	const makeCtx = (overrides: Record<string, unknown> = {}): ExtensionContext =>
		({
			cwd,
			hasUI: options.hasUI ?? true,
			ui,
			signal: new AbortController().signal,
			sessionManager: {
				getBranch: options.branchThrows
					? () => {
							throw new Error("boom");
						}
					: () => branch,
			},
			modelRegistry: registry,
			...overrides,
		}) as unknown as ExtensionContext;

	const first = (type: string): Handler => {
		const handler = handlers.get(type)?.[0];
		if (!handler) throw new Error(`no ${type} handler registered`);
		return handler;
	};

	return {
		ui,
		entries,
		registry,
		sessionStart: async (reason = "startup") => {
			if (reason === "new") branch = [];
			await first("session_start")({ type: "session_start", reason }, makeCtx());
		},
		tree: async (entries) => {
			branch = [...entries];
			await first("session_tree")({ type: "session_tree" }, makeCtx());
		},
		branch: () => [...branch],
		completions: (prefix) => complete?.(prefix),
		shutdown: async () => {
			await first("session_shutdown")({ type: "session_shutdown" }, makeCtx());
		},
		toolCall: async (command: string, toolCallId = "call-1") => {
			let result: ToolCallEventResult | undefined;
			for (const handler of handlers.get("tool_call") ?? []) {
				result = (await handler({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }, makeCtx())) as
					| ToolCallEventResult
					| undefined;
			}
			return result;
		},
		command: async (args: string) => {
			const handler = commands.get("bash-guard");
			if (!handler) throw new Error("no bash-guard command");
			await handler(args, makeCtx() as unknown as ExtensionCommandContext);
		},
		registeredBashTool: () => tools.find((tool) => tool.name === "bash")?.definition.execute,
		bashRenderers: (decorate) => rendererResolver("bash", () => {
			const base = tools.find((tool) => tool.name === "bash")!.definition;
			return decorate ? decorate(base) : base;
		})!,
		toolEnd: async (toolCallId) => {
			await first("tool_execution_end")({ type: "tool_execution_end", toolCallId }, makeCtx());
		},
	};
}

beforeEach(() => {
	delete process.env[APPROVAL_MODE_ENV];
	delete globalSymbols()[BASH_GUARD_RUNTIME_SYMBOL];
	mocks.shellCalls.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete globalSymbols()[BASH_GUARD_RUNTIME_SYMBOL];
	for (const path of tempProjects.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Jev endpoint extension wiring", () => {
	it("loads endpoint config at session_start and reports a credential-free model label", async () => {
		const key = "extension-private-key";
		vi.stubEnv("BG_EXTENSION_JEV_KEY", key);
		const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: { irreversible: { type: "noul", noul: 0.1 } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const h = makeHarness({
			jevP: 0.9,
			userConfig: { jev: { endpoint: { baseUrl: "https://private-endpoint.example/v1", apiKey: "$BG_EXTENSION_JEV_KEY", models: [`custom-${key}`] } } },
		});
		await h.sessionStart();
		await expect(h.toolCall("rm -rf node_modules")).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		expect(h.registry!.classify).not.toHaveBeenCalled();
		await h.command("");
		const status = h.ui.notify.mock.calls.at(-1)![0] as string;
		expect(status).toContain("jev: on - endpoint/custom-[REDACTED]");
		expect(status).not.toContain(key);
		expect(status).not.toContain("private-endpoint.example");
		await h.shutdown();
	});

	it("falls back to registry authentication after the configured endpoint fails", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		const h = makeHarness({ jevP: 0.1, userConfig: { jev: { endpoint: { baseUrl: "https://endpoint.example/v1", apiKey: "private-key" } } } });
		await h.sessionStart();
		await expect(h.toolCall("rm -rf node_modules")).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(h.registry!.classify).toHaveBeenCalledOnce();
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("jev: on - typesafe/jev-latest");
		await h.shutdown();
	});
});


describe("project config only tightens", () => {
	it("ignores a repo's attempt to disable the guard and says so", async () => {
		const h = makeHarness({ config: { guard: { enabled: false } } });
		await h.sessionStart();
		expect(runtime()!.guardEnabled).toBe(true);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("may only tighten the guard; ignored guard.enabled"), "warning");
		await expect(h.toolCall("rm -rf /")).resolves.toMatchObject({ block: true });
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("ignored guard.enabled (project config may only tighten)");
	});

	it("ignores a repo's allow patterns, so a whitelisted command is still judged", async () => {
		const h = makeHarness({ jevP: 0.9, config: { guard: { allowPatterns: ["npm run build"] } } });
		await h.sessionStart();
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("ignored guard.allowPatterns");
		await expect(h.toolCall("npm run build && rm -rf ~")).resolves.toMatchObject({ block: true });
	});

	it("keeps tightening from the repo without a warning", async () => {
		const h = makeHarness({ jevP: 0.1, config: { guard: { allowBelow: 0.05, extraRiskyPatterns: ["^helm uninstall"] } } });
		await h.sessionStart();
		expect(h.ui.notify.mock.calls.flat().join(" ")).not.toContain("may only tighten");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("allowBelow 0.05");
		await h.shutdown();
	});
});

describe("runtime capability marker lifecycle", () => {
	it("is not ready at factory time, ready after session_start, cleared on shutdown", async () => {
		const h = makeHarness();
		expect(runtime()).toBeDefined();
		expect(runtime()!.ready).toBe(false);
		await h.sessionStart();
		expect(runtime()!.ready).toBe(true);
		expect(runtime()!.guardEnabled).toBe(true);
		await h.shutdown();
		expect(runtime()).toBeUndefined();
		expect(h.ui.setStatus).toHaveBeenCalledWith("bash-guard", undefined);
	});

	it("publishes version, mode, and guard state", async () => {
		const h = makeHarness({ jevP: 0.1 });
		await h.sessionStart();
		const current = runtime()!;
		expect(current.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(current.approvalMode).toBe("ask");
		expect(current.envEnforced).toBe(false);
		expect(current.guardEnabled).toBe(true);
		expect(current.error).toBeUndefined();
	});

	it("stays not-ready when session_start fails before completing", async () => {
		const h = makeHarness({ branchThrows: true });
		await expect(h.sessionStart()).rejects.toThrow("boom");
		expect(runtime()!.ready).toBe(false);
	});

	it("a reload publishes a fresh marker that an old shutdown cannot clear", async () => {
		const a = makeHarness();
		await a.sessionStart();
		expect(runtime()!.ready).toBe(true);
		const b = makeHarness(); // extension runtime reload replaces the marker
		expect(runtime()!.ready).toBe(false);
		await a.shutdown(); // the old runtime's shutdown runs after the new factory
		expect(runtime()).toBeDefined();
		expect(runtime()!.ready).toBe(false);
		await b.sessionStart();
		expect(runtime()!.ready).toBe(true);
	});
});

describe("approval mode resolution", () => {
	it("env deny is enforced: the marker reports deny with the guard pinned on", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness();
		await h.sessionStart();
		const current = runtime()!;
		expect(current.ready).toBe(true);
		expect(current.approvalMode).toBe("deny");
		expect(current.envEnforced).toBe(true);
		expect(current.guardEnabled).toBe(true);
		expect(current.error).toBeUndefined();
	});

	it("env ask forces ask mode without enforcement", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "ask");
		const h = makeHarness();
		await h.sessionStart();
		expect(runtime()!.approvalMode).toBe("ask");
		expect(runtime()!.envEnforced).toBe(false);
	});

	it("invalid env fails closed with a clear error", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "denyy");
		const h = makeHarness();
		await h.sessionStart();
		const current = runtime()!;
		expect(current.ready).toBe(true);
		expect(current.approvalMode).toBe("deny");
		expect(current.envEnforced).toBe(true);
		expect(current.guardEnabled).toBe(true);
		expect(current.error).toContain(APPROVAL_MODE_ENV);
		expect(current.error).toContain("denyy");
		// The failure is surfaced loudly, as an error notification.
		const error = h.ui.notify.mock.calls.find(([message]) => String(message).includes(APPROVAL_MODE_ENV));
		expect(error).toBeDefined();
		expect(error![1]).toBe("error");
	});
});

describe("tool_call gating", () => {
	it("blocks a risky command without dialogs in env deny mode", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		expect(result!.reason).toContain("approvalMode=deny");
		expect(result!.reason).toContain("git-push-force");
		expect(h.ui.select).not.toHaveBeenCalled();
		// The footer reflects the effective deny state and the blocked tally.
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG deny · 1✗");
	});

	it("blocks restored session-approved commands in deny mode", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({
			jevP: 0.9,
			branch: [{ type: "custom", customType: ALLOW_ENTRY_TYPE, data: { command: "git push --force origin main" } }],
		});
		await h.sessionStart();
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("session approvals are ignored") });
	});

	it("passes safe commands in deny mode", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		await expect(h.toolCall("git status")).resolves.toBeUndefined();
	});

	it("still passes Jev-recoverable commands in deny mode", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.2 });
		await h.sessionStart();
		await expect(h.toolCall("rm -rf node_modules")).resolves.toBeUndefined();
		expect(h.registry!.classify).toHaveBeenCalledTimes(1);
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG deny · 1✓");
	});

	it("blocks rules-only in deny mode when no classifier is available", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness();
		await h.sessionStart();
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		expect(result!.reason).toContain("Jev is off");
		expect(result!.reason).toContain("denied");
	});

	it("keeps approval dialogs in ask mode", async () => {
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		h.ui.select.mockResolvedValueOnce("Allow once");
		const result = await h.toolCall("git push --force origin main");
		expect(result).toBeUndefined(); // allowed
		expect(h.ui.select).toHaveBeenCalledTimes(1);
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG ask · 1?");
	});

	it("still blocks denied commands when --no-bash-guard is set (env deny wins)", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ flag: true, jevP: 0.9 });
		await h.sessionStart();
		expect(runtime()!.guardEnabled).toBe(true);
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		// The watchdog stays independently toggleable: the flag disabled it.
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG deny · guard-only · 1✗");
	});

	it("lets --no-bash-guard turn everything off without env enforcement", async () => {
		const h = makeHarness({ flag: true });
		await h.sessionStart();
		expect(runtime()!.guardEnabled).toBe(false);
		await expect(h.toolCall("git push --force origin main")).resolves.toBeUndefined();
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG off");
	});

	it("honors a saved off session mode without env enforcement", async () => {
		const h = makeHarness({
			branch: [{ type: "custom", customType: SETTINGS_ENTRY_TYPE, data: { guard: "off", watchdog: false } }],
		});
		await h.sessionStart();
		expect(runtime()!.guardEnabled).toBe(false);
		await expect(h.toolCall("git push --force origin main")).resolves.toBeUndefined();
	});

	it("/bash-guard off cannot bypass enforced env deny", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		await h.command("off");
		// The toggle is recorded, a warning explains the enforcement, and the guard holds.
		expect(h.entries.at(-1)).toMatchObject({ type: SETTINGS_ENTRY_TYPE, data: { guard: "off" } });
		const warning = h.ui.notify.mock.calls.find(
			([message, type]) => String(message).includes("stays on in deny mode") && type === "warning",
		);
		expect(warning).toBeDefined();
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		expect(runtime()!.guardEnabled).toBe(true);
		// Off changes only the guard; the watchdog remains on.
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG deny · 1✗");
		await h.command("watchdog off");
		expect(h.ui.setStatus.mock.calls.at(-1)![1]).toBe("⛨ BG deny · guard-only · 1✗");
	});

	it("/bash-guard off works normally without env enforcement", async () => {
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		await h.command("off");
		expect(runtime()!.guardEnabled).toBe(false);
		await expect(h.toolCall("git push --force origin main")).resolves.toBeUndefined();
	});
});

describe("session settings commands", () => {
	it("completes only the supported grammar", () => {
		const h = makeHarness();
		expect(h.completions("")).toEqual(["ask", "deny", "off", "watchdog on", "watchdog off"].map((value) => ({ value, label: value })));
		expect(h.completions("watchdog o")).toEqual(["watchdog on", "watchdog off"].map((value) => ({ value, label: value })));
		expect(h.completions("guard")).toEqual([]);
		expect(h.completions("status")).toEqual([]);
	});

	it("switches ask/deny/off without changing the watchdog", async () => {
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		await h.command("deny");
		expect(runtime()).toMatchObject({ approvalMode: "deny", guardEnabled: true });
		expect(await h.toolCall("git push --force origin main")).toMatchObject({ block: true });
		expect(h.ui.select).not.toHaveBeenCalled();
		await h.command("off");
		expect(runtime()!.guardEnabled).toBe(false);
		expect(h.ui.notify).toHaveBeenLastCalledWith("Guard: off · Watchdog: on", "info");
		await h.command("ask");
		expect(runtime()).toMatchObject({ approvalMode: "ask", guardEnabled: true });
		h.ui.select.mockResolvedValueOnce("Allow once");
		await expect(h.toolCall("git push --force origin main")).resolves.toBeUndefined();
		expect(h.ui.select).toHaveBeenCalledOnce();
		expect(h.entries.filter((entry) => entry.type === SETTINGS_ENTRY_TYPE).map((entry) => entry.data)).toEqual([
			{ guard: "deny" }, { guard: "off" }, { guard: "ask" },
		]);
	});

	it("watchdog changes leave the guard selection untouched", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.command("deny");
		await h.command("watchdog off");
		expect(runtime()!.approvalMode).toBe("deny");
		expect(h.entries.at(-1)!.data).toEqual({ guard: "deny", watchdog: false });
		await h.command("watchdog on");
		expect(h.entries.at(-1)!.data).toEqual({ guard: "deny", watchdog: true });
		expect(h.ui.notify).toHaveBeenLastCalledWith("Guard: deny · Watchdog: on", "info");
	});

	it.each(["on", "guard on", "guard off", "guard ask", "prompt", "deny extra", "off extra", "ask extra", "status", "status extra", "watchdog", "watchdog ask", "watchdog on extra"])("rejects %s without changing or saving state", async (args) => {
		const h = makeHarness();
		await h.sessionStart();
		await h.command(args);
		expect(h.entries).toEqual([]);
		expect(runtime()).toMatchObject({ approvalMode: "ask", guardEnabled: true });
		expect(h.ui.notify).toHaveBeenLastCalledWith("usage: /bash-guard [ask|deny|off|watchdog on|off]", "warning");
	});

	it("bare invocation reports effective state and sources without saving", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("approval: ask (config)");
		expect(h.entries).toEqual([]);
		await h.command("deny");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("approval: deny (session)");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("session deny");
		expect(h.entries).toHaveLength(1);
	});

	it.each(["reload", "resume", "fork"] as const)("restores selected mode and watchdog on %s", async (reason) => {
		const original = makeHarness();
		await original.sessionStart();
		await original.command("deny");
		await original.command("watchdog off");
		const branch = original.branch();
		await original.shutdown();
		const restored = makeHarness({ branch });
		await restored.sessionStart(reason);
		expect(runtime()).toMatchObject({ approvalMode: "deny", guardEnabled: true });
		await restored.command("");
		expect(restored.ui.notify.mock.calls.at(-1)![0]).toContain("watchdog: off");
		expect(restored.entries).toEqual([]);
	});

	it("starts a new session from config instead of leaking previous session choices", async () => {
		const h = makeHarness({ config: { guard: { approvalMode: "deny" }, watchdog: { enabled: false } } });
		await h.sessionStart();
		expect(runtime()!.approvalMode).toBe("deny");
		await h.command("ask");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("approval: ask (session)");
		await h.sessionStart("new");
		expect(runtime()!.approvalMode).toBe("deny");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("approval: deny (config)");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("watchdog: off");
	});

	it("does not pin untouched guard settings when toggling the watchdog", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.command("watchdog off");
		expect(h.entries.at(-1)!.data).toEqual({ watchdog: false });
		const restored = makeHarness({ branch: h.branch(), config: { guard: { approvalMode: "deny" } } });
		await restored.sessionStart("resume");
		expect(runtime()!.approvalMode).toBe("deny");
	});

	it("tree navigation restores settings and approvals from the active branch", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.command("ask");
		h.ui.select.mockResolvedValueOnce("Allow for this session");
		await h.toolCall("git push --force origin main");
		const askBranch = h.branch();
		await h.command("deny");
		await h.command("watchdog off");
		expect(await h.toolCall("git push --force origin main")).toMatchObject({ block: true });
		await h.tree(askBranch);
		expect(runtime()!.approvalMode).toBe("ask");
		await expect(h.toolCall("git push --force origin main")).resolves.toBeUndefined();
		expect(h.ui.select).toHaveBeenCalledOnce();
		await h.tree([]);
		h.ui.select.mockResolvedValueOnce("Block");
		expect(await h.toolCall("git push --force origin main")).toMatchObject({ block: true });
		expect(h.ui.select).toHaveBeenCalledTimes(2);
	});

	it.each(["deny", "invalid"])("cannot weaken enforced launch policy %s", async (env) => {
		vi.stubEnv(APPROVAL_MODE_ENV, env);
		const h = makeHarness();
		await h.sessionStart();
		await h.command("ask");
		expect(runtime()).toMatchObject({ approvalMode: "deny", guardEnabled: true, envEnforced: true });
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("stays on in deny mode"), "warning");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain(env === "deny" ? "env enforced" : "fail closed");
	});

	it("env ask wins over a session deny but permits guard off", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "ask");
		const h = makeHarness();
		await h.sessionStart();
		await h.command("deny");
		expect(runtime()!.approvalMode).toBe("ask");
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("approval remains ask"), "warning");
		await h.command("");
		expect(h.ui.notify.mock.calls.at(-1)![0]).toContain("approval: ask (env via PI_BASH_GUARD_APPROVAL_MODE)");
		await h.command("off");
		expect(runtime()!.guardEnabled).toBe(false);
	});

	it("reports config-disabled components instead of claiming activation", async () => {
		const h = makeHarness({ userConfig: { guard: { enabled: false }, watchdog: { enabled: false } } });
		await h.sessionStart();
		await h.command("ask");
		expect(runtime()!.guardEnabled).toBe(false);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("guard.enabled=false"), "warning");
		await h.command("watchdog on");
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("watchdog.enabled=false"), "warning");
		expect(h.ui.notify).toHaveBeenLastCalledWith("Guard: off · Watchdog: off", "info");
	});

	it("reports the disabling launch flag", async () => {
		const h = makeHarness({ flag: true });
		await h.sessionStart();
		await h.command("deny");
		await h.command("watchdog on");
		expect(runtime()!.guardEnabled).toBe(false);
		expect(h.ui.notify).toHaveBeenCalledWith("bash-guard: guard remains off - --no-bash-guard", "warning");
		expect(h.ui.notify).toHaveBeenCalledWith("bash-guard: watchdog remains off - --no-bash-guard", "warning");
	});

	it("persists settings without attempting UI in headless mode", async () => {
		const h = makeHarness({ hasUI: false });
		await h.sessionStart();
		await h.command("deny");
		expect(h.entries.at(-1)!.data).toEqual({ guard: "deny" });
		expect(runtime()!.approvalMode).toBe("deny");
		expect(h.ui.notify).not.toHaveBeenCalled();
		expect(await h.toolCall("git push --force origin main")).toMatchObject({ block: true });
	});
});

describe("bash execution timer", () => {
	function row(h: Harness, toolCallId = "call-1") {
		let durationMs: number | undefined;
		const renderers = h.bashRenderers((base) => ({
			...base,
			renderResult: (result, options, theme, context) => {
				durationMs = (context as typeof context & { durationMs?: number }).durationMs;
				return base.renderResult!(result, options, theme, context);
			},
		}));
		const args = { command: "git push --force origin main" };
		const context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2] = {
			args, toolCallId, state: {}, executionStarted: true,
			argsComplete: true, isPartial: true, expanded: false,
			showImages: false, isError: false, cwd: "/proj",
			lastComponent: undefined, invalidate: vi.fn(),
		};
		// Pi 1.5 supplies lifecycle duration, which includes approval waits.
		Object.assign(context, { durationMs: 42_000 });
		return {
			durationMs: () => durationMs,
			draw(partial = true) {
				const theme = { fg: (_kind: string, text: string) => text } as Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
				renderers.renderCall!(args, theme, context);
				return renderers.renderResult!({ content: [], details: undefined },
					{ isPartial: partial, expanded: false }, theme, context).render(120).join("\n");
			},
		};
	}

	it.each([true, false])("excludes approval waits with watchdog enabled=%s", async (enabled) => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		initTheme("dark");
		const h = makeHarness({ jevP: 0.9, userConfig: { watchdog: { enabled } } });
		await h.sessionStart();
		const commandRow = row(h);
		const siblingRow = row(h, "sibling");
		expect(commandRow.draw()).not.toContain("Elapsed");
		expect(commandRow.durationMs()).toBeUndefined();
		let approve!: (choice: string) => void;
		h.ui.select.mockImplementationOnce(() => new Promise<string>((resolve) => { approve = resolve; }));
		const approval = h.toolCall("git push --force origin main");
		await vi.waitFor(() => expect(h.ui.select).toHaveBeenCalled());
		vi.setSystemTime(130_000);
		expect(commandRow.draw()).not.toContain("Elapsed");
		approve("Allow once");
		await approval;
		// Approval alone isn't execution (parallel siblings can still be in preflight).
		expect(commandRow.draw()).not.toContain("Elapsed");
		vi.setSystemTime(140_000);
		let updates = 0;
		await h.registeredBashTool()!("call-1", { command: "git push --force origin main" },
			undefined, () => {
				expect(commandRow.draw()).toContain(`Elapsed ${updates === 0 ? "0.0" : "2.0"}s`);
				expect(siblingRow.draw()).not.toContain("Elapsed");
				if (updates++ === 0) vi.advanceTimersByTime(2000);
			}, {
				cwd: "/proj",
				sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
			} as unknown as ExtensionContext);
		vi.setSystemTime(142_000);
		expect(commandRow.draw(false)).toContain("Took 2.0s");
		expect(commandRow.durationMs()).toBe(2000);
		await h.toolEnd("call-1");
		vi.setSystemTime(150_000);
		expect(commandRow.draw(false)).toContain("Took 2.0s");
		await h.shutdown();
	});

	it("does not display execution time for a blocked command", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		initTheme("dark");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		const commandRow = row(h);
		expect(commandRow.draw()).not.toContain("Elapsed");
		vi.setSystemTime(130_000);
		expect(await h.toolCall("git push --force origin main")).toMatchObject({ block: true });
		expect(commandRow.draw(false)).not.toContain("Took");
		await h.toolEnd("call-1");
		await h.shutdown();
	});
});

describe("guard hooks and the SDK bash override", () => {
	it("blocks a risky hook call without invoking the shell backend", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		expect(h.registeredBashTool()).toBeDefined();
		expect(mocks.shellCalls).toHaveLength(0);

		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		expect(mocks.shellCalls).toHaveLength(0);
	});

	it("runs a safe call through the SDK bash override with no real shell", async () => {
		const h = makeHarness({ jevP: 0.1 });
		await h.sessionStart();
		const tool = h.registeredBashTool();
		expect(tool).toBeDefined();
		await expect(h.toolCall("git status", "nested-1")).resolves.toBeUndefined(); // hook passes
		const ctx = {
			cwd: "/proj",
			sessionManager: { getSessionId: () => "s", getSessionFile: () => "/tmp/s.jsonl" },
			model: undefined,
		} as unknown as ExtensionContext;
		await expect(tool!("nested-1", { command: "git status" }, undefined, undefined, ctx)).resolves.toMatchObject({
			content: [expect.objectContaining({ type: "text" })],
		});
		// The wrapper engaged the (mocked) inner operations: recorded, not spawned.
		expect(mocks.shellCalls).toEqual([{ command: "git status", cwd: "/proj" }]);
	});

	it("blocks a risky hook call when the watchdog is off", async () => {
		vi.stubEnv(APPROVAL_MODE_ENV, "deny");
		const h = makeHarness({ jevP: 0.9 });
		await h.sessionStart();
		await h.command("watchdog off");
		const result = await h.toolCall("git push --force origin main");
		expect(result).toMatchObject({ block: true });
		expect(mocks.shellCalls).toHaveLength(0);
	});
});
