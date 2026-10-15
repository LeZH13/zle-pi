import type { CustomEditor, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	foregroundAnsi, getCellDimensions, mixColors, rgbColor, visibleWidth,
	type CellDimensions, type Color, type TerminalColorMode, type TUI,
} from "@earendil-works/pi-tui";

export const WORKING_BORDER_FRAME_MS = 25;
export const WORKING_BORDER_CYCLE_MS = 6_000;
export const WORKING_BORDER_TRAIL_FRACTION = 1 / 3;
const LEAD_FRACTION = 0.045;
const COLOR_STEPS = 512;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Keep native SGR and verbatim spinner escape sequences intact while visiting text runs.
const ANSI_OR_TEXT = /(\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_]))|([^\x1b]+)/g;
type BorderStatus = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
type BorderLabelPainter = (text: string, x: number, y: number) => string;
const BORDER_TOKENS: ThemeColor[] = [
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode", "border", "borderAccent", "borderMuted",
];
type BorderTheme = Pick<Theme, "colors" | "fg" | "getFgAnsi" | "getColorMode" | "appearance">;

const smoothstep = (value: number): number => value * value * (3 - 2 * value);

/** Cache both the fade math and terminal color conversion outside the frame path. */
export function createWorkingBorderPalette(base: Color, mode: TerminalColorMode, appearance: Theme["appearance"]): string[] {
	// A single-hue highlight: lighten on dark backgrounds, deepen on light ones.
	const highlight = mixColors(
		base, appearance === "dark" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0),
		appearance === "dark" ? 0.55 : 0.35, "srgb",
	);
	return Array.from({ length: COLOR_STEPS }, (_, i) => {
		const distance = i / (COLOR_STEPS - 1) * (LEAD_FRACTION + WORKING_BORDER_TRAIL_FRACTION) - LEAD_FRACTION;
		const age = Math.max(0, Math.min(1, distance / WORKING_BORDER_TRAIL_FRACTION));
		const strength = distance < 0 ? smoothstep(1 + distance / LEAD_FRACTION) : 1 - smoothstep(age);
		return foregroundAnsi(mixColors(base, highlight, strength, "srgb"), mode);
	});
}

/** Clockwise screen-space coordinates, including the editor's invisible side edges. */
export function workingBorderPosition(x: number, y: number, width: number, height: number, cells: CellDimensions): number {
	const horizontal = Math.max(0, width - 1) * cells.widthPx;
	const vertical = Math.max(0, height - 1) * cells.heightPx;
	const perimeter = 2 * (horizontal + vertical);
	if (perimeter === 0) return 0;
	const distance = y === 0 ? x * cells.widthPx : horizontal + vertical + (width - 1 - x) * cells.widthPx;
	return distance / perimeter;
}

export function workingBorderColor(position: number, head: number, palette: string[]): string | undefined {
	let age = ((head - position) % 1 + 1) % 1;
	if (age >= 1 - LEAD_FRACTION) age -= 1;
	if (age < -LEAD_FRACTION || age > WORKING_BORDER_TRAIL_FRACTION) return undefined;
	const fraction = (age + LEAD_FRACTION) / (LEAD_FRACTION + WORKING_BORDER_TRAIL_FRACTION);
	return palette[Math.min(palette.length - 1, Math.round(fraction * (palette.length - 1)))];
}

/** One timer per active editor. No layout changes, terminal writes, or idle redraws. */
export class WorkingBorderTrail {
	private timer: ReturnType<typeof setInterval> | undefined;
	private startedAt = 0;
	private disposed = false;
	private cache: {
		colors: BorderTheme["colors"]; sample: string; mode: TerminalColorMode;
		appearance: Theme["appearance"]; restore: string; palette: string[];
	} | undefined;

	constructor(
		private tui: Pick<TUI, "requestRender">,
		private getTheme: () => BorderTheme,
		private isCurrentEditor: () => boolean,
	) {}

