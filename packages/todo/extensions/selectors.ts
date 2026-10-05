/*
 * Pure selectors over TaskState. Derived views (visibility, grouping,
 * counts, overlay layout) so reducers and renderers stay independent.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 */
import type { Task, TaskState } from "./tasks.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}

export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

/** Counts for the overlay heading (`Todos (n/m)`) and the `/todos` report. */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/** Whether any visible task carries a blockedBy reference (gates `#id` prefixes). */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/** Resolve a task's subject by id; caller falls back to `#id` when unknown. */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

/** Whether any visible task is pending or in_progress. */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}

/**
 * Overlay layout: keep all tasks when they fit the budget, else drop completed
 * rows first and truncate the non-completed tail, reserving one slot for the
 * overflow summary row.
 */
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}
	const innerBudget = budget - 1;
	const nonCompleted = all.filter((t) => t.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;
	if (nonCompleted.length <= innerBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const t of all) {
			if (kept.size >= innerBudget) break;
			if (t.status === "completed") kept.add(t);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
	}
	return {
		visible: nonCompleted.slice(0, innerBudget),
		hiddenCompleted: totalCompleted,
		truncatedTail: nonCompleted.length - innerBudget,
	};
}
