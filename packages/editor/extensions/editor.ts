import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CommandCopyMenu } from "../lib/command-copy.js";
import { collectShellCommands, type ShellCommand } from "../lib/shell-commands.js";
import { WorkingBorderTrail } from "../lib/working-border.js";

export type ModalMode = "normal" | "insert";

/** DECSCUSR terminal cursor shape sequences. */
export const CURSOR_SHAPE_RESET = "\x1b[0 q";
export const CURSOR_SHAPE_BLOCK = "\x1b[2 q";
export const CURSOR_SHAPE_BEAM = "\x1b[6 q";
export const CURSOR_RESET_SEQUENCE = `\x1b[?25h${CURSOR_SHAPE_RESET}`;

type Motion = "h" | "j" | "k" | "l" | "0" | "^" | "$" | "w" | "b" | "e" | "I" | "A" | "a";
type Edit = "x" | "s" | "dw" | "cw" | "dd" | "cc" | "d$" | "c$" | "o" | "O";

/** An editor-local motion or edit; no synthetic editor keybindings are replayed. */
export interface NormalKeyAction {
	motion?: Motion;
	edit?: Edit;
	insert?: boolean;
}

/** Only advertise mappings whose meaning we implement for the prompt editor. */
export const NORMAL_KEYS: Record<string, NormalKeyAction> = {
	h: { motion: "h" }, j: { motion: "j" }, k: { motion: "k" }, l: { motion: "l" },
	"0": { motion: "0" }, "^": { motion: "^" }, $: { motion: "$" },
	w: { motion: "w" }, b: { motion: "b" }, e: { motion: "e" },
	x: { edit: "x" }, s: { edit: "s", insert: true },
	D: { edit: "d$" }, C: { edit: "c$", insert: true },
	i: { insert: true }, a: { motion: "a", insert: true },
	I: { motion: "I", insert: true }, A: { motion: "A", insert: true },
	o: { edit: "o", insert: true }, O: { edit: "O", insert: true },
};

export const NORMAL_COMBOS: Record<string, NormalKeyAction> = {
	dd: { edit: "dd" }, dw: { edit: "dw" }, "d$": { edit: "d$" },
	cc: { edit: "cc", insert: true }, cw: { edit: "cw", insert: true },
	"c$": { edit: "c$", insert: true },
};

/** Keys that begin a two-key combination; the next printable key completes it. */
export const COMBO_LEADERS = new Set(Object.keys(NORMAL_COMBOS).map((combo) => combo[0]!));

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Visible columns of native border preserved before the badge yields. */
export const BADGE_MIN_KEEP = 8;

/** Minimum truncated name width worth displaying (below this, render native). */
export const BADGE_MIN_NAME = 2;

/** Normalize a session name for display. Returns undefined when there is no explicit name. */
export function sanitizeSessionName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
	return cleaned ? cleaned : undefined;
}

/** Trailing padding after the badge so the name never touches the right edge. */
const BADGE_TRAILING = " ──";

/**
 * Compose the session-name badge over an already-rendered native top border.
 * Badge sits on the right (`──── name ──`), one leading space, two trailing
 * dashes, border-colored.
 * Unnamed, narrow, or overlong inputs fall back to the native border untouched,
 * so working status and scroll indicators always keep priority.
 */
export function renderTopBorderWithBadge(
	nativeBorder: string,
	rawName: string | undefined,
	width: number,
	borderColor: (text: string) => string,
): string {
	const name = sanitizeSessionName(rawName);
	if (!name || width <= 0) return nativeBorder;
	const maxNameWidth = width - 1 - visibleWidth(BADGE_TRAILING) - BADGE_MIN_KEEP;
	if (maxNameWidth < BADGE_MIN_NAME) return nativeBorder;
	const clipped = truncateToWidth(name, maxNameWidth, "…");
	const tag = ` ${clipped}${BADGE_TRAILING}`;
	const keep = width - visibleWidth(tag);
	if (keep < BADGE_MIN_KEEP) return nativeBorder;
	return sliceByColumn(nativeBorder, 0, keep) + borderColor(tag);
}

