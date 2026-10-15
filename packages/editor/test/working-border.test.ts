import { CustomEditor, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	foregroundAnsi, getCellDimensions, rgbColor, setCellDimensions, sliceByColumn,
	stripTerminalSequences, visibleWidth, type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import editorExtension, { NamedSessionEditor } from "../extensions/editor.js";
import {
	createWorkingBorderPalette, WorkingBorderTrail, workingBorderColor, workingBorderPosition,
	WORKING_BORDER_CYCLE_MS, WORKING_BORDER_FRAME_MS, WORKING_BORDER_TRAIL_FRACTION,
} from "../lib/working-border.js";

type Indicator = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
const indicator = (kind = "working"): Indicator => ({
	kind, renderInBorder: () => "◐ Working…", renderSpinnerInBorder: () => "◐",
}) as unknown as Indicator;
const originalCells = getCellDimensions();
const cells = { widthPx: 8, heightPx: 16 };

function makeTheme(mode: TerminalColorMode = "truecolor", appearance: Theme["appearance"] = "dark") {
	const colors = {
		thinkingOff: rgbColor(90, 90, 90), thinkingHigh: rgbColor(140, 100, 200),
		bashMode: rgbColor(200, 150, 50), border: rgbColor(70, 80, 90),
	} as Theme["colors"];
	const getFgAnsi = (token: ThemeColor) => foregroundAnsi(colors[token] ?? colors.border, mode);
	return {
		colors, appearance, getColorMode: () => mode, getFgAnsi,
		fg: vi.fn((token: ThemeColor, text: string) => getFgAnsi(token) + text + "\x1b[39m"),
	};
}

function setup(name = "demo─😀") {
	let theme = makeTheme();
	const tui = {
		terminal: { rows: 24, write: vi.fn() }, requestRender: vi.fn(),
		setShowHardwareCursor: vi.fn(), getShowHardwareCursor: () => true,
	};
	const editor = new NamedSessionEditor(
		tui as never, { borderColor: text => theme.fg("thinkingHigh", text), selectList: {} as never },
		{ matches: () => false } as never, () => name, () => theme as unknown as Theme, () => true,
	);
	return { editor, tui, get theme() { return theme; }, setTheme: (next: typeof theme) => { theme = next; } };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	setCellDimensions(cells);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	setCellDimensions(originalCells);
});

describe("working-border geometry and gradient", () => {
	it("travels right across the top and left across the bottom, with pixel-weighted invisible sides", () => {
		const position = (x: number, y: number) => workingBorderPosition(x, y, 81, 5, cells);
		const perimeter = 2 * (80 * 8 + 4 * 16);
		expect(position(0, 0)).toBe(0);
		expect(position(80, 0)).toBe(640 / perimeter);
		expect(position(80, 4)).toBe(0.5);
		expect(position(0, 4)).toBe((640 * 2 + 64) / perimeter);
		expect(position(10, 0)).toBeLessThan(position(20, 0));
		expect(position(20, 4)).toBeLessThan(position(10, 4));
		expect(workingBorderPosition(0, 0, 1, 1, cells)).toBe(0);
	});

	it("fades smoothly into the thinking color at both ends and wraps around the head", () => {
		const base = rgbColor(140, 100, 200);
		const palette = createWorkingBorderPalette(base, "truecolor", "dark");
		expect(palette[0]).toBe(foregroundAnsi(base, "truecolor"));
		expect(palette.at(-1)).toBe(foregroundAnsi(base, "truecolor"));
		expect(new Set(palette).size).toBeGreaterThan(100);
		expect(workingBorderColor(0, 0, palette)).not.toBe(foregroundAnsi(base, "truecolor"));
		expect(workingBorderColor(0.6, 0, palette)).toBeUndefined();
		expect(workingBorderColor(0.99, 0.01, palette)).toBe(workingBorderColor(0.49, 0.51, palette));
		expect(workingBorderColor(0, WORKING_BORDER_TRAIL_FRACTION + 0.001, palette)).toBeUndefined();
	});

	it.each(["dark", "light"] as const)("uses only shades of the thinking color on %s backgrounds", appearance => {
		const base = rgbColor(140, 100, 200);
		const palette = createWorkingBorderPalette(base, "truecolor", appearance);
		for (const ansi of palette) {
			const [, r, g, b] = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)!;
			const channels = [Number(r), Number(g), Number(b)];
			// All channels move proportionally toward the same neutral, never through unrelated hues.
			expect(channels[2]).toBeGreaterThan(channels[0]!);
			expect(channels[0]).toBeGreaterThan(channels[1]!);
			const target = appearance === "dark" ? 255 : 0;
			const amounts = channels.map((channel, i) => (channel - [base.r, base.g, base.b][i]!) / (target - [base.r, base.g, base.b][i]!));
			expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThan(0.02);
			expect(Math.min(...amounts)).toBeGreaterThanOrEqual(0);
		}
		const head = workingBorderColor(0, 0, palette)!;
		const headRed = Number(head.match(/\x1b\[38;2;(\d+);/)![1]);
		if (appearance === "dark") expect(headRed).toBeGreaterThan(base.r);
		else expect(headRed).toBeLessThan(base.r);
	});

	it("supports 256-color terminals without emitting truecolor sequences", () => {
		const palette = createWorkingBorderPalette(rgbColor(140, 100, 200), "256color", "dark");
		expect(palette.every(color => color.startsWith("\x1b[38;5;"))).toBe(true);
	});
});

