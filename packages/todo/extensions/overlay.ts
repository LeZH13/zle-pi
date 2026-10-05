/*
 * Persistent widget above the editor.
 *
 * Collapsed (default): one width-safe line — `▸ Todos 1/3 · implementing
 * controls` — with the activity label from the in-progress task's
 * activeForm. Expanded: heading plus per-task rows within a fixed row
 * budget, dropping completed rows first. Task updates never change the
 * collapse state; the widget hides when there are no visible tasks or when
 * tracking is disabled, and an all-completed summary stays until cleared.
 *
 * Reads live state via getRenderState() (the foreground slot) at render
 * time. Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT;
 * modified by zle13: collapse state and enablement move to /todos-controlled
 * preferences, completed tasks stay visible, i18n removed.
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_LABEL, formatOverlayTaskLine, sanitizeTerminalText } from "./format.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./selectors.js";
import { getRenderState } from "./store.js";
import type { TaskState } from "./tasks.js";

export const WIDGET_KEY = "zle-todos";

/** Content-row budget (heading included); the widget renders one spacer row more. */
export const DEFAULT_MAX_WIDGET_LINES = 12;

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: TUI | undefined;

	constructor(
		private collapsed: boolean,
		private enabled: boolean = true,
	) {}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent; on
		// identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.update();
	}

	setCollapsed(collapsed: boolean): void {
		if (collapsed === this.collapsed) return;
		this.collapsed = collapsed;
		// Forced full redraw on the collapsed↔expanded height step.
		this.tui?.requestRender(true);
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	/** Show the widget when tracking is on and tasks exist; hide otherwise. */
	update(): void {
		if (!this.uiCtx || !this.enabled || visibleCount() === 0) {
			this.hide();
			return;
		}
		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	isRegistered(): boolean {
		return this.registered;
	}

	private hide(): void {
		if (this.uiCtx && this.registered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const state = getRenderState();
		const visible: TaskState = {
			tasks: state.tasks.filter((t) => t.status !== "deleted"),
			nextId: state.nextId,
		};
		const lines = this.collapsed ? [this.collapsedLine(visible, theme, width)] : this.expandedLines(visible, theme, width);
		return withTrailingSpacer(lines);
	}

	/** The collapsed one-line summary: `▸ Todos 1/3 · <activity>`. */
	private collapsedLine(state: TaskState, theme: Theme, width: number): string {
		const counts = selectTodoCounts(state);
		const color = counts.completed === counts.total ? "success" : "accent";
		let text = `${theme.fg(color, "▸")} ${theme.fg(color, `Todos ${counts.completed}/${counts.total}`)}`;
		const active = state.tasks.find((t) => t.status === "in_progress");
		if (active) {
			// Model-controlled text is sanitized before styling/truncation so it
			// cannot inject terminal escapes or line breaks into the widget.
			text += ` ${theme.fg("muted", `· ${sanitizeTerminalText(active.activeForm ?? active.subject)}`)}`;
		} else if (counts.completed === counts.total) {
			text += ` ${theme.fg("muted", "· all completed")}`;
		}
		return truncateToWidth(text, width, "…");
	}

	private expandedLines(state: TaskState, theme: Theme, width: number): string[] {
		const counts = selectTodoCounts(state);
		const color = counts.completed === counts.total ? "success" : selectHasActive(state) ? "accent" : "dim";
		const lines = [
			truncateToWidth(`${theme.fg(color, "▾")} ${theme.fg(color, `Todos (${counts.completed}/${counts.total})`)}`, width),
		];
		const bodyBudget = DEFAULT_MAX_WIDGET_LINES - 1;
		const layout = selectOverlayLayout(state, bodyBudget);
		const showIds = selectShowTaskIds(state);
		for (const task of layout.visible) {
			lines.push(truncateToWidth(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`, width, "…"));
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		const parts: string[] = [];
		if (layout.hiddenCompleted > 0) parts.push(`${layout.hiddenCompleted} ${STATUS_LABEL.completed}`);
		if (layout.truncatedTail > 0) parts.push(`${layout.truncatedTail} ${STATUS_LABEL.pending}`);
		lines.push(
			truncateToWidth(
				`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${layout.hiddenCompleted + layout.truncatedTail} more (${parts.join(", ")})`)}`,
				width,
				"…",
			),
		);
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}

function visibleCount(): number {
	return getRenderState().tasks.filter((t) => t.status !== "deleted").length;
}

/**
 * Append a trailing blank line so the overlay isn't flush against the editor
 * box; Pi adds a leading spacer above the widget but none below.
 */
function withTrailingSpacer(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	lines.push("");
	return lines;
}
