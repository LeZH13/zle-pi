import { describe, expect, it } from "vitest";
import { buildToolResult, formatContent } from "../extensions/envelope.js";
import { sanitizeTerminalText } from "../extensions/format.js";
import {
	EMPTY_STATE,
	applyTaskMutation,
	detectCycle,
	isTransitionValid,
	type Task,
	type TaskState,
} from "../extensions/tasks.js";
import { selectOverlayLayout, selectTodoCounts, selectVisibleTasks } from "../extensions/selectors.js";
import { isTaskDetails, replayFromBranch } from "../extensions/store.js";
import { taskDetails, todoResultMessage } from "./harness.js";

function run(state: TaskState, action: Parameters<typeof applyTaskMutation>[1], params: any) {
	return applyTaskMutation(state, action, params);
}

function stateOf(tasks: Task[], nextId = tasks.length + 1): TaskState {
	return { tasks, nextId };
}

describe("task reducer", () => {
	it("rejects create without a subject and otherwise appends pending tasks", () => {
		const noSubject = run(EMPTY_STATE, "create", {});
		expect(noSubject.op).toMatchObject({ kind: "error", message: "subject required for create" });
		expect(noSubject.state).toEqual(EMPTY_STATE);

		const created = run(EMPTY_STATE, "create", { subject: "Research existing tool" });
		expect(created.op).toEqual({ kind: "create", taskId: 1 });
		expect(created.state.tasks[0]).toMatchObject({ id: 1, subject: "Research existing tool", status: "pending" });
		expect(created.state.nextId).toBe(2);
	});

	it("validates status transitions on update", () => {
		const state = stateOf([{ id: 1, subject: "A", status: "completed" }]);
		expect(run(state, "update", { id: 1, status: "in_progress" }).op).toMatchObject({
			kind: "error",
			message: "illegal transition completed → in_progress",
		});
		expect(run(state, "update", { id: 1, status: "deleted" }).op).toEqual({
			kind: "update",
			id: 1,
			fromStatus: "completed",
			toStatus: "deleted",
			changed: true,
		});
		expect(isTransitionValid("pending", "in_progress")).toBe(true);
		expect(isTransitionValid("deleted", "pending")).toBe(false);
	});

	it("reports no-change updates distinctly and rejects empty updates", () => {
		const state = stateOf([{ id: 1, subject: "A", status: "in_progress", activeForm: "working" }]);
		const noop = run(state, "update", { id: 1, status: "in_progress", activeForm: "working" });
		expect(noop.op).toMatchObject({ kind: "update", changed: false });
		expect(formatContent(noop.op, noop.state)).toBe(
			"No change: #1 already matches the requested values (status: in_progress)",
		);
		const empty = run(state, "update", { id: 1 });
		expect(empty.op).toMatchObject({ kind: "error" });
	});

	it("merges metadata and deletes keys via null", () => {
		const state = stateOf([{ id: 1, subject: "A", status: "pending", metadata: { keep: 1, drop: 2 } }]);
		const result = run(state, "update", { id: 1, metadata: { keep: 1, drop: null, add: "x" } });
		expect(result.state.tasks[0].metadata).toEqual({ keep: 1, add: "x" });
		const cleared = run(state, "update", { id: 1, metadata: { drop: null, keep: null } });
		expect(cleared.state.tasks[0].metadata).toBeUndefined();
	});

	it("validates blockedBy: dangling ids, deleted deps, self-blocks, and cycles", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "pending" },
			{ id: 2, subject: "B", status: "deleted" },
		]);
		expect(run(state, "create", { subject: "C", blockedBy: [9] }).op).toMatchObject({
			message: "blockedBy: #9 not found",
		});
		expect(run(state, "create", { subject: "C", blockedBy: [2] }).op).toMatchObject({
			message: "blockedBy: #2 is deleted",
		});
		expect(run(state, "update", { id: 1, addBlockedBy: [1] }).op).toMatchObject({
			message: "cannot block #1 on itself",
		});
		expect(run(state, "update", { id: 1, addBlockedBy: [9] }).op).toMatchObject({
			message: "addBlockedBy: #9 not found",
		});

		const cyclic = stateOf([
			{ id: 1, subject: "A", status: "pending", blockedBy: [2] },
			{ id: 2, subject: "B", status: "pending" },
		]);
		expect(run(cyclic, "update", { id: 2, addBlockedBy: [1] }).op).toMatchObject({
			message: "addBlockedBy would create a cycle in the blockedBy graph",
		});
		expect(detectCycle(cyclic.tasks, 2, [1])).toBe(true);
		expect(detectCycle(cyclic.tasks, 1, [])).toBe(false);
		expect(detectCycle(cyclic.tasks, 2, [])).toBe(false);
	});

	it("tombstones deletes and keeps ids stable on clear", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "completed" },
			{ id: 2, subject: "B", status: "pending" },
		]);
		const deleted = run(state, "delete", { id: 1 });
		expect(deleted.state.tasks[0]).toMatchObject({ id: 1, status: "deleted" });
		expect(run(deleted.state, "delete", { id: 1 }).op).toMatchObject({ message: "#1 is already deleted" });

		const cleared = run(deleted.state, "clear", {});
		expect(cleared.state).toEqual({ tasks: [], nextId: 1 });
		expect(cleared.op).toEqual({ kind: "clear", count: 2 });
	});

	it("list filters tombstones by default and get resolves reverse dependencies", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "deleted" },
			{ id: 2, subject: "B", status: "pending", blockedBy: [1] },
		]);
		const listed = run(state, "list", {});
		expect(listed.op).toEqual({ kind: "list", includeDeleted: false, statusFilter: undefined });
		expect(formatContent(listed.op, state)).toBe("[pending] #2 B ⛓ #1");

		const filtered = run(state, "list", { status: "pending", includeDeleted: true });
		expect(formatContent(filtered.op, state).split("\n")).toHaveLength(1);

		const got = run(state, "get", { id: 2 });
		expect(formatContent(got.op, state)).toContain("  blockedBy: #1");
	});
});

