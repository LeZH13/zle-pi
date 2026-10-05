import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMING_KEY, STATE_KEY } from "../lib/summary.js";
import { flush, response, setup } from "./harness.js";

beforeEach(() => {
	vi.stubEnv("PI_SUBAGENT_ID", "");
	vi.stubEnv("PI_SUBAGENT_SESSION", "");
});
afterEach(() => vi.unstubAllEnvs());

function persisted(manager: SessionManager, key: string) {
	return manager.getBranch().filter(e => e.type === "custom" && e.customType === key).map(e => (e as any).data);
}
const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
function widget(h: ReturnType<typeof setup>, theme = plainTheme) {
	const factory = h.setWidget.mock.calls.at(-1)?.[1];
	return typeof factory === "function" ? factory({}, theme) : undefined;
}

describe("registration and full exclusions", () => {
	it("registers only its two commands and supported lifecycle events", () => {
		const h = setup();
		expect([...h.commands.keys()]).toEqual(["recap", "autoname"]);
		expect([...h.handlers.keys()]).toEqual(["session_start", "agent_start", "agent_before_settle", "agent_settled", "session_info_changed", "session_before_tree", "session_tree", "session_shutdown"]);
	});
	it.each(["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"])("fully disables registration for %s", key => {
		vi.stubEnv(key, " child-123 ");
		const h = setup();
		expect(h.handlers.size).toBe(0);
		expect(h.commands.size).toBe(0);
		expect(h.appendEntry).not.toHaveBeenCalled();
	});
	it("ignores whitespace-only child environment values", () => {
		vi.stubEnv("PI_SUBAGENT_ID", "  ");
		vi.stubEnv("PI_SUBAGENT_SESSION", "\t");
		expect(setup().commands.size).toBe(2);
	});
	it.each([["rpc", true], ["json", false], ["print", false], ["tui", false]])("does no work in %s with hasUI=%s", async (mode, hasUI) => {
		const h = setup({ mode: String(mode), hasUI: Boolean(hasUI) });
		await h.start();
		h.user(); h.user(); h.user();
		await h.run();
		await h.command("recap");
		await h.command("autoname");
		await h.emit("session_info_changed", { name: "manual" });
		await h.emit("session_before_tree");
		await h.emit("session_tree");
		await h.emit("session_shutdown");
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.setWidget).not.toHaveBeenCalled();
	});
});

