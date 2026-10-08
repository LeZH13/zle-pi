import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import bashGuard from "../extensions/index.js";
import { BASH_GUARD_RUNTIME_SYMBOL, type BashGuardRuntime } from "../src/runtime.js";

// No SDK mocks: run the wrapped codemode tool, then its real ctx.executeTool()
// nested dispatch. Only bash's execution backend is a recording custom tool.
it("real codemode nesting enforces deny with watchdog disabled", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "bash-guard-sdk-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_BASH_GUARD_APPROVAL_MODE", "deny");
	vi.stubEnv("PI_OFFLINE", "1");
	writeFileSync(join(agentDir, "bash-guard.json"), JSON.stringify({
		watchdog: { enabled: false },
		guard: { extraRiskyPatterns: ["bg_guard_risky"] },
	}));
	const calls: string[] = [];
	const nested: { id: string; parent?: string }[] = [];
	let session: AgentSession | undefined;
	try {
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
		});
		vi.spyOn(modelRuntime, "getAvailableOfType").mockResolvedValue([]);
		const model = modelRuntime.getModels()[0]!;
		const call = {
			type: "toolCall" as const, id: "outer", name: "codemode",
			arguments: { code: `return await Promise.allSettled([
				tools.bash({command: "echo bg_guard_risky"}),
				tools.bash({command: "echo bg_guard_safe"})
			]);` },
		};
		// SDK nesting checks that the outer tool call belongs to a persisted assistant message.
		const assistant: AssistantMessage = {
			role: "assistant", content: [call], api: model.api,
			provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage(assistant);
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, noExtensions: true,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				(pi) => { pi.on("tool_call", (event) => {
					if (event.toolName === "bash") nested.push({ id: event.toolCallId, parent: event.parentToolCallId });
				}); },
				bashGuard, createCodemodeExtension({ models: false }),
			],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd, agentDir, model, modelRuntime, settingsManager, sessionManager, resourceLoader,
			tools: ["bash", "codemode"],
			customTools: [{
				name: "bash", label: "bash", description: "Recording stub; no shell",
				parameters: Type.Object({ command: Type.String() }),
				async execute(_id, { command }) {
					calls.push(command);
					return { content: [{ type: "text", text: "recorded" }], details: {} };
				},
			}],
		}));
		await session.bindExtensions({});
		const globals = globalThis as unknown as Record<symbol, unknown>;
		expect(globals[BASH_GUARD_RUNTIME_SYMBOL] as BashGuardRuntime)
			.toMatchObject({ ready: true, approvalMode: "deny", guardEnabled: true });
		const outcome = await runToolCall(call, {
			tools: session.agent.state.tools, assistantMessage: assistant,
			context: { messages: session.messages, tools: session.agent.state.tools },
			beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall,
		});
		expect(outcome.isError).toBe(false);
		expect(JSON.stringify(outcome.result.details)).toContain("approvalMode=deny");
		expect(calls).toEqual(["echo bg_guard_safe"]);
		expect(nested).toHaveLength(2);
		expect(nested.every((event) => event.parent === "outer" && /^outer\/\d+$/.test(event.id))).toBe(true);
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}, 15_000);