/**
 * Strip software inverse-video highlighting from the cursor grapheme in insert mode,
 * allowing the terminal's hardware vertical line cursor to show cleanly without
 * an inverted background block.
 */
export function stripCursorInverse(line: string): string {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex === -1) return line;
	const afterMarker = line.slice(markerIndex + CURSOR_MARKER.length);
	if (!afterMarker.startsWith("\x1b[7m")) return line;
	const resetIndex = afterMarker.indexOf("\x1b[0m");
	if (resetIndex === -1) return line;
	const inner = afterMarker.slice("\x1b[7m".length, resetIndex);
	const rest = afterMarker.slice(resetIndex + "\x1b[0m".length);
	return line.slice(0, markerIndex) + CURSOR_MARKER + inner + rest;
}

/**
 * Compose the vim mode indicator on the bottom border, left-aligned (`── NORMAL ───`),
 * with pending keys surfaced vim-style (`── NORMAL 3d ───`).
 * If width is insufficient or would collide with a scroll indicator, falls back to native.
 */
export function renderBottomBorderWithMode(
	nativeBorder: string,
	mode: ModalMode,
	pendingLeader: string | undefined,
	pendingCount: number | undefined,
	width: number,
	borderColor: (text: string) => string,
): string {
	if (width <= 0) return nativeBorder;
	const core = mode === "normal" ? "NORMAL" : "INSERT";
	const pending =
		(pendingCount !== undefined ? String(pendingCount) : "") +
		(pendingLeader ?? "");
	const modeText = `${core}${pending ? ` ${pending}` : ""}`;
	const tag = `── ${modeText} ──`;
	const tagWidth = visibleWidth(tag);
	if (width < tagWidth + 2) return nativeBorder;

	// Preserve scroll indicators (e.g. `↓ 5 more`)
	if (nativeBorder.includes("↓")) {
		const scrollIndex = nativeBorder.indexOf("↓");
		const scrollCol = visibleWidth(sliceByColumn(nativeBorder, 0, scrollIndex));
		if (scrollCol < tagWidth + 2) return nativeBorder;
	}

	const rest = sliceByColumn(nativeBorder, tagWidth, width - tagWidth);
	const styledMode = mode === "normal" ? `\x1b[1m${modeText}\x1b[22m` : modeText;
	const styledTag = `── ${styledMode} ──`;
	return borderColor(styledTag) + rest;
}

/** Private editor fields mirrored for vim undo/redo (same coupling pi-vim accepts). */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	pastes: Map<number, string>;
	pasteCounter: number;
	lastAction: string | null;
	preferredVisualCol: number | null;
	undoStack: { push(snapshot: unknown): void; length: number };
	undo(): void;
	pushUndoSnapshot(): void;
	setCursorCol(col: number): void;
	segment(text: string, mode: "grapheme"): Iterable<{ segment: string; index: number }>;
	exitHistoryBrowsing(): void;
	cancelAutocomplete(): void;
	onChange: ((text: string) => void) | undefined;
}

/** Snapshot shape used by the editor's undoStack ({@link EditorInternals}). */
interface UndoSnapshot {
	state: EditorInternals["state"];
	pastes: Map<number, string>;
	pasteCounter: number;
}

type WordClass = "space" | "word" | "punctuation";
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
const wordClass = (text: string): WordClass =>
	/^\s/u.test(text) ? "space" : /^[\p{L}\p{N}\p{M}_]/u.test(text) ? "word" : "punctuation";

