import { describe, expect, it, vi } from "vitest";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createJev, JEV_PREFERENCES, parseModelSpec } from "../src/jev.js";

function fakeModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return { provider, id, type: "classifier", api: "typesafe", contextWindow: 128_000 } as unknown as ClassifierModel<ClassifierApi>;
}

interface RegistryStub {
	getAvailableOfType: ReturnType<typeof vi.fn>;
	getModelOfType: ReturnType<typeof vi.fn>;
	classify: ReturnType<typeof vi.fn>;
}

/** getAvailable: provider -> model ids available for that provider. */
function makeRegistry(
	getAvailable: Record<string, string[]>,
	classify: (model: ClassifierModel<ClassifierApi>, context: unknown, options: { signal?: AbortSignal }) => Promise<Partial<ClassifierResult>>,
): RegistryStub {
	return {
		getAvailableOfType: vi.fn(async (_type: string, provider?: string) =>
			(getAvailable[provider ?? ""] ?? []).map((id) => fakeModel(provider ?? "", id)),
		),
		getModelOfType: vi.fn((_type: string, provider: string, modelId: string) => {
			const ids = getAvailable[provider] ?? [];
			return ids.includes(modelId) ? fakeModel(provider, modelId) : undefined;
		}),
		classify: vi.fn(classify),
	};
}

function makeJev(registry: RegistryStub, modelSpec?: string, timeoutMs = 3000) {
	return createJev({
		getRegistry: () => registry as unknown as ModelRegistry,
		modelSpec,
		timeoutMs,
	});
}

function stopResult(answers: Record<string, unknown>, provider = "openrouter", model = "~typesafe/jev-latest"): Partial<ClassifierResult> {
	return {
		provider,
		model,
		answers: answers as ClassifierResult["answers"],
		stopReason: "stop",
		usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 } },
	} as Partial<ClassifierResult>;
}

const BOOL_TRUE = { type: "bool", probability: 0.9 };

describe("jev model resolution", () => {
	it("parses provider/modelId on the first slash", () => {
		expect(parseModelSpec("openrouter/~typesafe/jev-latest")).toEqual({ provider: "openrouter", modelId: "~typesafe/jev-latest" });
		expect(parseModelSpec("typesafe/jev-latest")).toEqual({ provider: "typesafe", modelId: "jev-latest" });
		expect(parseModelSpec("jev-latest")).toBeUndefined();
		expect(parseModelSpec("/x")).toBeUndefined();
		expect(parseModelSpec("provider/")).toBeUndefined();
	});

	it("auto-detects in preference order and only Jev models", () => {
		const providers = new Set(JEV_PREFERENCES.map((p) => p.provider));
		expect(providers.has("typesafe")).toBe(true);
		expect(JEV_PREFERENCES.some((p) => p.modelId.includes("clef") || p.modelId.includes("llama"))).toBe(false);
	});

	it("picks the first available Jev model in preference order", async () => {
		const registry = makeRegistry(
			{ typesafe: [], openrouter: ["~typesafe/jev-latest", "typesafe/jev-1.13"] },
			async () => stopResult({ irreversible: { type: "bool", probability: 0.1 } }),
		);
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
		await jev.guardAnswer({ value: {} });
		expect(registry.classify.mock.calls[0][0].id).toBe("~typesafe/jev-latest");
	});

	it("prefers typesafe jev-latest when available", async () => {
		const registry = makeRegistry(
			{ typesafe: ["jev-latest"], openrouter: ["~typesafe/jev-latest"] },
			async () => stopResult({ irreversible: BOOL_TRUE }, "typesafe", "jev-latest"),
		);
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("typesafe/jev-latest");
	});

	it("uses the configured model and does not fall back when it is unavailable", async () => {
		const registry = makeRegistry(
			{ openrouter: [] }, // nothing available anywhere
			async () => stopResult({}),
		);
		const jev = makeJev(registry, "openrouter/~typesafe/jev-latest");
		expect(await jev.ensureAvailable()).toBe(false);
		expect(jev.available).toBe(false);
		const hint = jev.describeUnavailable();
		expect(hint).toContain("openrouter/~typesafe/jev-latest");
		// Never consulted another provider.
		expect(registry.getAvailableOfType.mock.calls.every((call) => call[1] === "openrouter")).toBe(true);
	});

	it("caches resolution and re-resolves only when the model vanishes", async () => {
		const available: Record<string, string[]> = { typesafe: ["jev-latest"] };
		const registry = makeRegistry(available, async () => stopResult({}));
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(true);
		const calls = registry.getAvailableOfType.mock.calls.length;
		expect(await jev.ensureAvailable()).toBe(true);
		expect(registry.getAvailableOfType.mock.calls.length).toBe(calls); // cached
		available.typesafe = []; // model vanished from the catalog
		expect(await jev.ensureAvailable()).toBe(false);
	});

	it("re-resolves lazily after a login makes a provider available", async () => {
		const available: Record<string, string[]> = {};
		const registry = makeRegistry(available, async () => stopResult({}));
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(false);
		expect(jev.describeUnavailable()).toContain("/login openrouter");
		available.openrouter = ["~typesafe/jev-latest"]; // /login happened
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
	});
});