	setActive(active: boolean): void {
		if (this.disposed) return;
		if (active && !this.isCurrentEditor()) {
			this.dispose();
			return;
		}
		if (active === (this.timer !== undefined)) return;
		if (active) {
			this.startedAt = Date.now();
			this.timer = setInterval(() => {
				// Pi does not dispose outgoing editors when another extension takes ownership.
				if (!this.isCurrentEditor()) this.dispose();
				if (!this.disposed) this.tui.requestRender();
			}, WORKING_BORDER_FRAME_MS);
			this.timer.unref();
		} else {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.tui.requestRender();
	}

	paint(
		lines: string[], bottomIndex: number, width: number, borderColor: (text: string) => string,
		status?: BorderStatus,
	): BorderLabelPainter | undefined {
		if (!this.timer || this.disposed || width <= 0 || bottomIndex < 1) return;
		const theme = this.getTheme();
		const colors = theme.colors;
		const mode = theme.getColorMode();
		const appearance = theme.appearance;
		const sample = borderColor("─");
		if (!this.cache || this.cache.colors !== colors || this.cache.sample !== sample || this.cache.mode !== mode || this.cache.appearance !== appearance) {
			// Match the actual native border, not a second interpretation of thinking/Bash state.
			const token = BORDER_TOKENS.find(token => theme.fg(token, "─") === sample);
			if (!token) return;
			this.cache = {
				colors, sample, mode, appearance, restore: theme.getFgAnsi(token),
				palette: createWorkingBorderPalette(colors[token], mode, appearance),
			};
		}
		const { palette, restore } = this.cache;
		// Concrete theme colors already account for faint tokens. Do not dim them twice.
		const clearFaint = restore.includes("\x1b[2m") ? "\x1b[22m" : "";
		const head = ((Date.now() - this.startedAt) % WORKING_BORDER_CYCLE_MS) / WORKING_BORDER_CYCLE_MS;
		const cells = getCellDimensions();
		const colorAt = (x: number, y: number) =>
			workingBorderColor(workingBorderPosition(x, y, width, bottomIndex + 1, cells), head, palette);
		const paintFill = (text: string, x: number, y: number) => text.replace(/─+/g, (run: string, offset: number) => {
			const start = x + visibleWidth(text.slice(0, offset));
			return Array.from(run, (glyph, i) => {
				const color = colorAt(start + i, y);
				return color ? clearFaint + color + glyph + restore : glyph;
			}).join("");
		});
		const paintLabel: BorderLabelPainter = (label, start, y) => {
			let column = 0;
			let nativeStyle = "\x1b[39m";
			return label.replace(ANSI_OR_TEXT, (_match, ansi: string | undefined, text: string | undefined) => {
				if (ansi) {
					if (ansi.startsWith("\x1b[") && ansi.endsWith("m")) nativeStyle += ansi;
					return ansi;
				}
				return Array.from(GRAPHEMES.segment(text!), ({ segment }) => {
					const color = colorAt(start + column, y);
					column += visibleWidth(segment);
					// Lift faint colors without losing NORMAL-mode bold emphasis.
					const emphasis = clearFaint ? nativeStyle.replace(/\x1b\[2m/g, "") : "";
					// Spaces occupy path distance; restore native styles after each lit grapheme.
					return color && segment.trim() ? clearFaint + emphasis + color + segment + nativeStyle : segment;
				}).join("");
			});
		};
		const top = lines[0]!;
		// Reuse the native renderer's exact status text, including spinner-only narrow layouts.
		// These render methods are pure: the native loader's own timer advances its frames.
		let label = status?.renderInBorder(Math.max(1, width - 5)) ?? "";
		let labelIndex = label ? top.indexOf(label) : -1;
		if (status && labelIndex < 0) {
			label = status.renderSpinnerInBorder(width);
			labelIndex = label ? top.indexOf(label) : -1;
		}
		if (labelIndex >= 0) {
			const prefix = top.slice(0, labelIndex);
			const suffix = top.slice(labelIndex + label.length);
			const start = visibleWidth(prefix);
			const paintedLabel = status?.kind === "working" ? paintLabel(label, start, 0) : label;
			lines[0] = paintFill(prefix, 0, 0) + paintedLabel + paintFill(suffix, start + visibleWidth(label), 0);
		} else {
			lines[0] = paintFill(top, 0, 0);
		}
		lines[bottomIndex] = paintFill(lines[bottomIndex]!, 0, bottomIndex);
		// Label composition uses this exact frame's phase and geometry, not a new animation clock.
		return paintLabel;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.timer = undefined;
		this.cache = undefined;
	}
}