describe("initial automatic session naming", () => {
	it.each(["startup", "new"])("names an empty %s only after completed full settlement, once", async reason => {
		const h = setup();
		await h.start(reason);
		expect(persisted(h.manager, NAMING_KEY)).toEqual([{ sessionId: h.manager.getSessionId(), eligible: true }]);
		h.user("Create recap feature");
		await h.emit("agent_start");
		await h.emit("agent_end");
		h.assistant();
		await h.emit("agent_before_settle", { outcome: "completed" });
		expect(h.streamSimple).not.toHaveBeenCalled();
		await h.emit("agent_settled");
		await flush();
		expect(h.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.state().completedRuns).toBe(1);
		await h.emit("agent_settled"); // duplicate notification is not a second run
		h.user("Continue");
		await h.run();
		expect(h.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.state().completedRuns).toBe(2);
		expect(persisted(h.manager, NAMING_KEY).at(-1).eligible).toBe(false);
	});
	it.each(["aborted", "error"])("does not count or name %s runs, retries after later success", async outcome => {
		const h = setup();
		await h.start();
		h.user();
		await h.run(outcome);
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(h.state()).toBeUndefined();
		h.answer("Successful title");
		await h.run();
		expect(h.manager.getSessionName()).toBe("Successful title");
		expect(h.state().completedRuns).toBe(1);
	});
	it.each(["length", "error", "aborted", "toolUse"])("ignores completed outcomes with unfinished main assistant stop reason %s", async stopReason => {
		const h = setup(); await h.start(); h.user(); h.user(); h.user();
		h.assistant(stopReason);
		await h.run();
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(h.state()).toBeUndefined();
		h.assistant("stop"); await h.run();
		expect(h.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.state().completedRuns).toBe(1);
	});
	it("ignores a completed outcome with no assistant response", async () => {
		const h = setup(); await h.start(); h.user();
		await h.emit("agent_before_settle", { outcome: "completed" });
		await h.emit("agent_settled"); await flush();
		expect(h.streamSimple).not.toHaveBeenCalled();
	});
	it("retries initial naming failures without duplicate automatic warnings", async () => {
		const h = setup();
		await h.start(); h.user();
		for (let i = 0; i < 2; i++) {
			h.streamSimple.mockImplementationOnce(() => ({ result: () => Promise.reject(new Error("offline")) }));
			await h.run();
		}
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.notify.mock.calls.filter(([text]) => text.includes("offline"))).toHaveLength(1);
		h.answer("Recovered title");
		await h.run();
		expect(h.manager.getSessionName()).toBe("Recovered title");
	});
	it.each(["resume", "fork", "clone"])("never auto names a %s session", async reason => {
		const h = setup();
		await h.start(reason); h.user(); await h.run();
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(persisted(h.manager, NAMING_KEY)).toEqual([{ sessionId: h.manager.getSessionId(), eligible: false }]);
	});
	it("excludes parent sessions even if startup is empty", async () => {
		const h = setup({ manager: SessionManager.inMemory("/test", { parentSession: "/parent.jsonl" }) });
		await h.start(); h.user(); await h.run();
		expect(h.setSessionName).not.toHaveBeenCalled();
	});
	it.each(["message", "compaction", "branch_summary"])("excludes preexisting %s on startup", async kind => {
		const h = setup();
		if (kind === "message") h.user("Existing conversation");
		else if (kind === "compaction") h.manager.appendCompaction("Existing summary", null, 1);
		else h.manager.branchWithSummary(null, "Existing branch summary");
		await h.start(); h.user(); await h.run();
		expect(h.setSessionName).not.toHaveBeenCalled();
	});
	it("preserves existing names and manual renames before first settlement", async () => {
		for (const beforeStart of [true, false]) {
			const h = setup();
			if (beforeStart) h.manager.appendSessionInfo("User title");
			await h.start();
			if (!beforeStart) h.setSessionName("User title");
			h.user(); await h.run();
			expect(h.manager.getSessionName()).toBe("User title");
			expect(h.streamSimple).not.toHaveBeenCalled();
			expect(persisted(h.manager, NAMING_KEY).at(-1).eligible).toBe(false);
		}
	});
	it("resumes eligible naming on reload, scoped to session id, but not on resume", async () => {
		const initial = setup();
		await initial.start(); initial.user();
		const reload = setup({ manager: initial.manager });
		await reload.start("reload"); await reload.run();
		expect(reload.setSessionName).toHaveBeenCalledTimes(1);
		for (const reason of ["reload", "resume"]) {
			const m = SessionManager.inMemory();
			m.appendCustomEntry(NAMING_KEY, { sessionId: reason === "reload" ? "wrong-session" : m.getSessionId(), eligible: true });
			const h = setup({ manager: m });
			await h.start(reason); h.user(); await h.run();
			expect(h.setSessionName).not.toHaveBeenCalled();
		}
	});
	it.each(["resume", "fork", "clone"])("permanently revokes pending naming after %s followed by reload", async reason => {
		const original = setup(); await original.start(); original.user();
		const reopened = setup({ manager: original.manager }); await reopened.start(reason);
		expect(persisted(reopened.manager, NAMING_KEY).at(-1).eligible).toBe(false);
		const reloaded = setup({ manager: reopened.manager }); await reloaded.start("reload"); await reloaded.run();
		expect(reloaded.streamSimple).not.toHaveBeenCalled();
		expect(reloaded.setSessionName).not.toHaveBeenCalled();
	});
	it("does not re-enable successful naming after reload even if name is cleared", async () => {
		const initial = setup();
		await initial.start(); initial.user(); await initial.run();
		initial.manager.appendSessionInfo("");
		const h = setup({ manager: initial.manager });
		await h.start("reload"); await h.run();
		expect(h.setSessionName).not.toHaveBeenCalled();
	});
});

