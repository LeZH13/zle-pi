/**
 * The watchdog: watch running bash commands and ask Jev periodically whether
 * they are progressing, waiting, stuck, or looping.
 *
 * A stop recommendation requires `agreeChecks` consecutive checks with a stuck/looping status at
 * or above `confidence`. A high `persistent` probability (a legitimate long-lived
 * service) vetoes the kill - except for `looping`, which always counts as a
 * failure loop - and instead steers the agent once per command to background
 * such services. Killing aborts the command's own AbortController; pi's bash
 * tool then reports the process tree as terminated, and the wrapper in
 * extensions/index.ts turns that into a watchdog-specific error message.
 */
import type { BashGuardConfig, WatchdogStopMode } from "./config.js";
import { commandPreview } from "./status.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Jev, WatchdogJevAnswer, WatchdogStatus } from "./jev.js";
import { redactSecrets } from "./redact.js";
import { truncateTail } from "@earendil-works/pi-coding-agent";
/** Bound on the raw output tail kept per command, in characters. */
const TAIL_LIMIT_CHARS = 6000;

/** Bound on the tail sent to Jev and error messages, in characters. */
const REPORT_TAIL_CHARS = 1500;

export interface StopRecommendation {
	command: string;
	jobId?: string;
	elapsedSeconds: number;
	reason: string;
}

export interface WatchdogDeps {
	stopMode?(): WatchdogStopMode;
	approveStop?(recommendation: StopRecommendation, signal: AbortSignal): Promise<boolean>;
	config: BashGuardConfig;
	jev: Jev;
	now(): number;
	/** Steer the agent mid-run (pi.sendUserMessage with deliverAs "steer"). */
	steer(message: string): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

export interface WatchdogHandle {
	readonly id: number;
	readonly command: string;
	readonly cwd: string;
}

/** One Jev check on a running command, for the UI log. */
export interface WatchCheckRecord {
	/** Seconds since the command started (when the check began). */
	elapsedSeconds: number;
	/** Present when Jev answered. */
	status?: WatchdogStatus;
	/** All choice probabilities keyed by label, when Jev answered. */
	probabilities?: Record<string, number>;
	/** Probability that the command is a legitimate long-lived service, when Jev answered. */
	persistent?: number;
	/** "agree n/N" | "veto" | "kill" | "failed: <reason>". */
	outcome: string;
}

/** Live view of the highest-priority watched command, for the footer. */
export interface WatchLive {
	pendingDecisions?: number;
	/** Commands currently watched. */
	running: number;
	/** Running commands currently flagged stuck or looping (excluding services). */
	warnings: number;
	/** Command text of the spotlighted watched command. */
	command: string;
	/** Seconds since the spotlighted command started. */
	elapsedSeconds: number;
	/** Its latest Jev answer; unset before the first check or after a failed one. */
	check?: {
		status: WatchdogStatus;
		/** Probability of the chosen status. */
		p: number;
		/** Consecutive kill-worthy checks so far, and how many trigger a kill. */
		agree: number;
		agreeNeeded: number;
		/** Judged a legitimate long-lived service, so the kill was vetoed. */
		service: boolean;
	};
}

/** Records kept per command, and commands kept in the log map. */
const MAX_CHECKS_PER_COMMAND = 10;
const MAX_LOGGED_COMMANDS = 40;

interface Entry {
	id: number;
	command: string;
	cwd: string;
	startedAt: number;
	lastOutputChangeAt: number;
	tail: string;
	outputDirty: boolean;
	active: boolean;
	killed: boolean;
	killReason?: string;
	steered: boolean;
	agreeCount: number;
	decision?: "pending" | "keep";
	jobId?: string;
	lastCheck?: WatchLive["check"];
	timer?: ReturnType<typeof setTimeout>;
	checkAbort?: AbortController;
	abort: () => void;
}
const STATUS_TEXT: Record<WatchdogStatus, string> = {
	progressing: "progressing",
	waiting: "legitimately waiting",
	stuck: "stuck",
	looping: "looping on repeated failure",
};

export class Watchdog {
	private readonly deps: WatchdogDeps;
	private nextId = 1;
	private readonly entries = new Map<number, Entry>();
	/** Per-command check logs, kept for running and recently finished commands. */
	private readonly logs = new Map<string, WatchCheckRecord[]>();

