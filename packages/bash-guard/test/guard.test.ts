import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatGuardScore, runGuard, SELECT_OPTIONS, type GuardDeps, type GitInfo } from "../src/guard.js";
import type { GuardJevResult, Jev } from "../src/jev.js";
import { RISKY_RULES } from "../src/rules.js";

const RISKY_COMMAND = "git push --force origin main";
const SAFE_COMMAND = "git status";

function makeJev(result: GuardJevResult): Jev & { guardCalls: number } {
	let guardCalls = 0;
	return {
		available: true,
		model: "typesafe/jev-latest",
		async ensureAvailable() {
			return true;
		},
		describeUnavailable: () => "",
		async guardAnswer() {
			guardCalls++;
			return result;
		},
		async watchdogAnswer() {
			throw new Error("not used in guard tests");
		},
		usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
		lastFailure: undefined,
		get guardCalls() {
			return guardCalls;
		},
	};
}

function makeDeps(overrides: Partial<GuardDeps> & { jev: Jev }): GuardDeps {
	const allowed = new Set<string>();
	return {
		config: structuredClone(DEFAULT_CONFIG),
		risky: { rules: RISKY_RULES, extra: [], allow: [] },
		gitInfo: async (): Promise<GitInfo> => ({ branch: "main", dirty: true }),
		hasUI: true,
		select: vi.fn(async () => "Block"),
		notify: vi.fn(),
		isSessionAllowed: (command) => allowed.has(command),
		allowForSession: (command) => allowed.add(command),
		notifyJevOffOnce: vi.fn(),
		...overrides,
	};
}

describe("guard decision flow", () => {
	it("allows non-risky commands without asking Jev", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev });
		const outcome = await runGuard(deps, { command: SAFE_COMMAND, cwd: "/w" });
		expect(outcome).toEqual({ action: "allow", reason: "no risky pattern matched" });
		expect(jev.guardCalls).toBe(0);
	});

	it("allows session-allowed commands before any matching", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev, isSessionAllowed: (command) => command === RISKY_COMMAND });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome).toEqual({ action: "allow", reason: "allowed for this session" });
		expect(jev.guardCalls).toBe(0);
	});

	it("allows risky commands when Jev probability is below allowBelow", async () => {
		const jev = makeJev({ ok: true, p: 0.1, model: "t" });
		const outcome = await runGuard(makeDeps({ jev }), { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome.action).toBe("allow");
		expect(outcome.reason).toContain("recoverable");
	});

	it("escalates risky commands above allowBelow and blocks on Block", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toContain("git-push-force");
		expect(outcome.reason).toContain("p=0.90");
		expect((deps.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual([...SELECT_OPTIONS]);
	});

	it("'Allow for this session' remembers the exact command", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev, select: vi.fn(async () => "Allow for this session") });
		const first = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(first.action).toBe("allow");
		const second = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(second).toEqual({ action: "allow", reason: "allowed for this session" });
	});

	it("escalates on Jev errors and blocks without UI", async () => {
		const deps = makeDeps({ jev: makeJev({ ok: false, reason: "timeout" }), hasUI: false });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toContain("Jev timeout");
		expect(deps.notifyJevOffOnce).not.toHaveBeenCalled();
	});

	it("blocks with no UI", async () => {
		const deps = makeDeps({ jev: makeJev({ ok: true, p: 0.9, model: "t" }), hasUI: false });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toContain("no UI to confirm");
	});

	it("blocks on aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const deps = makeDeps({ jev: makeJev({ ok: true, p: 0.9, model: "t" }) });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w", signal: controller.signal });
		expect(outcome.action).toBe("block");
	});

	it("runs rules-only when no Jev classifier is available", async () => {
		const unavailable: Jev = {
			available: false,
			model: "",
			async ensureAvailable() {
				return false;
			},
			describeUnavailable: () => "run /login openrouter or set TYPESAFE_API_KEY / OPENROUTER_API_KEY",
			async guardAnswer() {
				throw new Error("must not be called while unavailable");
			},
			async watchdogAnswer() {
				throw new Error("not used in guard tests");
			},
			usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
			lastFailure: undefined,
		};
		const deps = makeDeps({ jev: unavailable });
		const first = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(first.action).toBe("block");
		expect(first.reason).toContain("Jev is off");
		expect(first.reason).toContain("/login openrouter");
		// Each rules-only escalation asks the wiring to notify (dedup happens there).
		expect(deps.notifyJevOffOnce).toHaveBeenCalledTimes(1);
		await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(deps.notifyJevOffOnce).toHaveBeenCalledTimes(2);
		// Safe commands still pass instantly in rules-only mode.
		const safe = await runGuard(deps, { command: SAFE_COMMAND, cwd: "/w" });
		expect(safe.action).toBe("allow");
		expect(deps.notifyJevOffOnce).toHaveBeenCalledTimes(2);
	});

	it("sends only command, reasons, cwd, and git facts to Jev", async () => {
		let captured: unknown;
		const jev: Jev = {
			available: true,
			model: "typesafe/jev-latest",
			async ensureAvailable() {
				return true;
			},
			describeUnavailable: () => "",
			usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
			lastFailure: undefined,
			async guardAnswer(state) {
				captured = state;
				return { ok: true, p: 0.05, model: "t" };
			},
			async watchdogAnswer() {
				throw new Error("not used");
			},
		};
		await runGuard(makeDeps({ jev }), { command: RISKY_COMMAND, cwd: "/work" });
		const state = captured as { value: Record<string, unknown> };
		expect(Object.keys(state)).toEqual(["value"]);
		expect(Object.keys(state.value).sort()).toEqual(["command", "cwd", "git", "matched_rules"]);
		expect(state.value.command).toBe(RISKY_COMMAND);
		expect(state.value.cwd).toBe("/work");
		expect(state.value.git).toEqual({ branch: "main", dirty: true });
	});

	it("redacts command, cwd, and branch before sending state to Jev", async () => {
		let captured: unknown;
		const jev: Jev = {
			available: true,
			model: "typesafe/jev-latest",
			async ensureAvailable() {
				return true;
			},
			describeUnavailable: () => "",
			usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
			lastFailure: undefined,
			async guardAnswer(state) {
				captured = state;
				return { ok: true, p: 0.05, model: "t" };
			},
			async watchdogAnswer() {
				throw new Error("not used");
			},
		};
		const deps = makeDeps({
			jev,
			risky: { rules: RISKY_RULES, extra: [/curl\s+https:/], allow: [] },
			gitInfo: async () => ({ branch: "Bearer abcdefghij", dirty: false }),
		});
		await runGuard(deps, {
			command: "curl https://user:hunter2@host.example -H 'Authorization: Bearer sk-tok-12345678' --data api_key=abc123def456 password=letmein",
			cwd: "/secret dir with password=foo",
		});
		const state = captured as { value: Record<string, unknown> };
		const command = state.value.command as string;
		expect(command).not.toContain("hunter2");
		expect(command).not.toContain("sk-tok-12345678");
		expect(command).not.toContain("abc123def456");
		expect(command).not.toContain("letmein");
		expect(command).toContain("[REDACTED]");
		expect(state.value.cwd).not.toContain("foo");
		expect((state.value.git as { branch: string }).branch).not.toContain("abcdefghij");
	});

	it("passes the tool-call signal into the dialog and blocks if aborted after selection", async () => {
		const controller = new AbortController();
		const select = vi.fn(async (_title: string, _options: readonly string[], opts?: { signal?: AbortSignal }) => {
			expect(opts?.signal).toBe(controller.signal); // dialog is cancellable
			controller.abort(); // user cancels / tool call aborted mid-dialog
			return "Allow once";
		});
		const deps = makeDeps({ jev: makeJev({ ok: true, p: 0.9, model: "t" }), select });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w", signal: controller.signal });
		expect(select.mock.calls[0][2]).toEqual({ signal: controller.signal });
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toContain("aborted during confirmation");
	});

	it("allow patterns override risky rules", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev, risky: { rules: RISKY_RULES, extra: [], allow: [/^git push --force origin main$/] } });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome).toEqual({ action: "allow", reason: "matched an allow pattern" });
	});
});

