import { getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, SelectList, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ShellCommand } from "./shell-commands.js";

/** Render control characters visibly without changing the copied shell text. */
function displayText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** An inline menu. The prompt editor retains focus and handles typing, copy, and dismissal. */
export class CommandCopyMenu implements Component {
	private list: SelectList;
	private listSize = 5;
	private matches: readonly ShellCommand[];
	private query = "";
	private readonly previewText = new Text("", 0, 0);
	private readonly preview = new ScrollView(this.previewText, { scrollbar: "hidden", overscroll: "contain" });

	constructor(
		private readonly commands: readonly ShellCommand[],
		private readonly tui: TUI,
		private readonly getTheme: () => Theme,
		private readonly keybindings: KeybindingsManager,
	) {
		this.matches = commands;
		this.list = this.createList();
		this.updatePreview();
	}

	private createList(): SelectList {
		return new SelectList(this.matches.map(command => ({
			value: command.id,
			label: displayText(command.text).split("\n").find(line => line.trim()) ?? "",
			description: `R${command.reply} · ${command.language}`,
		})), this.listSize, getSelectListTheme());
	}

	get selected(): ShellCommand | undefined {
		return this.matches.find(command => command.id === this.list.getSelectedItem()?.value);
	}

	setQuery(query: string): void {
		const normalized = query.trim().toLowerCase();
		if (this.query === normalized) return;
		this.query = normalized;
		const selectedId = this.selected?.id;
		this.matches = this.commands.filter(command => command.text.toLowerCase().includes(normalized));
		this.list = this.createList();
		this.list.setSelectedIndex(Math.max(0, this.matches.findIndex(command => command.id === selectedId)));
		this.updatePreview();
	}

	private updatePreview(): void {
		this.previewText.setText(displayText(this.selected?.text ?? ""));
		this.preview.scrollToStart();
	}

	invalidate(): void {
		this.list.invalidate();
		this.preview.invalidate();
	}

	private moveSelection(delta: number, wrap = false): void {
		if (!this.matches.length) return;
		const index = this.matches.findIndex(command => command.id === this.selected?.id);
		const next = wrap ? (index + delta + this.matches.length) % this.matches.length : index + delta;
		this.list.setSelectedIndex(next);
		this.updatePreview();
	}

	/** Consume only list/preview navigation; plain cursor keys still belong to the editor. */
	handleInput(data: string): boolean {
		if (this.keybindings.matches(data, "tui.select.up")) this.moveSelection(-1, true);
		else if (this.keybindings.matches(data, "tui.select.down")) this.moveSelection(1, true);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveSelection(-this.listSize);
		else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveSelection(this.listSize);
		else if (matchesKey(data, "ctrl+left")) this.preview.scrollBy(-Math.max(1, this.preview.viewportHeight - 1));
		else if (matchesKey(data, "ctrl+right")) this.preview.scrollBy(Math.max(1, this.preview.viewportHeight - 1));
		else return false;
		this.tui.requestRender();
		return true;
	}

	render(width: number, maxHeight = Math.max(0, this.tui.terminal.rows - 7)): string[] {
		if (width <= 0 || maxHeight <= 0) return [];
		const theme = this.getTheme();
		const selected = this.selected;
		const size = Math.max(1, Math.min(5, Math.floor((maxHeight - 4) / 2)));
		if (size !== this.listSize) {
			this.listSize = size;
			this.list = this.createList();
			this.list.setSelectedIndex(Math.max(0, this.matches.findIndex(command => command.id === selected?.id)));
		}
		if (!this.matches.length) {
			return [
				theme.fg("accent", "Copy command · edit $$ to filter"),
				theme.fg("muted", this.commands.length ? "No matching shell code blocks" : "No shell code blocks in the last 10 assistant replies"),
			].slice(0, maxHeight).map(line => truncateToWidth(line, width));
		}
		const listLines = this.list.render(width);
		const lineCount = selected?.text.split("\n").length ?? 0;
		const meta = selected
			? `R${selected.reply} · ${selected.language} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`
			: "No command selected";
		const previewHeight = Math.max(1, Math.min(6, maxHeight - listLines.length - 4));
		this.preview.updateLayout(this.previewText.render(width).length, previewHeight, () => this.tui.requestRender());
		return [
			theme.fg("accent", "Copy command · edit $$ to filter"),
			...listLines,
			theme.fg("borderMuted", "─".repeat(width)),
			theme.fg("muted", meta),
			...this.preview.render(width).slice(this.preview.scrollTop, this.preview.scrollTop + previewHeight)
				.map(line => theme.fg("toolOutput", line)),
			theme.fg("dim", "↑↓ choose · Enter copy · Esc hide · Ctrl+←→ preview"),
		].slice(0, maxHeight).map(line => truncateToWidth(line, width));
	}
}
