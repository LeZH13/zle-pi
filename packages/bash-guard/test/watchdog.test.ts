import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Jev, WatchdogJevResult } from "../src/jev.js";
import { Watchdog, type WatchdogHandle } from "../src/watchdog.js";

const FIRST_MS = DEFAULT_CONFIG.watchdog.firstCheckSec * 1000;
const INTERVAL_MS = DEFAULT_CONFIG.watchdog.intervalSec * 1000;

interface JevScript {
	status: "progressing" | "waiting" | "stuck" | "looping";
	pStatus: number;
	persistent: number;
}

function fakeJev(script: JevScript | WatchdogJevResult): Jev & { states: unknown[] } {
	const states: unknown[] = [];
	return {
		available: true,
		model: "typesafe/jev-latest",
		async ensureAvailable() {
			return true;
		},
		describeUnavailable: () => "",
		async guardAnswer() {
			throw new Error("not used in watchdog tests");
		},
		async watchdogAnswer(state, signal) {
			expect(signal).toBeInstanceOf(AbortSignal);
			states.push(state);
			if ("ok" in script) return script as WatchdogJevResult;
			return {
				ok: true,
				status: script.status,
				pStatus: script.pStatus,
				probabilities: { [script.status]: script.pStatus },
				persistent: script.persistent,
				model: "t",
			};
		},
		usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
		lastFailure: undefined,
		states,
	};
}

interface Harness {
	watchdog: Watchdog;
	steer: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	entry: WatchdogHandle;
	jev: ReturnType<typeof fakeJev>;
}

