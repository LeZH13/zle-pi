/**
 * The footer status line renderer. Pure and style-agnostic: the caller supplies
 * a styler (`theme.fg`) so tests can assert plain text and the wiring can blend
 * with pi's default dimmed footer text.
 *
 * Shape: `⛨ BG <mode badge>[ · degraded label][ · <activity>]`. The badge is
 * the guard's effective mode: "ask"/"deny" while the guard runs, "off"
 * otherwise (including when only the watchdog runs, next to a "watch-only"
 * label, so it never shows a misleading "ask").
 */
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { APPROVAL_MODE_ENV, type ApprovalMode, type WatchdogStopMode } from "./config.js";
import type { JevFailureReason } from "./jev.js";
import { redactSecrets } from "./redact.js";
import type { GuardMode } from "./state.js";
import type { WatchCheckRecord, WatchLive } from "./watchdog.js";

/** Risky-command decisions this session. */
export interface GuardTally {
	passed: number;
	asked: number;
	blocked: number;
}

export interface BashGuardStatusState {
	/** Effective guard mode shown in the badge; "off" also when only the watchdog runs. */
	guardMode: "ask" | "deny" | "off";
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

	if (state.guardMode === "off" && !state.watchdogOn) {
		return `${dim("⛨ BG")} ${dim("off")}`;
	}

	// Degraded label: at most one, most severe first.
	const watchInert = state.bashConflict || !state.jevAvailable;
	let label: string | undefined;
	if (!state.jevAvailable) label = dim("rules-only");
	else if (state.watchdogOn && state.bashConflict) label = warning("⚠ bash conflict");
	else if (state.jevFailure) label = warning(`jev ✗ ${state.jevFailure}`);
	else if (!state.watchdogOn) label = dim("guard-only");
	else if (state.guardMode === "off") label = dim("watch-only");

	const activity = state.live && state.watchdogOn && !watchInert ? renderLive(state.live, dim, warning) : renderTally(state, dim, warning);

	const parts = [dim(state.guardMode), label, activity].filter((part): part is string => part !== undefined);
	return `${dim("⛨ BG")} ${parts.join(dim(" · "))}`;
}

function renderTally(
	state: BashGuardStatusState,
	dim: (text: string) => string,
	warning: (text: string) => string,
): string | undefined {
	if (state.guardMode === "off") return undefined;
	const { passed, asked, blocked } = state.tally;
	const chunks: string[] = [];
	if (passed > 0) chunks.push(dim(`${passed}✓`));
	if (asked > 0) chunks.push(dim(`${asked}?`));
	if (blocked > 0) chunks.push(warning(`${blocked}✗`));
	return chunks.length === 0 ? undefined : chunks.join(dim(" "));
}

