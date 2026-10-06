/**
 * The Jev transport, built on pi's built-in classifier API
 * (`ctx.modelRegistry.classify`) instead of a direct SDK, so the user's existing
 * pi credentials work: `/login`, TYPESAFE_API_KEY, OPENROUTER_API_KEY, etc.
 *
 * `classify` never rejects: every outcome travels through `stopReason`, so all
 * failures are translated into reason codes and callers route them to a decision
 * (guard escalates, watchdog treats the check as neutral and forgetful). Caller
 * cancellation is still visible as an `aborted` result, never as a verdict.
 *
 * The model resolves lazily: `jev.model` is "provider/modelId" (for example
 * "openrouter/~typesafe/jev-latest"); unset, the first available Jev classifier
 * in preference order is used. Resolution re-runs on demand (for example after
 * `/login`), and a configured model that is unavailable never falls back to
 * another provider.
 */
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Watchdog statuses Jev may report. */
export type WatchdogStatus = "progressing" | "waiting" | "stuck" | "looping";

export const WATCHDOG_STATUSES: readonly WatchdogStatus[] = ["progressing", "waiting", "stuck", "looping"];

export type JevFailureReason = "timeout" | "network" | "http" | "error" | "malformed" | "aborted" | "unknown";

export interface JevFailure {
	ok: false;
	reason: JevFailureReason;
	detail?: string;
}

export interface GuardJevAnswer {
	ok: true;
	/** Probability that the command could cause irreversible loss. */
	p: number;
	model: string;
}

export interface WatchdogJevAnswer {
	ok: true;
	status: WatchdogStatus;
	/** Probability of the selected status. */
	pStatus: number;
	/** All choice probabilities keyed by label. */
	probabilities: Record<string, number>;
	/** Probability that the command is a legitimate long-lived service. */
	persistent: number;
	model: string;
}

export type GuardJevResult = GuardJevAnswer | JevFailure;
export type WatchdogJevResult = WatchdogJevAnswer | JevFailure;

export interface JevUsage {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
}

export interface JevDeps {
	getRegistry(): ModelRegistry | undefined;
	/** Configured model as "provider/modelId"; undefined enables auto-detection. */
	modelSpec?: string;
	timeoutMs: number;
}

export interface Jev {
	/** Last known availability; `ensureAvailable()` re-resolves lazily. */
	readonly available: boolean;
	/** "provider/modelId" of the resolved model, or "" when none is resolved. */
	readonly model: string;
	ensureAvailable(): Promise<boolean>;
	/** Why Jev is off, and how to enable it. Empty string when available. */
	describeUnavailable(): string;
	guardAnswer(state: unknown, signal?: AbortSignal): Promise<GuardJevResult>;
	watchdogAnswer(state: unknown, signal?: AbortSignal): Promise<WatchdogJevResult>;
	/** Session totals from classifier calls that reported usage. */
	usage(): JevUsage;
	/** Reason of the most recent failed call; cleared by the next answer. Caller aborts never set it. */
	readonly lastFailure: JevFailureReason | undefined;
}

/** Jev models in preference order; Clef/llama classifier models are excluded. */
export const JEV_PREFERENCES: readonly { provider: string; modelId: string }[] = [
	{ provider: "typesafe", modelId: "jev-latest" },
	{ provider: "openrouter", modelId: "~typesafe/jev-latest" },
	{ provider: "openrouter", modelId: "typesafe/jev-1.13" },
	{ provider: "opencode", modelId: "jev-1.13" },
	{ provider: "vercel-ai-gateway", modelId: "typesafe-ai/jev" },
	{ provider: "cloudflare-workers-ai", modelId: "typesafe/jev" },
];

