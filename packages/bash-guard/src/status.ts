/**
 * The footer status line renderer. Pure and style-agnostic: the caller supplies
 * a styler (`theme.fg`) so tests can assert plain text and the wiring can blend
 * with pi's default dimmed footer text.
 *
 * Shape: `⛨ BG [degraded label ·] <activity>`, where activity is the live
 * watchdog view while commands run and the guard tally otherwise.
 */
import type { JevFailureReason } from "./jev.js";
import type { WatchLive } from "./watchdog.js";

/** Risky-command decisions this session. */
export interface GuardTally {
	passed: number;
	asked: number;
	blocked: number;
}

export interface BashGuardStatusState {
	flagDisabled: boolean;
	guardOn: boolean;
	watchdogOn: boolean;
	jevAvailable: boolean;
	/** Most recent Jev call failure; unset after a success. */
	jevFailure?: JevFailureReason;
	bashConflict: boolean;
	tally: GuardTally;
	/** Present while watched commands run. */
	live?: WatchLive;
}

export type StatusStyler = (text: string, kind: "dim" | "warning") => string;

/** Format seconds as m:ss, or h:mm:ss from one hour. */
export function formatElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Probability as ".92" (1 renders as "1.0"). */
function prob(p: number): string {
	return p >= 1 ? "1.0" : p.toFixed(2).slice(1);
}

/** Compose the status line; every chunk passes through the styler. */
export function renderStatus(state: BashGuardStatusState, styler: StatusStyler): string {
	const dim = (text: string): string => styler(text, "dim");
	const warning = (text: string): string => styler(text, "warning");
	const head = dim("⛨ BG");

	if (state.flagDisabled || (!state.guardOn && !state.watchdogOn)) {
		return `${head} ${dim("off")}`;
	}

	// Degraded label: at most one, most severe first.
	const watchInert = state.bashConflict || !state.jevAvailable;
	let label: string | undefined;
	if (!state.jevAvailable) label = dim("rules-only");
	else if (state.watchdogOn && state.bashConflict) label = warning("⚠ bash conflict");
	else if (state.jevFailure) label = warning(`jev ✗ ${state.jevFailure}`);
	else if (!state.watchdogOn) label = dim("guard-only");
	else if (!state.guardOn) label = dim("watch-only");

	const activity = state.live && state.watchdogOn && !watchInert ? renderLive(state.live, dim, warning) : renderTally(state, dim, warning);

	const parts = [label, activity].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? head : `${head} ${parts.join(dim(" · "))}`;
}

function renderTally(
	state: BashGuardStatusState,
	dim: (text: string) => string,
	warning: (text: string) => string,
): string | undefined {
	if (!state.guardOn) return undefined;
	const { passed, asked, blocked } = state.tally;
	const chunks: string[] = [];
	if (passed > 0) chunks.push(dim(`${passed}✓`));
	if (asked > 0) chunks.push(dim(`${asked}?`));
	if (blocked > 0) chunks.push(warning(`${blocked}✗`));
	return chunks.length === 0 ? undefined : chunks.join(dim(" "));
}

function renderLive(live: WatchLive, dim: (text: string) => string, warning: (text: string) => string): string {
	const clock = dim(`⏱${live.running > 1 ? live.running : ""} ${formatElapsed(live.elapsedSeconds)}`);
	const check = live.check;
	if (!check) return clock;
	if (check.service) return `${clock} ${dim("service")}`;
	const verdict = `${check.status} ${prob(check.p)}`;
	if (check.agree > 0) return `${clock} ${warning(`${verdict} kill ${check.agree}/${check.agreeNeeded}`)}`;
	const bad = check.status === "stuck" || check.status === "looping";
	return `${clock} ${bad ? warning(verdict) : dim(verdict)}`;
}
