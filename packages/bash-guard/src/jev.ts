/**
 * Jev transport: registry candidates retain pi's request-time authentication;
 * an explicit endpoint uses the SDK's native System One classifier directly.
 * Auto mode tries each available candidate once per decision, in preference
 * order, on errors, timeouts, or malformed answers. A valid verdict (at any
 * probability) ends the search. Model pins never use aliases or failover.
 */
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierQuestion, ClassifierResult, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { JevEndpointConfig } from "./config.js";
import { redactSecrets } from "./redact.js";

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
	/** Configured model as "provider/modelId"; undefined enables auto mode. */
	modelSpec?: string;
	/** Explicit System One endpoint, before registry candidates; excludes modelSpec. */
	endpoint?: JevEndpointConfig;
	timeoutMs: number;
}

export interface Jev {
	/** Last known availability; `ensureAvailable()` re-resolves lazily. */
	readonly available: boolean;
	/** Last successful (or initially resolved) "provider/modelId", without credentials. */
	readonly model: string;
	ensureAvailable(signal?: AbortSignal): Promise<boolean>;
	/** Why Jev is off, and how to enable it. Empty string when available. */
	describeUnavailable(): string;
	guardAnswer(state: unknown, signal?: AbortSignal): Promise<GuardJevResult>;
	watchdogAnswer(state: unknown, signal?: AbortSignal): Promise<WatchdogJevResult>;
	/** Session totals from all classifier attempts that reported usage. */
	usage(): JevUsage;
	/** Reason of the most recent failed decision; cleared by the next answer. Caller aborts never set it. */
	readonly lastFailure: JevFailureReason | undefined;
}

/** Jev models in preference order; aliases derive from an authenticated template. */
export const JEV_PREFERENCES: readonly { provider: string; modelId: string; templateId?: string }[] = [
	{ provider: "typesafe", modelId: "jev-latest" },
	{ provider: "typesafe", modelId: "jev-1.13.0", templateId: "jev-latest" },
	{ provider: "openrouter", modelId: "~typesafe/jev-latest" },
	{ provider: "openrouter", modelId: "typesafe/jev-1.13" },
	{ provider: "opencode", modelId: "jev-1.13" },
	{ provider: "vercel-ai-gateway", modelId: "typesafe-ai/jev" },
	{ provider: "cloudflare-workers-ai", modelId: "typesafe/jev" },
];

export const JEV_ENDPOINT_MODELS: readonly string[] = ["jev-latest", "jev-1.13.0"];

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

function failureOf(result: ClassifierResult): JevFailure {
	if (result.stopReason === "aborted") return { ok: false, reason: "aborted" };
	if (result.stopReason === "error") return { ok: false, reason: "error", detail: result.errorMessage ?? undefined };
	return { ok: false, reason: "unknown" };
}

interface CandidateModel {
	model: ClassifierModel<ClassifierApi>;
	/** Redacted "provider/modelId", never an endpoint URL. */
	label: string;
}

type Candidate = CandidateModel & (
	| { source: "registry"; registry: ModelRegistry }
	| { source: "endpoint"; apiKey: string }
);

