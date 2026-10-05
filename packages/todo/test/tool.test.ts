import { describe, expect, it } from "vitest";
import { SNAPSHOT_ENTRY_TYPE, type TaskDetails } from "../extensions/tasks.js";
import { identityTheme, setup, taskDetails } from "./harness.js";

describe("execution boundary", () => {
	it("throws on invalid mutations, leaves state untouched, and persists no snapshot", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "First" });
		const entriesBefore = h.appendEntry.mock.calls.length;

		await expect(h.execute({ action: "create", subject: "   " })).rejects.toThrow(/subject required/);
		await expect(h.execute({ action: "update" })).rejects.toThrow(/id required/);
		await expect(h.execute({ action: "update", id: 9, status: "completed" })).rejects.toThrow(/#9 not found/);
		await expect(h.execute({ action: "delete" })).rejects.toThrow(/id required/);
		await expect(h.execute({ action: "get", id: 9 })).rejects.toThrow(/#9 not found/);
		await h.runTodo({ action: "update", id: 1, status: "completed" });
		await expect(h.execute({ action: "update", id: 1, status: "in_progress" })).rejects.toThrow(/illegal transition/);

		// Failures persist nothing; the one successful update did.
		expect(h.appendEntry.mock.calls.length).toBe(entriesBefore + 1);

		const details = await h.execute({ action: "list" });
		expect((details.details as TaskDetails).tasks).toHaveLength(1);
	});

	it("persists a snapshot at execution time for direct calls and replays it", async () => {
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "Direct" });

		const snapshotCalls = h.appendEntry.mock.calls.filter(([type]: [string]) => type === SNAPSHOT_ENTRY_TYPE);
		expect(snapshotCalls).toHaveLength(1);
		const [entryType, data] = snapshotCalls[0];
		expect(entryType).toBe(SNAPSHOT_ENTRY_TYPE);
		expect((data as TaskDetails).tasks).toEqual([{ id: 1, subject: "Direct", status: "pending" }]);

		// Replay reads the snapshot entry alone; no toolResult is needed.
		await h.emit("session_compact", {});
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1");
	});

	it("persists snapshots for indirect nested calls too and replays them", async () => {
		const h = setup();
		await h.enable();
		await h.runTodoIndirect({ action: "create", subject: "Via executeTool" });
		await h.runTodoIndirect({ action: "update", id: 1, status: "in_progress", activeForm: "via executeTool" });

		const snapshotCalls = h.appendEntry.mock.calls.filter(([type]: [string]) => type === SNAPSHOT_ENTRY_TYPE);
		expect(snapshotCalls).toHaveLength(2);
		await h.emit("session_tree", {});
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/1 · via executeTool");
	});

	it("keeps nested mutations when a stale direct result is recorded later", async () => {
		// Mirrors a real parallel batch: nested snapshot executes first, then the
		// direct call's tool result (holding only its own view) is recorded after.
		const h = setup();
		await h.enable();
		await h.runTodo({ action: "create", subject: "Direct" });
		await h.runTodoIndirect({ action: "create", subject: "Nested" });
		// Late-recorded direct tool result: only the direct call's view.
		h.appendTodoResult(taskDetails([{ id: 1, subject: "Direct", status: "pending" }], 2));

		await h.emit("session_tree", {});
		const tasks = h.manager
			.getBranch()
			.filter((e: any) => e.type === "custom" && e.customType === SNAPSHOT_ENTRY_TYPE)
			.map((e: any) => (e.data as TaskDetails).tasks.map((t) => t.subject))
			.at(-1);
		expect(tasks).toEqual(["Direct", "Nested"]);
		expect(h.renderWidget(80)[0]).toBe("▸ Todos 0/2");
	});

	it("never replays toolResult snapshots — only execution-time entries", async () => {
		const h = setup();
		h.appendTodoResult(taskDetails([{ id: 1, subject: "Stale", status: "in_progress", activeForm: "stale" }], 2));
		await h.start();
		// The branch holds a todo toolResult, but replay ignores it entirely.
		expect(h.setWidget).not.toHaveBeenCalled();
	});
});

describe("registered renderResult", () => {
	it("renders failures via context.isError, not result.isError", () => {
		const h = setup();
		const render = h.tools.get("todo").renderResult(
			{ content: [{ type: "text", text: "#9 not found" }], details: undefined },
			{ expanded: false, isPartial: false },
			identityTheme,
			{ isError: true },
		) as unknown as { render(width: number): string[] };
		expect(render.render(80).join("").trimEnd()).toBe("✗ #9 not found");
	});

	it("renders successes from details when context.isError is false", () => {
		const h = setup();
		const render = h.tools.get("todo").renderResult(
			{
				content: [{ type: "text", text: "Created #1: First (pending)" }],
				details: taskDetails([{ id: 1, subject: "First", status: "pending" }], 2),
			},
			{ expanded: false, isPartial: false },
			identityTheme,
			{ isError: false },
		) as unknown as { render(width: number): string[] };
		expect(render.render(80).join("").trimEnd()).toBe("○ pending");
	});
});
