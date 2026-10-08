/**
 * Session-scoped settings overrides and the exact-command allowlist.
 *
 * State travels as custom session entries on the branch, so it survives
 * resume, reload, compaction, and forking, and it never reaches the model.
 * Settings are snapshots (last valid one wins); session allows accumulate as
 * individual entries so repeated "Allow for this session" stays compact.
 */
import type { ApprovalMode } from "./config.js";

export const SETTINGS_ENTRY_TYPE = "bash-guard-settings";
export const ALLOW_ENTRY_TYPE = "bash-guard-allow";

export type GuardMode = ApprovalMode | "off";

/** Only explicitly selected values are saved; untouched settings keep using config. */
export interface SessionSettings {
	guard?: GuardMode;
	watchdog?: boolean;
}

export interface AllowData {
	command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(data: unknown): SessionSettings | undefined {
	if (!isRecord(data)) return undefined;
	if (data.guard !== undefined && data.guard !== "ask" && data.guard !== "deny" && data.guard !== "off") return undefined;
	if (data.watchdog !== undefined && typeof data.watchdog !== "boolean") return undefined;
	return {
		...(data.guard !== undefined ? { guard: data.guard as GuardMode } : {}),
		...(data.watchdog !== undefined ? { watchdog: data.watchdog } : {}),
	};
}

function readAllow(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.command !== "string" || data.command.length === 0) return undefined;
	return data.command;
}

export interface RestoredState {
	settings: SessionSettings | undefined;
	allowedCommands: string[];
}

/**
 * Reconstruct state from the current branch, in order. Settings: last valid wins.
 * Allows: unique commands, accumulated.
 */
export function restoreState(branch: readonly unknown[]): RestoredState {
	let settings: SessionSettings | undefined;
	const allowed: string[] = [];
	const seen = new Set<string>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		switch (entry.customType) {
			case SETTINGS_ENTRY_TYPE:
				settings = readSettings(entry.data) ?? settings;
				break;
			case ALLOW_ENTRY_TYPE: {
				const command = readAllow(entry.data);
				if (command !== undefined && !seen.has(command)) {
					seen.add(command);
					allowed.push(command);
				}
				break;
			}
			default:
				break;
		}
	}
	return { settings, allowedCommands: allowed };
}