describe("forced commands and configured shared model", () => {
	it("autoname replaces existing titles even with autoName disabled", async () => {
		const h = setup({ settings: { recap: { autoName: false } } });
		await h.start(); h.user(); h.setSessionName("Old title");
		h.answer("Title: New subject");
		await h.command("autoname");
		expect(h.manager.getSessionName()).toBe("New subject");
		expect(h.notify).toHaveBeenLastCalledWith("Session named: New subject", "info");
	});
	it("recap ignores prompt threshold, unchanged input, cooldown and similarity when forced", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 99, cooldownTurns: 99, similarityThreshold: 0 } } });
		await h.start(); h.user();
		h.answer("First recap"); await h.command("recap");
		h.answer("Second recap"); await h.command("recap");
		expect(h.state()).toMatchObject({ recap: "Second recap", completedRuns: 0 });
		expect(h.state().lastAutoUpdateAt).toBeUndefined();
		expect(h.streamSimple).toHaveBeenCalledTimes(2);
		expect(widget(h).render(100).join("")).toContain("Second recap");
	});
	it.each(["recap", "autoname"])("validates /%s arguments, idle status, and conversation", async command => {
		const h = setup(); await h.start();
		await h.command(command, "extra");
		expect(h.notify).toHaveBeenLastCalledWith(`Usage: /${command} (no arguments)`, "warning");
		h.idle(false); await h.command(command);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("busy"), "warning");
		h.idle(true); await h.command(command, " \t");
		expect(h.notify).toHaveBeenLastCalledWith("No conversation yet", "warning");
		expect(h.streamSimple).not.toHaveBeenCalled();
	});
	it("declines both commands during pending summary without aborting the request", async () => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); const command = h.command("recap");
		await h.command("autoname"); await h.command("recap");
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		expect(h.notify.mock.calls.filter(([text]) => text.includes("busy"))).toHaveLength(2);
		expect((h.streamSimple.mock.calls[0] as any)[2].signal.aborted).toBe(false);
		pending.resolve(response("Done")); await command;
		expect(h.state().recap).toBe("Done");
	});
	it("uses shared configured model, prompts, safe request options and bounded input", async () => {
		const configured = { provider: "other", id: "small" };
		const h = setup({ settings: { recap: { model: "other/small", prompts: { name: "Name safely", recap: "Recap safely" }, maxWords: 2 } } });
		h.registry.find.mockReturnValue(configured);
		await h.start(); h.user("u".repeat(5000));
		h.answer("one two three"); await h.command("recap");
		h.answer("Coding subject"); await h.command("autoname");
		expect(h.registry.find).toHaveBeenCalledWith("other", "small");
		const calls = h.streamSimple.mock.calls as any[];
		expect(calls[0][0]).toBe(configured);
		expect(calls[0][1].systemPrompt).toBe("Recap safely");
		expect(calls[1][1].systemPrompt).toBe("Name safely");
		expect(calls[0][1].messages[0].content[0].text.length).toBeLessThan(1000);
		expect(calls[0][2]).toMatchObject({ maxTokens: 512, cacheRetention: "none", signal: expect.any(AbortSignal) });
		expect(h.state().recap).toBe("one two…");
	});
	it.each(["missing", "unauthenticated"])("fails configured %s model with no fallback for both commands", async failure => {
		const h = setup({ settings: { recap: { model: "other/small" } } });
		await h.start(); h.user();
		if (failure === "missing") h.registry.find.mockReturnValue(undefined as any);
		else h.registry.hasConfiguredAuth.mockReturnValue(false);
		await h.command("recap"); await h.command("autoname");
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.notify.mock.calls.filter(([text]) => text.includes("no fallback was used"))).toHaveLength(2);
	});
});

