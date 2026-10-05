import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WIDGET_KEY } from "../extensions/overlay.js";
import { getActiveRenderSession, getSessionEnabled } from "../extensions/store.js";
import { ENABLED_ENTRY_TYPE, SNAPSHOT_ENTRY_TYPE, type Task, type TaskDetails } from "../extensions/tasks.js";
import { identityTheme, setup, taskDetails, type Harness } from "./harness.js";

function task(partial: Partial<Task> & { id: number }): Task {
	return { subject: `Task ${partial.id}`, status: "pending", ...partial };
}

/** Seed the branch the way executed mutations do: snapshot entries. */
function appendSnapshot(manager: Harness["manager"], details: TaskDetails): void {
	manager.appendCustomEntry(SNAPSHOT_ENTRY_TYPE, details);
}

/** Seed a recorded enablement on the branch. */
function appendEnabled(manager: Harness["manager"], enabled: boolean): void {
	manager.appendCustomEntry(ENABLED_ENTRY_TYPE, { enabled });
}

async function startedWithTasks(): Promise<Harness> {
	const h = setup();
	appendSnapshot(
		h.manager,
		taskDetails([task({ id: 1 }), task({ id: 2, status: "in_progress", activeForm: "implementing controls" })], 3),
	);
	appendEnabled(h.manager, true);
	await h.start();
	return h;
}

describe("session lifecycle replay", () => {
	it("rebuilds task state from snapshot entries on session_start", async () => {
		const h = await startedWithTasks();
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/2 · implementing controls");
	});

	it("re-replays on compaction from snapshot entries", async () => {
		const h = await startedWithTasks();
		await h.runTodo({ action: "create", subject: "Executed" });
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/3 · implementing controls");

		await h.emit("session_compact", {});
		// Executed mutations persist their own snapshot, so they survive replay.
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/3 · implementing controls");
	});

	it("re-replays on tree navigation", async () => {
		const h = await startedWithTasks();
		appendSnapshot(h.manager, taskDetails([], 1, "clear"));
		await h.emit("session_tree", {});
		expect(h.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
	});

	it("tears down on shutdown and rebuilds on the next start", async () => {
		const h = await startedWithTasks();
		await h.emit("session_shutdown", {});
		expect(h.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
		expect(getActiveRenderSession()).toBe("");

		await h.start();
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/2 · implementing controls");
	});
});

describe("per-session enablement across the lifecycle", () => {
	it("every new session defaults to off, with tasks hidden and the tool inactive", async () => {
		const h = setup({ activeTools: ["read"] });
		appendSnapshot(h.manager, taskDetails([task({ id: 1 })], 2));
		await h.start();
		// Reconcile removed the declared tool and left unrelated tools alone.
		expect(h.activeTools()).toEqual(["read"]);
		// Tasks exist but tracking is off: the overlay stays hidden.
		expect(h.setWidget).not.toHaveBeenCalled();
		await expect(h.execute({ action: "list" })).rejects.toThrow(/run \/todos to enable/);
	});

	it("resume remembers enablement recorded on the branch", async () => {
		const h = setup({ activeTools: ["read"] });
		appendSnapshot(h.manager, taskDetails([task({ id: 1 })], 2));
		appendEnabled(h.manager, true);
		await h.start();
		// Reconcile re-activated the tool for the resumed session without
		// disturbing unrelated tools.
		expect(h.activeTools()).toEqual(["read", "todo"]);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1");
	});

	it("reload keeps the remembered enablement", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		await h.emit("session_start", { reason: "reload" });
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(true);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1");
	});

	it("forks inherit the enablement entry", async () => {
		// A fork shares the branch history; simulate one by replaying the parent's
		// entries through a session_start with reason "fork".
		const h = setup();
		await h.enable();
		const forkManager = SessionManager.inMemory("/fork");
		for (const entry of h.manager.getBranch()) {
			const e = entry as any;
			if (e.type === "custom") forkManager.appendCustomEntry(e.customType, e.data);
		}
		const fork = setup({ manager: forkManager, activeTools: ["read"] });
		await fork.emit("session_start", { reason: "fork" });
		expect(getSessionEnabled(forkManager.getSessionId())).toBe(true);
		expect(fork.activeTools()).toEqual(["read", "todo"]);
	});

	it("tree navigation follows the branch history (latest entry wins)", async () => {
		const h = setup({ activeTools: ["read"] });
		appendSnapshot(h.manager, taskDetails([task({ id: 1 })], 2));
		appendEnabled(h.manager, true);
		appendEnabled(h.manager, false);
		await h.start();
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(false);
		expect(h.activeTools()).toEqual(["read"]);
		expect(h.setWidget).not.toHaveBeenCalled();

		// Navigating to a branch that recorded enablement re-activates it.
		(h.ctx as any).sessionManager = {
			getSessionId: () => h.manager.getSessionId(),
			getBranch: () => [
				{ type: "custom", customType: ENABLED_ENTRY_TYPE, data: { enabled: true } },
				{
					type: "custom",
					customType: SNAPSHOT_ENTRY_TYPE,
					data: taskDetails([task({ id: 1, status: "in_progress", activeForm: "working" })], 2),
				},
			],
		};
		await h.emit("session_tree", {});
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(true);
		expect(h.activeTools()).toEqual(["read", "todo"]);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1 · working");
	});

	it("reconciles headless sessions before any UI gating", async () => {
		const h = setup({ hasUI: false, activeTools: ["read"] });
		appendEnabled(h.manager, true);
		await h.start();
		expect(h.activeTools()).toEqual(["read", "todo"]);
	});

	it("does not auto-disable when all tasks are completed", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		await h.runTodo({ action: "update", id: 1, status: "completed" });
		await h.emit("agent_start", {});
		expect(getSessionEnabled(h.manager.getSessionId())).toBe(true);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 1/1 · all completed");
	});

	it("keeps child session enablement isolated from the foreground", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "Foreground task" });
		const foreground = h.manager.getSessionId();
		const other = SessionManager.inMemory("/child");
		appendEnabled(other, false);
		const foregroundManager = h.ctx.sessionManager;
		(h.ctx as any).sessionManager = other;
		await h.emit("session_start", { reason: "resume" });
		(h.ctx as any).sessionManager = foregroundManager;

		// The child is off; the foreground stays enabled with its overlay intact.
		expect(getSessionEnabled(other.getSessionId())).toBe(false);
		expect(getSessionEnabled(foreground)).toBe(true);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1");
		expect(getActiveRenderSession()).toBe(foreground);
	});

	it("drops enablement with the session on shutdown", async () => {
		const h = setup();
		await h.enable();
		const sid = h.manager.getSessionId();
		await h.emit("session_shutdown", {});
		expect(getSessionEnabled(sid)).toBe(false);
	});
});

describe("guidance", () => {
	it("authorizes tracking for meaningful milestones, not artificial splitting", () => {
		const h = setup();
		const tool = h.tools.get("todo");
		expect(tool.promptGuidelines).toEqual([
			expect.stringContaining("3+ meaningful steps that have meaningful, verifiable milestones"),
			expect.stringContaining("Do not create or revise todos solely because new instructions arrived"),
			expect.stringContaining("in_progress BEFORE beginning work"),
			expect.stringContaining("Never mark a task completed"),
			expect.stringContaining("blockedBy"),
		]);
		expect(tool.promptSnippet).toBe("Manage a task list to track multi-step progress");
		expect(tool.renderCall({}, identityTheme, undefined)).toBeDefined();
		expect(tool.renderResult({ details: taskDetails([], 1) }, {}, identityTheme, { isError: false })).toBeDefined();
	});
});
