import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createJev, JEV_PREFERENCES, parseModelSpec } from "../src/jev.js";

function fakeModel(provider: string, id: string, api: ClassifierApi = "typesafe"): ClassifierModel<ClassifierApi> {
	return {
		provider, id, name: id, type: "classifier", api, contextWindow: 128_000,
		baseUrl: "https://api.relayrouter.ai/v1", input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const systemOneModel = (provider: string, id: string) => fakeModel(provider, id, "typesafe-system-one");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

interface RegistryStub {
	getAvailableOfType: ReturnType<typeof vi.fn>;
	getModelOfType: ReturnType<typeof vi.fn>;
	classify: ReturnType<typeof vi.fn>;
}

/** getAvailable: provider -> model ids available for that provider. */
function makeRegistry(
	getAvailable: Record<string, string[]>,
	classify: (model: ClassifierModel<ClassifierApi>, context: unknown, options: { signal?: AbortSignal }) => Promise<Partial<ClassifierResult>>,
	modelFor: (provider: string, id: string) => ClassifierModel<ClassifierApi> = fakeModel,
): RegistryStub {
	return {
		getAvailableOfType: vi.fn(async (_type: string, provider?: string) =>
			(getAvailable[provider ?? ""] ?? []).map((id) => modelFor(provider ?? "", id)),
		),
		getModelOfType: vi.fn((_type: string, provider: string, modelId: string) => {
			const ids = getAvailable[provider] ?? [];
			return ids.includes(modelId) ? modelFor(provider, modelId) : undefined;
		}),
		classify: vi.fn(classify),
	};
}

function makeJev(registry: RegistryStub, modelSpec?: string, timeoutMs = 6000) {
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

describe("lazy bounded availability", () => {
	it("stops availability and successful decisions at the first candidate", async () => {
		const registry = makeRegistry({}, async () => stopResult({ irreversible: BOOL_TRUE }));
		registry.getAvailableOfType.mockImplementation(async (_type, provider) =>
			provider === "typesafe" ? [fakeModel("typesafe", "jev-latest")] : new Promise(() => {}));
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(true);
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "typesafe/jev-latest" });
		expect(registry.getAvailableOfType.mock.calls.map((call) => call[1])).toEqual(["typesafe", "typesafe"]);
	});

	it("aborts a timed-out probe, falls back, and discards late availability", async () => {
		vi.useFakeTimers();
		let finishProbe!: (models: ClassifierModel<ClassifierApi>[]) => void;
		let probeSignal!: AbortSignal;
		const registry = makeRegistry({}, async () => stopResult({ irreversible: BOOL_TRUE }));
		registry.getAvailableOfType.mockImplementation(async (_type, provider, options) => {
			if (provider === "typesafe") {
				probeSignal = options.signal;
				return new Promise((resolve) => { finishProbe = resolve; });
			}
			return [fakeModel("openrouter", "~typesafe/jev-latest")];
		});
		const jev = makeJev(registry, undefined, 20);
		const pending = jev.guardAnswer({});
		await vi.advanceTimersByTimeAsync(21);
		expect(await pending).toMatchObject({ ok: true, model: "openrouter/~typesafe/jev-latest" });
		expect(probeSignal.aborted).toBe(true);
		finishProbe([fakeModel("typesafe", "jev-latest")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
		expect(registry.classify).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels pending ensureAvailable without fallback or late status mutation", async () => {
		let finishProbe!: (models: ClassifierModel<ClassifierApi>[]) => void;
		const controller = new AbortController();
		const registry = makeRegistry({}, async () => stopResult({}));
		registry.getAvailableOfType.mockImplementation(async () => new Promise((resolve) => { finishProbe = resolve; }));
		const jev = makeJev(registry);
		const pending = jev.ensureAvailable(controller.signal);
		controller.abort();
		expect(await pending).toBe(false);
		finishProbe([fakeModel("typesafe", "jev-latest")]);
		await Promise.resolve();
		expect(jev.available).toBe(false);
		expect(registry.getAvailableOfType).toHaveBeenCalledTimes(1);
		expect(registry.getAvailableOfType.mock.calls[0][2].signal.aborted).toBe(true);
		expect(registry.classify).not.toHaveBeenCalled();
	});
});

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

	it("refreshes availability and notices a vanished model", async () => {
		const available: Record<string, string[]> = { typesafe: ["jev-latest"] };
		const registry = makeRegistry(available, async () => stopResult({}));
		const jev = makeJev(registry);
		expect(await jev.ensureAvailable()).toBe(true);
		const calls = registry.getAvailableOfType.mock.calls.length;
		expect(await jev.ensureAvailable()).toBe(true);
		expect(registry.getAvailableOfType.mock.calls.length).toBeGreaterThan(calls);
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

describe("automatic Jev failover", () => {
	const available = { typesafe: ["jev-latest"], openrouter: ["~typesafe/jev-latest", "typesafe/jev-1.13"] };

	it("derives the TypeSafe wire alias from the full authenticated template without modifying it", async () => {
		const template = { ...systemOneModel("typesafe", "jev-latest"), headers: { "x-test": "preserved" }, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
		const registry = makeRegistry(available, async (model) => model.id === "jev-latest"
			? { stopReason: "error", errorMessage: "model not served" }
			: stopResult({ irreversible: BOOL_TRUE }, model.provider, model.id),
			(provider, id) => provider === "typesafe" ? template : systemOneModel(provider, id),
		);
		const jev = makeJev(registry);
		expect(await jev.guardAnswer({ value: {} })).toEqual({ ok: true, p: 0.9, model: "typesafe/jev-1.13.0" });
		expect(registry.classify.mock.calls.map(([model]) => model.id)).toEqual(["jev-latest", "jev-1.13.0"]);
		const [alias, , options] = registry.classify.mock.calls[1];
		expect(alias).toEqual({ ...template, id: "jev-1.13.0" });
		expect(alias).not.toBe(template);
		expect(template.id).toBe("jev-latest");
		expect(options).toEqual({ signal: expect.any(AbortSignal), timeoutMs: 6000, maxRetries: 0 });
		expect(options).not.toHaveProperty("apiKey"); // credentials stay with the registry
		expect(registry.getModelOfType).not.toHaveBeenCalled(); // the alias is not a catalog lookup
		expect(jev.model).toBe("typesafe/jev-1.13.0");
	});

	it("does not synthesize aliases for another API or without the base template", async () => {
		for (const models of [{ typesafe: ["jev-latest"] }, { typesafe: ["jev-1.13.0"] }]) {
			const registry = makeRegistry({ ...models, openrouter: ["~typesafe/jev-latest"] }, async (model) => model.provider === "typesafe"
				? { stopReason: "error" } : stopResult({ irreversible: BOOL_TRUE }));
			expect(await makeJev(registry).guardAnswer({})).toMatchObject({ ok: true, model: "openrouter/~typesafe/jev-latest" });
			expect(registry.classify.mock.calls.some(([model]) => model.id === "jev-1.13.0")).toBe(false);
		}
	});

	it("walks every available candidate once, in order, and uses the last failure if none succeed", async () => {
		const models: Record<string, string[]> = {};
		for (const { provider, modelId, templateId } of JEV_PREFERENCES) {
			if (!templateId) (models[provider] ??= []).push(modelId);
		}
		const registry = makeRegistry(models, async (model) => ({ stopReason: "error", errorMessage: `failed ${model.id}` }), systemOneModel);
		const jev = makeJev(registry);
		expect(await jev.guardAnswer({})).toEqual({ ok: false, reason: "error", detail: "failed typesafe/jev" });
		expect(registry.classify.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).toEqual(JEV_PREFERENCES.map((p) => `${p.provider}/${p.modelId}`));
		expect(new Set(registry.classify.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).size).toBe(JEV_PREFERENCES.length);
		expect(jev.lastFailure).toBe("error");
	});

	it.each([
		{ stopReason: "error", errorMessage: "upstream failed" },
		stopResult({}),
		stopResult({ irreversible: { type: "bool", probability: 2 } }),
		stopResult({ irreversible: { type: "bool", probability: NaN } }),
		stopResult({ irreversible: { type: "choice", choice: "wrong" } }),
	] as Partial<ClassifierResult>[])("fails over on error or malformed result %#", async (bad) => {
		const registry = makeRegistry(available, async (model) => model.provider === "typesafe" ? bad : stopResult({ irreversible: BOOL_TRUE }));
		const jev = makeJev(registry);
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, p: 0.9, model: "openrouter/~typesafe/jev-latest" });
		expect(registry.classify).toHaveBeenCalledTimes(2);
		expect(jev.lastFailure).toBeUndefined();
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
	});

	it("also fails over when classification or auth probing throws", async () => {
		const registry = makeRegistry(available, async (model) => {
			if (model.provider === "typesafe") throw new Error("connection lost");
			return stopResult({ irreversible: BOOL_TRUE });
		});
		expect(await makeJev(registry).guardAnswer({})).toMatchObject({ ok: true });
		expect(registry.classify).toHaveBeenCalledTimes(2);
		registry.classify.mockClear();
		registry.getAvailableOfType.mockImplementation(async (_type, provider) => {
			if (provider === "typesafe") throw new Error("auth probe failed");
			return provider === "openrouter" ? [fakeModel("openrouter", "~typesafe/jev-latest")] : [];
		});
		expect(await makeJev(registry).guardAnswer({})).toMatchObject({ ok: true });
		expect(registry.classify).toHaveBeenCalledTimes(1);
	});

	it("bounds non-cooperative requests and gives the next attempt a fresh timeout", async () => {
		vi.useFakeTimers();
		const registry = makeRegistry(available, async (model) => {
			if (model.provider === "typesafe") return new Promise(() => {});
			await new Promise((resolve) => setTimeout(resolve, 15));
			return stopResult({ irreversible: BOOL_TRUE });
		});
		const pending = makeJev(registry, undefined, 20).guardAnswer({});
		await vi.advanceTimersByTimeAsync(21);
		expect(registry.classify).toHaveBeenCalledTimes(2);
		const firstSignal = registry.classify.mock.calls[0][2].signal;
		const secondSignal = registry.classify.mock.calls[1][2].signal;
		expect(firstSignal.aborted).toBe(true);
		expect(secondSignal).not.toBe(firstSignal);
		expect(secondSignal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(14);
		expect(await pending).toMatchObject({ ok: true, model: "openrouter/~typesafe/jev-latest" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("restarts at the preferred provider on the next decision, without erasing the successful status label", async () => {
		let healthy = false;
		const registry = makeRegistry(available, async (model) => model.provider === "typesafe" && !healthy
			? { stopReason: "error" } : stopResult({ irreversible: BOOL_TRUE }, model.provider, model.id));
		const jev = makeJev(registry);
		await jev.guardAnswer({});
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
		healthy = true;
		await jev.guardAnswer({});
		expect(registry.classify.mock.calls.map(([model]) => model.provider)).toEqual(["typesafe", "openrouter", "typesafe"]);
		expect(jev.model).toBe("typesafe/jev-latest");
	});

	it("accumulates usage from errors, malformed responses, and the successful attempt", async () => {
		const registry = makeRegistry(available, async (model) => {
			const result = stopResult({ irreversible: BOOL_TRUE });
			if (model.provider === "typesafe") return { ...result, stopReason: "error" };
			if (model.id === "~typesafe/jev-latest") return { ...result, answers: {} };
			return result;
		});
		const jev = makeJev(registry);
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "openrouter/typesafe/jev-1.13" });
		expect(jev.usage()).toMatchObject({ input: 30, output: 15, totalTokens: 45 });
		expect(jev.usage().cost).toBeCloseTo(0.0006);
	});

	it.each([0, 0.9, 1])("never seeks a different guard verdict after a valid p=%s answer", async (p) => {
		const registry = makeRegistry(available, async (model) => stopResult({ irreversible: { type: "bool", probability: p } }, model.provider, model.id), systemOneModel);
		expect(await makeJev(registry).guardAnswer({})).toEqual({ ok: true, p, model: "typesafe/jev-latest" });
		expect(registry.classify).toHaveBeenCalledTimes(1);
	});

	it.each(["progressing", "stuck", "looping"])("never seeks a different watchdog verdict after valid status %s", async (status) => {
		const registry = makeRegistry(available, async (model) => stopResult({
			status: { type: "choice", choice: status, probabilities: { [status]: 1 }, confidence: 1 },
			persistent: { type: "bool", probability: 0 },
		}, model.provider, model.id), systemOneModel);
		expect(await makeJev(registry).watchdogAnswer({})).toMatchObject({ ok: true, status, pStatus: 1, model: "typesafe/jev-latest" });
		expect(registry.classify).toHaveBeenCalledTimes(1);
	});

	it.each([
		{},
		{ status: { type: "choice", choice: "other", probabilities: { other: 1 } }, persistent: BOOL_TRUE },
		{ status: { type: "choice", choice: "stuck", probabilities: { stuck: -1 } }, persistent: BOOL_TRUE },
		{ status: { type: "choice", choice: "stuck", probabilities: { stuck: 1 } } },
		{ status: { type: "choice", choice: "stuck", probabilities: { stuck: 1 } }, persistent: { type: "bool", probability: Infinity } },
	])("fails over on malformed watchdog answers %#", async (answers) => {
		const registry = makeRegistry(available, async (model) => stopResult(model.provider === "typesafe" ? answers : {
			status: { type: "choice", choice: "waiting", probabilities: { waiting: 1 } }, persistent: BOOL_TRUE,
		}, model.provider, model.id));
		expect(await makeJev(registry).watchdogAnswer({})).toMatchObject({ ok: true, status: "waiting", model: "openrouter/~typesafe/jev-latest" });
		expect(registry.classify).toHaveBeenCalledTimes(2);
	});

	it.each(["error", "malformed", "timeout"])("keeps pins single-target after %s", async (failure) => {
		vi.useFakeTimers();
		const registry = makeRegistry(available, async () => failure === "timeout" ? new Promise(() => {})
			: failure === "error" ? { stopReason: "error", errorMessage: "bad target" } : stopResult({}), systemOneModel);
		const jev = makeJev(registry, "typesafe/jev-latest", 20);
		const pending = jev.guardAnswer({});
		await vi.advanceTimersByTimeAsync(21);
		expect(await pending).toMatchObject({ ok: false, reason: failure });
		expect(registry.classify).toHaveBeenCalledTimes(1);
		expect(registry.classify.mock.calls[0][0].id).toBe("jev-latest");
		expect(registry.getAvailableOfType.mock.calls.every((call) => call[1] === "typesafe")).toBe(true);
	});

	it("stops pre-aborted decisions before any probing or classification", async () => {
		const registry = makeRegistry(available, async () => stopResult({ irreversible: BOOL_TRUE }), systemOneModel);
		const controller = new AbortController();
		controller.abort();
		expect(await makeJev(registry).guardAnswer({}, controller.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(registry.getAvailableOfType).not.toHaveBeenCalled();
		expect(registry.classify).not.toHaveBeenCalled();
	});

	it("stops immediately on caller abort even when the provider ignores its signal", async () => {
		const controller = new AbortController();
		const registry = makeRegistry(available, async () => {
			controller.abort();
			return new Promise(() => {});
		}, systemOneModel);
		const jev = makeJev(registry);
		expect(await jev.guardAnswer({}, controller.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(registry.classify).toHaveBeenCalledTimes(1);
		expect(registry.classify.mock.calls[0][2].signal.aborted).toBe(true);
		expect(jev.lastFailure).toBeUndefined();
	});

	it("does not probe further or start an attempt after aborting during availability resolution", async () => {
		const controller = new AbortController();
		const registry = makeRegistry(available, async () => stopResult({ irreversible: BOOL_TRUE }));
		registry.getAvailableOfType.mockImplementation(async () => {
			controller.abort();
			return new Promise(() => {});
		});
		expect(await makeJev(registry).guardAnswer({}, controller.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(registry.getAvailableOfType).toHaveBeenCalledTimes(1);
		expect(registry.classify).not.toHaveBeenCalled();
	});

	it("gives cancellation priority over a concurrently returned verdict", async () => {
		const controller = new AbortController();
		const registry = makeRegistry(available, async () => {
			controller.abort();
			return stopResult({ irreversible: BOOL_TRUE });
		});
		expect(await makeJev(registry).guardAnswer({}, controller.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(registry.classify).toHaveBeenCalledTimes(1);
	});

	it("does not fall through a provider aborted result", async () => {
		const registry = makeRegistry(available, async () => ({ stopReason: "aborted" }), systemOneModel);
		expect(await makeJev(registry).watchdogAnswer({})).toEqual({ ok: false, reason: "aborted" });
		expect(registry.classify).toHaveBeenCalledTimes(1);
	});
});

describe("jev last failure", () => {
	it("remembers the latest failure, clears on success, and ignores caller aborts", async () => {
		let next: Partial<ClassifierResult> = { stopReason: "error", errorMessage: "boom" };
		const registry = makeRegistry({ typesafe: ["jev-latest"] }, async () => next);
		const jev = makeJev(registry);
		expect(jev.lastFailure).toBeUndefined();
		await jev.guardAnswer({ value: {} });
		expect(jev.lastFailure).toBe("error");
		next = { stopReason: "aborted" };
		const aborted = new AbortController();
		aborted.abort();
		await jev.guardAnswer({ value: {} }, aborted.signal);
		expect(jev.lastFailure).toBe("error");
		next = stopResult({ irreversible: { type: "bool", probability: 0.1 } });
		await jev.guardAnswer({ value: {} });
		expect(jev.lastFailure).toBeUndefined();
	});
});
