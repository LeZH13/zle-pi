import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

type NativeBashResult = Awaited<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>>;
export type BashResult = Omit<NativeBashResult, "details"> & {
	details: NativeBashResult["details"] & { bashGuardBackground?: { status: "running"; job_id: string } } | undefined;
};
export type JobState = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type JobSnapshot = {
	job_id: string;
	command: string;
	state: JobState;
	wall_time_seconds: number;
	output: string;
	truncated: boolean;
	exit_code?: number;
	full_output_path?: string;
}
interface Job {
	id: string;
	command: string;
	startedAt: number;
	endedAt?: number;
	state: JobState;
	controller: AbortController;
	snapshot: Pick<JobSnapshot, "output" | "truncated" | "exit_code" | "full_output_path">;
	background: boolean;
	generation: number;
	done: Promise<void>;
}

type Outcome = { result: BashResult } | { error: unknown };
/** Jobs settle one at a time; the UI redraws on each transition. */
export type JobChange = (job: JobSnapshot | undefined) => void;
const MAX_RUNNING = 16;
const MAX_COMPLETED = 20;
/** How long shutdown waits for aborted commands before giving up on them. */
const DISPOSE_GRACE_MS = 2000;
export class BackgroundBash {
	private jobs = new Map<string, Job>();
	private generation = 0;

	constructor(private readonly notify: (job: JobSnapshot) => void) {}

	/** Deliver one completion now, outside the scheduler's own settle path. */
	deliver(job: JobSnapshot): void {
		try {
			this.notify(job);
		} catch {
			// bash_jobs still reports the result.
		}
	}

	private listeners = new Set<JobChange>();

	/** Observe job transitions (start, settle, cancel). Returns an unsubscribe. */
	onChange(listener: JobChange): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(job: Job | undefined): void {
		const snapshot = job ? this.describe(job) : undefined;
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// A broken observer must not break job execution.
			}
		}
	}

	async execute(options: {
		command: string;
		background?: boolean;
		afterMs: number;
		signal?: AbortSignal;
		onUpdate?: (result: BashResult) => void;
		run: (signal: AbortSignal, update: (result: BashResult) => void, jobId: string) => Promise<BashResult>;
	}): Promise<BashResult> {
		if (options.signal?.aborted) throw new Error("Command aborted");
		if (this.activeCount() >= MAX_RUNNING) throw new Error(`At most ${MAX_RUNNING} bash commands may run at once`);
		const job: Job = {
			id: `bg-${randomUUID().slice(0, 8)}`, command: options.command, startedAt: Date.now(),
			state: "running", controller: new AbortController(), snapshot: { output: "", truncated: false },
			background: false, generation: this.generation, done: Promise.resolve(),
		};
		this.jobs.set(job.id, job);
		const abort = () => job.controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const update = (result: BashResult) => {
			job.snapshot = snapshot(result);
			if (!job.background) options.onUpdate?.(result);
		};
		const execution: Promise<Outcome> = Promise.resolve().then(() => options.run(job.controller.signal, update, job.id)).then(
			(result) => ({ result }), (error: unknown) => ({ error }),
		);
		job.done = execution.then((outcome) => {
			job.endedAt = Date.now();
			if ("result" in outcome) job.snapshot = snapshot(outcome.result);
			else job.snapshot = snapshot({ content: [{ type: "text", text: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }], details: undefined });
			job.state = job.controller.signal.aborted ? "cancelled" : "error" in outcome || ("result" in outcome && outcome.result.isError) ? "failed" : "completed";
			options.signal?.removeEventListener("abort", abort);
			if (job.generation === this.generation) this.emit(job);
			if (job.background && job.generation === this.generation) {
				this.prune();
				// Prune first; the completion wakes the agent, and a throwing
				// handler must not surface as an unhandled rejection here.
				try {
					this.notify(this.describe(job));
				} catch {
					// The job's own record still reports the result through bash_jobs.
				}
			}
		});
		let clearTimer: (() => void) | undefined;
		try {
			const outcome = options.background === true ? undefined : await Promise.race([
				execution,
				...(options.background !== false && options.afterMs > 0
					? [new Promise<undefined>((resolve) => {
						const timer = setTimeout(() => resolve(undefined), options.afterMs);
						clearTimer = () => clearTimeout(timer);
					})] : []),
			]);
			if (outcome !== undefined) {
				this.jobs.delete(job.id);
				if ("error" in outcome) throw outcome.error;
				return outcome.result;
			}
			job.background = true;
			options.signal?.removeEventListener("abort", abort);
			this.emit(job);
			return {
				content: [{ type: "text", text: `Background job ${job.id} is running. Continue other work; its result arrives automatically. Do not poll or rerun it. Use bash_jobs to inspect or cancel. If nothing else remains, end your turn.` }],
				details: { bashGuardBackground: { status: "running", job_id: job.id } },
				structuredContent: { status: "running", job_id: job.id },
			};
		} finally {
			clearTimer?.();
		}
	}

	/** Background jobs only: what the user sees as owned async work. */
	backgroundJobs(): JobSnapshot[] {
		return [...this.jobs.values()].filter((job) => job.background).map((job) => this.describe(job));
	}

	list(id?: string): JobSnapshot[] {
		if (id) {
			const job = this.jobs.get(id);
			if (!job || !job.background) throw new Error(`Unknown background job: ${id}`);
			return [this.describe(job)];
		}
		// A list omits output, so `truncated` describes whether output is being
		// withheld here. A job whose full tail fits was never truncated.
		return this.backgroundJobs().map((job) => ({ ...job, output: "", truncated: false }));
	}

	cancel(id: string): JobSnapshot[] {
		this.list(id);
		const job = this.jobs.get(id)!;
		if (!job.endedAt) {
			job.state = "cancelling";
			job.controller.abort();
			this.emit(job);
		}
		return [this.describe(job)];
	}

	async dispose(): Promise<void> {
		this.generation++;
		const jobs = [...this.jobs.values()];
		for (const job of jobs) job.controller.abort();
		// A command that ignores its abort signal must not hang shutdown; the
		// kill path is best-effort from here, and the table is cleared either way.
		await Promise.race([
			Promise.all(jobs.map((job) => job.done)),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, DISPOSE_GRACE_MS);
				timer.unref?.();
			}),
		]);
		this.jobs.clear();
		this.emit(undefined);
	}

	private activeCount(): number {
		// Retained settled jobs stay in the table for inspection; they must not
		// count against the concurrency cap.
		return [...this.jobs.values()].filter((job) => job.endedAt === undefined).length;
	}

	private describe(job: Job): JobSnapshot {
		return {
			job_id: job.id, command: job.command.slice(0, 500), state: job.state,
			wall_time_seconds: Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt) / 1000,
			...job.snapshot,
		};
	}

	private prune(): void {
		// `execute` also inserts foreground jobs, so the retention cap counts
		// background jobs only and never evicts a command that is still running.
		const settled = [...this.jobs.values()].filter((job) => job.background && job.endedAt !== undefined);
		for (const job of settled.slice(0, -MAX_COMPLETED)) this.jobs.delete(job.id);
	}
}

function snapshot(result: BashResult): Job["snapshot"] {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const data = result.structuredContent as { exit_code?: number; full_output_path?: string } | undefined;
	const fullOutputPath = data?.full_output_path ?? result.details?.fullOutputPath;
	return {
		output: text,
		truncated: result.details?.truncation?.truncated === true,
		...(data?.exit_code !== undefined ? { exit_code: data.exit_code } : {}),
		...(fullOutputPath ? { full_output_path: fullOutputPath } : {}),
	};
}
