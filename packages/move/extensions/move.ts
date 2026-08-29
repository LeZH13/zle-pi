import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	buildSessionSelectionOptions,
	createNewSessionFile,
	formatDisplayDir,
	getDirectoryCompletions,
	resolveTargetDir,
} from "./utils.js";

export default function moveExtension(pi: ExtensionAPI) {
	let currentCwd = ".";
	try {
		currentCwd = process.cwd();
	} catch {
		currentCwd = ".";
	}

	let cachedSessions: SessionInfo[] = [];
	let lastCacheTime = 0;
	const CACHE_TTL_MS = 3000;

	async function getCachedSessions(): Promise<SessionInfo[]> {
		const now = Date.now();
		if (now - lastCacheTime > CACHE_TTL_MS || cachedSessions.length === 0) {
			try {
				cachedSessions = await SessionManager.listAll();
				lastCacheTime = now;
			} catch {
				// Keep existing cache on read error
			}
		}
		return cachedSessions;
	}

	// Warm session cache in the background
	getCachedSessions().catch(() => {});

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		SessionManager.listAll()
			.then((sessions) => {
				cachedSessions = sessions;
				lastCacheTime = Date.now();
			})
			.catch(() => {});
	});

	pi.registerCommand("move", {
		description: "Switch working directory and session",
		getArgumentCompletions: async (prefix: string) => {
			const sessions = await getCachedSessions();
			return getDirectoryCompletions(prefix, currentCwd, undefined, sessions);
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /move command requires an interactive UI", "error");
				return;
			}

			let rawPath = args.trim();
			if (!rawPath) {
				ctx.ui.notify("A destination path is required. Usage: /move <path>", "error");
				return;
			}

			// Strip optional surrounding quotes from user input
			if (
				(rawPath.startsWith('"') && rawPath.endsWith('"')) ||
				(rawPath.startsWith("'") && rawPath.endsWith("'"))
			) {
				rawPath = rawPath.slice(1, -1).trim();
			}
			if (!rawPath) {
				ctx.ui.notify("A destination path is required. Usage: /move <path>", "error");
				return;
			}

			const targetDir = resolveTargetDir(rawPath, ctx.cwd);

			// Check if target is already the current working directory
			if (resolve(targetDir) === resolve(ctx.cwd)) {
				ctx.ui.notify(`Already in ${formatDisplayDir(targetDir)}`, "info");
				return;
			}

			// Validate or prompt to create destination directory
			if (!existsSync(targetDir)) {
				const ok = await ctx.ui.confirm(
					"Directory does not exist",
					`Directory "${formatDisplayDir(targetDir)}" does not exist. Create it?`,
				);
				if (!ok) {
					ctx.ui.notify("Move cancelled", "info");
					return;
				}
				try {
					mkdirSync(targetDir, { recursive: true });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to create directory: ${message}`, "error");
					return;
				}
			} else {
				const stat = statSync(targetDir);
				if (!stat.isDirectory()) {
					ctx.ui.notify(`Target is not a directory: ${formatDisplayDir(targetDir)}`, "error");
					return;
				}
			}

			// Discover existing sessions in the target directory
			let sessions: SessionInfo[] = [];
			try {
				sessions = await SessionManager.list(targetDir);
			} catch {
				sessions = [];
			}

			let selectedSessionFile: string | undefined;
			let isNewSession = false;

			if (sessions.length > 0) {
				const options = buildSessionSelectionOptions(sessions);
				const choice = await ctx.ui.select(
					`Select session in ${formatDisplayDir(targetDir)}:`,
					options.map((o) => o.label),
				);

				if (choice === undefined) {
					ctx.ui.notify("Move cancelled", "info");
					return;
				}

				const selectedOption = options.find((o) => o.label === choice);
				if (!selectedOption || selectedOption.isNew) {
					isNewSession = true;
					selectedSessionFile = createNewSessionFile(targetDir);
				} else {
					selectedSessionFile = selectedOption.sessionPath;
				}
			} else {
				// No existing sessions found; automatically create a new session
				isNewSession = true;
				selectedSessionFile = createNewSessionFile(targetDir);
			}

			if (!selectedSessionFile) {
				ctx.ui.notify("Failed to prepare session for target directory", "error");
				return;
			}

			const displayTarget = formatDisplayDir(targetDir);
			const result = await ctx.switchSession(selectedSessionFile, {
				withSession: async (replacementCtx) => {
					try {
						process.chdir(targetDir);
					} catch {}

					const modeText = isNewSession ? "new session" : "resumed session";
					// Defer notification so it executes after Pi's handleResumeSession
					// displays "Resumed session", ensuring the correct new/resumed status is shown
					setTimeout(() => {
						try {
							replacementCtx.ui.notify(`Moved to ${displayTarget} (${modeText})`, "info");
						} catch {}
					}, 0);
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Session switch cancelled", "info");
			}
		},
	});
}
