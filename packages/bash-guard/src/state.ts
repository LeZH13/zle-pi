/**
 * Session-scoped toggle state and the exact-command allowlist.
 *
 * State travels as custom session entries on the branch, so it survives
 * resume, reload, compaction, and forking, and it never reaches the model.
 * Toggles are snapshots (last one wins); session allows accumulate as
 * individual entries so repeated "Allow for this session" stays compact.
 */
export const TOGGLES_ENTRY_TYPE = "bash-guard-toggles";
export const ALLOW_ENTRY_TYPE = "bash-guard-allow";

export interface TogglesData {
	guard: boolean;
	watchdog: boolean;
}

export interface AllowData {
	command: string;
}

/** Minimal shape of the entries we read back from the session branch. */
interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readToggles(data: unknown): TogglesData | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.guard !== "boolean" || typeof data.watchdog !== "boolean") return undefined;
	return { guard: data.guard, watchdog: data.watchdog };
}

function readAllow(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.command !== "string" || data.command.length === 0) return undefined;
	return data.command;
}

export interface RestoredState {
	toggles: TogglesData | undefined;
	allowedCommands: string[];
}

/**
 * Reconstruct state from the current branch, in order. Toggles: last wins.
 * Allows: unique commands, accumulated.
 */
export function restoreState(branch: readonly unknown[]): RestoredState {
	let toggles: TogglesData | undefined;
	const allowed: string[] = [];
	const seen = new Set<string>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		switch (entry.customType) {
			case TOGGLES_ENTRY_TYPE:
				toggles = readToggles(entry.data);
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
	return { toggles, allowedCommands: allowed };
}