/** Vim's small-word boundaries: keyword runs, punctuation runs, and whitespace. */
function wordBoundary(
	text: string, from: number, direction: "w" | "b" | "e",
	segment: (text: string) => { segment: string; index: number }[] = graphemes,
): number {
	const parts = segment(text);
	if (direction === "b") {
		let i = parts.findLastIndex((part) => part.index < from);
		while (i >= 0 && wordClass(parts[i]!.segment) === "space") i--;
		if (i < 0) return 0;
		const kind = wordClass(parts[i]!.segment);
		while (i > 0 && wordClass(parts[i - 1]!.segment) === kind) i--;
		return parts[i]!.index;
	}
	let i = parts.findIndex((part) => part.index >= from);
	if (i < 0) return text.length;
	if (direction === "e") {
		// Repeating e from a word end should reach the next word.
		if (i + 1 < parts.length && wordClass(parts[i]!.segment) !== "space" &&
			wordClass(parts[i + 1]!.segment) !== wordClass(parts[i]!.segment)) i++;
		while (i < parts.length && wordClass(parts[i]!.segment) === "space") i++;
		if (i >= parts.length) return parts.at(-1)?.index ?? 0;
		const kind = wordClass(parts[i]!.segment);
		while (i + 1 < parts.length && wordClass(parts[i + 1]!.segment) === kind) i++;
		return parts[i]!.index;
	}
	const kind = wordClass(parts[i]!.segment);
	if (kind !== "space") while (i < parts.length && wordClass(parts[i]!.segment) === kind) i++;
	while (i < parts.length && wordClass(parts[i]!.segment) === "space") i++;
	return parts[i]?.index ?? text.length;
}

