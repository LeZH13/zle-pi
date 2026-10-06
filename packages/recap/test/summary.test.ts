import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildSnapshot, cleanLine, cleanOutput, extractText, pickModel, readConfig, STATE_KEY, TITLE_MAX_CHARS } from "../lib/summary.js";
import { model } from "./harness.js";

const context = (sessionManager: SessionManager) => ({ sessionManager }) as unknown as ExtensionContext;
const user = (manager: SessionManager, text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
const assistant = (manager: SessionManager, text: string, tools: string[] = []) => manager.appendMessage({
	role: "assistant", content: [{ type: "text", text }, ...tools.map((name, i) => ({ type: "toolCall" as const, name, id: `call-${i}`, arguments: {} }))],
	api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 2,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as AssistantMessage);
const toolResult = (manager: SessionManager, callId: string, toolName: string, text: string, isError = false) =>
	manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError, timestamp: 3 });

describe("trusted recap settings", () => {
	it.each([undefined, null, [], true, "bad", { recap: [] }, { recap: null }])("defaults malformed settings %j", settings => {
		expect(readConfig(settings)).toMatchObject({ model: undefined, maxWords: 50, minTurns: 3, idleDelaySeconds: 120, placement: "aboveEditor", autoName: true });
	});
	it("uses only the recap namespace and trims configured values", () => {
		const result = readConfig({ model: "ignored", autoName: false, recap: { model: " provider/id/path ", maxWords: 7, minTurns: 1, idleDelaySeconds: 300, placement: "below", autoName: false, prompts: { recap: " Custom recap ", name: " Custom name " } } });
		expect(result).toEqual({ model: "provider/id/path", maxWords: 7, minTurns: 1, idleDelaySeconds: 300, placement: "belowEditor", autoName: false, recapPrompt: "Custom recap", namePrompt: "Custom name" });
	});
	it.each([0, -1, 1.5, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER + 1])("rejects invalid positive integers %s", value => {
		expect(readConfig({ recap: { maxWords: value, minTurns: value, idleDelaySeconds: value } })).toMatchObject({ maxWords: 50, minTurns: 3, idleDelaySeconds: 120 });
	});
	it("accepts the smallest positive integers", () => {
		expect(readConfig({ recap: { maxWords: 1, minTurns: 1, idleDelaySeconds: 1 } })).toMatchObject({ maxWords: 1, minTurns: 1, idleDelaySeconds: 1 });
	});
	it("defaults recap prompt to verified state, blockers and unresolved decisions", () => {
		const { recapPrompt, namePrompt } = readConfig({});
		for (const phrase of ["next-step tip", "confirmed state", "blockers", "unresolved decisions", "attempted", "verified"]) {
			expect(recapPrompt).toContain(phrase);
		}
		expect(recapPrompt).toContain("never report attempts as done");
		expect(namePrompt).toContain("at most 60 characters");
	});
	it("only literal false disables naming and both placement labels resolve", () => {
		expect(readConfig({ recap: { autoName: "false", placement: "belowEditor", prompts: { name: " ", recap: null } } })).toMatchObject({ autoName: true, placement: "aboveEditor" });
		expect(readConfig({ recap: { placement: "below" } }).placement).toBe("belowEditor");
	});
});

describe("output validation and cleanup", () => {
	it("extracts only text blocks, never thinking, images, or tool calls", () => {
		expect(extractText("plain")).toBe("plain");
		expect(extractText([{ type: "text", text: "hello" }, null, { type: "thinking", thinking: "secret" }, { type: "toolCall", name: "bash" }, { type: "text", text: 42 }, { type: "text", text: "world" }])).toBe("hello world");
		expect(extractText({ type: "text", text: "not an array" })).toBe("");
	});
	it.each([
		["- **Build** `widgets`!", "Build widgets!"], ["1. Fix [routing](https://example.test).", "Fix routing."],
		["※ recap: Fix tests。", "Fix tests。"], ["Title: “修复测试！”", "修复测试！"],
		["Here's the recap: Done?!", "Done?!"], ["\u001b[31mSession name: Plain\u001b[0m\u0007", "Plain"],
		["# Heading", "Heading"], ["• Work   on  tests", "Work on tests"],
	])("cleans %j", (input, expected) => expect(cleanLine(input)).toBe(expected));
	it("accepts a single content line with removable heading and collapses CRLF/whitespace", () => {
		expect(cleanOutput("\r\n# Heading\r\n  Recap: **Fix**   tests. \r\n", "recap", 40)).toBe("Fix tests.");
	});
	it.each(["", " \n ", "# Heading", "first\nsecond", "{\"title\":\"wrong\"}", "[\"wrong\"]", "x".repeat(4001), "\u001b[31m\u001b[0m"])("rejects malformed output %j", input => {
		expect(() => cleanOutput(input, "name", 40)).toThrow();
	});
	it("strips trailing periods from titles but keeps recap punctuation", () => {
		expect(cleanOutput("Fix the login bug.", "name", 40)).toBe("Fix the login bug");
		expect(cleanOutput("Fix the login bug?", "name", 40)).toBe("Fix the login bug?");
	});
	it("caps recaps by words and titles by Unicode code points without surrogate splitting", () => {
		expect(cleanOutput("one two three four", "recap", 3)).toBe("one two three…");
		expect(cleanOutput("one two three", "recap", 3)).toBe("one two three");
		expect(cleanOutput("😀".repeat(61), "name", 1)).toBe("😀".repeat(59) + "…");
		expect(Array.from(cleanOutput("界".repeat(70), "name", 1))).toHaveLength(TITLE_MAX_CHARS);
		expect(cleanOutput("x".repeat(60), "name", 1)).toHaveLength(60);
	});
});