describe("automatic recap scheduling and persisted branch state", () => {
	it("waits for three user prompts then enforces three completed-run cooldown", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		for (let i = 1; i <= 6; i++) {
			h.user(`Prompt ${i}`);
			if (i === 3 || i === 6) h.answer(i === 3 ? "First feature recap" : "Different second goal");
			await h.run();
			expect(h.streamSimple).toHaveBeenCalledTimes(i < 3 ? 0 : i < 6 ? 1 : 2);
		}
		expect(h.state()).toMatchObject({ completedRuns: 6, lastAutoUpdateAt: 6, recap: "Different second goal" });
	});
	it("allows the first recap immediately despite a long configured cooldown", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1, cooldownTurns: 100 } } });
		await h.start(); h.user(); h.answer("Initial recap"); await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		expect(h.state()).toMatchObject({ recap: "Initial recap", completedRuns: 1, lastAutoUpdateAt: 1 });
		h.user("Next prompt"); await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
	});
	it("does not consume requests for unchanged input, skips similar updates but persists their key", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		h.user("one"); h.user("two"); h.user("three");
		h.answer("Build feature and add tests"); await h.run();
		const oldKey = h.state().inputKey;
		for (let i = 0; i < 3; i++) await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		h.user("New activity"); h.answer("Add tests and build feature"); await h.run();
		expect(h.state().recap).toBe("Build feature and add tests");
		expect(h.state().inputKey).not.toBe(oldKey);
		expect(h.state().lastAutoUpdateAt).toBe(5);
		for (let i = 0; i < 3; i++) await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(2);
	});
	it("failed attempts also observe cooldown, but forced commands may immediately retry", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		h.user(); h.user(); h.user();
		h.answer("invalid", "error"); await h.run();
		expect(h.state()).toMatchObject({ completedRuns: 1, lastAutoUpdateAt: 1 });
		h.user("next"); await h.run(); await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		h.answer("Recovered recap"); await h.command("recap");
		expect(h.state().recap).toBe("Recovered recap");
	});
	it.each(["reload", "resume"])("restores recap, input key, and cooldown counters on %s", async reason => {
		const original = setup({ settings: { recap: { autoName: false } } }); await original.start();
		original.user(); original.user(); original.user(); original.answer("Stored recap"); await original.run();
		const state = original.state();
		const h = setup({ manager: original.manager, settings: { recap: { autoName: false } } });
		await h.start(reason);
		expect(widget(h).render(100).join("")).toContain("Stored recap");
		h.user("Next task"); await h.run();
		expect(h.state()).toMatchObject({ ...state, completedRuns: 2 });
		expect(h.streamSimple).not.toHaveBeenCalled();
		await h.run(); h.answer("Different recap subject"); await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		expect(h.state().lastAutoUpdateAt).toBe(4);
	});
	it("restores only active-branch recap/counters, including branches with no recap", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		const root = h.user("Root goal");
		const branchA = h.manager.appendCustomEntry(STATE_KEY, { recap: "Branch A", inputKey: "A", completedRuns: 8, lastAutoUpdateAt: 7 });
		h.manager.branch(root);
		h.manager.appendCustomEntry(STATE_KEY, { recap: "Branch B", inputKey: "B", completedRuns: 2, lastAutoUpdateAt: 0 });
		await h.emit("session_tree");
		expect(widget(h).render(100).join("")).toContain("Branch B");
		await h.run(); expect(h.state().completedRuns).toBe(3);
		h.manager.branch(branchA); await h.emit("session_tree");
		expect(widget(h).render(100).join("")).toContain("Branch A");
		await h.run(); expect(h.state().completedRuns).toBe(9);
		h.manager.branch(root); await h.emit("session_tree");
		expect(h.setWidget).toHaveBeenLastCalledWith("zle-recap", undefined);
		await h.run(); expect(h.state().completedRuns).toBe(1);
	});
	it("sanitizes corrupted persisted counters and ignores unrelated entries", async () => {
		const h = setup({ settings: { recap: { autoName: false } } });
		h.manager.appendCustomEntry(STATE_KEY, { recap: 12, inputKey: [], completedRuns: -1, lastAutoUpdateAt: Infinity });
		h.manager.appendCustomEntry(STATE_KEY, null);
		h.manager.appendCustomEntry("other", { recap: "Ignored", completedRuns: 50 });
		await h.start("resume"); h.user(); await h.run();
		expect(h.state()).toMatchObject({ completedRuns: 1 });
		expect(h.state().lastAutoUpdateAt).toBeUndefined();
		expect(h.state().recap).toBeUndefined();
	});
});

