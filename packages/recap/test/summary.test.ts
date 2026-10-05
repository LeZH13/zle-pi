import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildSnapshot, cleanLine, cleanOutput, extractText, pickModel, readConfig, similarity, TITLE_MAX_CHARS } from "../lib/summary.js";
import { model } from "./harness.js";

const context = (sessionManager: SessionManager) => ({ sessionManager }) as unknown as ExtensionContext;
const user = (manager: SessionManager, text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
const assistant = (manager: SessionManager, text: string, tools: string[] = []) => manager.appendMessage({
	role: "assistant", content: [{ type: "text", text }, ...tools.map((name, i) => ({ type: "toolCall" as const, name, id: `call-${i}`, arguments: {} }))],
	api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 2,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as AssistantMessage);

describe("trusted recap settings", () => {
	it.each([undefined, null, [], true, "bad", { recap: [] }, { recap: null }])("defaults malformed settings %j", settings => {
		expect(readConfig(settings)).toMatchObject({ model: undefined, maxWords: 40, minTurns: 3, cooldownTurns: 3, similarityThreshold: 0.7, placement: "aboveEditor", autoName: true });
	});
	it("uses only the recap namespace and trims configured prompts/model", () => {
		const result = readConfig({ model: "ignored", autoName: false, recap: { model: " provider/id/path ", maxWords: 7, minTurns: 1, cooldownTurns: 2, similarityThreshold: 0, placement: "below", autoName: false, prompts: { recap: " Custom recap ", name: " Custom name " } } });
		expect(result).toEqual({ model: "provider/id/path", maxWords: 7, minTurns: 1, cooldownTurns: 2, similarityThreshold: 0, placement: "belowEditor", autoName: false, recapPrompt: "Custom recap", namePrompt: "Custom name" });
	});
	it.each([0, -1, 1.5, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER + 1])("rejects invalid positive integers %s", value => {
		expect(readConfig({ recap: { maxWords: value, minTurns: value, cooldownTurns: value } })).toMatchObject({ maxWords: 40, minTurns: 3, cooldownTurns: 3 });
	});
	it.each([-1, 1.01, NaN, Infinity, "0.5"])("rejects invalid similarity threshold %s", value => {
		expect(readConfig({ recap: { similarityThreshold: value } }).similarityThreshold).toBe(0.7);
	});
	it("accepts threshold endpoints and only literal false disables naming", () => {
		expect(readConfig({ recap: { similarityThreshold: 1, autoName: "false", placement: "belowEditor", prompts: { name: " ", recap: null } } })).toMatchObject({ similarityThreshold: 1, autoName: true, placement: "aboveEditor" });
		expect(readConfig({ recap: { maxWords: 12 } }).recapPrompt).toContain("under 12 words");
		expect(readConfig({}).namePrompt).toContain("at most 60 characters");
	});
});

describe("output validation and cleanup", () => {
	it("extracts only text blocks, never thinking, images, or tool calls", () => {
		expect(extractText("plain")).toBe("plain");
		expect(extractText([{ type: "text", text: "hello" }, null, { type: "thinking", thinking: "secret" }, { type: "toolCall", name: "bash" }, { type: "text", text: 42 }, { type: "text", text: "world" }])).toBe("hello world");
		expect(extractText({ type: "text", text: "not an array" })).toBe("");
	});
	it.each([
		["- **Build** `widgets`!", "Build widgets"], ["1. Fix [routing](https://example.test).", "Fix routing"],
		["※ recap: Fix tests。", "Fix tests"], ["Title: “修复测试！”", "修复测试"],
		["Here's the recap: Done?!", "Done"], ["\u001b[31mSession name: Plain\u001b[0m\u0007", "Plain"],
		["# Heading", "Heading"], ["• Work   on  tests", "Work on tests"],
	])("cleans %j", (input, expected) => expect(cleanLine(input)).toBe(expected));
	it("accepts a single content line with removable heading and collapses CRLF/whitespace", () => {
		expect(cleanOutput("\r\n# Heading\r\n  Recap: **Fix**   tests. \r\n", "recap", 40)).toBe("Fix tests");
	});
	it.each(["", " \n ", "# Heading", "first\nsecond", "{\"title\":\"wrong\"}", "[\"wrong\"]", "x".repeat(4001), "\u001b[31m\u001b[0m"])("rejects malformed output %j", input => {
		expect(() => cleanOutput(input, "name", 40)).toThrow();
	});
	it("caps recaps by words and titles by Unicode code points without surrogate splitting", () => {
		expect(cleanOutput("one two three four", "recap", 3)).toBe("one two three…");
		expect(cleanOutput("one two three", "recap", 3)).toBe("one two three");
		expect(cleanOutput("😀".repeat(61), "name", 1)).toBe("😀".repeat(59) + "…");
		expect(Array.from(cleanOutput("界".repeat(70), "name", 1))).toHaveLength(TITLE_MAX_CHARS);
		expect(cleanOutput("x".repeat(60), "name", 1)).toHaveLength(60);
	});
	it("computes case/punctuation-insensitive set Jaccard similarity with Unicode", () => {
		expect(similarity("Fix fix TESTS!", "tests fix")).toBe(1);
		expect(similarity("one two", "two three")).toBeCloseTo(1 / 3);
		expect(similarity("修复 测试", "修复 界面")).toBeCloseTo(1 / 3);
		expect(similarity("😀!", "...")).toBe(0);
		expect(similarity("one", "other")).toBe(0);
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

describe("real SessionManager snapshot projection", () => {
	it("returns undefined for empty or metadata-only branches", () => {
		const m = SessionManager.inMemory();
		m.appendSessionInfo("Existing name");
		m.appendCustomEntry("state", { text: "hidden" });
		expect(buildSnapshot(context(m))).toBeUndefined();
	});
	it("retains original goal, uses only last three rounds/latest assistant, deduplicates tools", () => {
		const m = SessionManager.inMemory();
		for (let i = 0; i < 5; i++) {
			user(m, `user-${i}`);
			assistant(m, `intermediate-${i}`, ["read", "read", "edit"]);
			assistant(m, `final-${i}`);
		}
		const result = buildSnapshot(context(m))!;
		expect(result).toMatchObject({ goal: "user-0", userCount: 5 });
		expect(result.prompt).toContain("Round 1 user: user-2");
		expect(result.prompt).toContain("Round 3 assistant: final-4");
		expect(result.prompt).toContain("tools: read, edit");
		expect(result.prompt).not.toContain("intermediate");
		expect(result.prompt).not.toContain("user-1");
		expect(result.inputKey).toMatch(/^[a-f0-9]{64}$/);
		expect(buildSnapshot(context(m))!.inputKey).toBe(result.inputKey);
		m.appendCustomEntry("ignored", { text: "noise" });
		expect(buildSnapshot(context(m))!.inputKey).toBe(result.inputKey);
		assistant(m, "changed answer");
		expect(buildSnapshot(context(m))!.inputKey).not.toBe(result.inputKey);
	});
	it("bounds goals, recent messages, summaries and tool lists", () => {
		const m = SessionManager.inMemory();
		user(m, "g".repeat(500));
		const kept = user(m, "u".repeat(500));
		assistant(m, "a".repeat(600), ["t".repeat(400)]);
		m.appendCompaction("s".repeat(2000), kept, 100);
		const result = buildSnapshot(context(m))!;
		expect(result.goal).toHaveLength(500);
		for (const [character, limit] of [["g", 200], ["u", 200], ["a", 300], ["s", 1000], ["t", 200]] as const) {
			expect(result.prompt).toContain(character.repeat(limit));
			expect(result.prompt).not.toContain(character.repeat(limit + 1));
		}
	});
	it("honors active-branch context replacements and omissions including original goal", () => {
		const m = SessionManager.inMemory();
		const goal = user(m, "private original goal");
		const omitted = user(m, "private omitted prompt");
		const answer = assistant(m, "private replaced answer");
		m.appendContextEdit(goal, { content: "safe revised goal" });
		m.appendContextEdit(omitted, null);
		m.appendContextEdit(answer, { content: [{ type: "text", text: "safe answer" }] });
		const result = buildSnapshot(context(m))!;
		expect(result.goal).toBe("safe revised goal");
		expect(result.prompt).not.toContain("private");
		expect(result.prompt).toContain("safe answer");
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
		expect(result.prompt).toContain("<context_summary>\nSummarized earlier progress");
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
});
