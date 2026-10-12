import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJev } from "../src/jev.js";

interface WireCall {
	path: string;
	headers: IncomingHttpHeaders;
	body: { model: string; state: unknown; questions: Record<string, { type: string }> };
}

const servers: Server[] = [];
const directories: string[] = [];

/** Real HTTP, SDK wire conversion, and response parsing; no transport mocks. */
async function startEndpoint(reply: (call: WireCall) => { status: number; body: unknown } | undefined) {
	const calls: WireCall[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const call = {
			path: request.url!, headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireCall["body"],
		};
		calls.push(call);
		const result = reply(call);
		if (result) {
			response.writeHead(result.status, { "content-type": "application/json" });
			response.end(JSON.stringify(result.body));
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { calls, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function success(probability = 0.9) {
	return {
		status: 200,
		body: { answers: { irreversible: { type: "noul", noul: probability } }, usage: { input_tokens: 10, output_tokens: 2 } },
	};
}

function fallbackRegistry() {
	const model: ClassifierModel<ClassifierApi> = {
		type: "classifier", provider: "openrouter", api: "typesafe-system-one", id: "~typesafe/jev-latest",
		name: "Jev", baseUrl: "https://unused.example/v1", input: ["text"], contextWindow: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const classify = vi.fn(async () => ({
		provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: "stop",
		answers: { irreversible: { type: "bool", probability: 0.7 } },
	}));
	const registry = {
		getAvailableOfType: vi.fn(async (_type: string, provider: string) => provider === "openrouter" ? [model] : []),
		classify,
	};
	return { registry: registry as unknown as ModelRegistry, classify };
}

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	})));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit Jev System One endpoint", () => {
	it("executes the endpoint without probing unused stalled registry auth", async () => {
		const { baseUrl, calls } = await startEndpoint(() => success());
		const getAvailableOfType = vi.fn(async () => new Promise(() => {}));
		const classify = vi.fn();
		const jev = createJev({
			getRegistry: () => ({ getAvailableOfType, classify }) as unknown as ModelRegistry,
			timeoutMs: 3000, endpoint: { baseUrl, apiKey: "endpoint-key" },
		});
		expect(await jev.ensureAvailable()).toBe(true);
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "endpoint/jev-latest" });
		expect(calls).toHaveLength(1);
		expect(getAvailableOfType).not.toHaveBeenCalled();
		expect(classify).not.toHaveBeenCalled();
	});

	it("uses the SDK's /systemone protocol, default IDs, literal auth, and zero catalog costs", async () => {
		const { baseUrl, calls } = await startEndpoint((call) => call.body.model === "jev-latest"
			? { status: 503, body: { error: { message: "this wire ID is not served" } } } : success());
		const jev = createJev({ getRegistry: () => undefined, timeoutMs: 3000, endpoint: { baseUrl: `${baseUrl}/`, apiKey: "literal-private-key" } });
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("endpoint/jev-latest");
		const state = { value: { command: "git push --force" } };
		expect(await jev.guardAnswer(state)).toEqual({ ok: true, p: 0.9, model: "endpoint/jev-1.13.0" });
		expect(calls.map((call) => call.body.model)).toEqual(["jev-latest", "jev-1.13.0"]); // no SDK retries
		expect(calls.every((call) => call.path === "/v1/systemone" && call.headers.authorization === "Bearer literal-private-key")).toBe(true);
		expect(calls[0].body).toMatchObject({ state, questions: { irreversible: { type: "noul" } } });
		expect(jev.model).toBe("endpoint/jev-1.13.0");
		expect(jev.model).not.toContain(baseUrl);
		expect(jev.usage()).toEqual({ input: 10, output: 2, totalTokens: 12, cost: 0 });
	});

	it("honors explicit endpoint order, deduplicates IDs, then falls back to the registry", async () => {
		const { baseUrl, calls } = await startEndpoint(() => ({ status: 401, body: { error: { message: "unauthorized" } } }));
		const { registry, classify } = fallbackRegistry();
		const jev = createJev({
			getRegistry: () => registry, timeoutMs: 3000,
			endpoint: { baseUrl, apiKey: "endpoint-key", models: ["jev-1.13.0", "jev-1.13.0", "jev-latest"] },
		});
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, p: 0.7, model: "openrouter/~typesafe/jev-latest" });
		expect(calls.map((call) => call.body.model)).toEqual(["jev-1.13.0", "jev-latest"]);
		expect(classify).toHaveBeenCalledTimes(1);
		expect(classify.mock.calls[0]).toHaveLength(3);
		expect((classify.mock.calls as unknown[][])[0][2]).not.toHaveProperty("apiKey");
		expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
	});

	it.each(["$BG_TEST_JEV_KEY", "${BG_TEST_JEV_KEY}"])("resolves whole-value environment reference %s on demand", async (apiKey) => {
		const { baseUrl, calls } = await startEndpoint(() => success());
		vi.stubEnv("BG_TEST_JEV_KEY", undefined);
		const jev = createJev({ getRegistry: () => undefined, timeoutMs: 3000, endpoint: { baseUrl, apiKey } });
		expect(await jev.ensureAvailable()).toBe(false);
		expect(await jev.guardAnswer({})).toMatchObject({ ok: false, reason: "error" });
		expect(jev.available).toBe(false);
		expect(jev.model).toBe("");
		expect(jev.describeUnavailable()).toContain("environment variable");
		expect(jev.describeUnavailable()).not.toContain(baseUrl);
		expect(calls).toEqual([]);
		vi.stubEnv("BG_TEST_JEV_KEY", "first-private-key");
		expect(await jev.ensureAvailable()).toBe(true);
		await jev.guardAnswer({});
		vi.stubEnv("BG_TEST_JEV_KEY", "rotated-private-key");
		await jev.guardAnswer({});
		expect(calls.map((call) => call.headers.authorization)).toEqual(["Bearer first-private-key", "Bearer rotated-private-key"]);
	});

	it.each([undefined, "", "   ", "$UNRESOLVED_KEY"])("skips unavailable env auth (%s) rather than sending a placeholder", async (value) => {
		const { baseUrl, calls } = await startEndpoint(() => success());
		vi.stubEnv("BG_TEST_JEV_KEY", value);
		const { registry, classify } = fallbackRegistry();
		const jev = createJev({ getRegistry: () => registry, timeoutMs: 3000, endpoint: { baseUrl, apiKey: "$BG_TEST_JEV_KEY" } });
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "openrouter/~typesafe/jev-latest" });
		expect(calls).toEqual([]);
		expect(classify).toHaveBeenCalledOnce();
	});

	it.each(["error", "malformed", "timeout"])("fails over from an endpoint %s with a bounded attempt", async (kind) => {
		const { baseUrl, calls } = await startEndpoint(() => kind === "timeout" ? undefined
			: kind === "error" ? { status: 503, body: { error: { message: "unavailable" } } }
			: { status: 200, body: { answers: { irreversible: { type: "noul", noul: 2 } } } });
		const { registry, classify } = fallbackRegistry();
		const fetch = vi.spyOn(globalThis, "fetch");
		const jev = createJev({ getRegistry: () => registry, timeoutMs: 200, endpoint: { baseUrl, apiKey: "endpoint-key", models: ["jev-latest"] } });
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "openrouter/~typesafe/jev-latest" });
		expect(calls).toHaveLength(1);
		expect(fetch).toHaveBeenCalledOnce();
		if (kind === "timeout") expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(classify).toHaveBeenCalledOnce();
		expect(jev.lastFailure).toBeUndefined();
	});

	it("counts usage retained by the SDK on malformed answers as well as successful aliases", async () => {
		const { baseUrl } = await startEndpoint((call) => call.body.model === "jev-latest"
			? { status: 200, body: { answers: {}, usage: { input_tokens: 10, output_tokens: 2 } } } : success());
		const jev = createJev({ getRegistry: () => undefined, timeoutMs: 3000, endpoint: { baseUrl, apiKey: "endpoint-key" } });
		expect(await jev.guardAnswer({})).toMatchObject({ ok: true, model: "endpoint/jev-1.13.0" });
		expect(jev.usage()).toEqual({ input: 20, output: 4, totalTokens: 24, cost: 0 });
	});

	it.each([false, true])("redacts echoed explicit API keys and URL credentials in failures (env: %s)", async (useEnv) => {
		const key = "otherwise-unrecognizable-private-value";
		vi.stubEnv("BG_TEST_JEV_KEY", key);
		const { baseUrl } = await startEndpoint(() => ({ status: 401, body: { error: { message: `echo ${key} https://user:private-password@example.com/v1` } } }));
		const jev = createJev({ getRegistry: () => undefined, timeoutMs: 3000, endpoint: { baseUrl, apiKey: useEnv ? "${BG_TEST_JEV_KEY}" : key } });
		const result = await jev.guardAnswer({});
		expect(result).toMatchObject({ ok: false, reason: "error", detail: expect.stringContaining("[REDACTED]") });
		expect(JSON.stringify(result)).not.toContain(key);
		expect(JSON.stringify(result)).not.toContain("private-password");
		expect(jev.model).toBe("endpoint/jev-latest");
	});

	it("also redacts an explicit key if it appears in a configured model label", async () => {
		const key = "opaque-sensitive-value";
		const { baseUrl } = await startEndpoint(() => success());
		const jev = createJev({ getRegistry: () => undefined, timeoutMs: 3000, endpoint: { baseUrl, apiKey: key, models: [`custom-${key}`] } });
		expect(await jev.ensureAvailable()).toBe(true);
		expect(jev.model).toBe("endpoint/custom-[REDACTED]");
		expect(await jev.guardAnswer({})).toMatchObject({ model: "endpoint/custom-[REDACTED]" });
	});

	it("forwards caller cancellation to the SDK and never tries a registry fallback", async () => {
		const controller = new AbortController();
		const { baseUrl, calls } = await startEndpoint(() => { controller.abort(); return undefined; });
		const { registry, classify } = fallbackRegistry();
		const fetch = vi.spyOn(globalThis, "fetch");
		const jev = createJev({ getRegistry: () => registry, timeoutMs: 3000, endpoint: { baseUrl, apiKey: "endpoint-key" } });
		expect(await jev.guardAnswer({}, controller.signal)).toEqual({ ok: false, reason: "aborted" });
		expect(calls).toHaveLength(1);
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(classify).not.toHaveBeenCalled();
	});
});