describe("stale-write and cancellation guards", () => {
	it.each(["recap", "autoname"])("aborts pending /%s at next run even if provider ignores signal", async command => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); const job = h.command(command);
		const signal = (h.streamSimple.mock.calls[0] as any)[2].signal;
		await h.emit("agent_start");
		expect(signal.aborted).toBe(true);
		pending.resolve(response("Stale output")); await job;
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.state()).toBeUndefined();
		expect(h.notify.mock.calls.some(([text]) => text.includes("updated") || text.includes("Session named:"))).toBe(false);
	});
	it.each(["session_before_tree", "session_tree", "session_shutdown", "session_start"])("discards pending recap across %s", async event => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); const job = h.command("recap");
		await h.emit(event, { reason: "reload" });
		expect((h.streamSimple.mock.calls[0] as any)[2].signal.aborted).toBe(true);
		pending.resolve(response("Stale recap")); await job;
		expect(h.state()).toBeUndefined();
		expect(widget(h)).toBeUndefined();
	});
	it.each(["recap", "autoname"])("discards /%s if conversation context is edited or compacted while pending", async command => {
		for (const change of ["edit", "compact"]) {
			const h = setup(); await h.start(); const goal = h.user("Original goal");
			const pending = h.pending(); const job = h.command(command);
			if (change === "edit") h.manager.appendContextEdit(goal, { content: "Updated goal" });
			else h.manager.appendCompaction("Updated compacted context", goal, 20);
			pending.resolve(response("Obsolete summary")); await job;
			expect(h.setSessionName).not.toHaveBeenCalled();
			expect(h.state()).toBeUndefined();
			expect(h.notify.mock.calls.some(([text]) => text.includes("failed") || text.includes("updated") || text.includes("Session named:"))).toBe(false);
		}
	});
	it("silently discards provider errors for a changed context", async () => {
		const h = setup(); await h.start(); const goal = h.user();
		const pending = h.pending(); const job = h.command("recap");
		h.manager.appendContextEdit(goal, null);
		pending.reject(new Error("Failure from obsolete context")); await job;
		expect(h.notify.mock.calls.some(([text]) => text.includes("failed"))).toBe(false);
	});
	it("discards old-session requests without aborting newer-session work in finally", async () => {
		const h = setup(); await h.start(); h.user("Old session");
		const old = h.pending(); const oldJob = h.command("recap");
		h.switchManager(SessionManager.inMemory()); await h.start("new"); h.user("New session");
		const current = h.pending(); const currentJob = h.command("recap");
		old.resolve(response("Old stale recap")); await oldJob;
		await h.command("autoname");
		expect(h.streamSimple).toHaveBeenCalledTimes(2);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("busy"), "warning");
		current.resolve(response("Current recap")); await currentJob;
		expect(h.state().recap).toBe("Current recap");
	});
	it("a manual rename during forced naming wins, even if changed back to captured name", async () => {
		const h = setup(); await h.start(); h.user(); h.setSessionName("Original");
		const pending = h.pending(); const job = h.command("autoname");
		h.setSessionName("Temporary"); h.setSessionName("Original");
		pending.resolve(response("Generated stale name")); await job;
		expect(h.manager.getSessionName()).toBe("Original");
		expect(h.setSessionName).toHaveBeenCalledTimes(3);
	});
	it("also checks direct metadata changes not reported as events", async () => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); const job = h.command("autoname");
		h.manager.appendSessionInfo("External name");
		pending.resolve(response("Generated stale name")); await job;
		expect(h.manager.getSessionName()).toBe("External name");
		expect(h.setSessionName).not.toHaveBeenCalled();
	});
	it("serializes automatic naming before recap without blocking main settlement", async () => {
		const h = setup(); await h.start(); h.user(); h.user(); h.user();
		const name = h.pending(); const recap = h.pending();
		await h.run(); // event handler does not await the pending name
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		name.resolve(response("Automatic title")); await flush();
		expect(h.setSessionName).toHaveBeenCalledWith("Automatic title");
		expect(h.streamSimple).toHaveBeenCalledTimes(2);
		recap.resolve(response("Automatic recap")); await flush();
		expect(h.state().recap).toBe("Automatic recap");
	});
	it("serializes automatic naming then recap and never starts recap after shutdown", async () => {
		const h = setup(); await h.start(); h.user(); h.user(); h.user();
		const pending = h.pending(); await h.run();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		await h.emit("session_shutdown");
		pending.resolve(response("Late name")); await flush();
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		expect(h.setSessionName).not.toHaveBeenCalled();
	});
	it.each(["session_shutdown", "session_before_tree", "session_tree"])("does not begin new summary work if %s happens between settle events", async event => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		h.user(); h.user(); h.user(); h.assistant();
		await h.emit("agent_start");
		await h.emit("agent_before_settle", { outcome: "completed" });
		await h.emit(event);
		await h.emit("agent_settled"); await flush();
		expect(h.streamSimple).not.toHaveBeenCalled();
	});
	it("retries initially cancelled automatic naming on the next complete run", async () => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); await h.run();
		await h.emit("agent_start");
		pending.resolve(response("Abandoned name")); await flush();
		expect(h.setSessionName).not.toHaveBeenCalled();
		h.answer("Retried name"); await h.run();
		expect(h.manager.getSessionName()).toBe("Retried name");
	});
	it("cancellation failures are silent and release generation for a later command", async () => {
		const h = setup(); await h.start(); h.user();
		const pending = h.pending(); const job = h.command("recap");
		await h.emit("agent_start"); pending.reject(new Error("AbortError")); await job;
		expect(h.notify.mock.calls.some(([text]) => text.includes("failed"))).toBe(false);
		h.answer("Fresh recap"); await h.command("recap");
		expect(h.state().recap).toBe("Fresh recap");
	});
});