describe("jev score on allowed outcomes", () => {
	it("attaches the below-threshold Jev score to the allow outcome", async () => {
		const jev = makeJev({ ok: true, p: 0.31, model: "t" });
		const outcome = await runGuard(makeDeps({ jev }), { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome).toMatchObject({ action: "allow", jev: { p: 0.31, userApproved: false } });
	});

	it("attaches a user-approved score when the dialog allows once", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev, select: vi.fn(async () => "Allow once") });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome).toMatchObject({ action: "allow", jev: { p: 0.9, userApproved: true } });
	});

	it("attaches a user-approved score when the dialog allows for the session", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const deps = makeDeps({ jev, select: vi.fn(async () => "Allow for this session") });
		const outcome = await runGuard(deps, { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome).toMatchObject({ action: "allow", jev: { p: 0.9, userApproved: true } });
	});

	it("carries no score on a blocked outcome", async () => {
		const jev = makeJev({ ok: true, p: 0.9, model: "t" });
		const outcome = await runGuard(makeDeps({ jev }), { command: RISKY_COMMAND, cwd: "/w" });
		expect(outcome.action).toBe("block");
		expect("jev" in outcome).toBe(false);
	});
});

describe("formatGuardScore", () => {
	it("labels Jev passes as recoverable and user approvals distinctly", () => {
		expect(formatGuardScore({ p: 0.31, userApproved: false })).toBe("jev p=0.31 recoverable");
		expect(formatGuardScore({ p: 0.604, userApproved: true })).toBe("jev p=0.60 allowed by user");
	});
});

describe("guard verdicts for the footer tally", () => {
	it("tags passed, asked, and blocked decisions only", async () => {
		const pass = await runGuard(makeDeps({ jev: makeJev({ ok: true, p: 0.1, model: "t" }) }), { command: RISKY_COMMAND, cwd: "/w" });
		expect(pass.verdict).toBe("passed");
		const ask = await runGuard(makeDeps({ jev: makeJev({ ok: true, p: 0.9, model: "t" }), select: vi.fn(async () => "Allow once") }), {
			command: RISKY_COMMAND,
			cwd: "/w",
		});
		expect(ask.verdict).toBe("asked");
		const block = await runGuard(makeDeps({ jev: makeJev({ ok: true, p: 0.9, model: "t" }) }), { command: RISKY_COMMAND, cwd: "/w" });
		expect(block.verdict).toBe("blocked");
		const safe = await runGuard(makeDeps({ jev: makeJev({ ok: true, p: 0.1, model: "t" }) }), { command: SAFE_COMMAND, cwd: "/w" });
		expect(safe.verdict).toBeUndefined();
	});
});
