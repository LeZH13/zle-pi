import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	findCurrentWorktree,
	findWorktreeByInput,
	getGitWorktrees,
	type GitWorktree,
} from "./git.js";
import {
	buildEmptyDirectorySessionOptions,
	buildSessionSelectionOptions,
	buildUnifiedMoveOptions,
	createForkedSessionFile,
	createNewSessionFile,
	extractRecentDirectories,
	formatDisplayDir,
	formatRelativeTime,
	formatSessionSummary,
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
	let cachedWorktrees: GitWorktree[] | null = null;
	let lastWorktreeCacheTime = 0;
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

	async function getCachedWorktrees(cwd: string): Promise<GitWorktree[] | null> {
		const now = Date.now();
		if (now - lastWorktreeCacheTime > CACHE_TTL_MS || cachedWorktrees === null) {
			try {
				cachedWorktrees = await getGitWorktrees(cwd);
				lastWorktreeCacheTime = now;
			} catch {
				cachedWorktrees = null;
			}
		}
		return cachedWorktrees;
	}

	// Warm cache in the background
	getCachedSessions().catch(() => {});

	pi.on("session_start", (event, ctx) => {
		currentCwd = ctx.cwd;
		lastWorktreeCacheTime = 0;
		cachedWorktrees = null;

		SessionManager.listAll()
			.then((sessions) => {
				cachedSessions = sessions;
				lastCacheTime = Date.now();
			})
			.catch(() => {});

		// Proactive hint when starting Pi in an empty linked git worktree
		if (event.reason === "startup" && ctx.hasUI) {
			getGitWorktrees(ctx.cwd)
				.then((worktrees) => {
					if (!worktrees) return;
					const currentWt = findCurrentWorktree(worktrees);
					if (currentWt && !currentWt.isMain) {
						const entries = ctx.sessionManager?.getEntries() ?? [];
						const hasMessages = entries.some((e) => e.type === "message");
						if (!hasMessages) {
							ctx.ui.notify("Git worktree detected. Run /move to inherit a session from main.", "info");
						}
					}
				})
				.catch(() => {});
		}
	});

	pi.registerCommand("move", {
		description: "Switch working directory and session",
		getArgumentCompletions: async (prefix: string) => {
			const [sessions, worktrees] = await Promise.all([
				getCachedSessions(),
				getCachedWorktrees(currentCwd),
			]);
			return getDirectoryCompletions(prefix, currentCwd, undefined, sessions, undefined, undefined, worktrees ?? []);
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /move command requires an interactive UI", "error");
				return;
			}

			let rawPath = args.trim();

			// Strip optional surrounding quotes from user input
			if (
				(rawPath.startsWith('"') && rawPath.endsWith('"')) ||
				(rawPath.startsWith("'") && rawPath.endsWith("'"))
			) {
				rawPath = rawPath.slice(1, -1).trim();
			}

			const worktrees = await getGitWorktrees(ctx.cwd);

			// Helper function to handle moving to targetDir and choosing session
			const moveToTargetDir = async (targetDir: string) => {
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

				// Inspect current session to see if it can be inherited (must have at least 1 message)
				const currentSessionFile = ctx.sessionManager?.getSessionFile();
				let hasCurrentMessages = false;
				try {
					const entries = ctx.sessionManager?.getEntries() ?? [];
					hasCurrentMessages = entries.some((e) => e.type === "message");
				} catch {}
				const canInheritCurrent = Boolean(currentSessionFile && hasCurrentMessages);

				// Discover existing sessions in the target directory
				let sessions: SessionInfo[] = [];
				try {
					sessions = await SessionManager.list(targetDir);
				} catch {
					sessions = [];
				}

				let selectedSessionFile: string | undefined;
				let sessionMode: "new" | "resumed" | "forked" = "new";

				if (sessions.length > 0) {
					const options = buildSessionSelectionOptions(
						sessions,
						undefined,
						canInheritCurrent ? { path: currentSessionFile } : null,
					);
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
						sessionMode = "new";
						selectedSessionFile = createNewSessionFile(targetDir);
					} else if (selectedOption.isFork && selectedOption.sourceSessionPath) {
						sessionMode = "forked";
						try {
							selectedSessionFile = createForkedSessionFile(selectedOption.sourceSessionPath, targetDir);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(`Failed to fork session: ${message}`, "error");
							return;
						}
					} else {
						sessionMode = "resumed";
						selectedSessionFile = selectedOption.sessionPath;
					}
				} else {
					// Target has 0 sessions
					if (canInheritCurrent) {
						const options = buildEmptyDirectorySessionOptions({ path: currentSessionFile! });
						const choice = await ctx.ui.select(
							`Select session in ${formatDisplayDir(targetDir)}:`,
							options.map((o) => o.label),
						);

						if (choice === undefined) {
							ctx.ui.notify("Move cancelled", "info");
							return;
						}

						const selectedOption = options.find((o) => o.label === choice);
						if (selectedOption?.isFork && selectedOption.sourceSessionPath) {
							sessionMode = "forked";
							try {
								selectedSessionFile = createForkedSessionFile(selectedOption.sourceSessionPath, targetDir);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								ctx.ui.notify(`Failed to fork session: ${message}`, "error");
								return;
							}
						} else {
							sessionMode = "new";
							selectedSessionFile = createNewSessionFile(targetDir);
						}
					} else {
						// No existing sessions found and current session is empty
						sessionMode = "new";
						selectedSessionFile = createNewSessionFile(targetDir);
					}
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

						const modeText =
							sessionMode === "forked"
								? "forked session"
								: sessionMode === "new"
								? "new session"
								: "resumed session";
						// Defer notification so it executes after Pi's handleResumeSession displays status
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
			};

			// If no argument is provided, open the Unified Move Hub
			if (!rawPath) {
				const sessions = await getCachedSessions();
				const recentDirs = extractRecentDirectories(sessions, ctx.cwd, 10);
				const unifiedOptions = buildUnifiedMoveOptions(ctx.cwd, worktrees, recentDirs);

				if (unifiedOptions.length === 0) {
					ctx.ui.notify("No other worktrees or recent directories found", "info");
					return;
				}

				const choice = await ctx.ui.select(
					"Select destination or action:",
					unifiedOptions.map((o) => o.label),
				);
				if (!choice) {
					ctx.ui.notify("Move cancelled", "info");
					return;
				}

				const selected = unifiedOptions.find((o) => o.label === choice);
				if (!selected) return;

				if (selected.action === "inherit_from_main") {
					// Flow: Inherit session from main dev folder
					let mainSessions: SessionInfo[] = [];
					try {
						mainSessions = await SessionManager.list(selected.dir);
					} catch {
						mainSessions = [];
					}

					if (mainSessions.length === 0) {
						ctx.ui.notify(`No sessions found in main repo (${formatDisplayDir(selected.dir)})`, "info");
						return;
					}

					const inheritOptions = mainSessions.map((s, idx) => {
						const summary = formatSessionSummary(s);
						const timeAgo = formatRelativeTime(s.modified);
						const bullet = idx === 0 ? "[●]" : "[ ]";
						const suffix = idx === 0 ? " [most recent]" : "";
						return {
							label: `${bullet} ${summary} (${timeAgo})${suffix}`,
							sessionPath: s.path,
						};
					});

					const chosenSession = await ctx.ui.select(
						"Select session to inherit from main:",
						inheritOptions.map((o) => o.label),
					);
					if (!chosenSession) {
						ctx.ui.notify("Inherit cancelled", "info");
						return;
					}

					const chosenItem = inheritOptions.find((o) => o.label === chosenSession);
					if (!chosenItem) return;

					let forkedSessionFile: string;
					try {
						forkedSessionFile = createForkedSessionFile(chosenItem.sessionPath, ctx.cwd);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to inherit session: ${message}`, "error");
						return;
					}

					const currentDisplay = formatDisplayDir(ctx.cwd);
					const result = await ctx.switchSession(forkedSessionFile, {
						withSession: async (replacementCtx) => {
							setTimeout(() => {
								try {
									replacementCtx.ui.notify(
										`Inherited session from main repo into ${currentDisplay}`,
										"info",
									);
								} catch {}
							}, 0);
						},
					});

					if (result.cancelled) {
						ctx.ui.notify("Session switch cancelled", "info");
					}
					return;
				}

				// Action is "switch_dir"
				await moveToTargetDir(selected.dir);
				return;
			}

			// When rawPath is provided, check if it matches a worktree branch or path
			let targetDir: string;
			const matchedWorktree = worktrees ? findWorktreeByInput(rawPath, worktrees) : undefined;
			if (matchedWorktree) {
				targetDir = matchedWorktree.path;
			} else {
				targetDir = resolveTargetDir(rawPath, ctx.cwd);
			}

			await moveToTargetDir(targetDir);
		},
	});
}
