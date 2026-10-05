import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodoOverlay, WIDGET_KEY } from "../extensions/overlay.js";
import { __resetState, commitState, setActiveRenderSession } from "../extensions/store.js";
import type { Task, TaskState } from "../extensions/tasks.js";
import { identityTheme } from "./harness.js";

function task(partial: Partial<Task> & { id: number }): Task {
	return { subject: `Task ${partial.id}`, status: "pending", ...partial };
}

function stateOf(tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

function uiHarness() {
	const setWidget = vi.fn();
	const uiCtx = { setWidget, getToolsExpanded: () => false };
	return { setWidget, uiCtx: uiCtx as never };
}

function render(setWidget: ReturnType<typeof vi.fn>, width = 80): string[] {
	const call = setWidget.mock.calls.findLast(([, factory]) => typeof factory === "function");
	if (!call) return [];
	const component = (call[1] as (tui: any, theme: unknown) => any)({ requestRender: vi.fn() }, identityTheme);
	return component.render(width) as string[];
}

/** Foreground slot + overlay bound to the harness UI (collapsed by default). */
function bind(tasks: Task[], collapsed = true) {
	__resetState();
	setActiveRenderSession("foreground");
	commitState("foreground", stateOf(tasks));
	const { setWidget, uiCtx } = uiHarness();
	const overlay = new TodoOverlay(collapsed);
	overlay.setUICtx(uiCtx);
	overlay.update();
	return { setWidget, overlay };
}

beforeEach(() => {
	__resetState();
});

describe("collapsed view", () => {
	it("renders one content line with the in-progress activity from activeForm", () => {
		const { setWidget } = bind([
			task({ id: 1, status: "completed" }),
			task({ id: 2, status: "in_progress", activeForm: "implementing controls" }),
			task({ id: 3 }),
		]);
		expect(render(setWidget)).toEqual(["▸ Todos 1/3 · implementing controls", ""]);
	});

	it("falls back to the subject when no activeForm is set", () => {
		const { setWidget } = bind([task({ id: 1, status: "in_progress" })]);
		expect(render(setWidget)[0]).toBe("▸ Todos 0/1 · Task 1");
	});

	it("sanitizes terminal injection from activeForm and subject", () => {
		// activeForm is the activity source; subject is the fallback source.
		const { setWidget } = bind([
			task({
				id: 1,
				status: "in_progress",
				activeForm: "writing\nnext\u001b]52;c;QUJD\u0007 tests",
			}),
		]);
		let line = render(setWidget)[0];
		expect(line).not.toContain("\u001b");
		expect(line).not.toContain("\n");
		expect(line).toContain("writing next tests");

		const fallback = bind([task({ id: 1, status: "in_progress", subject: "Bad\u001b[31mSubject\u001b[0m" })]);
		line = render(fallback.setWidget)[0];
		expect(line).not.toContain("\u001b");
		expect(line).toContain("BadSubject");
	});

	it("is width-safe: truncates to the terminal width", () => {
		const { setWidget } = bind([
			task({ id: 1, status: "in_progress", activeForm: "a very long activity label that will not fit" }),
		]);
		const lines = render(setWidget, 24);
		expect(lines).toHaveLength(2);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(24);
		expect(lines[0]).toContain("…");
	});

	it("omits the activity part when nothing is in progress", () => {
		const { setWidget } = bind([task({ id: 1 })]);
		expect(render(setWidget)[0]).toBe("▸ Todos 0/1");
	});

	it("marks an all-completed list and keeps it visible until cleared", () => {
		const { setWidget } = bind([task({ id: 1, status: "completed" }), task({ id: 2, status: "completed" })]);
		expect(render(setWidget)[0]).toBe("▸ Todos 2/2 · all completed");
	});
});

describe("expanded view", () => {
	it("renders the heading and one row per task with status glyphs", () => {
		const { setWidget } = bind(
			[
				task({ id: 1, status: "completed" }),
				task({ id: 2, status: "in_progress", activeForm: "writing tests" }),
				task({ id: 3, blockedBy: [2] }),
			],
			false,
		);
		const lines = render(setWidget);
		expect(lines[0]).toBe("▾ Todos (1/3)");
		expect(lines[1]).toBe("├─ ✓ #1 Task 1");
		expect(lines[2]).toBe("├─ ◐ #2 Task 2 (writing tests)");
		expect(lines[3]).toBe("└─ ○ #3 Task 3 ⛓ #2");
		expect(lines[4]).toBe("");
	});

	it("summarizes overflow with completed dropped first", () => {
		const { setWidget } = bind(
			[
				task({ id: 1, status: "completed" }),
				task({ id: 2, status: "completed" }),
				...Array.from({ length: 15 }, (_, i) => task({ id: i + 3 })),
			],
			false,
		);
		const lines = render(setWidget);
		// 12 content rows: heading + 10 body rows + summary (spacer excluded).
		expect(lines).toHaveLength(13);
		expect(lines.at(-2)).toBe("└─ +7 more (2 completed, 5 pending)");
	});
});

describe("enablement and collapse control", () => {
	it("hides the widget when tracking is disabled and shows it again on enable", () => {
		const { setWidget, overlay } = bind([task({ id: 1 })]);
		expect(overlay.isRegistered()).toBe(true);

		overlay.setEnabled(false);
		expect(setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);

		overlay.setEnabled(true);
		expect(render(setWidget)[0]).toBe("▸ Todos 0/1");
	});

	it("never expands on task updates", () => {
		const { setWidget, overlay } = bind([task({ id: 1 })], true);
		commitState("foreground", stateOf([task({ id: 1 }), task({ id: 2 })]));
		overlay.update();
		expect(overlay.isCollapsed()).toBe(true);
		expect(render(setWidget)[0]).toBe("▸ Todos 0/2");
	});

	it("hides when the last task is deleted and returns on a fresh task", () => {
		const { setWidget, overlay } = bind([task({ id: 1 })]);
		commitState("foreground", { tasks: [task({ id: 1, status: "deleted" })], nextId: 2 });
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);

		commitState("foreground", stateOf([task({ id: 1, status: "deleted" }), task({ id: 2 })]));
		overlay.update();
		expect(overlay.isRegistered()).toBe(true);
	});

	it("forces a full redraw on the collapsed/expanded step", () => {
		__resetState();
		setActiveRenderSession("foreground");
		commitState("foreground", stateOf([task({ id: 1 })]));
		const { setWidget, uiCtx } = uiHarness();
		const overlay = new TodoOverlay(false);
		overlay.setUICtx(uiCtx);
		overlay.update();
		const tui = { requestRender: vi.fn() };
		(setWidget.mock.calls.at(-1)![1] as (tui: any, theme: unknown) => any)(tui, identityTheme);
		overlay.setCollapsed(true);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});
