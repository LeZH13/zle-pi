/**
 * The guard: judge bash tool calls for irreversibility.
 *
 * Non-risky commands pass instantly with no Jev call. Risky commands are asked
 * one noul question ("could this cause irreversible loss?"); anything below
 * `allowBelow` passes, everything else - irreversible, uncertain, Jev error,
 * timeout, malformed response - escalates to the user (or blocks when there is
 * no UI). The state sent to Jev is deliberately tiny: command, matched rule
 * reasons, cwd, and cheap git facts. Nothing else leaves the machine.
 */
import type { BashGuardConfig } from "./config.js";
import type { Jev } from "./jev.js";
import { redactSecrets } from "./redact.js";
import type { RiskyMatch, RiskyScan } from "./rules.js";
import { findRisky } from "./rules.js";

export interface GitInfo {
	branch?: string;
	dirty?: boolean;
}

export interface GuardInput {
	command: string;
	cwd: string;
	signal?: AbortSignal;
}

export type GuardOutcome =
	| { action: "allow"; reason: string }
	| { action: "block"; reason: string };

export const SELECT_OPTIONS = ["Allow once", "Allow for this session", "Block"] as const;

export interface GuardDeps {
	config: BashGuardConfig;
	jev: Jev;
	risky: RiskyScan;
	/** Cheap git facts for the Jev state; must tolerate non-repo directories. */
	gitInfo(cwd: string): Promise<GitInfo>;
	hasUI: boolean;
	select(title: string, options: readonly string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	/** Exact-command allowlist remembered for this session. */
	isSessionAllowed(command: string): boolean;
	allowForSession(command: string): void;
	/** One-time "Jev is off" notice when running rules-only. */
	notifyJevOffOnce(): void;
}

function reasonList(matches: readonly RiskyMatch[]): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const match of matches) {
		if (seen.has(match.description)) continue;
		seen.add(match.description);
		parts.push(`${match.ruleId}: ${match.description}`);
	}
	return parts.join("; ");
}

export async function runGuard(deps: GuardDeps, input: GuardInput): Promise<GuardOutcome> {
	const { command } = input;

	if (deps.isSessionAllowed(command)) {
		return { action: "allow", reason: "allowed for this session" };
	}

	const scan = findRisky(command, deps.risky);
	if (scan.allowed) {
		return { action: "allow", reason: "matched an allow pattern" };
	}
	if (scan.matches.length === 0) {
		return { action: "allow", reason: "no risky pattern matched" };
	}

	const reasons = reasonList(scan.matches);

	if (!(await deps.jev.ensureAvailable())) {
		deps.notifyJevOffOnce();
		return escalate(deps, input, reasons, undefined, `Jev is off: ${deps.jev.describeUnavailable()}`);
	}

	const git = await deps.gitInfo(input.cwd);
	// The command, cwd, and reason text are redacted: nothing secret-bearing
	// reaches Jev even when the user pattern includes a credential.
	const state = {
		value: {
			command: redactSecrets(command),
			matched_rules: scan.matches.map((match) => ({
				id: match.ruleId,
				description: redactSecrets(match.description),
			})),
			cwd: redactSecrets(input.cwd),
			git: { branch: redactSecrets(git.branch ?? ""), dirty: git.dirty ?? false },
		},
	};

	const answer = await deps.jev.guardAnswer(state, input.signal);
	if (!answer.ok) {
		const detail = answer.detail !== undefined ? `Jev ${answer.reason}: ${answer.detail}` : `Jev ${answer.reason}`;
		return escalate(deps, input, reasons, undefined, detail);
	}

	if (answer.p < deps.config.guard.allowBelow) {
		return { action: "allow", reason: `Jev judged it recoverable (p=${answer.p.toFixed(2)})` };
	}

	return escalate(deps, input, reasons, answer.p, `irreversible p=${answer.p.toFixed(2)} (allowBelow=${deps.config.guard.allowBelow})`);
}

async function escalate(
	deps: GuardDeps,
	input: GuardInput,
	reasons: string,
	probability: number | undefined,
	jevDetail: string,
): Promise<GuardOutcome> {
	if (input.signal?.aborted) {
		return { action: "block", reason: `aborted before decision (${jevDetail})` };
	}
	const blockReason = `bash-guard: risky command - ${reasons} - ${jevDetail}`;
	if (!deps.hasUI) {
		return { action: "block", reason: `${blockReason} (no UI to confirm)` };
	}
	let choice: string | undefined;
	try {
		// The dialog auto-dismisses when the signal aborts; the post-select check
		// below still fails closed.
		choice = await deps.select(`bash-guard risky command\n${reasons}\n${jevDetail}`, SELECT_OPTIONS, { signal: input.signal });
	} catch {
		return { action: "block", reason: `${blockReason} (selection failed)` };
	}
	if (input.signal?.aborted) {
		return { action: "block", reason: `${blockReason} (aborted during confirmation)` };
	}
	if (choice === "Allow once") {
		return { action: "allow", reason: "allowed once by user" };
	}
	if (choice === "Allow for this session") {
		deps.allowForSession(input.command);
		return { action: "allow", reason: "allowed for this session by user" };
	}
	// "Block" or a dismissed dialog (undefined) both fail closed.
	return { action: "block", reason: blockReason };
}
