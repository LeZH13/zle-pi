import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
	type SessionHeader,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	findCurrentWorktree,
	findMainWorktree,
	type GitWorktree,
} from "./git.js";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".turbo", ".next", "dist", "coverage"]);

/**
 * Replace the home directory prefix with ~ for clean display.
 */
export function formatDisplayDir(dir: string, home: string = homedir()): string {
	const normalizedDir = normalize(dir);
	const normalizedHome = normalize(home);

	if (normalizedDir === normalizedHome) {
		return "~";
	}
	if (normalizedDir.startsWith(normalizedHome + "/")) {
		return `~/${normalizedDir.slice(normalizedHome.length + 1)}`;
	}
	return normalizedDir;
}

/**
 * Expand ~ to user's home directory.
 */
export function expandHomePath(inputPath: string, home: string = homedir()): string {
	if (inputPath === "~") {
		return home;
	}
	if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
		return join(home, inputPath.slice(2));
	}
	return inputPath;
}

/**
 * Resolve target path from user input against the current working directory.
 */
export function resolveTargetDir(inputPath: string, currentCwd: string, home: string = homedir()): string {
	const trimmed = inputPath.trim();
	const expanded = expandHomePath(trimmed, home);
	return resolve(currentCwd, expanded);
}

/**
 * Format a timestamp into human-readable relative time (e.g. "just now", "2h ago", "yesterday", "3d ago").
 */
export function formatRelativeTime(date: Date | string | number, now: Date = new Date()): string {
	const targetTime = typeof date === "number" ? date : new Date(date).getTime();
	const diffSeconds = Math.max(0, Math.floor((now.getTime() - targetTime) / 1000));

	if (diffSeconds < 60) {
		return "just now";
	}
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) {
		return `${diffMinutes}m ago`;
	}
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) {
		return "yesterday";
	}
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}
	const diffWeeks = Math.floor(diffDays / 7);
	if (diffWeeks < 5) {
		return `${diffWeeks}w ago`;
	}
	const d = new Date(targetTime);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Format session name or first message snippet for display.
 */
export function formatSessionSummary(
	session: { name?: string; firstMessage?: string },
	maxLength: number = 55,
): string {
	if (session.name && session.name.trim()) {
		return session.name.trim();
	}
	if (session.firstMessage && session.firstMessage.trim()) {
		const singleLine = session.firstMessage.replace(/[\r\n\t]+/g, " ").trim();
		if (singleLine.length > maxLength) {
			return `${singleLine.slice(0, maxLength - 3)}...`;
		}
		return singleLine;
	}
	return "(empty session)";
}

export const NERD_ICONS = {
	git: "",
	folder: "",
} as const;

export interface SessionOptionItem {
	label: string;
	sessionPath?: string;
	isNew: boolean;
	isFork?: boolean;
	sourceSessionPath?: string;
	description?: string;
}

export interface RecentDirectoryInfo {
	dir: string;
	modified: Date | number | string;
}

/**
 * Extract distinct recent directories from session history, ordered by most recent activity.
 * Skips the current working directory, non-existent directories, and non-directories.
 */
export function extractRecentDirectories(
	sessions: Array<{ cwd?: string; modified?: Date | string | number }>,
	currentCwd: string,
	limit: number = 5,
	existsChecker: (dir: string) => boolean = (dir) => {
		try {
			return existsSync(dir) && statSync(dir).isDirectory();
		} catch {
			return false;
		}
	},
): RecentDirectoryInfo[] {
	if (!sessions || sessions.length === 0) {
		return [];
	}

	const normalizedCurrentCwd = resolve(currentCwd);
	const seenDirs = new Set<string>();
	const recentDirs: RecentDirectoryInfo[] = [];

	// Sort sessions descending by modified date
	const sorted = [...sessions].sort((a, b) => {
		const timeA = a.modified ? (typeof a.modified === "number" ? a.modified : new Date(a.modified).getTime()) : 0;
		const timeB = b.modified ? (typeof b.modified === "number" ? b.modified : new Date(b.modified).getTime()) : 0;
		return timeB - timeA;
	});

	for (const s of sorted) {
		if (!s.cwd) continue;
		const resolvedDir = resolve(s.cwd);
		if (resolvedDir === normalizedCurrentCwd) continue;
		if (seenDirs.has(resolvedDir)) continue;
		seenDirs.add(resolvedDir);

		if (existsChecker(resolvedDir)) {
			recentDirs.push({
				dir: resolvedDir,
				modified: s.modified ?? new Date(),
			});
			if (recentDirs.length >= limit) {
				break;
			}
		}
	}

	return recentDirs;
}