function setup(script: JevScript | WatchdogJevResult, configOverrides: Partial<typeof DEFAULT_CONFIG.watchdog> = {}): Harness {
	const config = structuredClone(DEFAULT_CONFIG);
	Object.assign(config.watchdog, configOverrides);
	const steer = vi.fn();
	const notify = vi.fn();
	const abort = vi.fn();
	const jev = fakeJev(script);
	const watchdog = new Watchdog({
		config,
		jev,
		now: () => Date.now(),
		steer,
		notify,
	});
	const entry = watchdog.start("tail -f /tmp/app.log", "/work", { abort });
	return { watchdog, steer, notify, abort, entry, jev };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("watchdog state machine", () => {
	it.each(["finish", "dispose"] as const)("aborts pending availability on %s and never classifies an inactive entry", async (stop) => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 });
		let probeSignal!: AbortSignal;
		let finishProbe!: (available: boolean) => void;
		h.jev.ensureAvailable = vi.fn(async (signal?: AbortSignal) => {
			probeSignal = signal!;
			return new Promise<boolean>((resolve) => { finishProbe = resolve; });
		});
		const answer = vi.spyOn(h.jev, "watchdogAnswer");
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(probeSignal.aborted).toBe(false);
		if (stop === "finish") h.watchdog.finish(h.entry);
		else h.watchdog.dispose();
		expect(probeSignal.aborted).toBe(true);
		finishProbe(true); // Non-cooperative late availability must not start a request.
		await vi.advanceTimersByTimeAsync(0);
		expect(answer).not.toHaveBeenCalled();
		expect(h.steer).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does nothing on a healthy first check", async () => {
		const h = setup({ status: "progressing", pStatus: 0.95, persistent: 0.1 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.steer).not.toHaveBeenCalled();
	});

	it("kills only after consecutive agreeing stuck checks", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0.05 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.abort).not.toHaveBeenCalled(); // one agreeing check is not enough
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).toHaveBeenCalledTimes(1);
		expect(h.steer).toHaveBeenCalledTimes(1);
		expect(h.steer.mock.calls[0][0]).toContain("do not rerun the same command unchanged");
		expect(h.notify).toHaveBeenCalled();
		// After the kill no further checks are scheduled.
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
		expect(h.abort).toHaveBeenCalledTimes(1);
	});

	it("resets agreement when a check disagrees", async () => {
		let calls = 0;
		const script = fakeJev({ ok: true, status: "stuck", pStatus: 0.95, persistent: 0, model: "t" });
		const config = structuredClone(DEFAULT_CONFIG);
		const steer = vi.fn();
		const notify = vi.fn();
		const abort = vi.fn();
		const watchdog = new Watchdog({ config, jev: script, now: () => Date.now(), steer, notify });
		const base = script.watchdogAnswer.bind(script);
		script.watchdogAnswer = async (state, signal) => {
			calls++;
			if (calls === 2) return { ok: true, status: "progressing", pStatus: 0.9, probabilities: { progressing: 0.9 }, persistent: 0, model: "t" };
			return base(state, signal);
		};
		const entry = watchdog.start("cmd", "/w", { abort });
		await vi.advanceTimersByTimeAsync(FIRST_MS); // agree 1
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // disagree
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // agree 1 again
		expect(abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // agree 2 -> kill
		expect(abort).toHaveBeenCalledTimes(1);
		void entry;
	});

	it("does not kill below the confidence threshold", async () => {
		const h = setup({ status: "stuck", pStatus: 0.7, persistent: 0 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).not.toHaveBeenCalled();
	});

	it("vetoed long-lived services steer once and never die", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0.8 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.steer).toHaveBeenCalledTimes(1);
		expect(h.steer.mock.calls[0][0]).toContain("nohup");
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.steer).toHaveBeenCalledTimes(1); // one-time steer per command
	});

	it("resets agreement across an unavailable check", async () => {
		let calls = 0;
		const script = fakeJev({ ok: true, status: "stuck", pStatus: 0.95, persistent: 0, model: "t" });
		const config = structuredClone(DEFAULT_CONFIG);
		const steer = vi.fn();
		const notify = vi.fn();
		const abort = vi.fn();
		const watchdog = new Watchdog({ config, jev: script, now: () => Date.now(), steer, notify });
		const base = script.watchdogAnswer.bind(script);
		script.watchdogAnswer = async (state, signal) => {
			calls++;
			if (calls === 2) return { ok: false, reason: "timeout" };
			return base(state, signal);
		};
		watchdog.start("cmd", "/w", { abort });
		await vi.advanceTimersByTimeAsync(FIRST_MS); // agree 1
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // unavailable -> reset
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // agree 1 again
		expect(abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS); // agree 2 -> kill
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("records a bounded per-check log with outcomes", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0.05 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		const log = h.watchdog.getLog("tail -f /tmp/app.log");
		expect(log).toHaveLength(2);
		expect(log[0]).toMatchObject({
			elapsedSeconds: 120,
			status: "stuck",
			probabilities: { stuck: 0.95 },
			persistent: 0.05,
			outcome: "agree 1/2",
		});
		expect(log[1]).toMatchObject({ elapsedSeconds: 420, status: "stuck", outcome: "kill" });
		expect(h.watchdog.getLog("never-ran")).toEqual([]);
	});

	it("records veto and healthy outcomes", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0.8 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.watchdog.getLog("tail -f /tmp/app.log").map((c) => c.outcome)).toEqual(["veto", "veto"]);
		const healthy = setup({ status: "progressing", pStatus: 0.9, persistent: 0 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(healthy.watchdog.getLog("tail -f /tmp/app.log").map((c) => c.outcome)).toEqual(["agree 0/2"]);
	});

	it("records failed checks with reasons", async () => {
		let calls = 0;
		const script = fakeJev({ ok: true, status: "stuck", pStatus: 0.95, persistent: 0, model: "t" });
		const base = script.watchdogAnswer.bind(script);
		script.watchdogAnswer = async (state, signal) => {
			calls++;
			if (calls === 2) return { ok: false, reason: "timeout" };
			return base(state, signal);
		};
		const config = structuredClone(DEFAULT_CONFIG);
		const watchdog = new Watchdog({ config, jev: script, now: () => Date.now(), steer: vi.fn(), notify: vi.fn() });
		watchdog.start("cmd", "/w", { abort: vi.fn() });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		const outcomes = watchdog.getLog("cmd").map((c) => c.outcome);
		expect(outcomes).toEqual(["agree 1/2", "failed: timeout"]);
	});

	it("bounds the log to the last 10 checks per command", async () => {
		const h = setup({ status: "progressing", pStatus: 0.9, persistent: 0 }, { firstCheckSec: 5, intervalSec: 5 });
		await vi.advanceTimersByTimeAsync(60_000);
		const log = h.watchdog.getLog("tail -f /tmp/app.log");
		expect(log).toHaveLength(10);
		expect(log[0].elapsedSeconds).toBe(15);
		expect(log[9].elapsedSeconds).toBe(60);
	});

	it("lists recent logs newest-first and keeps finished commands", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 });
		h.watchdog.start("other command", "/w", { abort: vi.fn() });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		h.watchdog.finish(h.entry);
		const recent = h.watchdog.recentLogs(5);
		expect(recent.map((entry) => entry.command)).toEqual(["other command", "tail -f /tmp/app.log"]);
		expect(h.watchdog.getLog("tail -f /tmp/app.log").length).toBeGreaterThan(0);
	});

	it("redacts the command and cwd in the check state", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		const jev = fakeJev({ status: "waiting", pStatus: 0.95, persistent: 0.9 });
		const watchdog = new Watchdog({ config, jev, now: () => Date.now(), steer: vi.fn(), notify: vi.fn() });
		const entry = watchdog.start("curl https://user:hunter2@host.example -H 'Authorization: Bearer sk-tok-99999999'", "/creds password=x", { abort: vi.fn() });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		const state = (jev.states[0] as { value: Record<string, unknown> }).value;
		expect(state.command).not.toContain("hunter2");
		expect(state.command).not.toContain("sk-tok-99999999");
		expect(state.cwd).not.toContain("x");
		expect(state.command).toContain("[REDACTED]");
		void entry;
	});

	it("looping overrides the persistent veto", async () => {
		const h = setup({ status: "looping", pStatus: 0.95, persistent: 0.9 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).toHaveBeenCalledTimes(1);
		expect(h.steer).toHaveBeenCalledTimes(1);
		expect(h.steer.mock.calls[0][0]).toContain("do not rerun");
	});

	it("treats unavailable Jev as neutral", async () => {
		const h = setup({ ok: false, reason: "timeout" });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.steer).not.toHaveBeenCalled();
	});

	it("honors configured agreeChecks and confidence", async () => {
		const h = setup({ status: "stuck", pStatus: 0.85, persistent: 0 }, { agreeChecks: 3, confidence: 0.85 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.abort).toHaveBeenCalledTimes(1);
	});

	it("stops timers on finish and dispose", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 });
		h.watchdog.finish(h.entry);
		await vi.advanceTimersByTimeAsync(FIRST_MS + INTERVAL_MS * 3);
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.watchdog.runningCount()).toBe(0);
	});

	it("dispose is idempotent and clears running commands", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 });
		h.watchdog.start("other", "/w", { abort: vi.fn() });
		expect(h.watchdog.runningCount()).toBe(2);
		h.watchdog.dispose();
		h.watchdog.dispose();
		expect(h.watchdog.runningCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(FIRST_MS + INTERVAL_MS * 3);
		expect(h.abort).not.toHaveBeenCalled();
	});
});

