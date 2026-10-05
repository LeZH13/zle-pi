/*
 * Global todo preferences. One small JSON file under the user config
 * directory; read once at extension load and written through on every
 * change. Values apply to the current process and future starts only —
 * there is no live cross-process synchronization. Enablement is NOT global:
 * it is per session, recorded on the session branch.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TodoPrefs {
	/** Whether the overlay renders collapsed to its one-line summary. Default true. */
	collapsed: boolean;
}

export const DEFAULT_PREFS: TodoPrefs = { collapsed: true };

const FILE_NAME = "config.json";

/** Config directory: `$XDG_CONFIG_HOME/pi-todo` or `~/.config/pi-todo`. */
export function configDir(baseDir?: string): string {
	if (baseDir) return join(baseDir, "pi-todo");
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return join(xdg || join(homedir(), ".config"), "pi-todo");
}

/** Load prefs; a missing or malformed file falls back to the defaults.
 * Unknown keys (e.g. a legacy global "enabled") are ignored. */
export function loadPrefs(baseDir?: string): TodoPrefs {
	try {
		const data = JSON.parse(readFileSync(join(configDir(baseDir), FILE_NAME), "utf8")) as Record<string, unknown>;
		return { collapsed: data?.collapsed === false ? false : DEFAULT_PREFS.collapsed };
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

/** Persist prefs, creating the directory if needed. Throws on write failure. */
export function savePrefs(prefs: TodoPrefs, baseDir?: string): void {
	const dir = configDir(baseDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, FILE_NAME), `${JSON.stringify(prefs, null, 2)}\n`);
}