function fuzzySubsequenceMatch(query: string, target: string): boolean {
	if (!query || !target) return false;
	let queryIdx = 0;
	for (let i = 0; i < target.length && queryIdx < query.length; i++) {
		if (target[i] === query[queryIdx]) {
			queryIdx++;
		}
	}
	return queryIdx === query.length;
}

/**
 * Match a query against a recent directory using substring, prefix, regex, or fuzzy subsequence matching.
 */
export function matchRecentDirectory(
	rawQuery: string,
	displayPath: string,
	absolutePath: string,
): boolean {
	const query = rawQuery.trim();
	if (!query) {
		return true;
	}

	const lowerQuery = query.toLowerCase();
	const lowerDisplay = displayPath.toLowerCase();
	const lowerAbsolute = absolutePath.toLowerCase();
	const baseName = basename(absolutePath).toLowerCase();

	// 1. Direct substring match against display path, absolute path, or directory basename
	if (
		lowerDisplay.includes(lowerQuery) ||
		lowerAbsolute.includes(lowerQuery) ||
		baseName.includes(lowerQuery)
	) {
		return true;
	}

	// 2. Prefix match for paths (e.g. user typed "~/zle" or "/Users/zle")
	if (lowerDisplay.startsWith(lowerQuery) || lowerAbsolute.startsWith(lowerQuery)) {
		return true;
	}

	// 3. Regex match attempt (safe against invalid regex syntax)
	try {
		const regex = new RegExp(query, "i");
		if (regex.test(displayPath) || regex.test(absolutePath) || regex.test(baseName)) {
			return true;
		}
	} catch {
		// Invalid regex pattern, ignore
	}

	// 4. Fuzzy subsequence match on basename or display path
	return fuzzySubsequenceMatch(lowerQuery, baseName) || fuzzySubsequenceMatch(lowerQuery, lowerDisplay);
}

/**
 * Match a worktree against a query by checking branch name, path, or basename.
 */
export function matchWorktree(
	rawQuery: string,
	worktree: GitWorktree,
	displayPath: string,
): boolean {
	const query = rawQuery.trim();
	if (!query) return true;
	const lowerQuery = query.toLowerCase();
	if (worktree.branch && worktree.branch.toLowerCase().includes(lowerQuery)) {
		return true;
	}
	return matchRecentDirectory(rawQuery, displayPath, worktree.path);
}

/**
 * Build autocomplete items for git worktrees.
 */
export function buildWorktreeCompletions(
	worktrees: GitWorktree[],
	currentCwd: string,
	query: string,
	home: string = homedir(),
): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];
	const resolvedCwd = resolve(currentCwd);

	for (const wt of worktrees) {
		const resolvedPath = resolve(wt.path);
		if (resolvedPath === resolvedCwd) {
			continue;
		}

		const rawDisplay = formatDisplayDir(wt.path, home);
		const displayPath = rawDisplay.endsWith("/") || rawDisplay.endsWith("\\") ? rawDisplay : `${rawDisplay}/`;

		if (!matchWorktree(query, wt, displayPath)) {
			continue;
		}

		const branch = wt.branch ?? basename(wt.path);
		const role = wt.isMain ? "main repo" : "worktree";
		const value = displayPath.includes(" ") ? `"${displayPath}"` : displayPath;

		items.push({
			value,
			label: `${branch}/`,
			description: `Git ${role} (${displayPath})`,
		});
	}

	return items;
}