describe("jev classify calls", () => {
	it("maps the guard bool answer", async () => {
		const registry = makeRegistry(
			{ typesafe: ["jev-latest"] },
			async (_model, context, options) => {
				expect(context).toMatchObject({ questions: { irreversible: { type: "bool" } } });
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				return stopResult({ irreversible: { type: "bool", probability: 0.42 } }, "typesafe", "jev-latest");
			},
		);
		const jev = makeJev(registry);
		const answer = await jev.guardAnswer({ value: {} });
		expect(answer).toEqual({ ok: true, p: 0.42, model: "typesafe/jev-latest" });
	});

	it("maps the watchdog status and persistent answers", async () => {
		const registry = makeRegistry(
			{ typesafe: ["jev-latest"] },
			async () =>
				stopResult(
					{
						status: { type: "choice", choice: "stuck", probabilities: { stuck: 0.95, waiting: 0.05 }, confidence: 0.95 },
						persistent: { type: "bool", probability: 0.2 },
					},
					"typesafe",
					"jev-latest",
				),
		);
		const jev = makeJev(registry);
		const answer = await jev.watchdogAnswer({ value: {} });
		expect(answer).toEqual({
			ok: true,
			status: "stuck",
			pStatus: 0.95,
			probabilities: { stuck: 0.95, waiting: 0.05 },
			persistent: 0.2,
			model: "typesafe/jev-latest",
		});
	});

	it("maps stopReason error to a failure with detail", async () => {
		const registry = makeRegistry({ typesafe: ["jev-latest"] }, async () => ({ stopReason: "error", errorMessage: "401 unauthorized" }) as Partial<ClassifierResult>);
		const answer = await makeJev(registry).guardAnswer({ value: {} });
		expect(answer).toEqual({ ok: false, reason: "error", detail: "401 unauthorized" });
	});

	it("maps caller abort to aborted and timeout to timeout", async () => {
		const registry = makeRegistry({ typesafe: ["jev-latest"] }, async (_m, _c, options) => {
			await new Promise<void>((resolve) => {
				const done = () => resolve();
				if (options?.signal?.aborted) done();
				else options?.signal?.addEventListener("abort", done, { once: true });
			});
			return { stopReason: options?.signal?.aborted ? "aborted" : "stop" } as Partial<ClassifierResult>;
		});
		const aborted = new AbortController();
		aborted.abort();
		expect(await makeJev(registry).guardAnswer({ value: {} }, aborted.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(await makeJev(registry, undefined, 20).guardAnswer({ value: {} })).toEqual({ ok: false, reason: "timeout" });
	});

	it("treats malformed answers as failures", async () => {
		const missing = makeRegistry({ typesafe: ["jev-latest"] }, async () => stopResult({}));
		expect(await makeJev(missing).guardAnswer({ value: {} })).toEqual({ ok: false, reason: "malformed" });
		const wrongType = makeRegistry({ typesafe: ["jev-latest"] }, async () => stopResult({ irreversible: { type: "choice", choice: "x" } }));
		expect(await makeJev(wrongType).guardAnswer({ value: {} })).toEqual({ ok: false, reason: "malformed" });
	});

	it("accumulates classifier usage for the session", async () => {
		const registry = makeRegistry(
			{ typesafe: ["jev-latest"] },
			async () => stopResult({ irreversible: { type: "bool", probability: 0.1 } }),
		);
		const jev = makeJev(registry);
		await jev.guardAnswer({ value: {} });
		await jev.guardAnswer({ value: {} });
		expect(jev.usage()).toEqual({ input: 20, output: 10, totalTokens: 30, cost: 0.0004 });
	});
});