/** Bound work even if a provider doesn't promptly settle after cancellation. */
async function untilAbort<T>(pending: Promise<T>, signal: AbortSignal, failure: () => JevFailure): Promise<T | JevFailure> {
	let onAbort!: () => void;
	const interrupted = new Promise<JevFailure>((resolve) => {
		onAbort = () => resolve(failure());
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, interrupted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function createJev(deps: JevDeps): Jev {
	let resolved: Candidate | undefined;
	let endpointProvider: Provider | undefined;
	let usageTotals: JevUsage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	let lastFailure: JevFailureReason | undefined;
	// Retain observed endpoint keys so even a late response after key rotation is safe.
	const secrets = new Set<string>();
	if (deps.endpoint?.apiKey) secrets.add(deps.endpoint.apiKey);

	function sanitize(text: string): string {
		for (const secret of secrets) {
			text = text.replaceAll(secret, "[REDACTED]");
			try {
				text = text.replaceAll(encodeURIComponent(secret), "[REDACTED]");
			} catch {
				// A malformed Unicode key still gets literal redaction.
			}
		}
		return redactSecrets(text);
	}

	function track<T extends GuardJevResult | WatchdogJevResult>(result: T): T {
		if (result.ok) lastFailure = undefined;
		else if (result.reason !== "aborted") lastFailure = result.reason;
		return result;
	}

	function labelOf(model: ClassifierModel<ClassifierApi>): string {
		return sanitize(`${model.provider}/${model.id}`);
	}

	function endpointCandidates(): Candidate[] {
		const endpoint = deps.endpoint;
		if (!endpoint || /\s/.test(endpoint.apiKey)) return [];
		const reference = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(endpoint.apiKey);
		// Only whole-value references are supported; never send an unresolved placeholder.
		if (!reference && (endpoint.apiKey.includes("$") || endpoint.apiKey.startsWith("!"))) return [];
		const apiKey = reference ? process.env[(reference[1] ?? reference[2])!] : endpoint.apiKey;
		if (!apiKey?.trim() || apiKey.includes("$")) return [];
		secrets.add(apiKey);
		return [...new Set(endpoint.models ?? JEV_ENDPOINT_MODELS)].map((id) => {
			const model: ClassifierModel<"typesafe-system-one"> = {
				type: "classifier",
				provider: "endpoint",
				api: "typesafe-system-one",
				id,
				name: id,
				baseUrl: endpoint.baseUrl,
				input: ["text"],
				contextWindow: 128_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			return { source: "endpoint", model, label: labelOf(model), apiKey };
		});
	}

	async function* resolveCandidates(signal?: AbortSignal): AsyncGenerator<Candidate> {
		if (signal?.aborted || (deps.modelSpec !== undefined && deps.endpoint !== undefined)) return;
		if (deps.modelSpec === undefined) {
			for (const candidate of endpointCandidates()) {
				if (signal?.aborted) return;
				yield candidate;
			}
		}
		if (signal?.aborted) return;
		const registry = deps.getRegistry();
		if (!registry) return;
		const availableByProvider = new Map<string, readonly ClassifierModel<ClassifierApi>[]>();
		async function availableFor(provider: string): Promise<readonly ClassifierModel<ClassifierApi>[]> {
			const cached = availableByProvider.get(provider);
			if (cached) return cached;
			const deadline = new AbortController();
			const probeSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
			const timer = setTimeout(() => deadline.abort(), deps.timeoutMs);
			try {
				const pending = (async () => {
					if (probeSignal.aborted) return [];
					try {
						return await registry!.getAvailableOfType("classifier", provider, { signal: probeSignal });
					} catch {
						return []; // Unavailable auth must not disable other providers.
					}
				})();
				const result = await untilAbort(pending, probeSignal, () => ({ ok: false, reason: signal?.aborted ? "aborted" : "timeout" }));
				// Only the winning probe result enters the cache; late auth output
				// cannot update availability or the selected status model.
				const available = probeSignal.aborted || !Array.isArray(result) ? [] : result;
				availableByProvider.set(provider, available);
				return available;
			} finally {
				clearTimeout(timer);
			}
		}
		const pin = deps.modelSpec === undefined ? undefined : parseModelSpec(deps.modelSpec);
		if (deps.modelSpec !== undefined && !pin) return;
		for (const preference of pin ? [pin] : JEV_PREFERENCES) {
			if (signal?.aborted) break;
			const available = await availableFor(preference.provider);
			if (signal?.aborted) return;
			const templateId = "templateId" in preference ? preference.templateId : undefined;
			let model = available.find((model) => model.id === (templateId ?? preference.modelId));
			if (templateId) {
				// Only the native TypeSafe System One model can supply this wire alias.
				if (model?.provider !== "typesafe" || model.api !== "typesafe-system-one") continue;
				model = { ...model, id: preference.modelId };
			}
			if (model) yield { source: "registry", registry, model, label: labelOf(model) };
		}
	}

	async function ensureAvailable(signal?: AbortSignal): Promise<boolean> {
		for await (const candidate of resolveCandidates(signal)) {
			if (signal?.aborted) return false;
			// Keep the last successful label (including wire aliases) without
			// probing unused fallback providers merely to refresh status.
			resolved ??= candidate;
			return true;
		}
		if (!signal?.aborted) resolved = undefined;
		return false;
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

	async function attempt(candidate: Candidate, context: ClassifierContext, signal?: AbortSignal): Promise<ClassifierResult | JevFailure> {
		const deadline = new AbortController();
		const callSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
		const interruption = (): JevFailure => ({ ok: false, reason: signal?.aborted ? "aborted" : "timeout" });
		const timer = setTimeout(() => deadline.abort(), deps.timeoutMs);
		const pending = (async (): Promise<ClassifierResult | JevFailure> => {
			try {
				if (callSignal.aborted) return interruption();
				const options = { signal: callSignal, timeoutMs: deps.timeoutMs, maxRetries: 0 };
				let result: ClassifierResult;
				if (candidate.source === "endpoint") {
					// Pi exposes providers/all to managed extensions, not raw API subpaths.
					// Call the native provider directly so registry auth/overrides stay isolated.
					endpointProvider ??= builtinProviders().find((provider) => provider.id === "typesafe");
					if (!endpointProvider?.classify) throw new Error("Pi's TypeSafe classifier is unavailable");
					result = await endpointProvider.classify(candidate.model, context, { ...options, apiKey: candidate.apiKey });
				} else {
					result = await candidate.registry.classify(candidate.model, context, options);
				}
				// Include billed failures, malformed answers, and late cancelled results.
				addUsage(result);
				if (callSignal.aborted) return interruption();
				return result;
			} catch (error) {
				if (callSignal.aborted) return interruption();
				return { ok: false, reason: "error", detail: sanitize(error instanceof Error ? error.message : String(error)) };
			}
		})();
		try {
			return await untilAbort(pending, callSignal, interruption);
		} finally {
			clearTimeout(timer);
		}
	}

	async function ask<T extends GuardJevAnswer | WatchdogJevAnswer>(
		state: unknown,
		questions: Record<string, ClassifierQuestion>,
		signal: AbortSignal | undefined,
		answerOf: (result: ClassifierResult, model: string) => T | JevFailure,
	): Promise<T | JevFailure> {
		const aborted = (): JevFailure => ({ ok: false, reason: "aborted" });
		if (signal?.aborted) return aborted();
		let found = false;
		let failure: JevFailure = { ok: false, reason: "error", detail: "no Jev classifier available" };
		for await (const candidate of resolveCandidates(signal)) {
			if (signal?.aborted) return aborted();
			found = true;
			resolved ??= candidate;
			const result = await attempt(candidate, { state: state as ClassifierContext["state"], questions }, signal);
			if (signal?.aborted) return aborted();
			const answer = "ok" in result ? result
				: result.stopReason !== "stop" ? failureOf(result)
				: answerOf(result, candidate.label);
			if (answer.ok) {
				resolved = candidate;
				return answer;
			}
			if (answer.reason === "aborted") return answer;
			failure = answer.detail === undefined ? answer : { ...answer, detail: sanitize(answer.detail) };
		}
		if (signal?.aborted) return aborted();
		if (!found) resolved = undefined;
		return failure;
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
			if (deps.modelSpec !== undefined && deps.endpoint !== undefined) return "jev.model and jev.endpoint are mutually exclusive";
			if (deps.modelSpec !== undefined) {
				const spec = parseModelSpec(deps.modelSpec);
				if (spec) return sanitize(`configured classifier ${deps.modelSpec} is not available - check its credentials (/login ${spec.provider} or its API key env)`);
			}
			return `${deps.endpoint ? "configured Jev endpoint is unavailable - check jev.endpoint.apiKey and its environment variable; " : ""}no Jev classifier is available - run \`/login openrouter\` or set TYPESAFE_API_KEY / OPENROUTER_API_KEY`;
		},
		get lastFailure(): JevFailureReason | undefined {
			return lastFailure;
		},
		guardAnswer: async (state, signal) => track(await ask(state, { irreversible: GUARD_QUESTION }, signal, guardAnswerOf)),
		watchdogAnswer: async (state, signal) => track(await ask(state, WATCHDOG_QUESTIONS, signal, watchdogAnswerOf)),
		usage(): JevUsage {
			return { ...usageTotals };
		},
	};
}

function guardAnswerOf(result: ClassifierResult, model: string): GuardJevResult {
	const answer = result.answers?.irreversible;
	if (answer?.type !== "bool" || !isProbability(answer.probability)) return { ok: false, reason: "malformed" };
	return { ok: true, p: answer.probability, model };
}

function watchdogAnswerOf(result: ClassifierResult, model: string): WatchdogJevResult {
	const statusAnswer = result.answers?.status;
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
		model,
	};
}