const GUARD_QUESTION = {
	type: "bool",
	instructions:
		"Running the bash command in value could cause irreversible loss - data, git history, or remote state - that cannot be undone with normal tooling.",
	criteria: {
		true: "Running the command would destroy data, history, or remote state beyond recovery with normal tooling (git reflog/restore, file backups, redeploying, re-publishing).",
		false: "The command is recoverable or benign in context: any damage can be undone with normal tooling, or the matched risky pattern does not apply here.",
	},
} as const;

const WATCHDOG_QUESTIONS = {
	status: {
		type: "choice",
		instructions: "The running bash command described in value is currently...",
		criteria: {
			progressing: "Making forward progress or doing expected long work",
			waiting: "Legitimately waiting (network, build step, sleep, human-scale timer)",
			stuck: "Hung, deadlocked, waiting on input that will never come, or frozen",
			looping: "Repeating the same failure/output without progress",
		},
	},
	persistent: {
		type: "bool",
		instructions: "The command in value is a long-lived service operating normally.",
		criteria: {
			true: "It is a long-lived service or watcher intended to keep running (dev server, file watcher, log tail, container, daemon) and it is operating normally.",
			false: "It is ordinary one-shot work that should finish on its own.",
		},
	},
} as const;

/** Parse "provider/modelId" (split on the first slash). */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function failureOf(result: ClassifierResult, timedOut: boolean): JevFailure {
	if (result.stopReason === "aborted") {
		return timedOut ? { ok: false, reason: "timeout" } : { ok: false, reason: "aborted" };
	}
	if (result.stopReason === "error") {
		return { ok: false, reason: "error", detail: result.errorMessage ?? undefined };
	}
	return { ok: false, reason: "unknown" };
}

interface Resolution {
	model: ClassifierModel<ClassifierApi>;
	/** "provider/modelId". */
	label: string;
	configured: boolean;
}