describe("watchdog Jev state", () => {
	it("reports command, cwd, runtime, output freshness, and a redacted tail", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 }, { firstCheckSec: 30 });
		vi.advanceTimersByTime(10_000);
		h.watchdog.recordOutput(h.entry, "doing things\npassword=hunter2 Bearer abcdefghij AWS AKIAIOSFODNN7EXAMPLE\n");
		vi.advanceTimersByTime(20_000);
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.jev.states.length).toBe(1);
		const state = (h.jev.states[0] as { value: Record<string, unknown> }).value;
		expect(state.command).toBe("tail -f /tmp/app.log");
		expect(state.cwd).toBe("/work");
		expect(state.runtime_seconds).toBe(30);
		expect(state.seconds_since_output_change).toBe(20);
		expect(state.output_changed_since_last_check).toBe(true);
		const tail = state.output_tail as string;
		expect(tail).toContain("doing things");
		expect(tail).not.toContain("hunter2");
		expect(tail).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(tail).toContain("[REDACTED]");
	});

	it("marks no output change when the command is silent", async () => {
		const h = setup({ status: "waiting", pStatus: 0.95, persistent: 0.9 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		const state = (h.jev.states[0] as { value: Record<string, unknown> }).value;
		expect(state.output_changed_since_last_check).toBe(false);
		expect(state.seconds_since_output_change).toBeGreaterThan(0);
	});

	it("bounds the tail sent to Jev", async () => {
		const h = setup({ status: "waiting", pStatus: 0.95, persistent: 0.9 });
		h.watchdog.recordOutput(h.entry, "x".repeat(20_000));
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		const tail = (h.jev.states[0] as { value: Record<string, unknown> }).value.output_tail as string;
		expect(tail.length).toBeLessThanOrEqual(2000);
	});
});

