import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundBash, type BashResult, type JobSnapshot } from "../src/background.js";

const result = (text = "done", code = 0): BashResult => ({
	content: [{ type: "text", text }], details: undefined,
	structuredContent: { output: text, exit_code: code, truncated: false, wall_time_seconds: 1 },
	...(code ? { isError: true } : {}),
});
function deferred() {
	let resolve!: (value: BashResult) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<BashResult>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }

afterEach(() => vi.useRealTimers());

describe("background bash scheduling", () => {
	it("returns native foreground successes and error results unchanged", async () => {
		const notify = vi.fn();
		const jobs = new BackgroundBash(notify);
		for (const code of [0, 1]) {
			const native = result("output", code);
			expect(await jobs.execute({ command: "test", afterMs: 60_000, run: async () => native })).toBe(native);
		}
		expect(jobs.list()).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("preserves foreground exceptions", async () => {
		const jobs = new BackgroundBash(vi.fn());
		const error = new Error("spawn failed");
		await expect(jobs.execute({ command: "test", afterMs: 0, run: async () => { throw error; } })).rejects.toBe(error);
		expect(jobs.list()).toEqual([]);
	});

	it("returns immediately and delivers one completion while retaining job status", async () => {
		const notify = vi.fn();
		const jobs = new BackgroundBash(notify);
		const pending = deferred();
		const ack = await jobs.execute({ command: "test", background: true, afterMs: 0, run: () => pending.promise });
		expect(ack.structuredContent).toMatchObject({ status: "running", job_id: expect.stringMatching(/^bg-/) });
		expect(ack.details).toEqual({ bashGuardBackground: ack.structuredContent });
		const id = jobs.list()[0]!.job_id;
		pending.resolve(result());
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ job_id: id, state: "completed", output: "done", exit_code: 0 }));
		expect(jobs.list(id)[0]!.state).toBe("completed");
	});

	it("automatically yields without rerunning the command or forwarding later updates", async () => {
		vi.useFakeTimers();
		const jobs = new BackgroundBash(vi.fn());
		const pending = deferred();
		const onUpdate = vi.fn();
		let update!: (value: BashResult) => void;
		const run = vi.fn((_signal, cb) => { update = cb; return pending.promise; });
		const call = jobs.execute({ command: "test", afterMs: 100, onUpdate, run });
		await vi.advanceTimersByTimeAsync(50);
		update(result("before"));
		expect(onUpdate).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(50);
		expect((await call).structuredContent).toMatchObject({ status: "running" });
		update(result("after"));
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(jobs.list(jobs.list()[0]!.job_id)[0]!.output).toBe("after");
		expect(run).toHaveBeenCalledTimes(1);
		pending.resolve(result());
		await jobs.dispose();
	});

	it.each([false, undefined])("supports forced foreground and disabled automatic backgrounding (%s)", async (background) => {
		vi.useFakeTimers();
		const jobs = new BackgroundBash(vi.fn());
		const pending = deferred();
		const call = jobs.execute({ command: "test", afterMs: background === false ? 100 : 0, background, run: () => pending.promise });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(jobs.list()).toEqual([]);
		const native = result();
		pending.resolve(native);
		expect(await call).toBe(native);
	});

	it("keeps turn abort attached in foreground but detaches it after backgrounding", async () => {
		const jobs = new BackgroundBash(vi.fn());
		for (const background of [true, false]) {
			const parent = new AbortController();
			const pending = deferred();
			let signal!: AbortSignal;
			const call = jobs.execute({ command: "test", background, afterMs: 0, signal: parent.signal, run: (value) => { signal = value; return pending.promise; } });
			if (background) await call;
			else await Promise.resolve();
			parent.abort();
			expect(signal.aborted).toBe(!background);
			pending.resolve(result());
			await call;
		}
		await jobs.dispose();
	});

	it("rejects already-aborted calls before execution", async () => {
		const jobs = new BackgroundBash(vi.fn());
		const run = vi.fn();
		await expect(jobs.execute({ command: "test", background: true, afterMs: 0, signal: AbortSignal.abort(), run })).rejects.toThrow("aborted");
		expect(run).not.toHaveBeenCalled();
	});

	it("cancels through the execution signal and reports the final state", async () => {
		const notify = vi.fn();
		const jobs = new BackgroundBash(notify);
		await jobs.execute({ command: "test", background: true, afterMs: 0, run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
		const id = jobs.list()[0]!.job_id;
		expect(jobs.cancel(id)[0]!.state).toBe("cancelling");
		await flush();
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled" }));
		expect(jobs.cancel(id)[0]!.state).toBe("cancelled");
		expect(() => jobs.cancel("missing")).toThrow("Unknown");
	});

	it("reports nonzero exits and thrown timeout/watchdog errors as failures", async () => {
		const notices: JobSnapshot[] = [];
		const jobs = new BackgroundBash((job) => notices.push(job));
		for (const run of [async () => result("bad", 2), async () => { throw new Error("Command timed out"); }]) {
			await jobs.execute({ command: "test", background: true, afterMs: 0, run });
		}
		await flush();
		expect(notices.map((job) => job.state)).toEqual(["failed", "failed"]);
		expect(notices[0]!.exit_code).toBe(2);
		expect(notices[1]!.output).toContain("timed out");
	});

	it("preserves native output, bounds history, retains full-output paths, and lists compactly", async () => {
		const notify = vi.fn();
		const jobs = new BackgroundBash(notify);
		for (let i = 0; i < 25; i++) {
			await jobs.execute({ command: "test", background: true, afterMs: 0, run: async () => ({ ...result("x".repeat(20_000)), details: { fullOutputPath: "/tmp/native-output" } }) });
			await flush();
		}
		expect(jobs.list()).toHaveLength(20);
		expect(jobs.list()[0]!.output).toBe("");
		const job = jobs.list(jobs.list()[0]!.job_id)[0]!;
		expect(job.output).toBe("x".repeat(20_000));
		expect(job.truncated).toBe(false);
		expect(job.full_output_path).toBe("/tmp/native-output");
	});

	it("waits for cancellation on cleanup, suppresses stale completions, and can be reused", async () => {
		const notify = vi.fn();
		const jobs = new BackgroundBash(notify);
		await jobs.execute({ command: "old", background: true, afterMs: 0, run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
		await jobs.dispose();
		await jobs.dispose();
		expect(jobs.list()).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
		await jobs.execute({ command: "new", background: true, afterMs: 0, run: async () => result() });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("limits concurrent commands instead of starting unbounded processes", async () => {
		const jobs = new BackgroundBash(vi.fn());
		for (let i = 0; i < 16; i++) {
			await jobs.execute({ command: "test", background: true, afterMs: 0, run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
		}
		await expect(jobs.execute({ command: "overflow", background: true, afterMs: 0, run: async () => result() })).rejects.toThrow("16");
		await jobs.dispose();
	});

	it("counts retained finished jobs as inactive, not against the concurrency cap", async () => {
		const jobs = new BackgroundBash(vi.fn());
		for (let i = 0; i < 16; i++) {
			await jobs.execute({ command: `done-${i}`, background: true, afterMs: 0, run: async () => result() });
		}
		await flush();
		expect(jobs.backgroundJobs()).toHaveLength(16);
		const next = await jobs.execute({ command: "next", background: true, afterMs: 0, run: async () => result() });
		expect(next.structuredContent).toMatchObject({ status: "running" });
		await jobs.dispose();
	});

	it("survives a throwing settle notifier and still records the result", async () => {
		const jobs = new BackgroundBash(() => { throw new Error("delivery failed"); });
		await jobs.execute({ command: "test", background: true, afterMs: 0, run: async () => result("kept") });
		await flush();
		const [job] = jobs.backgroundJobs();
		expect(job).toMatchObject({ state: "completed", output: "kept" });
		await expect(jobs.dispose()).resolves.toBeUndefined();
	});

	it("reports list entries as carrying no output rather than truncated", async () => {
		const jobs = new BackgroundBash(vi.fn());
		await jobs.execute({ command: "test", background: true, afterMs: 0, run: async () => result("short") });
		await flush();
		const [listed] = jobs.list();
		expect(listed).toMatchObject({ output: "", truncated: false });
		// The detail view still reports real truncation.
		expect(jobs.list(listed!.job_id)[0]!.truncated).toBe(false);
	});

	it("returns from shutdown even when a command ignores its abort signal", async () => {
		const jobs = new BackgroundBash(vi.fn());
		await jobs.execute({ command: "stubborn", background: true, afterMs: 0, run: () => new Promise(() => {}) });
		const started = Date.now();
		await jobs.dispose();
		expect(Date.now() - started).toBeLessThan(4000);
		expect(jobs.backgroundJobs()).toEqual([]);
	}, 10_000);

	it("keeps running jobs when retention pruning drops settled ones", async () => {
		const jobs = new BackgroundBash(vi.fn());
		const live = deferred();
		await jobs.execute({ command: "long", background: true, afterMs: 0, run: () => live.promise });
		for (let i = 0; i < 24; i++) {
			await jobs.execute({ command: `quick-${i}`, background: true, afterMs: 0, run: async () => result() });
			await flush();
		}
		const retained = jobs.backgroundJobs();
		expect(retained.some((job) => job.command === "long" && job.state === "running")).toBe(true);
		expect(retained.filter((job) => job.state === "completed").length).toBeLessThanOrEqual(20);
		await jobs.dispose();
	});
});