describe("shared model selection", () => {
	const setup = () => {
		const registry = { find: vi.fn(() => ({ provider: "other", id: "configured" })), hasConfiguredAuth: vi.fn(() => true) };
		return { registry, ctx: { model, modelRegistry: registry } as unknown as ExtensionContext };
	};
	it("uses the authenticated current model by default", () => {
		const h = setup();
		expect(pickModel(h.ctx, undefined)).toBe(model);
		expect(h.registry.find).not.toHaveBeenCalled();
	});
	it.each([["other/model/path", "other", "model/path"], ["configured", "test", "configured"]])("resolves %s without losing slashes", (setting, provider, id) => {
		const h = setup();
		expect(pickModel(h.ctx, setting)).toEqual({ provider: "other", id: "configured" });
		expect(h.registry.find).toHaveBeenCalledWith(provider, id);
	});
	it.each(["missing", "unauthenticated"])("never falls back when configured model is %s", failure => {
		const h = setup();
		if (failure === "missing") h.registry.find.mockReturnValue(undefined as any);
		else h.registry.hasConfiguredAuth.mockReturnValue(false);
		expect(() => pickModel(h.ctx, "other/configured")).toThrow("no fallback was used");
	});
	it("fails closed without a current authenticated model or provider", () => {
		const h = setup();
		h.registry.hasConfiguredAuth.mockReturnValue(false);
		expect(() => pickModel(h.ctx, undefined)).toThrow("No authenticated session model");
		h.ctx.model = undefined;
		expect(() => pickModel(h.ctx, undefined)).toThrow();
		expect(() => pickModel(h.ctx, "bare-id")).toThrow("no fallback");
	});
});