/**
 * Build autocomplete items for matching recent directories.
 */
export function buildRecentDirectoryCompletions(
	recentDirs: RecentDirectoryInfo[],
	query: string,
	home: string = homedir(),
	now: Date = new Date(),
): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];

	for (const { dir, modified } of recentDirs) {
		const rawDisplay = formatDisplayDir(dir, home);
		const displayPath = rawDisplay.endsWith("/") || rawDisplay.endsWith("\\") ? rawDisplay : `${rawDisplay}/`;

		if (!matchRecentDirectory(query, displayPath, dir)) {
			continue;
		}

		const timeAgo = formatRelativeTime(modified, now);
		const value = displayPath.includes(" ") ? `"${displayPath}"` : displayPath;

		items.push({
			value,
			label: displayPath,
			description: `Recent (${timeAgo})`,
		});
	}

	return items;
}

/**
 * Build structured select list items for existing sessions in the target directory,
 * with a new session option at the top and an optional inherit (fork) option.
 */
export function buildSessionSelectionOptions(
	sessions: SessionInfo[],
	now: Date = new Date(),
	currentSession?: { path?: string; messageCount?: number; name?: string } | null,
): SessionOptionItem[] {
	const items: SessionOptionItem[] = [
		{
			label: "[+] Start a new session",
			isNew: true,
			description: "Create a fresh session in this directory",
		},
	];

	if (currentSession?.path) {
		items.push({
			label: `${NERD_ICONS.git} Inherit current session (fork)`,
			isNew: false,
			isFork: true,
			sourceSessionPath: currentSession.path,
			description: "Fork all conversation context into this directory",
		});
	}

	for (let i = 0; i < sessions.length; i++) {
		const session = sessions[i];
		const isMostRecent = i === 0;
		const summary = formatSessionSummary(session);
		const timeAgo = formatRelativeTime(session.modified, now);
		const bullet = isMostRecent ? "[●]" : "[ ]";
		const suffix = isMostRecent ? " [most recent]" : "";
		const label = `${bullet} ${summary} (${timeAgo})${suffix}`;

		items.push({
			label,
			sessionPath: session.path,
			isNew: false,
			description: `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"} · ${session.id.slice(0, 8)}`,
		});
	}

	return items;
}

/**
 * Build session selection options for a target directory that has no previous sessions,
 * offering to inherit the current conversation or start fresh.
 */
export function buildEmptyDirectorySessionOptions(currentSession: {
	path: string;
	name?: string;
	messageCount?: number;
}): SessionOptionItem[] {
	return [
		{
			label: `${NERD_ICONS.git} Inherit current session (fork)`,
			isNew: false,
			isFork: true,
			sourceSessionPath: currentSession.path,
			description: "Fork all conversation context into this directory",
		},
		{
			label: "[+] Start a new session",
			isNew: true,
			description: "Create a fresh empty session",
		},
	];
}

/**
 * Create a new forked session JSONL file in the target directory inheriting from a source session.
 */
export function createForkedSessionFile(
	sourceSessionFile: string,
	targetDir: string,
	sessionDirOverride?: string,
): string {
	const sm = SessionManager.forkFrom(sourceSessionFile, targetDir, sessionDirOverride);
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error(`Failed to create forked session for directory: ${targetDir}`);
	}
	return sessionFile;
}

export interface UnifiedMoveOption {
	label: string;
	action: "inherit_from_main" | "switch_dir";
	dir: string;
	description?: string;
}

/**
 * Build unified options for running /move with no arguments.
 */
