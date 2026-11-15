import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import { truncateTail, type createBashToolDefinition } from "@earendil-works/pi-coding-agent";

export type BashResult = Awaited<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>>;
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

export class BackgroundBash {
	private jobs = new Map<string, Job>();
	private generation = 0;

	constructor(private readonly notify: (job: JobSnapshot) => void) {}

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
		run: (signal: AbortSignal, update: (result: BashResult) => void) => Promise<BashResult>;
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
		const execution: Promise<Outcome> = Promise.resolve().then(() => options.run(job.controller.signal, update)).then(
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
				this.notify(this.describe(job));
				this.prune();
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
				details: undefined,
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
		return [...this.jobs.values()].filter((job) => job.background).map((job) => ({ ...this.describe(job), output: "", truncated: job.snapshot.truncated || job.snapshot.output.length > 0 }));
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
		await Promise.all(jobs.map((job) => job.done));
		this.jobs.clear();
		this.emit(undefined);
	}

	private activeCount(): number {
		return [...this.jobs.values()].filter((job) => !job.endedAt).length;
	}

	private describe(job: Job): JobSnapshot {
		return {
			job_id: job.id, command: job.command.slice(0, 500), state: job.state,
			wall_time_seconds: Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt) / 1000,
			...job.snapshot,
		};
	}

	private prune(): void {
		const completed = [...this.jobs.values()].filter((job) => job.endedAt !== undefined);
		for (const job of completed.slice(0, -MAX_COMPLETED)) this.jobs.delete(job.id);
	}
}

function snapshot(result: BashResult): Job["snapshot"] {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const tail = truncateTail(text, { maxBytes: 4096, maxLines: 40 });
	const data = result.structuredContent as { exit_code?: number; full_output_path?: string; truncated?: boolean } | undefined;
	const fullOutputPath = data?.full_output_path ?? result.details?.fullOutputPath;
	return {
		output: tail.content,
		truncated: tail.truncated || data?.truncated === true || result.details?.truncation?.truncated === true,
		...(data?.exit_code !== undefined ? { exit_code: data.exit_code } : {}),
		...(fullOutputPath ? { full_output_path: fullOutputPath } : {}),
	};
}