export function createJev(deps: JevDeps): Jev {
	let resolved: Resolution | undefined;
	let configuredMissing: { provider: string; modelId: string } | undefined;
	let usageTotals: JevUsage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	let lastFailure: JevFailureReason | undefined;

	function track<T extends GuardJevResult | WatchdogJevResult>(result: T): T {
		if (result.ok) lastFailure = undefined;
		else if (result.reason !== "aborted") lastFailure = result.reason;
		return result;
	}

	function labelOf(model: ClassifierModel<ClassifierApi>): string {
		return `${model.provider}/${model.id}`;
	}

	async function ensureAvailable(): Promise<boolean> {
		const registry = deps.getRegistry();
		if (!registry) return false;
		if (resolved) {
			// Cheap catalog re-check; a vanished model triggers re-resolution.
			if (registry.getModelOfType("classifier", resolved.model.provider, resolved.model.id)) return true;
			resolved = undefined;
		}
		if (deps.modelSpec !== undefined) {
			const spec = parseModelSpec(deps.modelSpec);
			if (!spec) return false;
			try {
				const available = await registry.getAvailableOfType("classifier", spec.provider);
				const found = available.find((model) => model.id === spec.modelId);
				if (found) {
					resolved = { model: found, label: deps.modelSpec, configured: true };
					configuredMissing = undefined;
					return true;
				}
			} catch {
				// Auth probing failed; report unavailable rather than guessing.
			}
			configuredMissing = spec;
			return false;
		}
		for (const preference of JEV_PREFERENCES) {
			try {
				const available = await registry.getAvailableOfType("classifier", preference.provider);
				const found = available.find((model) => model.id === preference.modelId);
				if (found) {
					resolved = { model: found, label: `${preference.provider}/${preference.modelId}`, configured: false };
					return true;
				}
			} catch {
				// Try the next provider.
			}
		}
		return false;
	}

	function combinedSignal(callSignal: AbortSignal | undefined): { signal: AbortSignal; timedOut(): boolean } {
		const timeout = AbortSignal.timeout(deps.timeoutMs);
		if (callSignal === undefined) {
			return { signal: timeout, timedOut: () => timeout.aborted };
		}
		return { signal: AbortSignal.any([callSignal, timeout]), timedOut: () => timeout.aborted };
	}

	function addUsage(result: ClassifierResult): void {
		const usage = result.usage;
		if (!usage) return;
		usageTotals = {
			input: usageTotals.input + (usage.input ?? 0),
			output: usageTotals.output + (usage.output ?? 0),
			totalTokens: usageTotals.totalTokens + (usage.totalTokens ?? 0),
			cost: usageTotals.cost + (usage.cost?.total ?? 0),
		};
	}

	async function ask(
		state: unknown,
		questions: Record<string, ClassifierQuestion>,
		signal: AbortSignal | undefined,
	): Promise<ClassifierResult | JevFailure> {
		if (resolved === undefined && !(await ensureAvailable())) {
			return { ok: false, reason: "error", detail: "no Jev classifier available" };
		}
		const registry = deps.getRegistry();
		const model = resolved?.model;
		if (!registry || !model) return { ok: false, reason: "error", detail: "no Jev classifier available" };
		const { signal: callSignal, timedOut } = combinedSignal(signal);
		const result = await registry.classify(
			model,
			{ state: state as ClassifierContext["state"], questions },
			{ signal: callSignal },
		);
		addUsage(result);
		if (result.stopReason !== "stop") return failureOf(result, timedOut());
		return result;
	}

	return {
		get available(): boolean {
			return resolved !== undefined;
		},
		get model(): string {
			return resolved?.label ?? "";
		},
		ensureAvailable,
		describeUnavailable(): string {
			if (resolved) return "";
			if (configuredMissing) {
				return `configured classifier ${configuredMissing.provider}/${configuredMissing.modelId} is not available - check its credentials (/login ${configuredMissing.provider} or its API key env)`;
			}
			return "no Jev classifier is available - run `/login openrouter` or set TYPESAFE_API_KEY / OPENROUTER_API_KEY";
		},
		get lastFailure(): JevFailureReason | undefined {
			return lastFailure;
		},
		guardAnswer: async (state, signal) => track(await guardAnswer(state, signal)),
		watchdogAnswer: async (state, signal) => track(await watchdogAnswer(state, signal)),
		usage(): JevUsage {
			return { ...usageTotals };
		},
	};

	async function guardAnswer(state: unknown, signal: AbortSignal | undefined): Promise<GuardJevResult> {
		const result = await ask(state, { irreversible: GUARD_QUESTION }, signal);
		if (!("answers" in result)) return result;
		const answer = result.answers.irreversible;
		if (answer?.type !== "bool" || !isProbability(answer.probability)) return { ok: false, reason: "malformed" };
		return { ok: true, p: answer.probability, model: `${result.provider}/${result.model}` };
	}

	async function watchdogAnswer(state: unknown, signal: AbortSignal | undefined): Promise<WatchdogJevResult> {
		const result = await ask(state, WATCHDOG_QUESTIONS, signal);
		if (!("answers" in result)) return result;
		const statusAnswer = result.answers.status;
		if (statusAnswer?.type !== "choice" || !WATCHDOG_STATUSES.includes(statusAnswer.choice as WatchdogStatus)) {
			return { ok: false, reason: "malformed" };
		}
		const pStatus = (statusAnswer.probabilities as Record<string, unknown> | undefined)?.[statusAnswer.choice];
		if (!isProbability(pStatus)) return { ok: false, reason: "malformed" };
		const persistent = result.answers.persistent;
		if (persistent?.type !== "bool" || !isProbability(persistent.probability)) return { ok: false, reason: "malformed" };
		const probabilities: Record<string, number> = {};
		for (const [label, value] of Object.entries(statusAnswer.probabilities ?? {})) {
			if (isProbability(value)) probabilities[label] = value;
		}
		return {
			ok: true,
			status: statusAnswer.choice as WatchdogStatus,
			pStatus,
			probabilities,
			persistent: persistent.probability,
			model: `${result.provider}/${result.model}`,
		};
	}
}