describe("watchdog kill message", () => {
	it("describes the kill and includes a redacted tail", async () => {
		const h = setup({ status: "stuck", pStatus: 0.95, persistent: 0 });
		h.watchdog.recordOutput(h.entry, "stuck output password=topsecret\n");
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(h.watchdog.isKilled(h.entry)).toBe(true);
		const message = h.watchdog.killMessage(h.entry);
		expect(message).toContain("killed by bash-guard watchdog");
		expect(message).toContain("stuck");
		expect(message).not.toContain("topsecret");
		expect(message).toContain("do not rerun the same command unchanged");
	});
});

describe("watchdog unavailable Jev", () => {
	it("is inert when the key is missing", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		const steer = vi.fn();
		const notify = vi.fn();
		const abort = vi.fn();
		const unavailable: Jev = {
			available: false,
			model: "",
			async ensureAvailable() {
				return false;
			},
			describeUnavailable: () => "no classifier",
			async guardAnswer() {
				throw new Error("not used in watchdog tests");
			},
			async watchdogAnswer() {
				throw new Error("checks must not ask Jev while unavailable");
			},
			usage: () => ({ input: 0, output: 0, totalTokens: 0, cost: 0 }),
			lastFailure: undefined,
		};
		const watchdog = new Watchdog({
			config,
			jev: unavailable,
			now: () => Date.now(),
			steer,
			notify,
		});
		const entry = watchdog.start("cmd", "/w", { abort });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		// Without a classifier the checks are neutral and never ask Jev.
		expect(abort).not.toHaveBeenCalled();
		void entry;
	});
});

describe("watchdog live view", () => {
	it("reports the oldest running command's clock and latest check", async () => {
		const h = setup({ status: "stuck", pStatus: 0.9, persistent: 0 });
		expect(h.watchdog.live()).toEqual({ running: 1, elapsedSeconds: 0 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.watchdog.live()).toEqual({
			running: 1,
			elapsedSeconds: FIRST_MS / 1000,
			check: { status: "stuck", p: 0.9, agree: 1, agreeNeeded: 2, service: false },
		});
		h.watchdog.start("second", "/w", { abort: vi.fn() });
		expect(h.watchdog.live()?.running).toBe(2);
		expect(h.watchdog.live()?.elapsedSeconds).toBe(FIRST_MS / 1000);
		h.watchdog.dispose();
		expect(h.watchdog.live()).toBeUndefined();
	});

	it("marks a vetoed service and drops the check after a failure", async () => {
		const h = setup({ status: "stuck", pStatus: 0.9, persistent: 0.9 });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(h.watchdog.live()?.check).toMatchObject({ service: true, agree: 0 });
		const failing = setup({ ok: false, reason: "timeout" });
		await vi.advanceTimersByTimeAsync(FIRST_MS);
		expect(failing.watchdog.live()?.check).toBeUndefined();
	});
});
