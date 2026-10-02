import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";

export const LOGO_COLOR_ANSI = "\x1b[38;2;182;189;115m";
export const RESET_FG_ANSI = "\x1b[39m";

export const ASCII_ART = [
	"   ███████████████████████████╗  ",
	"   ╚══██████╔════════██████╔══╝  ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"   ████████████╗  ████████████╗  ",
	"   ╚═══════════╝  ╚═══════════╝  ",
];

function formatKeyPart(part: string): string {
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

export function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part))
				.join("+"),
		)
		.join("/");
}

export function getActionKeyText(actionId: string): string {
	const keys = getKeybindings().getKeys(actionId as any);
	if (!keys || keys.length === 0) return "";
	return formatKeyText(keys.join("/"));
}

export function buildHeaderLines(theme: Theme, expanded = false, width = 120): string[] {
	const styledAscii = ASCII_ART.map(line =>
		theme.bold(`${LOGO_COLOR_ANSI}${line}${RESET_FG_ANSI}`)
	);

	const title =
		theme.bold(`${LOGO_COLOR_ANSI}pi${RESET_FG_ANSI}`) +
		theme.fg("dim", ` v${VERSION}`);

	// Dynamic Keybinding resolution from Pi's live registry
	const keybindings = getKeybindings();

	const hint = (actionId: string, description?: string): string | undefined => {
		const key = getActionKeyText(actionId);
		if (!key) return undefined;
		const desc = description ?? keybindings.getDefinition(actionId as any)?.description ?? actionId;
		return theme.fg("dim", key) + theme.fg("muted", ` ${desc}`);
	};

	const rawHint = (key: string, description: string): string | undefined => {
		if (!key) return undefined;
		return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
	};

	const dot = theme.fg("muted", " · ");

	const clearKey = getActionKeyText("app.clear");
	const exitKey = getActionKeyText("app.exit");
	const clearExitKey = [clearKey, exitKey].filter(Boolean).join("/");

	const expandKey = getActionKeyText("app.tools.expand");

	const compactRow1 = [
		hint("app.interrupt", "interrupt"),
		clearExitKey ? rawHint(clearExitKey, "clear/exit") : undefined,
	].filter((h): h is string => Boolean(h)).join(dot);

	const compactRow2 = [
		rawHint("/", "commands"),
		rawHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].filter((h): h is string => Boolean(h)).join(dot);

	const compactHelp = expandKey
		? theme.fg("dim", `Press ${expandKey} to show full startup help.`)
		: "";
	const onboarding1 = theme.fg("dim", "Pi can explain its own features and look up its docs.");
	const onboarding2 = theme.fg("dim", "Ask it how to use or extend Pi.");

	const cycleFwd = getActionKeyText("app.model.cycleForward");
	const cycleBwd = getActionKeyText("app.model.cycleBackward");
	const cycleKeys = [cycleFwd, cycleBwd].filter(Boolean).join("/");

	const allHints = [
		hint("app.interrupt", "to interrupt"),
		hint("app.clear", "to clear"),
		clearKey ? rawHint(`${clearKey} twice`, "to exit") : undefined,
		hint("app.exit", "to exit (empty)"),
		hint("app.suspend", "to suspend"),
		hint("tui.editor.deleteToLineEnd", "to delete to end"),
		hint("app.thinking.cycle", "to cycle thinking level"),
		cycleKeys ? rawHint(cycleKeys, "to cycle models") : undefined,
		hint("app.model.select", "to select model"),
		hint("app.tools.expand", "to toggle tool output"),
		hint("app.thinking.toggle", "to expand thinking"),
		hint("app.editor.external", "for external editor"),
		rawHint("/", "for commands"),
		rawHint("!", "to run bash"),
		rawHint("!!", "to run bash (no context)"),
		hint("app.message.followUp", "to queue follow-up"),
		hint("app.message.dequeue", "to edit all queued messages"),
		hint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
		rawHint("drop files", "to attach"),
	].filter((h): h is string => Boolean(h));

	// Fallback to stacked layout if terminal is too narrow for side-by-side
	if (width < 85) {
		const stacked = ["", ...styledAscii, "", title, ""];
		if (!expanded) {
			stacked.push(compactRow1, compactRow2, "", compactHelp, "", `${onboarding1} ${onboarding2}`);
		} else {
			stacked.push(...allHints, "", `${onboarding1} ${onboarding2}`);
		}
		return stacked;
	}

	// Side-by-side layout: text to the right of the logo
	let rightLines: string[] = [];
	if (!expanded) {
		rightLines = [
			title,
			"",
			compactRow1,
			compactRow2,
			"",
			compactHelp,
			"",
			"",
			onboarding1,
			onboarding2,
		];
	} else if (width >= 115) {
		// Expanded 2-column mode to align neatly with the 10-line logo
		const col1 = allHints.slice(0, 10);
		const col2 = allHints.slice(10);
		const col1Width = Math.max(...col1.map(h => visibleWidth(h)));

		rightLines = [title];
		for (let i = 0; i < 10; i++) {
			const h1 = col1[i] ?? "";
			const pad = " ".repeat(Math.max(2, col1Width - visibleWidth(h1) + 4));
			const h2 = col2[i] ?? "";
			rightLines.push(h1 ? h1 + pad + h2 : "");
		}
		rightLines.push("");
		if (expandKey) {
			rightLines.push(theme.fg("dim", `Press ${expandKey} to collapse startup help.`));
		}
		rightLines.push(`${onboarding1} ${onboarding2}`);
	} else {
		// Expanded single-column mode
		rightLines = [
			title,
			"",
			...allHints,
			"",
			expandKey ? theme.fg("dim", `Press ${expandKey} to collapse startup help.`) : "",
			`${onboarding1} ${onboarding2}`,
		].filter(Boolean);
	}

	const maxRows = Math.max(styledAscii.length, rightLines.length);
	const result = [""];
	for (let i = 0; i < maxRows; i++) {
		const left = i < styledAscii.length ? styledAscii[i] : " ".repeat(33);
		const right = rightLines[i] ?? "";
		result.push(left + (right ? "   " + right : ""));
	}
	return result;
}

export default function headerExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		let expanded = ctx.ui.getToolsExpanded?.() ?? false;

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return buildHeaderLines(theme, expanded, width);
			},
			setExpanded(value: boolean) {
				expanded = value;
			},
			invalidate() {},
		}));
	});

	pi.registerCommand("builtin-header", {
		description: "Restore the built-in startup header",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
