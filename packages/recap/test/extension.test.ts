import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMING_KEY, STATE_KEY } from "../lib/summary.js";
import { flush, response, setup } from "./harness.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("PI_SUBAGENT_ID", "");
	vi.stubEnv("PI_SUBAGENT_SESSION", "");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

function persisted(manager: SessionManager, key: string) {
	return manager.getBranch().filter(e => e.type === "custom" && e.customType === key).map(e => (e as any).data);
}
const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
function widget(h: ReturnType<typeof setup>, theme = plainTheme) {
	const factory = h.setWidget.mock.calls.at(-1)?.[1];
	return typeof factory === "function" ? factory({ requestRender: vi.fn() }, theme) : undefined;
}

describe("registration and full exclusions", () => {
	it("registers only its two commands and supported lifecycle events", () => {
		const h = setup();
		expect([...h.commands.keys()]).toEqual(["recap", "autoname"]);
		expect([...h.handlers.keys()]).toEqual(["session_start", "input", "user_bash", "agent_start", "agent_before_settle", "agent_settled", "session_info_changed", "session_before_tree", "session_tree", "session_shutdown"]);
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
		expect(h.state()).toBeUndefined();
		await h.emit("agent_settled"); // duplicate notification is not a second run
		h.user("Continue");
		await h.run();
		expect(h.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.state()).toBeUndefined();
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
		expect(h.state()).toBeUndefined();
	});
	it.each(["length", "error", "aborted", "toolUse"])("ignores completed outcomes with unfinished main assistant stop reason %s", async stopReason => {
		const h = setup(); await h.start(); h.user(); h.user(); h.user();
		h.assistant(stopReason);
		await h.run();
		expect(h.streamSimple).not.toHaveBeenCalled();
		expect(h.state()).toBeUndefined();
		h.assistant("stop"); await h.run();
		expect(h.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.state()).toBeUndefined();
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
	it("recap ignores prompt threshold, unchanged input and idle delay when forced", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 99, idleDelaySeconds: 999 } } });
		await h.start(); h.user();
		h.answer("First recap"); await h.command("recap");
		h.answer("Second recap"); await h.command("recap");
		expect(h.state()).toMatchObject({ recap: "Second recap" });
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
		expect(calls[0][1].messages[0].content[0].text.length).toBeLessThan(10000);
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

describe("automatic idle recaps and branch freshness", () => {
	it("requires three prompts and two uninterrupted idle minutes, then refreshes after each eligible run", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start();
		for (let i = 1; i <= 2; i++) { h.user(); await h.run(); await vi.advanceTimersByTimeAsync(120000); }
		expect(h.streamSimple).not.toHaveBeenCalled();
		h.user(); h.answer("First recap"); await h.run();
		expect(widget(h)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(119999); expect(h.streamSimple).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1); expect(h.state().recap).toBe("First recap");
		h.user("Next work"); h.answer("Fresh wording"); await h.run();
		expect(widget(h)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(120000);
		expect(h.streamSimple).toHaveBeenCalledTimes(2); expect(h.state().recap).toBe("Fresh wording");
	});
	it("resets the countdown on terminal activity without consuming input", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); await h.run();
		await vi.advanceTimersByTimeAsync(119000); h.terminal("a");
		await vi.advanceTimersByTimeAsync(119000); expect(h.streamSimple).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
	});
	it("does not reset for terminal capability replies or focus reports", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); await h.run();
		await vi.advanceTimersByTimeAsync(119000); h.terminal("\x1b[I"); h.terminal("\x1b[?1;2c");
		await vi.advanceTimersByTimeAsync(1000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
	});
	it("cancels the old countdown when another run starts", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); await h.run();
		await vi.advanceTimersByTimeAsync(119000); h.idle(false); await h.emit("agent_start");
		await vi.advanceTimersByTimeAsync(120000); expect(h.streamSimple).not.toHaveBeenCalled();
		h.user("New run"); await h.run(); await vi.advanceTimersByTimeAsync(120000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
	});
	it.each(["question tool", "bash approval"])("does not count time awaiting a %s as idle", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); h.idle(false);
		await h.emit("agent_start"); await h.emit("tool_execution_start");
		await vi.advanceTimersByTimeAsync(300000); expect(h.streamSimple).not.toHaveBeenCalled();
		h.assistant(); await h.emit("agent_before_settle", { outcome: "completed" }); h.idle(true); await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(119999); expect(h.streamSimple).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1); expect(h.streamSimple).toHaveBeenCalledTimes(1);
	});
	it.each(["aborted", "error"])("never schedules after %s", async outcome => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); await h.run(outcome);
		h.terminal("a"); await vi.advanceTimersByTimeAsync(300000); expect(h.streamSimple).not.toHaveBeenCalled();
	});
	it("disarms idle recap when a user shell command starts", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user(); await h.run();
		await h.emit("user_bash", { command: "long-running-command" });
		await vi.advanceTimersByTimeAsync(300000); expect(h.streamSimple).not.toHaveBeenCalled();
		expect(widget(h)).toBeUndefined();
	});
	it("rechecks idle and conversation at the timer boundary", async () => {
		for (const change of ["busy", "edit"]) {
			const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); const goal = h.user(); await h.run();
			if (change === "busy") h.idle(false); else h.manager.appendContextEdit(goal, { content: "Changed context" });
			await vi.advanceTimersByTimeAsync(120000); expect(h.streamSimple).not.toHaveBeenCalled();
			await h.emit("session_shutdown");
		}
	});
	it("skips unchanged conversation but always uses freshly generated wording for changed input", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user();
		h.answer("Build feature and add tests"); await h.run(); await vi.advanceTimersByTimeAsync(120000);
		await h.run(); await vi.advanceTimersByTimeAsync(120000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
		h.user("Change"); h.answer("Add tests and build feature"); await h.run(); await vi.advanceTimersByTimeAsync(120000);
		expect(h.state().recap).toBe("Add tests and build feature");
	});
	it("does not loop failed requests; manual refresh retries immediately", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user();
		h.answer("invalid", "error"); await h.run(); await vi.advanceTimersByTimeAsync(120000);
		await vi.advanceTimersByTimeAsync(600000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
		h.terminal("a"); await vi.advanceTimersByTimeAsync(120000); expect(h.streamSimple).toHaveBeenCalledTimes(1);
		h.answer("Recovered"); await h.command("recap"); expect(h.state().recap).toBe("Recovered");
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(["reload", "resume"])("restores only fresh recap on %s", async reason => {
		const original = setup({ settings: { recap: { autoName: false } } }); await original.start(); const goal = original.user();
		original.answer("Stored recap"); await original.command("recap");
		const h = setup({ manager: original.manager }); await h.start(reason);
		expect(widget(h).render(100).join("")).toContain("Stored recap");
		h.manager.appendContextEdit(goal, { content: "Changed goal" }); await h.start(reason);
		expect(widget(h)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(300000); expect(h.streamSimple).not.toHaveBeenCalled();
	});
	it("hides recap during new work and restores only matching active-branch metadata", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start(); const root = h.user("Root");
		h.answer("Branch A"); await h.command("recap"); const branchA = h.manager.getLeafId()!;
		h.user("Branch B"); h.answer("Branch B"); await h.command("recap"); const branchB = h.manager.getLeafId()!;
		await h.emit("agent_start"); expect(widget(h)).toBeUndefined();
		h.manager.branch(branchA); await h.emit("session_tree"); expect(widget(h).render(100).join("")).toContain("Branch A");
		h.manager.branch(branchB); await h.emit("session_tree"); expect(widget(h).render(100).join("")).toContain("Branch B");
		h.manager.branch(root); await h.emit("session_tree"); expect(widget(h)).toBeUndefined();
	});
	it("ignores corrupted state and never displays unvalidated old fingerprints", async () => {
		const h = setup(); h.user();
		h.manager.appendCustomEntry(STATE_KEY, { recap: 12, inputKey: [] });
		h.manager.appendCustomEntry(STATE_KEY, null); h.manager.appendCustomEntry("other", { recap: "Ignored" });
		await h.start("resume"); expect(widget(h)).toBeUndefined();
		h.manager.appendCustomEntry(STATE_KEY, { recap: "Old stale recap", inputKey: "old" });
		await h.start("reload"); expect(widget(h)).toBeUndefined();
	});
	it("shows an animated bounded badge only during generation and stops it on success", async () => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user();
		const pending = h.pending(); await h.run(); expect(widget(h)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(120000); const component = widget(h);
		const first = component.render(80).join(""); expect(first).toContain("Generating recap…");
		await vi.advanceTimersByTimeAsync(80); expect(component.render(80).join("")).not.toBe(first);
		for (const width of [1, 2, 10, 80]) for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		pending.resolve(response("Fresh recap")); await flush();
		expect(widget(h).render(100).join("")).toContain("Fresh recap"); expect(vi.getTimerCount()).toBe(0);
	});
	it.each(["typing", "run", "shutdown"])("discards late recap and stops animation on %s", async activity => {
		const h = setup({ settings: { recap: { autoName: false, minTurns: 1 } } }); await h.start(); h.user();
		const pending = h.pending(); await h.run(); await vi.advanceTimersByTimeAsync(120000); widget(h);
		if (activity === "typing") h.terminal("a"); else await h.emit(activity === "run" ? "agent_start" : "session_shutdown");
		expect((h.streamSimple.mock.calls[0] as any)[2].signal.aborted).toBe(true);
		pending.resolve(response("Late recap")); await flush(); expect(h.state()).toBeUndefined();
		expect(widget(h)).toBeUndefined(); expect(vi.getTimerCount()).toBe(activity === "typing" ? 1 : 0);
		await h.emit("session_shutdown"); expect(vi.getTimerCount()).toBe(0); expect(h.terminalListenerCount).toBe(0);
	});
	it("caches projection across renders and typing but invalidates it for context edits", async () => {
		const h = setup({ settings: { recap: { autoName: false } } }); await h.start(); const goal = h.user();
		h.answer("Current recap"); await h.command("recap");
		const component = widget(h); component.render(80);
		const projection = vi.spyOn(h.manager, "buildSessionProjection");
		for (let i = 0; i < 10; i++) { component.render(80); h.terminal("a"); }
		expect(projection).not.toHaveBeenCalled();
		h.manager.appendContextEdit(goal, { content: "New goal" });
		expect(component.render(80)).toEqual([]); expect(projection).toHaveBeenCalledTimes(1);
		projection.mockRestore();
	});
	it("removes input subscriptions on reload and shutdown", async () => {
		const h = setup(); await h.start(); expect(h.terminalListenerCount).toBe(1);
		await h.start("reload"); expect(h.terminalListenerCount).toBe(1);
		await h.emit("session_shutdown"); await h.emit("session_shutdown"); expect(h.terminalListenerCount).toBe(0);
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
	it("discards an in-flight result when only omitted middle context changes", async () => {
		const h = setup(); await h.start(); const prefix = "start ".repeat(400); const suffix = " end".repeat(400);
		const goal = h.user(prefix + "old decision" + suffix); h.assistant();
		const pending = h.pending(); const job = h.command("recap");
		h.manager.appendContextEdit(goal, { content: prefix + "new decision" + suffix });
		pending.resolve(response("Obsolete recap")); await job;
		expect(h.state()).toBeUndefined(); expect(widget(h)).toBeUndefined();
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
		expect(h.streamSimple).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(120000);
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
		expect(b.state()).toBeUndefined();
	});
});