describe("native working-status integration", () => {
	it("has no idle timer, starts just once, and removes its timer and trail when the native status clears", () => {
		const { editor, tui } = setup();
		const idle = editor.render(80);
		expect(vi.getTimerCount()).toBe(0);
		editor.setWorkingStatusIndicator(indicator());
		editor.setWorkingStatusIndicator(indicator());
		expect(vi.getTimerCount()).toBe(1);
		const first = editor.render(80);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(WORKING_BORDER_FRAME_MS * 4);
		expect(tui.requestRender).toHaveBeenCalledTimes(4);
		expect(editor.render(80)[0]).not.toBe(first[0]);
		editor.setWorkingStatusIndicator(undefined);
		expect(vi.getTimerCount()).toBe(0);
		expect(editor.render(80)).toEqual(idle);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(WORKING_BORDER_CYCLE_MS);
		expect(tui.requestRender).not.toHaveBeenCalled();
		editor.dispose();
	});

	it.each(["working", "retry", "compaction", "branchSummary"])("animates native %s activity, not just model streaming", kind => {
		const { editor } = setup();
		editor.setWorkingStatusIndicator(indicator(kind));
		expect(vi.getTimerCount()).toBe(1);
		editor.setWorkingStatusIndicator(undefined);
		expect(vi.getTimerCount()).toBe(0);
		editor.dispose();
	});

	it("preserves label text, Unicode names, prompt text, and cursor positions across frames", () => {
		const { editor } = setup();
		editor.focused = true;
		editor.setText("a prompt─中😀");
		editor.setWorkingStatusIndicator(indicator());
		const first = editor.render(80);
		vi.advanceTimersByTime(WORKING_BORDER_CYCLE_MS / 4);
		const next = editor.render(80);
		expect(next.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
		expect(next.slice(1, -1)).toEqual(first.slice(1, -1));
		expect(stripTerminalSequences(next[0]!)).toContain("◐ Working…");
		expect(stripTerminalSequences(next[0]!)).toContain(" demo─😀 ──");
		expect(stripTerminalSequences(next.at(-1)!)).toContain("── INSERT ──");
		expect(next.every(line => visibleWidth(line) <= 80)).toBe(true);
		expect(next[0]).not.toBe(first[0]);
		editor.dispose();
	});

	it("includes the Unicode session badge in the exact same trail and restores idle styling", () => {
		const { editor, theme } = setup();
		editor.setText("unchanged prompt");
		const idle = editor.render(80);
		editor.setWorkingStatusIndicator(indicator());
		const before = editor.render(80);
		const tag = " demo─😀 ──";
		const start = 80 - visibleWidth(tag);
		const position = workingBorderPosition(start + 6, 0, 80, before.length, cells);
		const elapsed = Math.round(position * WORKING_BORDER_CYCLE_MS);
		vi.setSystemTime(1_000 + elapsed);
		const next = editor.render(80);
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		for (const [offset, glyph] of [[1, "d"], [5, "─"], [6, "😀"], [10, "─"]] as const) {
			const column = start + offset;
			const color = workingBorderColor(workingBorderPosition(column, 0, 80, next.length, cells), elapsed / WORKING_BORDER_CYCLE_MS, palette)!;
			expect(sliceByColumn(next[0]!, column, visibleWidth(glyph))).toContain(color + glyph);
		}
		expect(next.map(stripTerminalSequences)).toEqual(before.map(stripTerminalSequences));
		expect(next.slice(1, -1)).toEqual(before.slice(1, -1));
		expect(vi.getTimerCount()).toBe(1);
		editor.setWorkingStatusIndicator(undefined);
		expect(editor.render(80)).toEqual(idle);
		editor.dispose();
	});

	it.each(["insert", "normal"] as const)("includes %s mode text and pending keys in the same bottom-edge trail", mode => {
		const { editor, theme } = setup();
		if (mode === "normal") {
			editor.handleInput("\x1b");
			editor.handleInput("3");
			editor.handleInput("d");
		}
		const idle = editor.render(80);
		editor.setWorkingStatusIndicator(indicator());
		const before = editor.render(80);
		const bottom = before.length - 1;
		const position = workingBorderPosition(3, bottom, 80, before.length, cells);
		const elapsed = Math.round(position * WORKING_BORDER_CYCLE_MS);
		vi.setSystemTime(1_000 + elapsed);
		const next = editor.render(80);
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		const glyphs = mode === "normal" ? [[3, "N"], [4, "O"], [10, "3"], [11, "d"]] as const : [[3, "I"], [4, "N"], [8, "T"]] as const;
		for (const [column, glyph] of glyphs) {
			const color = workingBorderColor(workingBorderPosition(column, bottom, 80, next.length, cells), elapsed / WORKING_BORDER_CYCLE_MS, palette)!;
			expect(sliceByColumn(next[bottom]!, column, 1)).toContain(color + glyph);
		}
		if (mode === "normal") expect(next[bottom]).toContain("\x1b[1m");
		expect(next.map(stripTerminalSequences)).toEqual(before.map(stripTerminalSequences));
		expect(vi.getTimerCount()).toBe(1);
		editor.setWorkingStatusIndicator(undefined);
		expect(editor.render(80)).toEqual(idle);
		editor.dispose();
	});

	it("retains NORMAL bold emphasis while lifting a faint theme color", () => {
		const { editor, theme } = setup();
		const nativeAnsi = theme.getFgAnsi;
		theme.getFgAnsi = token => nativeAnsi(token) + "\x1b[2m";
		theme.fg = vi.fn((token, text) => theme.getFgAnsi(token) + text + "\x1b[22;39m");
		editor.handleInput("\x1b");
		editor.setWorkingStatusIndicator(indicator());
		const before = editor.render(80);
		const bottom = before.length - 1;
		const position = workingBorderPosition(3, bottom, 80, before.length, cells);
		const elapsed = Math.round(position * WORKING_BORDER_CYCLE_MS);
		vi.setSystemTime(1_000 + elapsed);
		const next = editor.render(80);
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		const color = workingBorderColor(position, elapsed / WORKING_BORDER_CYCLE_MS, palette)!;
		const letter = sliceByColumn(next[bottom]!, 3, 1);
		expect(letter).toContain("\x1b[1m" + color + "N"); // Bold is reapplied after clearing faint, before the lit glyph.
		expect(next[bottom]).toContain(color + "N\x1b[39m" + nativeAnsi("thinkingHigh") + "\x1b[2m\x1b[1m");
		editor.dispose();
	});

	it("lights the native working spinner and text at the exact same phase as adjacent border cells", () => {
		const { editor, theme } = setup("");
		let frame = "⠇";
		const status = indicator();
		status.renderInBorder = () => theme.fg("thinkingHigh", frame) + " " + theme.fg("thinkingHigh", "Working…");
		status.renderSpinnerInBorder = () => theme.fg("thinkingHigh", frame);
		editor.setWorkingStatusIndicator(status);
		vi.advanceTimersByTime(600);
		const lines = editor.render(80);
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		for (const [column, glyph] of [[0, "─"], [3, frame], [5, "W"], [6, "o"], [12, "…"], [14, "─"]] as const) {
			const color = workingBorderColor(workingBorderPosition(column, 0, 80, lines.length, cells), 0.1, palette)!;
			expect(sliceByColumn(lines[0]!, column, 1)).toContain(color + glyph);
		}
		expect(vi.getTimerCount()).toBe(1); // No second pulse or spinner timer is introduced.
		frame = "⠋";
		expect(stripTerminalSequences(editor.render(80)[0]!)).toContain("⠋ Working…");
		vi.advanceTimersByTime(2_400);
		expect(editor.render(80)[0]).toContain(status.renderInBorder(75)); // Outside the trail: native styling again.
		editor.dispose();
	});

	it("keeps Unicode status graphemes, native styling, and hyperlinks intact", () => {
		const { editor, theme } = setup("");
		const openLink = "\x1b]8;;https://example.com\x1b\\";
		const closeLink = "\x1b]8;;\x1b\\";
		const text = theme.fg("thinkingHigh", "\x1b[1m⠇ 工😀é\x1b[22m " + openLink + "work" + closeLink);
		const status = indicator();
		status.renderInBorder = () => text;
		editor.setWorkingStatusIndicator(status);
		vi.advanceTimersByTime(600);
		const lines = editor.render(80);
		expect(stripTerminalSequences(lines[0]!)).toContain("⠇ 工😀é work");
		expect(lines[0]).toContain("\x1b[1m");
		expect(lines[0]).toContain("\x1b[22m");
		expect(lines[0]!.split(openLink)).toHaveLength(2);
		expect(lines[0]!.split(closeLink)).toHaveLength(2);
		expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
		expect(lines[0]).not.toContain(text); // Text is lit, rather than a single steady native span.
		editor.dispose();
	});

	it.each(["retry", "compaction", "branchSummary"])("preserves %s status colors, even for border-like text", kind => {
		const { editor } = setup("");
		const text = "\x1b[33m◐ Important ─ status\x1b[39m";
		const status = indicator(kind);
		status.renderInBorder = () => text;
		editor.setWorkingStatusIndicator(status);
		vi.advanceTimersByTime(600);
		expect(editor.render(80)[0]).toContain(text);
		editor.dispose();
	});

	it("includes spinner-only narrow layouts in the same trail without changing scroll layout", () => {
		const { editor, theme } = setup("");
		editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
		const status = indicator();
		status.renderInBorder = () => theme.fg("thinkingHigh", "◐ A very long working message which cannot fit");
		status.renderSpinnerInBorder = () => theme.fg("thinkingHigh", "◐");
		editor.setWorkingStatusIndicator(status);
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		for (const width of [1, 4, 12, 25]) {
			const before = editor.render(width);
			const plain = stripTerminalSequences(before[0]!);
			const column = plain.indexOf("◐");
			expect(column).toBeGreaterThanOrEqual(0);
			const position = workingBorderPosition(column, 0, width, before.length, cells);
			const elapsed = Math.round(position * WORKING_BORDER_CYCLE_MS);
			vi.setSystemTime(1_000 + elapsed);
			const next = editor.render(width);
			const color = workingBorderColor(position, elapsed / WORKING_BORDER_CYCLE_MS, palette)!;
			expect(sliceByColumn(next[0]!, column, 1)).toContain(color + "◐");
			expect(next.map(stripTerminalSequences)).toEqual(before.map(stripTerminalSequences));
		}
		editor.dispose();
	});

	it("preserves scroll labels across frames and resize, including narrow terminals and long names", () => {
		const { editor } = setup("a very long session name 中😀");
		editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
		editor.setWorkingStatusIndicator(indicator());
		for (const width of [1, 2, 8, 20, 80, 120]) {
			const first = editor.render(width);
			vi.advanceTimersByTime(375);
			const next = editor.render(width);
			expect(next.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
			// Native Pi can overflow its cursor padding at width 1; the trail never changes body layout.
			expect([next[0]!, next.at(-1)!].every(line => visibleWidth(line) <= width)).toBe(true);
			if (width >= 80) expect(next[0]).toContain("↑");
		}
		editor.dispose();
	});

	it("does not paint autocomplete or the inline copy menu", () => {
		const { editor, theme } = setup();
		vi.spyOn(CustomEditor.prototype, "render").mockImplementation(function (this: CustomEditor) {
			(this as unknown as { renderedAutocompleteHeight: number }).renderedAutocompleteHeight = 2;
			return [theme.fg("thinkingHigh", "─".repeat(80)), "prompt", theme.fg("thinkingHigh", "─".repeat(80)), "completion─one", "completion─two"];
		});
		editor.onCopyCommand = () => ({ setQuery() {}, render: () => ["COPY─MENU"] }) as never;
		editor.handleInput("$");
		editor.handleInput("$");
		editor.setWorkingStatusIndicator(indicator());
		vi.advanceTimersByTime(WORKING_BORDER_CYCLE_MS * 0.7);
		const lines = editor.render(80);
		expect(lines.slice(-3)).toEqual(["completion─one", "completion─two", "COPY─MENU"]);
		expect(stripTerminalSequences(lines[2]!)).toContain("INSERT");
		expect(lines[2]).not.toBe(theme.fg("thinkingHigh", "─".repeat(80)));
		editor.dispose();
	});

	it("releases the timer idempotently and cannot restart after disposal", () => {
		const { editor, tui } = setup();
		editor.setWorkingStatusIndicator(indicator());
		editor.dispose();
		editor.dispose();
		editor.setWorkingStatusIndicator(indicator());
		expect(vi.getTimerCount()).toBe(0);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(tui.requestRender).not.toHaveBeenCalled();
	});
});

describe("palette invalidation", () => {
	it("returns a label painter bound to the border frame's exact phase", () => {
		const theme = makeTheme();
		const trail = new WorkingBorderTrail({ requestRender() {} }, () => theme, () => true);
		trail.setActive(true);
		vi.advanceTimersByTime(600);
		const border = (text: string) => theme.fg("thinkingHigh", text);
		const lines = [border("─".repeat(80)), "body", border("─".repeat(80))];
		const paintLabel = trail.paint(lines, 2, 80, border)!;
		const palette = createWorkingBorderPalette(theme.colors.thinkingHigh, "truecolor", "dark");
		const color = workingBorderColor(workingBorderPosition(5, 0, 80, 3, cells), 0.1, palette)!;
		vi.advanceTimersByTime(2_000);
		expect(paintLabel(border("X"), 5, 0)).toContain(color + "X");
		const nextPainter = trail.paint([border("─".repeat(80)), "body", border("─".repeat(80))], 2, 80, border)!;
		expect(nextPainter(border("X"), 5, 0)).not.toContain(color + "X");
		trail.dispose();
	});

	it("clears faint styling for concrete gradient colors and restores terminal-default faint borders", () => {
		const theme = makeTheme();
		const originalAnsi = theme.getFgAnsi;
		theme.getFgAnsi = token => token === "thinkingOff" ? "\x1b[39m\x1b[2m" : originalAnsi(token);
		theme.fg = vi.fn((token, text) => theme.getFgAnsi(token) + text + "\x1b[22;39m");
		const trail = new WorkingBorderTrail({ requestRender() {} }, () => theme, () => true);
		trail.setActive(true);
		const border = (text: string) => theme.fg("thinkingOff", text);
		const lines = [border("─".repeat(80)), "body", border("─".repeat(80))];
		trail.paint(lines, 2, 80, border);
		expect(lines[0]).toContain("\x1b[22m\x1b[38;2;");
		expect(lines[0]).toContain("─\x1b[39m\x1b[2m");
		expect(stripTerminalSequences(lines[0]!)).toBe("─".repeat(80));
		trail.dispose();
	});

	it("caches color math but follows thinking, Bash mode, theme, and terminal color-mode changes", () => {
		let theme = makeTheme();
		const trail = new WorkingBorderTrail({ requestRender() {} }, () => theme, () => true);
		trail.setActive(true);
		vi.advanceTimersByTime(1_000);
		const paint = (token: ThemeColor) => {
			const border = (text: string) => theme.fg(token, text);
			const lines = [border("─".repeat(80)), "body", border("─".repeat(80))];
			trail.paint(lines, 2, 80, border);
			return lines;
		};
		const high = paint("thinkingHigh");
		theme.fg.mockClear();
		expect(paint("thinkingHigh")).toEqual(high);
		// Two border strings and one sample; no theme-token search on a cached frame.
		expect(theme.fg).toHaveBeenCalledTimes(3);
		theme.appearance = "light";
		expect(paint("thinkingHigh")).not.toEqual(high);
		theme.appearance = "dark";
		expect(paint("thinkingOff")).not.toEqual(high);
		expect(paint("bashMode")).not.toEqual(high);
		theme = makeTheme();
		theme.colors = { ...theme.colors, thinkingHigh: rgbColor(200, 50, 90) };
		expect(paint("thinkingHigh")).not.toEqual(high);
		theme = makeTheme("256color");
		expect(paint("thinkingHigh").join("")).not.toContain("\x1b[38;2;");
		trail.dispose();
	});

	it("leaves most of the border in its original color and restores it before labels", () => {
		const theme = makeTheme();
		const trail = new WorkingBorderTrail({ requestRender() {} }, () => theme, () => true);
		trail.setActive(true);
		vi.advanceTimersByTime(2_100);
		const border = (text: string) => theme.fg("thinkingHigh", text);
		const lines = [border("─".repeat(80)), "unchanged body", border("─".repeat(80))];
		trail.paint(lines, 2, 80, border);
		expect(sliceByColumn(lines[0]!, 0, 10)).toContain(theme.getFgAnsi("thinkingHigh"));
		expect(lines[2]).toBe(border("─".repeat(80)));
		expect(lines[1]).toBe("unchanged body");
		trail.dispose();
	});
});

describe("extension animation cleanup", () => {
	it("stops animation on own or foreign factory replacement and shutdown/reload", () => {
		const handlers = new Map<string, (event: never, ctx: never) => void>();
		editorExtension({ registerCommand() {}, on: (name: string, handler: (event: never, ctx: never) => void) => handlers.set(name, handler) } as never);
		const theme = makeTheme();
		const tui = { terminal: { rows: 24, write: vi.fn() }, requestRender: vi.fn(), setShowHardwareCursor() {} };
		let factory: ((...args: never[]) => NamedSessionEditor) | undefined;
		const ctx = {
			mode: "tui", ui: { theme, getEditorComponent: () => factory, setEditorComponent: (next: typeof factory) => { factory = next; } },
			sessionManager: { getSessionName: () => "test" },
		};
		handlers.get("session_start")!(undefined as never, ctx as never);
		const make = () => factory!(tui as never, { borderColor: (text: string) => theme.fg("thinkingHigh", text), selectList: {} } as never, { matches: () => false } as never);
		const first = make();
		first.setWorkingStatusIndicator(indicator());
		expect(vi.getTimerCount()).toBe(1);
		const second = make();
		expect(vi.getTimerCount()).toBe(0);
		second.setWorkingStatusIndicator(indicator());
		const ourFactory = factory;
		factory = () => ({} as NamedSessionEditor); // Another extension takes ownership while work continues.
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(WORKING_BORDER_FRAME_MS);
		expect(vi.getTimerCount()).toBe(0);
		expect(tui.requestRender).not.toHaveBeenCalled();
		second.setWorkingStatusIndicator(indicator());
		expect(vi.getTimerCount()).toBe(0);
		factory = ourFactory;
		const third = make();
		third.setWorkingStatusIndicator(indicator());
		expect(vi.getTimerCount()).toBe(1);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			handlers.get("session_shutdown")!(undefined as never, ctx as never);
			handlers.get("session_shutdown")!(undefined as never, ctx as never);
		} finally { stdout.mockRestore(); }
		expect(vi.getTimerCount()).toBe(0);
		expect(factory).toBeUndefined();
	});
});