export function buildUnifiedMoveOptions(
	currentCwd: string,
	worktrees: GitWorktree[] | null,
	recentDirs: RecentDirectoryInfo[],
	home: string = homedir(),
	now: Date = new Date(),
): UnifiedMoveOption[] {
	const options: UnifiedMoveOption[] = [];
	const resolvedCwd = resolve(currentCwd);

	if (worktrees && worktrees.length > 0) {
		const currentWt = findCurrentWorktree(worktrees);
		const mainWt = findMainWorktree(worktrees);

		// If currently in a linked worktree (not the main worktree), offer to inherit from main
		if (currentWt && !currentWt.isMain && mainWt) {
			const mainBranch = mainWt.branch ?? "main";
			options.push({
				label: `${NERD_ICONS.git} Inherit session from main dev folder (${mainBranch})`,
				action: "inherit_from_main",
				dir: mainWt.path,
				description: `Adopt session from ${formatDisplayDir(mainWt.path, home)}`,
			});
		}

		// List other worktrees in the repo
		for (const wt of worktrees) {
			if (resolve(wt.path) === resolvedCwd) continue;
			const branch = wt.branch ?? basename(wt.path);
			const role = wt.isMain ? "main repo" : "worktree";
			const displayPath = formatDisplayDir(wt.path, home);
			options.push({
				label: `${NERD_ICONS.git} ${branch} · ${displayPath}`,
				action: "switch_dir",
				dir: wt.path,
				description: `Git ${role}`,
			});
		}
	}

	// List recent directories from session history (excluding current cwd and worktrees already listed)
	const seenDirs = new Set<string>();
	if (worktrees) {
		for (const wt of worktrees) {
			seenDirs.add(resolve(wt.path));
		}
	}
	seenDirs.add(resolvedCwd);

	for (const { dir, modified } of recentDirs) {
		const resolvedDir = resolve(dir);
		if (seenDirs.has(resolvedDir)) continue;
		seenDirs.add(resolvedDir);

		const timeAgo = formatRelativeTime(modified, now);
		const displayPath = formatDisplayDir(dir, home);
		options.push({
			label: `${NERD_ICONS.folder} ${displayPath}`,
			action: "switch_dir",
			dir,
			description: `Recent (${timeAgo})`,
		});
	}

	return options;
}

/**
 * Create a new session JSONL file with header entry in the target directory's session folder.
 */
export function createNewSessionFile(targetDir: string, sessionDirOverride?: string): string {
	const sm = SessionManager.create(targetDir, sessionDirOverride);
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error(`Failed to initialize session file for directory: ${targetDir}`);
	}
	const sessionDir = sm.getSessionDir();
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sm.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: targetDir,
	};

	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
	return sessionFile;
}

/**
 * Get filesystem, recent directory, and git worktree autocompletion items for the given prefix.
 */