	constructor(deps: WatchdogDeps) {
		this.deps = deps;
	}

	get firstCheckMs(): number {
		return this.deps.config.watchdog.firstCheckSec * 1000;
	}

	get intervalMs(): number {
		return this.deps.config.watchdog.intervalSec * 1000;
	}

	/** Track a running command. `hooks.abort` must abort that command's execution. */
	start(command: string, cwd: string, hooks: { abort(): void; jobId?: string }): WatchdogHandle {
		const now = this.deps.now();
		const entry: Entry = {
			id: this.nextId++,
			command,
			cwd,
			startedAt: now,
			lastOutputChangeAt: now,
			tail: "",
			outputDirty: false,
			active: true,
			killed: false,
			steered: false,
			agreeCount: 0,
			abort: hooks.abort,
			jobId: hooks.jobId,
		};
		this.entries.set(entry.id, entry);
		this.logs.delete(command); // a fresh run starts a fresh log
		this.logs.set(command, []);
		while (this.logs.size > MAX_LOGGED_COMMANDS) {
			const oldest = this.logs.keys().next().value;
			if (oldest === undefined) break;
			this.logs.delete(oldest);
		}
		this.arm(entry, this.firstCheckMs);
		return entry;
	}

	recordOutput(handle: WatchdogHandle, text: string): void {
		const entry = this.entries.get(handle.id);
		if (!entry || !entry.active) return;
		entry.tail = entry.tail.length + text.length > TAIL_LIMIT_CHARS
			? (entry.tail + text).slice(-TAIL_LIMIT_CHARS)
			: entry.tail + text;
		entry.lastOutputChangeAt = this.deps.now();
		entry.outputDirty = true;
	}

	/** Stop tracking a command: clears its timers. Safe to call twice. */
	finish(handle: WatchdogHandle): void {
		const entry = this.entries.get(handle.id);
		if (!entry) return;
		entry.active = false;
		this.clearTimers(entry);
		this.entries.delete(entry.id);
	}

	/** Clear every timer and cancel in-flight checks. Idempotent. */
	dispose(): void {
		for (const entry of [...this.entries.values()]) {
			entry.active = false;
			this.clearTimers(entry);
		}
		this.entries.clear();
	}

	runningCount(): number {
		return this.entries.size;
	}

	withdrawStopDecisions(): void {
		for (const entry of this.entries.values()) {
			if (entry.decision !== "pending") continue;
			entry.decision = "keep";
			entry.agreeCount = 0;
			entry.lastCheck = undefined;
			entry.checkAbort?.abort();
		}
	}

	/** The highest-priority watched command, or undefined when none runs. */
	live(): WatchLive | undefined {
		let focus: Entry | undefined;
		let warnings = 0;
		let pendingDecisions = 0;
		for (const entry of this.entries.values()) {
			if (isWarningCheck(entry.lastCheck)) warnings++;
			if (entry.decision === "pending") pendingDecisions++;
			if (!focus || compareLivePriority(entry, focus) < 0) focus = entry;
		}
		if (!focus) return undefined;
		return {
			running: this.entries.size,
			...(pendingDecisions ? { pendingDecisions } : {}),
			warnings,
			command: focus.command,
			elapsedSeconds: Math.max(0, Math.floor((this.deps.now() - focus.startedAt) / 1000)),
			...(focus.lastCheck ? { check: focus.lastCheck } : {}),
		};
	}

	/** Whether the watchdog killed this command's process. */
	isKilled(handle: WatchdogHandle): boolean {
		return this.entries.get(handle.id)?.killed ?? false;
	}

	/** The check log for one command (running or recently finished). */
	getLog(command: string): readonly WatchCheckRecord[] {
		return this.logs.get(command) ?? [];
	}

	/** Commands with non-empty logs, most recent first. */
	recentLogs(limit: number): { command: string; checks: readonly WatchCheckRecord[] }[] {
		const result: { command: string; checks: readonly WatchCheckRecord[] }[] = [];
		for (const [command, checks] of [...this.logs.entries()].reverse()) {
			if (checks.length === 0) continue;
			result.push({ command, checks });
			if (result.length >= limit) break;
		}
		return result;
	}