it("real ModelRuntime preserves models.json auth and metadata for cloned TypeSafe IDs, then fails over to OpenRouter", async () => {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("BG_RELAY_KEY", "relay-private-key");
	vi.stubEnv("BG_ROUTER_KEY", "router-private-key");
	let aliasWorks = true;
	const { baseUrl, calls } = await startEndpoint((call) => {
		if (call.path === "/v1/relay/systemone") {
			return aliasWorks && call.body.model === "jev-1.13.0" ? success()
				: { status: 503, body: { error: { message: "this RelayRouter wire ID is unavailable" } } };
		}
		return success(0.8);
	});
	const directory = mkdtempSync(join(tmpdir(), "bash-guard-jev-runtime-"));
	directories.push(directory);
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: {
		typesafe: { baseUrl: `${baseUrl}/relay`, apiKey: "$BG_RELAY_KEY", headers: { "x-test": "preserved" } },
		openrouter: { baseUrl: `${baseUrl}/router`, apiKey: "${BG_ROUTER_KEY}" },
	} }));
	const runtime = await ModelRuntime.create({
		modelsPath, modelsStorePath: join(directory, "models-store"), authPath: join(directory, "auth.json"), refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	const template = registry.getModelOfType("classifier", "typesafe", "jev-latest")!;
	expect(template.api).toBe("typesafe-system-one");
	expect(registry.getModelOfType("classifier", "typesafe", "jev-1.13.0")).toBeUndefined();
	const classify = vi.spyOn(registry, "classify");
	const jev = createJev({ getRegistry: () => registry, timeoutMs: 3000 });
	expect(await jev.guardAnswer({ value: { command: "rm -rf node_modules" } })).toEqual({ ok: true, p: 0.9, model: "typesafe/jev-1.13.0" });
	expect(classify.mock.calls[1][0]).toEqual({ ...template, id: "jev-1.13.0" });
	expect(template.id).toBe("jev-latest");
	expect(classify.mock.calls[1][2]).not.toHaveProperty("apiKey");
	expect(calls.map((call) => [call.path, call.body.model, call.headers.authorization])).toEqual([
		["/v1/relay/systemone", "jev-latest", "Bearer relay-private-key"],
		["/v1/relay/systemone", "jev-1.13.0", "Bearer relay-private-key"],
	]);
	expect(calls.every((call) => call.headers["x-test"] === "preserved")).toBe(true);
	expect(jev.model).toBe("typesafe/jev-1.13.0");
	aliasWorks = false;
	expect(await jev.guardAnswer({})).toEqual({ ok: true, p: 0.8, model: "openrouter/~typesafe/jev-latest" });
	expect(calls.slice(2).map((call) => [call.path, call.body.model, call.headers.authorization])).toEqual([
		["/v1/relay/systemone", "jev-latest", "Bearer relay-private-key"],
		["/v1/relay/systemone", "jev-1.13.0", "Bearer relay-private-key"],
		["/v1/router/systemone", "~typesafe/jev-latest", "Bearer router-private-key"],
	]);
	expect(jev.model).toBe("openrouter/~typesafe/jev-latest");
	const pinned = createJev({ getRegistry: () => registry, timeoutMs: 3000, modelSpec: "typesafe/jev-latest" });
	expect(await pinned.guardAnswer({})).toMatchObject({ ok: false, reason: "error" });
	expect(calls).toHaveLength(6);
	expect(calls.at(-1)!.body.model).toBe("jev-latest");
}, 15_000);
