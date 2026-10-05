import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { NAMING_KEY, STATE_KEY } from "../lib/summary.js";

it("loads the package through Pi and names/recaps real settled SDK runs without network calls", async () => {
	// Exercise a parent TUI even when the test runner itself is a subagent.
	vi.stubEnv("PI_SUBAGENT_ID", "");
	vi.stubEnv("PI_SUBAGENT_SESSION", "");
	const dir = await mkdtemp(join(tmpdir(), "pi-recap-runtime-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let named!: () => void;
	let recapped!: () => void;
	const nameReady = new Promise<void>(resolve => { named = resolve; });
	const recapReady = new Promise<void>(resolve => { recapped = resolve; });
	const requests: string[] = [];
	try {
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
			extensionFactories: [pi => {
				pi.registerProvider("recap-test", {
					baseUrl: "https://unused.invalid",
					apiKey: "test-key-not-a-credential",
					api: "openai-responses",
					models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
					streamSimple: (model, context) => {
						const input = JSON.stringify(context.messages);
						const sideCall = input.includes("<session_goal>");
						const namingCall = sideCall && input.includes("Name this coding session");
						const text = sideCall
							? (namingCall ? (requests.includes("summary") ? "OAuth validation hardening" : "OAuth callback validation") : "OAuth callback validation fixed; tests pass")
							: "Implementation complete and verified.";
						requests.push(sideCall ? "summary" : "agent");
						const message: AssistantMessage = {
							role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(),
						};
						const stream = createAssistantMessageEventStream();
						stream.push({ type: "done", reason: "stop", message });
						stream.end();
						return stream;
					},
				});
				pi.on("session_info_changed", event => { if (event.name === "OAuth callback validation") named(); });
			}],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		expect(resourceLoader.getExtensions().extensions.flatMap(extension => [...extension.commands.keys()])).toEqual(expect.arrayContaining(["recap", "autoname"]));
		const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const manager = SessionManager.inMemory(dir);
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, resourceLoader, sessionManager: manager, settingsManager, tools: [], thinkingLevel: "off" }));
		const errors: unknown[] = [];
		await session.bindExtensions({
			mode: "tui",
			onError: error => errors.push(error),
			uiContext: {
				notify: vi.fn(),
				setWidget: (_key: string, widget: unknown) => { if (widget) recapped(); },
			} as unknown as ExtensionUIContext,
		});
		// Provider registration binds before the session model is selected here.
		const model = modelRuntime.getModel("recap-test", "test")!;
		await session.setModel(model, { persist: false });
		await session.prompt("Fix OAuth callback validation");
		await nameReady;
		expect(manager.getSessionName()).toBe("OAuth callback validation");
		await session.prompt("Add validation tests");
		await session.prompt("Verify the implementation");
		await recapReady;
		expect(requests.filter(kind => kind === "summary")).toHaveLength(2);
		expect(manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === STATE_KEY).at(-1)).toMatchObject({ data: { recap: "OAuth callback validation fixed; tests pass" } });
		expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === NAMING_KEY)).toBe(true);
		await session.prompt("/autoname");
		expect(manager.getSessionName()).toBe("OAuth validation hardening");
		await session.prompt("/recap");
		expect(requests.filter(kind => kind === "summary")).toHaveLength(4);
		expect(requests.filter(kind => kind === "agent")).toHaveLength(3);
		expect(manager.buildSessionProjection().messages.some(message => "customType" in message && message.customType === STATE_KEY)).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	}
});