describe("bounded session snapshot", () => {
	it("returns undefined for empty or metadata-only branches", () => {
		const m = SessionManager.inMemory();
		m.appendSessionInfo("Existing name");
		m.appendCustomEntry("state", { text: "hidden" });
		expect(buildSnapshot(context(m))).toBeUndefined();
	});
	it("retains original goal, renders a three-round window and deduplicates tool outcomes", () => {
		const m = SessionManager.inMemory();
		for (let i = 0; i < 5; i++) {
			user(m, `user-${i}`);
			assistant(m, `intermediate-${i}`, ["read", "read", "edit"]);
			toolResult(m, "call-0", "read", `read-${i}`);
			toolResult(m, "call-1", "read", `read-${i}-again`);
			toolResult(m, "call-2", "edit", `edit-${i}`);
			assistant(m, `final-${i}`);
		}
		const result = buildSnapshot(context(m))!;
		expect(result).toMatchObject({ goal: "user-0", userCount: 5 });
		expect(result.prompt).toContain("Earlier exchange:");
		expect(result.prompt).toContain("Most recent exchange:");
		expect(result.prompt).toContain("user-2");
		expect(result.prompt).toContain("user-3");
		expect(result.prompt).toContain("user-4");
		expect(result.prompt).toContain("Assistant: final-4");
		expect(result.prompt).toContain("Tools: read ok, edit ok");
		expect(result.prompt).not.toContain("intermediate");
		expect(result.prompt).not.toContain("user-1");
		expect(result.prompt).toContain("Use the same language as the user's messages.");
		for (const phrase of ["blockers", "unresolved decisions", "attempted", "verified"]) expect(result.prompt).toContain(phrase);
		// Freshness covers the whole effective conversation, independent of the
		// truncated prompt, and our own persisted state never expires a recap.
		expect(result.inputKey).toMatch(/^[a-f0-9]{64}$/);
		expect(buildSnapshot(context(m))!.inputKey).toBe(result.inputKey);
		m.appendCustomEntry("ignored", { text: "noise" });
		m.appendCustomEntry(STATE_KEY, { recap: "x" });
		m.appendCustomMessageEntry(STATE_KEY, "recap metadata noise", false, undefined);
		expect(buildSnapshot(context(m))!.inputKey).toBe(result.inputKey);
		m.appendCustomMessageEntry("other", "injected context", true, undefined);
		expect(buildSnapshot(context(m))!.inputKey).not.toBe(result.inputKey);
	});
	it("folds tool calls, results and call arguments into the freshness key", () => {
		const m = SessionManager.inMemory();
		user(m, "task");
		const base = buildSnapshot(context(m))!.inputKey;
		assistant(m, "ran a tool", ["read"]);
		const withCall = buildSnapshot(context(m))!.inputKey;
		expect(withCall).not.toBe(base);
		toolResult(m, "call-0", "read", "done");
		const withResult = buildSnapshot(context(m))!.inputKey;
		expect(withResult).not.toBe(withCall);
		m.appendMessage({
			role: "assistant", content: [{ type: "toolCall", name: "read", id: "call-args", arguments: { path: "different" } }],
			api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 2,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as AssistantMessage);
		expect(buildSnapshot(context(m))!.inputKey).not.toBe(withResult);
	});
	it("renders bounded tool outcomes and errors, never raw full logs", () => {
		const m = SessionManager.inMemory();
		user(m, "Run the checks");
		assistant(m, "Starting checks", ["bash", "edit", "grep"]);
		toolResult(m, "call-0", "bash", `OKHEAD ${"x".repeat(600)} OKTAIL`);
		toolResult(m, "call-1", "edit", `ERRHEAD ${"y".repeat(600)} ERRTAIL`, true);
		assistant(m, "All checks passed");
		const { prompt } = buildSnapshot(context(m))!;
		expect(prompt).toContain("Most recent exchange:");
		expect(prompt).toContain("Tools: bash ok, edit failed, grep attempted");
		// Successful and failing outcomes are excerpted with both ends kept and
		// the middle replaced by an explicit marker, not shipped as raw logs.
		expect(prompt).toContain("bash ok: OKHEAD");
		expect(prompt).toContain("OKTAIL");
		expect(prompt).toContain("edit failed: ERRHEAD");
		expect(prompt).toContain("ERRTAIL");
		expect(prompt).toContain("chars omitted");
		expect(prompt).not.toContain("x".repeat(200));
		expect(prompt).not.toContain("y".repeat(200));
		// A call without a recorded result stays attempted, never verified.
		expect(prompt).toContain("grep attempted");
		expect(prompt).toContain("Assistant: All checks passed");
	});
	it("bounds oversized tool names in outcome detail lines as well as the tool list", () => {
		const m = SessionManager.inMemory(); user(m, "Task");
		const name = "tool".repeat(5000); assistant(m, "Done", [name, name]);
		toolResult(m, "call-0", name, "Success"); toolResult(m, "call-1", name, "Failure", true);
		const { prompt } = buildSnapshot(context(m))!;
		expect(prompt).toContain("Success"); expect(prompt).toContain("Failure");
		expect(prompt.length).toBeLessThan(2000); expect(prompt).not.toContain("tool".repeat(100));
	});
	it("gives older exchanges smaller budgets and no successful-output excerpts", () => {
		const m = SessionManager.inMemory();
		user(m, "First task");
		assistant(m, "first plan", ["read"]);
		toolResult(m, "call-0", "read", `OLDOK ${"z".repeat(400)} OLDOKTAIL`);
		assistant(m, "first result");
		user(m, "Second task");
		assistant(m, "second plan");
		const { prompt } = buildSnapshot(context(m))!;
		expect(prompt).toContain("Earlier exchange:");
		expect(prompt).toContain("Most recent exchange:");
		expect(prompt).toContain("First task");
		expect(prompt).toContain("Tools: read ok");
		// Only the latest exchange carries successful-output excerpts.
		expect(prompt).not.toContain("OLDOK");
		expect(prompt).not.toContain("z".repeat(200));
		expect(prompt).toContain("Assistant: first result");
		expect(prompt).not.toContain("first plan");
		expect(prompt).toContain("Assistant: second plan");
	});
	it("labels a trailing unanswered turn without displacing the latest completed exchange", () => {
		const m = SessionManager.inMemory();
		user(m, "First task");
		assistant(m, "first answer");
		user(m, "Pending follow-up");
		const { prompt } = buildSnapshot(context(m))!;
		expect(prompt).toContain("Most recent exchange:");
		expect(prompt).toContain("Assistant: first answer");
		expect(prompt).toContain("Unanswered exchange (no assistant reply yet):");
		expect(prompt).toContain("Pending follow-up");
	});
	it("bounds goals, summaries, rounds and tool lines with explicit middle markers", () => {
		const m = SessionManager.inMemory();
		const goalId = user(m, "g".repeat(500));
		const kept = user(m, `HEADMARK${"m".repeat(600)}TAILMARK`);
		assistant(m, "a".repeat(2000), ["t".repeat(400)]);
		m.appendCompaction("s".repeat(2000), kept, 100);
		const result = buildSnapshot(context(m))!;
		expect(result.goal).toHaveLength(500);
		expect(result.userCount).toBe(2);
		const prompt = result.prompt;
		// Original goal is secondary background: short prefix/suffix with a marker.
		expect(prompt).toContain("g".repeat(30));
		expect(prompt).not.toContain("g".repeat(200));
		// Older compaction summary is bounded well below its raw length.
		expect(prompt).toContain("s".repeat(200));
		expect(prompt).not.toContain("s".repeat(500));
		// The latest exchange keeps the largest budget, both ends included.
		expect(prompt).toContain("HEADMARK");
		expect(prompt).toContain("TAILMARK");
		expect(prompt).not.toContain("m".repeat(600));
		expect(prompt).toContain("a".repeat(700));
		expect(prompt).not.toContain("a".repeat(1000));
		expect(prompt).toContain("t".repeat(100));
		expect(prompt).not.toContain("t".repeat(300));
		expect(prompt).toContain("attempted");
		expect(prompt).toContain("chars omitted");
		expect(prompt).toContain("secondary to recent activity");
		expect(prompt.length).toBeLessThan(5000);
		expect(m.getEntry(goalId!)).toBeDefined();
	});
	it("honors active-branch context replacements and omissions including original goal", () => {
		const m = SessionManager.inMemory();
		const goal = user(m, "private original goal");
		const omitted = user(m, "private omitted prompt");
		const answer = assistant(m, "private replaced answer");
		m.appendContextEdit(goal, { content: "safe revised goal" });
		m.appendContextEdit(omitted, null);
		const interim = buildSnapshot(context(m))!;
		m.appendContextEdit(answer, { content: [{ type: "text", text: "safe answer" }] });
		const result = buildSnapshot(context(m))!;
		expect(result.goal).toBe("safe revised goal");
		expect(result.prompt).not.toContain("private");
		expect(result.prompt).toContain("safe answer");
		expect(result.inputKey).not.toBe(interim.inputKey);
		m.appendContextEdit(goal, null);
		expect(buildSnapshot(context(m))).toBeUndefined();
	});
	it("keeps goal after compaction, includes summary, excludes compacted raw answers", () => {
		const m = SessionManager.inMemory();
		user(m, "Build original feature");
		assistant(m, "compacted secret answer");
		const kept = user(m, "Current task");
		m.appendCompaction("Summarized earlier progress", kept, 1000);
		assistant(m, "Current answer");
		const result = buildSnapshot(context(m))!;
		expect(result.userCount).toBe(2);
		expect(result.prompt).toContain("Build original feature");
		expect(result.prompt).toContain("<context_summary>");
		expect(result.prompt).toContain("Summarized earlier progress");
		expect(result.prompt).toContain("Current answer");
		expect(result.prompt).not.toContain("compacted secret");
	});
	it("excludes abandoned paths and their edits, includes branch summaries", () => {
		const m = SessionManager.inMemory();
		const root = user(m, "Shared goal");
		user(m, "Abandoned path");
		m.appendContextEdit(root, { content: "Abandoned goal replacement" });
		m.branchWithSummary(root, "Branch transition summary");
		user(m, "New path");
		const result = buildSnapshot(context(m))!;
		expect(result).toMatchObject({ goal: "Shared goal", userCount: 2 });
		expect(result.prompt).toContain("Branch transition summary");
		expect(result.prompt).toContain("New path");
		expect(result.prompt).not.toContain("Abandoned");
	});
	it("changes inputKey for effective-conversation changes the truncated prompt cannot show", () => {
		const m = SessionManager.inMemory();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(user(m, `user-${i}`));
			assistant(m, `final-${i}`);
		}
		const before = buildSnapshot(context(m))!;
		m.appendContextEdit(ids[1], { content: "edited outside the prompt window with plenty of detail" });
		const after = buildSnapshot(context(m))!;
		expect(after.prompt).toBe(before.prompt);
		expect(after.inputKey).not.toBe(before.inputKey);
	});
	it("hashes injected bash executions into the freshness key", () => {
		const m = SessionManager.inMemory();
		user(m, "task");
		const base = buildSnapshot(context(m))!.inputKey;
		m.appendMessage({ role: "bashExecution", command: "npm test", output: "all green", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 });
		const afterBash = buildSnapshot(context(m))!.inputKey;
		expect(afterBash).not.toBe(base);
		m.appendMessage({ role: "bashExecution", command: "npm test", output: "all green", exitCode: 1, cancelled: false, truncated: false, timestamp: 6 });
		expect(buildSnapshot(context(m))!.inputKey).not.toBe(afterBash);
	});
});