describe("response failures and UI rendering", () => {
	it.each(["error", "aborted", "length", "toolUse"])("rejects nonfinal stop reason %s", async stopReason => {
		const h = setup(); await h.start(); h.user();
		h.answer("Otherwise valid", stopReason); await h.command("autoname");
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining(`did not finish (${stopReason})`), "warning");
	});
	it.each([[], [{ type: "thinking", thinking: "Hidden" }], [{ type: "text", text: "two\nlines" }], [{ type: "text", text: "{\"title\":\"bad\"}" }], [{ type: "text", text: "x".repeat(4001) }]].map(content => ({ content })))("rejects malformed response content %# without changing prior recap", async ({ content }) => {
		const h = setup(); await h.start(); h.user();
		h.answer("Existing recap"); await h.command("recap");
		h.streamSimple.mockImplementationOnce(() => ({ result: () => Promise.resolve({ stopReason: "stop", content }) }));
		await h.command("recap");
		expect(h.state().recap).toBe("Existing recap");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Recap failed:"), "warning");
	});
	it("contains unexpected preparation errors in fire-and-forget automatic work", async () => {
		const h = setup(); await h.start(); h.user(); h.assistant();
		const spy = vi.spyOn(h.manager, "getBranch").mockImplementation(() => { throw new Error("Projection unavailable"); });
		await h.run();
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Projection unavailable"), "warning");
		expect(h.streamSimple).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it("reports synchronous provider throws and rejected results, retries forced errors", async () => {
		const h = setup(); await h.start(); h.user();
		h.streamSimple.mockImplementationOnce(() => { throw new Error("Provider down"); });
		await h.command("recap");
		h.streamSimple.mockImplementationOnce(() => ({ result: () => Promise.reject("Provider down") }));
		await h.command("recap");
		expect(h.notify.mock.calls.filter(([text]) => text.includes("Provider down"))).toHaveLength(2);
		h.answer("Recovered"); await h.command("recap");
		expect(h.state().recap).toBe("Recovered");
	});
	it("renders themed CJK/emoji safely at narrow widths, moves placement, cleans up shutdown", async () => {
		const h = setup(); await h.start(); h.user();
		h.answer("修复界面 😀 👨‍👩‍👧‍👦 and tests"); await h.command("recap");
		const theme = {
			fg: vi.fn((token: string, text: string) => `\u001b[${token === "accent" ? 36 : 90}m${text}\u001b[39m`),
			bold: vi.fn((text: string) => `\u001b[1m${text}\u001b[22m`),
			italic: vi.fn((text: string) => `\u001b[3m${text}\u001b[23m`),
		};
		const component = widget(h, theme);
		for (const width of [1, 2, 3, 8, 20, 80]) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(component.render(0)).toEqual([]); expect(component.render(-1)).toEqual([]);
		expect(component.render(80).map(stripTerminalSequences).join("")).toContain("※ recap: 修复界面");
		expect(theme.fg).toHaveBeenCalledWith("accent", expect.any(String));
		expect(theme.fg).toHaveBeenCalledWith("muted", expect.any(String));
		component.invalidate();
		h.settings({ recap: { placement: "below" } });
		await h.emit("session_tree");
		expect(h.setWidget.mock.calls.at(-2)).toEqual(["zle-recap", undefined]);
		expect(h.setWidget.mock.calls.at(-1)?.[2]).toEqual({ placement: "belowEditor" });
		await h.emit("session_shutdown");
		expect(h.setWidget).toHaveBeenLastCalledWith("zle-recap", undefined);
		const count = h.setWidget.mock.calls.length;
		await h.emit("session_shutdown");
		expect(h.setWidget).toHaveBeenCalledTimes(count);
	});
	it("deduplicates automatic warnings per instance and resets warnings after reload", async () => {
		const a = setup(); const b = setup();
		for (const h of [a, b]) {
			await h.start(); h.user();
			for (let i = 0; i < 2; i++) { h.answer("", "error"); await h.run(); }
			expect(h.notify.mock.calls.filter(([text]) => text.includes("failed"))).toHaveLength(1);
		}
		await a.start("reload"); a.answer("", "error"); await a.run();
		expect(a.notify.mock.calls.filter(([text]) => text.includes("failed"))).toHaveLength(2);
		expect(b.notify.mock.calls.filter(([text]) => text.includes("failed"))).toHaveLength(1);
	});
	it("keeps state, cancellation, settings, and naming independent per instance", async () => {
		const a = setup({ settings: { recap: { autoName: false } } });
		const b = setup(); await a.start(); await b.start(); a.user(); b.user();
		const pending = a.pending(); const aJob = a.command("recap");
		b.answer("Independent name"); await b.run();
		expect(b.manager.getSessionName()).toBe("Independent name");
		await b.emit("session_shutdown");
		expect((a.streamSimple.mock.calls[0] as any)[2].signal.aborted).toBe(false);
		pending.resolve(response("Independent recap")); await aJob;
		expect(a.state().recap).toBe("Independent recap");
		expect(a.manager.getSessionName()).toBeUndefined();
		expect(b.state().recap).toBeUndefined();
	});
});
