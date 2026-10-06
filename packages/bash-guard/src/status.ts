/**
 * The footer status line renderer. Pure and style-agnostic: the caller supplies
 * a styler (`theme.fg`) so tests can assert plain text and the wiring can blend
 * with pi's default dimmed footer text.
 */

export interface BashGuardStatusState {
	flagDisabled: boolean;
	guardOn: boolean;
	watchdogOn: boolean;
	jevAvailable: boolean;
	/** Commands currently watched. */
	running: number;
	bashConflict: boolean;
}

export type StatusStyler = (text: string, kind: "dim" | "warning") => string;

/** Compose the status line; every chunk passes through the styler. */
export function renderStatus(state: BashGuardStatusState, styler: StatusStyler): string {
	const dim = (text: string): string => styler(text, "dim");
	const warning = (text: string): string => styler(text, "warning");

	if (state.flagDisabled || (!state.guardOn && !state.watchdogOn)) {
		return dim("⛨ off");
	}

	const segments: string[] = [];
	if (state.guardOn) segments.push("bg");
	// The watchdog is inert without a Jev model, so its segment is suppressed.
	if (state.watchdogOn && state.jevAvailable) {
		segments.push(state.running > 0 ? `watch(${state.running})` : "watch");
	}
	if (state.jevAvailable) segments.push("jev");
	else if (state.guardOn) segments.push("rules-only");

	let out = dim("⛨ ");
	if (segments.length === 0) {
		out += dim("off");
	} else {
		out += segments.map(dim).join(dim(" · "));
	}
	if (state.bashConflict && segments.length > 0) {
		out += dim(" · ") + warning("⚠ bash conflict");
	}
	return out;
}