export function sanitizeLine(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function commandPreview(command: string): string {
	return sanitizeLine(command).replace(/\s+/g, " ").trim();
}

/** Compact command label; shortens a leading path binary to its basename. */
export function chipCommand(command: string, maxLen = 16): string {
	let preview = commandPreview(command);
	const quotedPath = preview.match(/^"([^"\s]+\/([^"\s/]+))"(\s.*)?$/);
	if (quotedPath) preview = `${quotedPath[2]!}${quotedPath[3] ?? ""}`;
	else {
		const barePath = preview.match(/^(\S+\/([^\s/]+))(\s.*)?$/);
		if (barePath) preview = `${barePath[2]!}${barePath[3] ?? ""}`;
	}
	return truncateToWidth(preview, maxLen, "…");
}

function renderLive(live: WatchLive, dim: (text: string) => string, warning: (text: string) => string): string {
	if (live.pendingDecisions) {
		return `${dim(`⏱ ${live.running} watched · `)}${warning(`${live.pendingDecisions} awaiting decision`)}`;
	}
	const elapsed = formatElapsed(live.elapsedSeconds);
	const check = live.check;
	if (!check) {
		return dim(`⏱${live.running > 1 ? live.running : ""} ${elapsed}`);
	}
	const styledVerdict = styleVerdict(check, dim, warning);
	if (live.running <= 1) {
		return `${dim(`⏱ ${elapsed}`)} ${styledVerdict}`;
	}
	const warnings = live.warnings ?? 0;
	const head = warnings > 1 ? `${dim(`⏱${live.running}`)} ${warning(`${warnings}⚠`)}` : dim(`⏱${live.running}`);
	const cmd = live.command ? chipCommand(live.command, 16) : "";
	const focus = cmd ? `${cmd} ${elapsed}` : elapsed;
	return `${head}${dim(" · ")}${dim(focus)} ${styledVerdict}`;
}

function styleVerdict(
	check: NonNullable<WatchLive["check"]>,
	dim: (text: string) => string,
	warning: (text: string) => string,
): string {
	if (check.service) return dim("service");
	const verdict = `${check.status} ${prob(check.p)}`;
	if (check.agree > 0) return warning(`${verdict} (${check.agree}/${check.agreeNeeded} agree)`);
	const bad = check.status === "stuck" || check.status === "looping";
	return bad ? warning(verdict) : dim(verdict);
}

/** Snapshot needed to render the `/bash-guard status` details view. */
export interface StatusDetailsInput {
	guard: {
		mode: GuardMode;
		approvalMode: ApprovalMode;
		approvalSource: "config" | "session" | "env";
		envEnforced: boolean;
		envError?: string;
		configEnabled: boolean;
		sessionSetting?: GuardMode;
		allowBelow: number;
		sessionAllowedCount: number;
		allowPatternCount: number;
		extraRiskyPatternCount: number;
		tally: GuardTally;
	};
	watchdog: {
		on: boolean;
		stopMode: WatchdogStopMode;
		stopModeSource: "config" | "session";
		configEnabled: boolean;
		sessionSetting?: boolean;
		running: number;
		pendingDecisions: number;
		bashConflict: boolean;
		bashRegistered: boolean;
		firstCheckSec: number;
		intervalSec: number;
		agreeChecks: number;
		confidence: number;
	};
	jev: {
		available: boolean;
		model?: string;
		unavailableReason?: string;
		timeoutMs: number;
		lastFailure?: JevFailureReason;
		usage: { totalTokens: number; cost: number };
	};
	config: {
		flagDisabled: boolean;
		files: readonly string[];
		ignoredProjectKeys?: { path: string; keys: readonly string[] };
	};
	recentChecks: readonly { command: string; checks: readonly WatchCheckRecord[] }[];
}

const DETAILS_LABEL_WIDTH = 14;

function detailsRow(label: string, value: string | number): string {
	return `  ${label.padEnd(DETAILS_LABEL_WIDTH)} ${value}`;
}

function detailsSection(title: string): string {
	return `── ${title} ──`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatGuardMode(guard: StatusDetailsInput["guard"], flagDisabled: boolean): string {
	if (guard.envError) return `⚠ deny (fail closed: ${guard.envError})`;
	if (guard.mode !== "off") {
		const source = guard.envEnforced
			? `env enforced via ${APPROVAL_MODE_ENV}`
			: guard.approvalSource === "env"
				? `env via ${APPROVAL_MODE_ENV}`
				: guard.approvalSource;
		return `${guard.mode} (${source})`;
	}
	if (flagDisabled) return "off (disabled by --no-bash-guard)";
	if (!guard.configEnabled) return "off (disabled in config)";
	if (guard.sessionSetting === "off") {
		return guard.approvalSource === "env"
			? `off (disabled in session; env approval: ${guard.approvalMode})`
			: "off (disabled in session)";
	}
	return "off";
}

function formatWatchdogMode(watchdog: StatusDetailsInput["watchdog"], flagDisabled: boolean): string {
	if (watchdog.on) return `${watchdog.stopMode} (${watchdog.stopModeSource})`;
	if (flagDisabled) return "off (disabled by --no-bash-guard)";
	if (!watchdog.configEnabled) return "off (disabled in config)";
	if (watchdog.sessionSetting === false) return `off (disabled in session; stop mode: ${watchdog.stopMode})`;
	return "off";
}

/** Format one recent watchdog check line for the status details view. */
export function formatWatchCheck(check: WatchCheckRecord): string {
	const p = check.status === undefined ? undefined : check.probabilities?.[check.status];
	const statusText = check.status === undefined
		? undefined
		: p === undefined ? check.status : `${check.status} (${p.toFixed(2)})`;
	const outcome = commandPreview(check.outcome);
	const parts = [
		statusText,
		check.persistent === undefined ? undefined : `service ${check.persistent.toFixed(2)}`,
		outcome.startsWith("failed:") ? `⚠ ${outcome}` : outcome,
	].filter(Boolean);
	return `${formatElapsed(check.elapsedSeconds).padEnd(6)} ${parts.join(" · ")}`;
}

/** Render the multi-section status details shown by `/bash-guard status` and "View details". */
export function renderStatusDetails(input: StatusDetailsInput): string {
	const alerts: string[] = [];
	if (input.config.flagDisabled) alerts.push("⚠ --no-bash-guard");
	if (input.guard.envError) alerts.push("⚠ fail closed");
	if (input.watchdog.on && input.watchdog.bashConflict) alerts.push("⚠ bash conflict");
	if (input.jev.lastFailure) alerts.push(`⚠ jev: ${input.jev.lastFailure}`);
	if (input.config.ignoredProjectKeys) alerts.push("⚠ project keys ignored");

	const summary = [
		`Guard: ${input.guard.mode}`,
		`Watchdog: ${input.watchdog.on ? input.watchdog.stopMode : "off"}`,
		`Jev: ${input.jev.available ? "on" : "off (rules-only)"}`,
		...alerts,
	].join(" · ");

	const watching = input.watchdog.pendingDecisions > 0
		? `${input.watchdog.running} running · ⚠ ${input.watchdog.pendingDecisions} awaiting decision`
		: `${input.watchdog.running} running`;

	const bashOverride = input.watchdog.bashConflict
		? "⚠ unavailable (owned by another extension)"
		: input.watchdog.bashRegistered ? "active" : "not registered";

	const lines = [
		"Bash Guard · Status",
		summary,
		"",
		detailsSection("Guard"),
		detailsRow("Mode", formatGuardMode(input.guard, input.config.flagDisabled)),
		detailsRow("Decisions", `${input.guard.tally.passed} passed by Jev · ${input.guard.tally.asked} approved · ${input.guard.tally.blocked} blocked`),
		detailsRow("Allow below", `${input.guard.allowBelow} (risk score)`),
		detailsRow("Allowlist", `${plural(input.guard.sessionAllowedCount, "session command")} · ${plural(input.guard.allowPatternCount, "config pattern")}`),
		detailsRow("Extra risky", plural(input.guard.extraRiskyPatternCount, "custom pattern")),
		"",
		detailsSection("Watchdog"),
		detailsRow("Mode", formatWatchdogMode(input.watchdog, input.config.flagDisabled)),
		detailsRow("Watching", watching),
		detailsRow("Bash override", bashOverride),
		detailsRow("Checks", `first at ${input.watchdog.firstCheckSec}s, then every ${input.watchdog.intervalSec}s`),
		detailsRow("Stop rule", `${plural(input.watchdog.agreeChecks, "consecutive check")} ≥ ${input.watchdog.confidence} confidence`),
		"",
		detailsSection("Jev classifier"),
		detailsRow("Status", input.jev.available ? "on" : "⚠ off"),
		input.jev.available
			? detailsRow("Model", input.jev.model ?? "unknown")
			: detailsRow("Reason", input.jev.unavailableReason ?? "unavailable"),
		detailsRow("Timeout", `${input.jev.timeoutMs}ms`),
	];

	if (input.jev.lastFailure) lines.push(detailsRow("Last error", `⚠ ${input.jev.lastFailure}`));
	if (input.jev.usage.totalTokens > 0) {
		const cost = input.jev.usage.cost;
		lines.push(detailsRow("Usage", `${input.jev.usage.totalTokens} tokens · $${cost.toFixed(cost >= 0.01 ? 2 : 4)}`));
	}

	lines.push("", detailsSection("Configuration"));
	if (input.config.flagDisabled) {
		const effect = input.guard.envEnforced
			? "watchdog disabled; guard stays on in enforced deny mode"
			: "disables guard & watchdog";
		lines.push(detailsRow("Launch flag", `⚠ --no-bash-guard (${effect})`));
	}
	if (input.config.files.length === 0) {
		lines.push(detailsRow("Config files", "none (using defaults)"));
	} else {
		for (const [index, file] of input.config.files.entries()) {
			lines.push(detailsRow(index === 0 ? "Config files" : "", file));
		}
	}
	if (input.config.ignoredProjectKeys) {
		lines.push(
			detailsRow("Ignored keys", `⚠ ${input.config.ignoredProjectKeys.keys.join(", ")}`),
			detailsRow("Project file", input.config.ignoredProjectKeys.path),
		);
	}

	if (input.recentChecks.length > 0) {
		lines.push("", detailsSection("Recent watchdog checks"));
		for (const log of input.recentChecks) {
			lines.push(`  $ ${truncateToWidth(commandPreview(redactSecrets(log.command)), 64)}`);
			for (const check of log.checks) lines.push(`    ${formatWatchCheck(check)}`);
		}
	}

	return lines.join("\n");
}