	private clearTimers(entry: Entry): void {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.checkAbort?.abort();
		entry.checkAbort = undefined;
	}

	private arm(entry: Entry, delayMs: number): void {
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			void this.runCheck(entry);
		}, delayMs);
	}

	private async runCheck(entry: Entry): Promise<void> {
		if (!entry.active || entry.killed) return;
		try {
			await this.check(entry);
		} catch {
			// A check failure must never break the watched command.
		}
		if (entry.active && !entry.killed && entry.decision !== "keep") {
			this.arm(entry, this.intervalMs);
		}
	}

	private async check(entry: Entry): Promise<void> {
		const elapsed = (): number => Math.max(0, Math.round((this.deps.now() - entry.startedAt) / 1000));
		const record = (outcome: string, answer?: WatchdogJevAnswer): void => {
			entry.lastCheck = answer
				? {
						status: answer.status,
						p: answer.pStatus,
						agree: entry.agreeCount,
						agreeNeeded: this.deps.config.watchdog.agreeChecks,
						service: outcome === "veto",
					}
				: undefined;
			const checks = this.logs.get(entry.command);
			if (!checks) return;
			checks.push({
				elapsedSeconds: elapsed(),
				...(answer
					? { status: answer.status, probabilities: answer.probabilities, persistent: answer.persistent }
					: {}),
				outcome,
			});
			if (checks.length > MAX_CHECKS_PER_COMMAND) checks.splice(0, checks.length - MAX_CHECKS_PER_COMMAND);
		};

		const checkAbort = new AbortController();
		entry.checkAbort = checkAbort;
		const available = await this.deps.jev.ensureAvailable(checkAbort.signal);
		if (!entry.active || entry.killed || checkAbort.signal.aborted) return;
		if (!available) {
			// No Jev to judge with: stay neutral and forgetful.
			entry.agreeCount = 0;
			record("failed: no Jev classifier available");
			return;
		}
		const now = this.deps.now();
		const changedSinceLastCheck = entry.outputDirty;
		const state = {
			value: {
				command: redactSecrets(entry.command),
				cwd: redactSecrets(entry.cwd),
				runtime_seconds: Math.max(0, Math.round((now - entry.startedAt) / 1000)),
				seconds_since_output_change: Math.max(0, Math.round((now - entry.lastOutputChangeAt) / 1000)),
				output_changed_since_last_check: changedSinceLastCheck,
				output_tail: tailForReport(entry.tail),
			},
		};
		const answer = await this.deps.jev.watchdogAnswer(state, checkAbort.signal);
		if (!entry.active || entry.killed) return;
		entry.outputDirty = false;
		if (!answer.ok) {
			// Neutral AND forgetful: an unavailable Jev must not let one earlier
			// agreeing check pair with a later one across the outage.
			entry.agreeCount = 0;
			record(`failed: ${answer.detail !== undefined ? `${answer.reason}: ${answer.detail}` : answer.reason}`);
			return;
		}

		const killWorthy = (answer.status === "stuck" || answer.status === "looping") && answer.pStatus >= this.deps.config.watchdog.confidence;
		if (!killWorthy) {
			entry.agreeCount = 0;
			record(`agree 0/${this.deps.config.watchdog.agreeChecks}`, answer);
			return;
		}

		if (answer.persistent >= 0.5 && answer.status !== "looping") {
			// A long-lived service operating normally: never kill, steer once.
			entry.agreeCount = 0;
			record("veto", answer);
			if (!entry.steered) {
				entry.steered = true;
				this.deps.steer(
					`bash-guard: \`${entry.command}\` looks like a long-lived service (Jev: persistent p=${answer.persistent.toFixed(2)}, status ${answer.status}). ` +
						"If it should keep running, start it in the background instead of holding a bash tool call, e.g. `nohup <command> > /tmp/name.log 2>&1 &`, then tail the log on demand.",
				);
			}
			return;
		}

		entry.agreeCount++;
		if (entry.agreeCount >= this.deps.config.watchdog.agreeChecks) {
			const reason = `Jev judged the running command ${STATUS_TEXT[answer.status]} (confidence ${answer.pStatus.toFixed(2)}) across ${entry.agreeCount} consecutive checks`;
			const mode = this.deps.stopMode?.() ?? this.deps.config.watchdog.stopMode;
			if (mode === "notify-only") {
				const command = truncateToWidth(commandPreview(redactSecrets(entry.command)), 240);
				entry.decision = "keep";
				entry.agreeCount = 0;
				record("notified", answer);
				this.deps.notify(`Watchdog: leaving command running after ${elapsed()}s\n$ ${command}\n${reason}`, "warning");
				return;
			}
			if (mode === "ask") {
				entry.decision = "pending";
				record("awaiting decision", answer);
				let approved = false;
				try {
					approved = await this.deps.approveStop?.({
						command: entry.command, jobId: entry.jobId, elapsedSeconds: elapsed(), reason,
					}, checkAbort.signal) === true;
				} catch {
					// An unavailable dialog is not consent.
				}
				if (!entry.active || checkAbort.signal.aborted) return;
				if (!approved) {
					entry.decision = "keep";
					entry.agreeCount = 0;
					record("kept running");
					return;
				}
				entry.decision = undefined;
			}
			record("kill", answer);
			this.kill(entry, reason);
		} else {
			record(`agree ${entry.agreeCount}/${this.deps.config.watchdog.agreeChecks}`, answer);
		}
	}

	private kill(entry: Entry, reason: string): void {
		entry.killed = true;
		entry.killReason = reason;
		this.clearTimers(entry);
		this.deps.notify(`bash-guard killed: ${entry.command}\n${entry.killReason}`, "error");
		this.deps.steer(
			`bash-guard killed the bash command \`${entry.command}\` after ${Math.round((this.deps.now() - entry.startedAt) / 1000)}s (${entry.killReason}). ` +
				"Try a different approach; do not rerun the same command unchanged.",
		);
		entry.abort();
	}

	/** The error text the bash tool surfaces when the watchdog killed a command. */
	killMessage(handle: WatchdogHandle): string {
		const entry = this.entries.get(handle.id);
		const reason = entry?.killReason ?? "watchdog kill";
		const runtimeSeconds = entry ? Math.max(0, Math.round((this.deps.now() - entry.startedAt) / 1000)) : 0;
		const tail = entry ? tailForReport(entry.tail) : "";
		return (
			`Command killed by bash-guard watchdog after ${runtimeSeconds}s. Reason: ${reason}. ` +
			"Try a different approach; do not rerun the same command unchanged." +
			(tail ? `\nLast output (redacted):\n${tail}` : "")
		);
	}
}