export class NamedSessionEditor extends CustomEditor {
	private workingBorder: WorkingBorderTrail;
	private borderStatus: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
	/** Build an inline menu without changing editor focus. */
	onCopyCommand: (() => CommandCopyMenu) | undefined;
	onCopyStatus: ((message: string, type: "info" | "error") => void) | undefined;
	private copyPrefixPending = false;
	private copyPrefixEditing = false;
	private copyPasteActive = false;
	private copyMode = false;
	private copyMenu: CommandCopyMenu | undefined;
	private copyMenuVisible = false;
	private copyRevision = 0;
	private copying = false;
	private disposed = false;
	private mode: ModalMode = "insert";
	/** Leader of a two-key combination awaiting its second key (e.g. `d` in `dd`). */
	private pendingLeader: string | undefined;
	/** Accumulated repeat count awaiting a motion or operator (e.g. `3` in `3w`). */
	private pendingCount: number | undefined;
	/** States for vim ctrl+r, filled by vimUndo and drained by vimRedo. */
	private redoStack: UndoSnapshot[] = [];
	/** Vim's sticky column for repeated j/k across shorter lines. */
	private desiredColumn: number | undefined;
	/** Discard bracketed paste data while in normal mode, even across input chunks. */
	private ignoringPaste = false;
	/** The editor's own snapshot push, used for direct edits. */
	private basePushUndo: () => void;
	/** Last cursor shape escape sequence written to the terminal. */
	private lastShapeWritten: string | undefined;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		private readonly copyKeybindings: ConstructorParameters<typeof CustomEditor>[2],
		private getSessionName: () => string | undefined,
		getTheme: () => Theme,
		isCurrentEditor: () => boolean,
	) {
		super(tui, theme, copyKeybindings, { embedWorkingStatus: true });
		this.workingBorder = new WorkingBorderTrail(tui, getTheme, isCurrentEditor);
		const internals = this as unknown as EditorInternals;
		const base = internals.pushUndoSnapshot.bind(this);
		this.basePushUndo = base;
		// Native insert edits also invalidate vim redo.
		internals.pushUndoSnapshot = () => {
			this.redoStack = [];
			base();
		};
		this.tui?.setShowHardwareCursor?.(true);
		this.syncHardwareCursor(true);
	}

	get vimMode(): ModalMode {
		return this.mode;
	}

	private setMode(mode: ModalMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		if (mode === "normal") {
			this.closeCopyMode();
			this.copyPrefixEditing = false;
		}
		this.syncHardwareCursor(true);
	}

	private syncHardwareCursor(force = false): void {
		if (this.tui?.getShowHardwareCursor?.() === false) {
			this.tui?.setShowHardwareCursor?.(true);
			force = true;
		}
		const shape = this.mode === "normal" ? CURSOR_SHAPE_BLOCK : CURSOR_SHAPE_BEAM;
		if (!force && this.lastShapeWritten === shape) return;
		this.lastShapeWritten = shape;
		this.tui?.terminal?.write?.(shape);
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(indicator);
		this.borderStatus = indicator;
		this.workingBorder.setActive(indicator !== undefined);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.workingBorder.dispose();
		this.borderStatus = undefined;
		this.closeCopyMode();
		this.lastShapeWritten = undefined;
		if (this.tui?.terminal?.write) {
			this.tui.terminal.write(CURSOR_RESET_SEQUENCE);
		} else if (process.stdout?.write) {
			process.stdout.write(CURSOR_RESET_SEQUENCE);
		}
	}

	private parts(text: string): { segment: string; index: number }[] {
		return [...(this as unknown as EditorInternals).segment(text, "grapheme")];
	}

	private cursorOffset(): number {
		const { lines, cursorLine, cursorCol } = (this as unknown as EditorInternals).state;
		return lines.slice(0, cursorLine).reduce((sum, line) => sum + line.length + 1, 0) + cursorCol;
	}

	private setCursor(offset: number, insert = false): void {
		const internals = this as unknown as EditorInternals;
		const before = this.getText().slice(0, offset);
		const linesBefore = before.split("\n");
		const line = Math.min(linesBefore.length - 1, internals.state.lines.length - 1);
		internals.state.cursorLine = line;
		const text = internals.state.lines[line] ?? "";
		const col = insert ? Math.min(linesBefore.at(-1)!.length, text.length)
			: Math.min(linesBefore.at(-1)!.length, Math.max(0, text.length - 1));
		const inside = this.parts(text).find((part) => part.index < col && col < part.index + part.segment.length);
		internals.setCursorCol(inside?.index ?? col);
		internals.preferredVisualCol = null;
	}

	private move(motion: Motion): void {
		const state = (this as unknown as EditorInternals).state;
		const line = state.lines[state.cursorLine] ?? "";
		const offset = this.cursorOffset();
		if (motion !== "j" && motion !== "k") this.desiredColumn = undefined;
		switch (motion) {
			case "h": this.setCursor(offset - (state.cursorCol > 0 ? 1 : 0)); break;
			case "l": this.setCursor(offset + (this.parts(line).find((part) => part.index > state.cursorCol)?.index ?? state.cursorCol) - state.cursorCol); break;
			case "j": case "k": {
				const column = this.desiredColumn ?? state.cursorCol;
				this.desiredColumn = column;
				const target = Math.max(0, Math.min(state.lines.length - 1, state.cursorLine + (motion === "j" ? 1 : -1)));
				const targetStart = state.lines.slice(0, target).reduce((sum, text) => sum + text.length + 1, 0);
				this.setCursor(targetStart + Math.min(column, Math.max(0, state.lines[target]!.length - 1)));
				break;
			}
			case "0": this.setCursor(offset - state.cursorCol); break;
			case "^": this.setCursor(offset - state.cursorCol + (line.search(/\S/u) < 0 ? 0 : line.search(/\S/u))); break;
			case "$": this.setCursor(offset - state.cursorCol + Math.max(0, line.length - 1)); break;
			case "w": case "b": case "e": this.setCursor(wordBoundary(this.getText(), offset, motion, (text) => this.parts(text))); break;
			case "a": this.setCursor(offset + (state.cursorCol < line.length ? 1 : 0), true); break;
			case "A": this.setCursor(offset - state.cursorCol + line.length, true); break;
			case "I": this.setCursor(offset - state.cursorCol + (line.search(/\S/u) < 0 ? 0 : line.search(/\S/u)), true); break;
		}
	}

	/** Replace a range as one undoable edit, preserving editor change notifications. */
	private replace(start: number, end: number, replacement: string, cursor: number, insert = false): void {
		const internals = this as unknown as EditorInternals;
		const old = this.getText();
		const next = old.slice(0, start) + replacement + old.slice(end);
		if (next === old) return;
		internals.exitHistoryBrowsing();
		internals.cancelAutocomplete();
		this.redoStack = [];
		this.basePushUndo();
		internals.state.lines = next.split("\n");
		// Large paste contents belong to their visible marker, not to a deleted draft.
		for (const id of internals.pastes.keys()) {
			if (!new RegExp(`\\[paste #${id}(?: (?:\\+\\d+ lines|\\d+ chars))?\\]`, "u").test(next)) {
				internals.pastes.delete(id);
			}
		}
		internals.lastAction = null;
		this.desiredColumn = undefined;
		this.setCursor(cursor, insert);
		internals.onChange?.(this.getText());
	}

	private edit(command: Edit, count: number): void {
		const state = (this as unknown as EditorInternals).state;
		const line = state.lines[state.cursorLine] ?? "";
		const offset = this.cursorOffset();
		const start = offset - state.cursorCol;
		const end = start + line.length;
		switch (command) {
			case "x": case "s": {
				const chars = this.parts(line.slice(state.cursorCol));
				const length = chars.slice(0, count).reduce((sum, char) => sum + char.segment.length, 0);
				if (length) this.replace(offset, offset + length, "", offset, command === "s");
				break;
			}
			case "dw": case "cw": {
				let to = offset;
				for (let i = 0; i < count; i++) {
					if (command === "dw") to = wordBoundary(this.getText(), to, "w", (text) => this.parts(text));
					else {
						const text = this.getText();
						const segments = this.parts(text);
						let n = segments.findIndex((part) => part.index >= to);
						if (n < 0) break;
						if (wordClass(segments[n]!.segment) === "space") to = wordBoundary(text, to, "w", (source) => this.parts(source));
						else {
							const kind = wordClass(segments[n]!.segment);
							while (n < segments.length && wordClass(segments[n]!.segment) === kind) n++;
							to = segments[n]?.index ?? text.length;
							if (i + 1 < count) to = wordBoundary(text, to, "w", (source) => this.parts(source));
						}
					}
				}
				this.replace(offset, to, "", offset, command === "cw");
				break;
			}
			case "dd": {
				const last = Math.min(state.lines.length, state.cursorLine + count);
				const through = start + state.lines.slice(state.cursorLine, last).reduce((sum, text) => sum + text.length + 1, 0);
				if (last < state.lines.length) this.replace(start, through, "", start);
				else if (start > 0) this.replace(start - 1, this.getText().length, "", start - 1);
				else this.replace(0, this.getText().length, "", 0);
				break;
			}
			case "cc": {
				const last = Math.min(state.lines.length, state.cursorLine + count);
				const through = start + state.lines.slice(state.cursorLine, last).reduce((sum, text) => sum + text.length + 1, 0) - 1;
				this.replace(start, through, "", start, true);
				break;
			}
			case "d$": case "c$": this.replace(offset, end, "", offset, command === "c$"); break;
			case "o": this.replace(end, end, "\n", end + 1, true); break;
			case "O": this.replace(start, start, "\n", start, true); break;
		}
	}

	/** Apply a normal-mode action, honoring counts on motions and deletions. */
	private applyAction(action: NormalKeyAction): void {
		const count = Math.min(this.pendingCount ?? 1, 999);
		this.pendingCount = undefined;
		this.pendingLeader = undefined;
		if (action.motion) for (let i = 0; i < count; i++) this.move(action.motion);
		if (action.edit) this.edit(action.edit, count);
		if (action.insert) this.setMode("insert");
	}

	/** Vim `u`: snapshot the current state for redo, then run the editor's own undo. */
	private vimUndo(): void {
		const internals = this as unknown as EditorInternals;
		if (internals.undoStack.length === 0) return;
		this.redoStack.push(
			structuredClone({ state: internals.state, pastes: internals.pastes, pasteCounter: internals.pasteCounter }),
		);
		internals.undo();
	}

	/** Vim `ctrl+r`: restore the last undone state, keeping it reachable via undo. */
	private vimRedo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		const internals = this as unknown as EditorInternals;
		// Make the current state reachable through undo again
		internals.undoStack.push({ state: internals.state, pastes: internals.pastes, pasteCounter: internals.pasteCounter });
		Object.assign(internals.state, snapshot.state);
		internals.pastes = snapshot.pastes;
		internals.pasteCounter = snapshot.pasteCounter;
		internals.lastAction = null;
		internals.preferredVisualCol = null;
		internals.onChange?.(this.getText());
	}

	private closeCopyMode(): void {
		this.copyMode = false;
		this.copyMenu = undefined;
		this.copyMenuVisible = false;
		this.copyPrefixPending = false;
		this.copyRevision++;
	}

	private activateCopyMode(): void {
		this.copyMode = true;
		this.copyPrefixEditing = true;
		(this as unknown as EditorInternals).cancelAutocomplete();
		try {
			this.copyMenu = this.onCopyCommand!();
			this.copyMenu.setQuery(this.getExpandedText().slice(2));
			this.copyMenuVisible = true;
		} catch (error) {
			this.onCopyStatus?.(`Command copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		this.tui?.requestRender?.();
	}

	/** Slash-command entry point; callers must leave an existing draft untouched. */
	startCommandCopy(): void {
		if (!this.onCopyCommand || this.getText() !== "") return;
		this.setMode("insert");
		this.setText("$$");
		this.activateCopyMode();
	}

	private async copySelected(command: ShellCommand): Promise<void> {
		if (this.copying) return;
		this.copying = true;
		const revision = this.copyRevision;
		try {
			await copyToClipboard(command.text);
			if (this.disposed || revision !== this.copyRevision) return;
			this.setText("");
			this.onCopyStatus?.("Command sent to clipboard (terminal clipboard delivery may be best effort)", "info");
		} catch (error) {
			if (!this.disposed && revision === this.copyRevision) {
				this.onCopyStatus?.(`Command copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} finally {
			this.copying = false;
		}
	}

	override setText(text: string): void {
		this.closeCopyMode();
		this.copyPrefixEditing = false;
		super.setText(text);
		this.tui?.requestRender?.();
	}

	override invalidate(): void {
		super.invalidate();
		this.copyMenu?.invalidate();
	}

	override handleInput(data: string): void {
		const pasteChunk = this.copyPasteActive || data.includes("\x1b[200~");
		if (data.includes("\x1b[200~")) this.copyPasteActive = true;
		if (data.includes("\x1b[201~")) this.copyPasteActive = false;
		const dollar = !pasteChunk && matchesKey(data, "$");
		const startCopy = !!this.onCopyCommand && this.mode === "insert" && dollar
			&& ((this.copyPrefixPending && this.getText() === "$" && this.cursorOffset() === 1) || this.copyPrefixEditing);
		this.copyPrefixPending = false;
		if (this.copyMode && this.mode === "insert" && !pasteChunk) {
			const cancel = matchesKey(data, "escape") || this.copyKeybindings.matches(data, "tui.select.cancel");
			if (cancel && this.copyMenuVisible) {
				this.copyMenuVisible = false;
				this.copyRevision++;
				this.tui?.requestRender?.();
				return;
			}
			if (this.copyKeybindings.matches(data, "tui.select.confirm") || this.copyKeybindings.matches(data, "tui.input.submit")) {
				if (!this.copyMenuVisible) {
					this.copyMenuVisible = true;
					this.tui?.requestRender?.();
				} else if (this.copyMenu?.selected) void this.copySelected(this.copyMenu.selected);
				return; // A copy query is never a prompt submission, even with no matches.
			}
			if (this.copyKeybindings.matches(data, "app.message.followUp") || matchesKey(data, "tab")) return;
			if (this.copyMenuVisible && this.copyMenu?.handleInput(data)) return;
			if (cancel) {
				this.closeCopyMode();
				this.copyPrefixEditing = false;
			}
		}
		if (this.mode === "normal") {
			if (this.ignoringPaste) {
				if (data.includes("\x1b[201~")) this.ignoringPaste = false;
				return;
			}
			if (data.includes("\x1b[200~")) {
				this.ignoringPaste = !data.includes("\x1b[201~");
				this.pendingLeader = undefined;
				this.pendingCount = undefined;
				return;
			}
		}
		// Escape toggles to normal mode, or passes through for app handling
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				if (this.isShowingAutocomplete()) {
					super.handleInput(data); // dismiss the completion first
					return;
				}
				this.setMode("normal");
				this.desiredColumn = undefined;
				const state = (this as unknown as EditorInternals).state;
				if (state.cursorCol > 0) this.setCursor(this.cursorOffset() - 1);
			} else if (this.pendingLeader !== undefined || this.pendingCount !== undefined) {
				this.pendingLeader = undefined;
				this.pendingCount = undefined;
			} else {
				super.handleInput(data); // abort agent, etc.
			}
			return;
		}

		// Edit the prefix/query in place. The menu never owns terminal focus.
		if (this.mode === "insert") {
			const armCopy = !!this.onCopyCommand && dollar && this.getText() === "";
			const before = this.getExpandedText();
			if (this.copyMode) (this as unknown as EditorInternals).cancelAutocomplete();
			super.handleInput(data);
			const after = this.getExpandedText();
			if (this.copyMode) {
				if (!after.startsWith("$$")) {
					this.closeCopyMode();
					this.copyPrefixEditing = after.startsWith("$");
				} else {
					if (before !== after) {
						this.copyRevision++;
						this.copyMenu?.setQuery(after.slice(2));
						this.copyMenuVisible = true;
					}
					(this as unknown as EditorInternals).cancelAutocomplete();
				}
			} else if (startCopy && after.startsWith("$$")) {
				this.activateCopyMode();
			} else {
				this.copyPrefixPending = armCopy && after === "$";
				if (!after.startsWith("$") || pasteChunk) this.copyPrefixEditing = false;
			}
			this.tui?.requestRender?.();
			return;
		}

		// Repeat counts: digits accumulate ("3w"), bare "0" is line start
		if (this.pendingLeader === undefined && data >= "1" && data <= "9") {
			this.pendingCount = Math.min((this.pendingCount ?? 0) * 10 + Number(data), 999);
			return;
		}
		if (this.pendingLeader === undefined && data === "0" && this.pendingCount !== undefined) {
			this.pendingCount = Math.min(this.pendingCount * 10, 999);
			return;
		}

		// Undo / redo act on the editor's history directly (vim u / ctrl+r).
		// ctrl+r arrives as 0x12 on legacy terminals and as a Kitty CSI-u
		// sequence on protocol terminals, so match through pi's decoder.
		const isUndoKey = data === "u";
		const isRedoKey = matchesKey(data, "ctrl+r");
		if (isUndoKey || isRedoKey) {
			const count = Math.min(this.pendingCount ?? 1, 999);
			this.pendingCount = undefined;
			this.pendingLeader = undefined;
			for (let i = 0; i < count; i++) {
				if (isUndoKey) this.vimUndo();
				else this.vimRedo();
			}
			return;
		}

		// A failed operator discards its second printable key, not a new command.
		const comboKey = this.pendingLeader === undefined ? undefined : this.pendingLeader + data;
		this.pendingLeader = undefined;
		if (comboKey !== undefined) {
			if (Object.hasOwn(NORMAL_COMBOS, comboKey)) this.applyAction(NORMAL_COMBOS[comboKey]!);
			else {
				this.pendingCount = undefined;
				if (data.length !== 1 || data.charCodeAt(0) < 32) super.handleInput(data);
			}
			return;
		}
		if (COMBO_LEADERS.has(data)) {
			this.pendingLeader = data;
			return;
		}

		// Single-key actions
		if (Object.hasOwn(NORMAL_KEYS, data)) {
			this.applyAction(NORMAL_KEYS[data]!);
			return;
		}

		// Unmapped: drop pending input, pass controls to Pi, ignore printables.
		this.pendingCount = undefined;
		this.pendingLeader = undefined;
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		this.syncHardwareCursor();

		// Strip software cursor inverse styling in insert mode so the terminal's
		// hardware vertical line cursor shows cleanly without an inverted background block.
		// If hardware cursor is disabled or unavailable, preserve the software inverse
		// styling so the cursor remains visible.
		if (this.mode === "insert" && this.tui?.getShowHardwareCursor?.() !== false) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]!.includes(CURSOR_MARKER)) {
					lines[i] = stripCursorInverse(lines[i]!);
					break;
				}
			}
		}

		// Mode indicator on the bottom border, left-aligned (`── NORMAL ───`),
		// with pending keys surfaced vim-style (`── NORMAL 3d ───`).
		const autocompleteHeight =
			(this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight ?? 0;
		const borderIndex = lines.length - 1 - autocompleteHeight;
		const paintLabel = this.workingBorder.paint(lines, borderIndex, width, this.borderColor, this.borderStatus);
		// Compose labels using the same frame and terminal-column coordinates as the border.
		lines[0] = renderTopBorderWithBadge(
			lines[0]!, this.getSessionName(), width, (text) => {
				const native = this.borderColor(text);
				return paintLabel ? paintLabel(native, width - visibleWidth(text), 0) : native;
			},
		);
		if (borderIndex >= 0 && borderIndex < lines.length) {
			lines[borderIndex] = renderBottomBorderWithMode(
				lines[borderIndex]!,
				this.mode,
				this.pendingLeader,
				this.pendingCount,
				width,
				(text) => {
					const native = this.borderColor(text);
					return paintLabel ? paintLabel(native, 0, borderIndex) : native;
				},
			);
		}
		if (this.copyMenuVisible && this.copyMenu) {
			const maxHeight = Math.max(0, this.tui.terminal.rows - lines.length - 4);
			return [...lines, ...this.copyMenu.render(width, maxHeight)];
		}
		return lines;
	}
}