export function getDirectoryCompletions(
	argumentPrefix: string,
	currentCwd: string,
	home: string = homedir(),
	recentSessions: Array<{ cwd?: string; modified?: Date | string | number }> = [],
	now: Date = new Date(),
	limitRecent: number = 5,
	worktrees: GitWorktree[] = [],
): AutocompleteItem[] | null {
	const rawPrefix = argumentPrefix.trimStart();

	const worktreeItems = buildWorktreeCompletions(worktrees, currentCwd, rawPrefix, home);
	const recentDirs = extractRecentDirectories(recentSessions, currentCwd, limitRecent);
	const recentItems = buildRecentDirectoryCompletions(recentDirs, rawPrefix, home, now);

	const fsResults: AutocompleteItem[] = [];

	try {
		let searchDir: string;
		let searchPrefix: string;
		let pathPrefixForValue: string;

		if (rawPrefix === "" || rawPrefix === "." || rawPrefix === "./") {
			searchDir = currentCwd;
			searchPrefix = "";
			pathPrefixForValue = rawPrefix === "./" ? "./" : "";
		} else if (rawPrefix === "~" || rawPrefix === "~/") {
			searchDir = home;
			searchPrefix = "";
			pathPrefixForValue = "~/";
		} else if (rawPrefix === "/" || rawPrefix === "\\") {
			searchDir = "/";
			searchPrefix = "";
			pathPrefixForValue = "/";
		} else if (rawPrefix.startsWith("~/") || rawPrefix.startsWith("~\\")) {
			const subPath = rawPrefix.slice(2);
			if (subPath.endsWith("/") || subPath.endsWith("\\")) {
				searchDir = join(home, subPath);
				searchPrefix = "";
				pathPrefixForValue = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
			} else {
				const parent = dirname(subPath);
				searchDir = parent === "." ? home : join(home, parent);
				searchPrefix = basename(subPath);
				pathPrefixForValue = parent === "." ? "~/" : `~/${parent}/`;
			}
		} else if (isAbsolute(rawPrefix)) {
			if (rawPrefix.endsWith("/") || rawPrefix.endsWith("\\")) {
				searchDir = rawPrefix;
				searchPrefix = "";
				pathPrefixForValue = rawPrefix;
			} else {
				searchDir = dirname(rawPrefix);
				searchPrefix = basename(rawPrefix);
				pathPrefixForValue = searchDir === "/" ? "/" : `${searchDir}/`;
			}
		} else {
			// Relative path
			if (rawPrefix.endsWith("/") || rawPrefix.endsWith("\\")) {
				searchDir = resolve(currentCwd, rawPrefix);
				searchPrefix = "";
				pathPrefixForValue = rawPrefix;
			} else {
				const parent = dirname(rawPrefix);
				searchDir = parent === "." ? currentCwd : resolve(currentCwd, parent);
				searchPrefix = basename(rawPrefix);
				pathPrefixForValue = parent === "." ? (rawPrefix.startsWith("./") ? "./" : "") : `${parent}/`;
			}
		}

		if (existsSync(searchDir)) {
			const stat = statSync(searchDir);
			if (stat.isDirectory()) {
				const entries = readdirSync(searchDir, { withFileTypes: true });

				// If at base of search and prefix is empty, add quick shortcuts
				if (rawPrefix === "" && searchDir === currentCwd) {
					fsResults.push({
						value: "../",
						label: "../",
						description: "Parent directory",
					});
					fsResults.push({
						value: "~/",
						label: "~/",
						description: "Home directory",
					});
				}

				const lowerSearchPrefix = searchPrefix.toLowerCase();

				for (const entry of entries) {
					if (searchPrefix === "" && IGNORED_DIRECTORIES.has(entry.name)) {
						continue;
					}
					if (entry.name.startsWith(".") && !searchPrefix.startsWith(".")) {
						continue;
					}
					if (searchPrefix && !entry.name.toLowerCase().startsWith(lowerSearchPrefix)) {
						continue;
					}

					let isDir = entry.isDirectory();
					if (!isDir && entry.isSymbolicLink()) {
						try {
							isDir = statSync(join(searchDir, entry.name)).isDirectory();
						} catch {
							isDir = false;
						}
					}

					if (!isDir) {
						continue;
					}

					const dirName = `${entry.name}/`;
					const completionValue = `${pathPrefixForValue}${dirName}`;
					const displayValue = completionValue.includes(" ") ? `"${completionValue}"` : completionValue;

					fsResults.push({
						value: displayValue,
						label: dirName,
						description: "Directory",
					});
				}

				fsResults.sort((a, b) => {
					if (a.value === "../") return -1;
					if (b.value === "../") return 1;
					if (a.value === "~/") return -1;
					if (b.value === "~/") return 1;
					return a.label.localeCompare(b.label);
				});
			}
		}
	} catch {
		// Ignore filesystem errors and continue with recent items
	}

	// Combine worktrees, recent items, and filesystem results, deduplicating by completion value
	const combined: AutocompleteItem[] = [...worktreeItems];
	const seenValues = new Set(worktreeItems.map((item) => item.value));

	for (const item of recentItems) {
		if (!seenValues.has(item.value)) {
			seenValues.add(item.value);
			combined.push(item);
		}
	}

	for (const item of fsResults) {
		if (!seenValues.has(item.value)) {
			seenValues.add(item.value);
			combined.push(item);
		}
	}

	return combined.length > 0 ? combined : null;
}