function tailForReport(tail: string): string {
	if (!tail) return "";
	const result = truncateTail(tail, { maxBytes: REPORT_TAIL_CHARS, maxLines: 60 });
	return redactSecrets(result.content);
}

function isWarningCheck(check: Entry["lastCheck"]): boolean {
	return check !== undefined && !check.service && (check.status === "stuck" || check.status === "looping");
}

function liveTier(check: Entry["lastCheck"]): number {
	if (!check) return 0;
	if (check.service) return 1;
	if (check.agree > 0) return 4;
	if (check.status === "stuck" || check.status === "looping") return 3;
	return 2;
}

/** Negative when `a` should take priority over `b` in the footer spotlight. */
function compareLivePriority(a: Entry, b: Entry): number {
	const tierDiff = liveTier(b.lastCheck) - liveTier(a.lastCheck);
	if (tierDiff !== 0) return tierDiff;
	if (a.lastCheck && b.lastCheck) {
		if (liveTier(a.lastCheck) === 4) {
			const ratioDiff =
				b.lastCheck.agree / Math.max(1, b.lastCheck.agreeNeeded) -
				a.lastCheck.agree / Math.max(1, a.lastCheck.agreeNeeded);
			if (ratioDiff !== 0) return ratioDiff;
		}
		if (liveTier(a.lastCheck) >= 3) {
			const pDiff = b.lastCheck.p - a.lastCheck.p;
			if (pDiff !== 0) return pDiff;
		}
	}
	return a.startedAt - b.startedAt;
}