describe("tool envelope", () => {
	it("carries the post-mutation snapshot in details for replay", () => {
		const result = buildToolResult(
			"create",
			{ subject: "A" },
			{ tasks: [{ id: 1, subject: "A", status: "pending" }], nextId: 2 },
			{ kind: "create", taskId: 1 },
		);
		expect(result.content[0]).toEqual({ type: "text", text: "Created #1: A (pending)" });
		expect(result.details).toMatchObject({ action: "create", tasks: [{ id: 1 }], nextId: 2 });
	});

	it("renders multi-line get output with blocks and owner", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "pending", owner: "agent" },
			{ id: 2, subject: "B", status: "pending", blockedBy: [1] },
		]);
		const op = run(state, "get", { id: 1 }).op;
		expect(formatContent(op, state).split("\n")).toEqual([
			"#1 [pending] A",
			"  blocks: #2",
			"  owner: agent",
		]);
	});
});

describe("sanitizeTerminalText", () => {
	it("strips escape sequences, control characters, and bidi controls", () => {
		expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
		expect(sanitizeTerminalText("\u009b1m")).toBe("");
		expect(sanitizeTerminalText("\u001b]0;title\u0007after")).toBe("after");
		expect(sanitizeTerminalText("a\nb\tc\u0000d")).toBe("a b cd");
		expect(sanitizeTerminalText("a\u202ea\u200fb")).toBe("aab");
		expect(sanitizeTerminalText("\u001bA")).toBe("");
	});
});

describe("replay", () => {
	it("isTaskDetails rejects corrupt envelopes", () => {
		expect(isTaskDetails(undefined)).toBe(false);
		expect(isTaskDetails({ tasks: "no" })).toBe(false);
		expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(true);
	});

	it("replays last-write-wins from the branch and ignores other tools", () => {
		const manager = {
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "hi" } },
					{
						type: "message",
						message: todoResultMessage(taskDetails([{ id: 1, subject: "A", status: "pending" }], 2)),
					},
					{ type: "custom", customType: "other", data: {} },
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "todo",
							content: [],
							isError: false,
							details: { broken: true },
						},
					},
					{
						type: "message",
						message: todoResultMessage(taskDetails([], 1, "clear")),
					},
				],
			},
		};
		const replayed = replayFromBranch(manager as never);
		expect(replayed).toEqual({ tasks: [], nextId: 1 });
	});

	it("returns an empty state for a branch without todo results", () => {
		expect(replayFromBranch({ sessionManager: { getBranch: () => [] } })).toEqual(EMPTY_STATE);
	});
});

describe("selectors", () => {
	it("counts only visible tasks", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "deleted" },
			{ id: 2, subject: "B", status: "in_progress" },
			{ id: 3, subject: "C", status: "completed" },
			{ id: 4, subject: "D", status: "pending" },
		]);
		expect(selectVisibleTasks(state)).toHaveLength(3);
		expect(selectTodoCounts(state)).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
	});

	it("drops completed rows first, then truncates the tail", () => {
		const state = stateOf([
			{ id: 1, subject: "A", status: "completed" },
			{ id: 2, subject: "B", status: "pending" },
			{ id: 3, subject: "C", status: "pending" },
			{ id: 4, subject: "D", status: "pending" },
			{ id: 5, subject: "E", status: "pending" },
		]);
		// Budget 4 = heading + 3 body rows (1 reserved for the summary row).
		const layout = selectOverlayLayout(state, 4);
		expect(layout.visible.map((t) => t.id)).toEqual([2, 3, 4]);
		expect(layout).toMatchObject({ hiddenCompleted: 1, truncatedTail: 1 });

		// Completed rows are dropped before non-completed ones.
		const mostlyDone = stateOf([
			{ id: 1, subject: "A", status: "completed" },
			{ id: 2, subject: "B", status: "completed" },
			{ id: 3, subject: "C", status: "completed" },
			{ id: 4, subject: "D", status: "pending" },
		]);
		const keepWork = selectOverlayLayout(mostlyDone, 3);
		expect(keepWork.visible.map((t) => t.id)).toEqual([1, 4]);
		expect(keepWork).toMatchObject({ hiddenCompleted: 2, truncatedTail: 0 });
	});
});