export default function editorExtension(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	let ourFactory: EditorFactory | undefined;
	let activeEditor: NamedSessionEditor | undefined;
	pi.registerCommand("copy-command", {
		description: "Open the inline shell-code-block copy menu in an empty editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || !activeEditor || ctx.ui.getEditorComponent() !== ourFactory) {
				ctx.ui.notify("Inline command copying requires the pi-editor terminal editor", "error");
				return;
			}
			if (activeEditor.getText() !== "") {
				ctx.ui.notify("Clear the editor before opening command-copy mode", "error");
				return;
			}
			activeEditor.startCommandCopy();
		},
	});

	const onProcessExit = () => {
		try {
			process.stdout?.write?.(CURSOR_RESET_SEQUENCE);
		} catch {}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const existing = ctx.ui.getEditorComponent();
		if (existing !== undefined && existing !== ourFactory) {
			ctx.ui.notify("Session-name badge deferred: another custom editor is active", "info");
			return;
		}
		process.once("exit", onProcessExit);
		const sessionCtx = ctx;
		const factory: EditorFactory = (tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			activeEditor?.dispose();
			const editor: NamedSessionEditor = new NamedSessionEditor(
				tui, theme, keybindings, () => sessionCtx.sessionManager.getSessionName(), () => sessionCtx.ui.theme,
				() => activeEditor === editor && sessionCtx.ui.getEditorComponent() === ourFactory,
			);
			editor.onCopyCommand = () => new CommandCopyMenu(
				collectShellCommands(sessionCtx.sessionManager.getBranch()), tui, () => sessionCtx.ui.theme, keybindings,
			);
			editor.onCopyStatus = (message, type) => {
				if (activeEditor === editor) sessionCtx.ui.notify(message, type);
			};
			activeEditor = editor;
			return editor;
		};
		ourFactory = factory;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_info_changed", () => {
		requestRender?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = undefined;
		process.removeListener("exit", onProcessExit);
		onProcessExit();
		activeEditor?.dispose();
		activeEditor = undefined;
		if (ctx && ourFactory !== undefined && ctx.ui.getEditorComponent() === ourFactory) {
			ctx.ui.setEditorComponent(undefined);
		}
		ourFactory = undefined;
	});
}
