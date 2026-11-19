import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildEmptyDirectorySessionOptions,
	buildRecentDirectoryCompletions,
	buildSessionSelectionOptions,
	buildUnifiedMoveOptions,
	buildWorktreeCompletions,
	createForkedSessionFile,
	createNewSessionFile,
	expandHomePath,
	extractRecentDirectories,
	formatDisplayDir,
	formatRelativeTime,
	formatSessionSummary,
	getDirectoryCompletions,
	matchRecentDirectory,
	NERD_ICONS,
	resolveTargetDir,
} from "../extensions/utils.js";
import type { GitWorktree } from "../extensions/git.js";

describe("utils", () => {
	const mockHome = "/Users/testuser";
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-move-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tempDir, ".pi-agent"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	describe("formatDisplayDir", () => {
		it("formats home directory as ~", () => {
			expect(formatDisplayDir("/Users/testuser", mockHome)).toBe("~");
		});

		it("formats subdirectories under home with ~/", () => {
			expect(formatDisplayDir("/Users/testuser/projects/app", mockHome)).toBe("~/projects/app");
		});

		it("leaves paths outside home unchanged", () => {
			expect(formatDisplayDir("/var/log/pi", mockHome)).toBe("/var/log/pi");
		});
	});

	describe("expandHomePath", () => {
		it("expands bare ~ to home", () => {
			expect(expandHomePath("~", mockHome)).toBe(mockHome);
		});

		it("expands ~/path to full path", () => {
			expect(expandHomePath("~/projects/repo", mockHome)).toBe(join(mockHome, "projects/repo"));
		});

		it("leaves relative and absolute paths unchanged", () => {
			expect(expandHomePath("./local/dir", mockHome)).toBe("./local/dir");
			expect(expandHomePath("/opt/custom", mockHome)).toBe("/opt/custom");
		});
	});

	describe("resolveTargetDir", () => {
		it("resolves relative path against cwd", () => {
			const cwd = "/workspace/project";
			expect(resolveTargetDir("src/utils", cwd, mockHome)).toBe("/workspace/project/src/utils");
			expect(resolveTargetDir("../other", cwd, mockHome)).toBe("/workspace/other");
		});

		it("resolves home path", () => {
			const cwd = "/workspace/project";
			expect(resolveTargetDir("~/documents", cwd, mockHome)).toBe(join(mockHome, "documents"));
		});

		it("resolves absolute path", () => {
			const cwd = "/workspace/project";
			expect(resolveTargetDir("/etc/nginx", cwd, mockHome)).toBe("/etc/nginx");
		});
	});

	describe("formatRelativeTime", () => {
		it("formats seconds as just now", () => {
			const now = new Date("2026-03-01T12:00:00Z");
			const date = new Date("2026-03-01T11:59:30Z");
			expect(formatRelativeTime(date, now)).toBe("just now");
		});

		it("formats minutes ago", () => {
			const now = new Date("2026-03-01T12:00:00Z");
			const date = new Date("2026-03-01T11:45:00Z");
			expect(formatRelativeTime(date, now)).toBe("15m ago");
		});

		it("formats hours ago", () => {
			const now = new Date("2026-03-01T12:00:00Z");
			const date = new Date("2026-03-01T08:00:00Z");
			expect(formatRelativeTime(date, now)).toBe("4h ago");
		});

		it("formats yesterday", () => {
			const now = new Date("2026-03-02T12:00:00Z");
			const date = new Date("2026-03-01T12:00:00Z");
			expect(formatRelativeTime(date, now)).toBe("yesterday");
		});

		it("formats days ago", () => {
			const now = new Date("2026-03-05T12:00:00Z");
			const date = new Date("2026-03-01T12:00:00Z");
			expect(formatRelativeTime(date, now)).toBe("4d ago");
		});

		it("formats weeks ago", () => {
			const now = new Date("2026-03-20T12:00:00Z");
			const date = new Date("2026-03-01T12:00:00Z");
			expect(formatRelativeTime(date, now)).toBe("2w ago");
		});
	});

	describe("formatSessionSummary", () => {
		it("prefers session name when present", () => {
			expect(formatSessionSummary({ name: "Auth Refactor", firstMessage: "Hello agent" })).toBe("Auth Refactor");
		});

		it("uses first message when name is absent", () => {
			expect(formatSessionSummary({ firstMessage: "Fix failing unit tests in core" })).toBe(
				"Fix failing unit tests in core",
			);
		});

		it("flattens multi-line first messages into a single line", () => {
			expect(formatSessionSummary({ firstMessage: "Line 1\nLine 2\n\tLine 3" })).toBe("Line 1 Line 2 Line 3");
		});

		it("truncates long first messages", () => {
			const longMsg = "a".repeat(100);
			const summary = formatSessionSummary({ firstMessage: longMsg }, 40);
			expect(summary.length).toBeLessThanOrEqual(40);
			expect(summary.endsWith("...")).toBe(true);
		});

		it("handles empty session", () => {
			expect(formatSessionSummary({})).toBe("(empty session)");
			expect(formatSessionSummary({ firstMessage: "   " })).toBe("(empty session)");
		});
	});

	describe("buildSessionSelectionOptions", () => {
		it("always provides Start a new session as the first option", () => {
			const options = buildSessionSelectionOptions([]);
			expect(options).toHaveLength(1);
			expect(options[0].isNew).toBe(true);
			expect(options[0].label).toContain("Start a new session");
		});

		it("formats multiple sessions with recent markers and timestamps", () => {
			const now = new Date("2026-03-01T12:00:00Z");
			const sessions = [
				{
					path: "/sessions/s1.jsonl",
					id: "session-1",
					cwd: "/app",
					name: "Recent work",
					firstMessage: "Hello",
					created: new Date("2026-03-01T10:00:00Z"),
					modified: new Date("2026-03-01T11:00:00Z"),
					messageCount: 5,
					allMessagesText: "Hello",
				},
				{
					path: "/sessions/s2.jsonl",
					id: "session-2",
					cwd: "/app",
					firstMessage: "Old task",
					created: new Date("2026-02-25T10:00:00Z"),
					modified: new Date("2026-02-25T10:00:00Z"),
					messageCount: 1,
					allMessagesText: "Old task",
				},
			];

			const options = buildSessionSelectionOptions(sessions, now);
			expect(options).toHaveLength(3);
			expect(options[0].isNew).toBe(true);
			expect(options[1].isNew).toBe(false);
			expect(options[1].sessionPath).toBe("/sessions/s1.jsonl");
			expect(options[1].label).toContain("[●]");
			expect(options[1].label).toContain("Recent work");
			expect(options[1].label).toContain("1h ago");
			expect(options[1].label).toContain("[most recent]");

			expect(options[2].isNew).toBe(false);
			expect(options[2].sessionPath).toBe("/sessions/s2.jsonl");
			expect(options[2].label).toContain("[ ]");
			expect(options[2].label).toContain("Old task");
			expect(options[2].label).toContain("4d ago");
		});

		it("includes fork option when currentSession has a valid path", () => {
			const sessions: any[] = [
				{
					id: "12345678-abcd",
					path: "/sessions/target-session.jsonl",
					name: "Target Session",
					firstMessage: "Work on target",
					modified: new Date("2026-03-01T11:00:00Z"),
					messageCount: 5,
				},
			];

			const options = buildSessionSelectionOptions(
				sessions,
				new Date("2026-03-01T12:00:00Z"),
				{ path: "/sessions/current.jsonl", messageCount: 3 },
			);

			expect(options).toHaveLength(3);
			expect(options[0].isNew).toBe(true);
			expect(options[1].isFork).toBe(true);
			expect(options[1].label).toBe(`${NERD_ICONS.git} Inherit current session (fork)`);
			expect(options[1].sourceSessionPath).toBe("/sessions/current.jsonl");
			expect(options[2].sessionPath).toBe("/sessions/target-session.jsonl");
		});
	});

	describe("createNewSessionFile", () => {
		it("creates a valid session JSONL file with header and target cwd", () => {
			const targetDir = join(tempDir, "target-project");
			mkdirSync(targetDir, { recursive: true });

			const sessionDir = join(tempDir, "sessions");
			const sessionFile = createNewSessionFile(targetDir, sessionDir);
			expect(existsSync(sessionFile)).toBe(true);

			const content = readFileSync(sessionFile, "utf-8");
			const entries = parseSessionEntries(content);
			expect(entries).toHaveLength(1);
			expect(entries[0].type).toBe("session");
			expect((entries[0] as any).cwd).toBe(targetDir);
		});
	});

	describe("extractRecentDirectories", () => {
		it("extracts unique directory paths ordered by modified date descending", () => {
			const dir1 = join(tempDir, "dir1");
			const dir2 = join(tempDir, "dir2");
			const dir3 = join(tempDir, "dir3");
			mkdirSync(dir1, { recursive: true });
			mkdirSync(dir2, { recursive: true });
			mkdirSync(dir3, { recursive: true });

			const currentCwd = join(tempDir, "current");
			mkdirSync(currentCwd, { recursive: true });

			const sessions = [
				{ cwd: dir1, modified: new Date("2026-03-01T10:00:00Z") },
				{ cwd: dir2, modified: new Date("2026-03-01T12:00:00Z") }, // Most recent
				{ cwd: dir1, modified: new Date("2026-03-01T08:00:00Z") }, // Duplicate dir1
				{ cwd: dir3, modified: new Date("2026-03-01T11:00:00Z") },
				{ cwd: currentCwd, modified: new Date("2026-03-01T13:00:00Z") }, // Should be skipped (currentCwd)
			];

			const recents = extractRecentDirectories(sessions, currentCwd, 5);
			expect(recents).toHaveLength(3);
			expect(recents[0].dir).toBe(dir2);
			expect(recents[1].dir).toBe(dir3);
			expect(recents[2].dir).toBe(dir1);
		});

		it("filters out non-existent directories", () => {
			const existingDir = join(tempDir, "existing");
			mkdirSync(existingDir, { recursive: true });
			const nonExistentDir = join(tempDir, "deleted-folder");

			const sessions = [
				{ cwd: nonExistentDir, modified: new Date("2026-03-01T12:00:00Z") },
				{ cwd: existingDir, modified: new Date("2026-03-01T10:00:00Z") },
			];

			const recents = extractRecentDirectories(sessions, tempDir, 5);
			expect(recents).toHaveLength(1);
			expect(recents[0].dir).toBe(existingDir);
		});

		it("respects the limit parameter", () => {
			const dirs = [1, 2, 3, 4, 5, 6].map((i) => {
				const d = join(tempDir, `dir-${i}`);
				mkdirSync(d, { recursive: true });
				return d;
			});

			const sessions = dirs.map((d, index) => ({
				cwd: d,
				modified: new Date(`2026-03-0${index + 1}T10:00:00Z`),
			}));

			const recents = extractRecentDirectories(sessions, tempDir, 3);
			expect(recents).toHaveLength(3);
		});

		it("returns empty array when session list is empty", () => {
			expect(extractRecentDirectories([], tempDir)).toEqual([]);
		});
	});

	describe("matchRecentDirectory", () => {
		const display = "~/workspace/pi-interactive-subagents/";
		const abs = "/Users/testuser/workspace/pi-interactive-subagents";

		it("matches empty query", () => {
			expect(matchRecentDirectory("", display, abs)).toBe(true);
			expect(matchRecentDirectory("   ", display, abs)).toBe(true);
		});

		it("matches substring in display path or basename", () => {
			expect(matchRecentDirectory("interactive", display, abs)).toBe(true);
			expect(matchRecentDirectory("subagents", display, abs)).toBe(true);
			expect(matchRecentDirectory("workspace", display, abs)).toBe(true);
			expect(matchRecentDirectory("pi", display, abs)).toBe(true);
		});

		it("matches path prefix", () => {
			expect(matchRecentDirectory("~/work", display, abs)).toBe(true);
			expect(matchRecentDirectory("/Users/testuser", display, abs)).toBe(true);
		});

		it("matches regex pattern", () => {
			expect(matchRecentDirectory("pi-.*subagents", display, abs)).toBe(true);
			expect(matchRecentDirectory("work.*sub", display, abs)).toBe(true);
		});

		it("matches fuzzy subsequence", () => {
			expect(matchRecentDirectory("pisub", display, abs)).toBe(true);
			expect(matchRecentDirectory("wspi", display, abs)).toBe(true);
		});

		it("safely handles invalid regex pattern without throwing", () => {
			expect(matchRecentDirectory("[unclosed", display, abs)).toBe(false);
		});

		it("returns false for non-matching queries", () => {
			expect(matchRecentDirectory("unrelated-project", display, abs)).toBe(false);
		});
	});

	describe("buildRecentDirectoryCompletions", () => {
		it("formats autocomplete items with ~ path and relative time description", () => {
			const now = new Date("2026-03-01T12:00:00Z");
			const recentDirs = [
				{
					dir: join(mockHome, "projects", "backend"),
					modified: new Date("2026-03-01T10:00:00Z"),
				},
				{
					dir: join(mockHome, "work with spaces", "web app"),
					modified: new Date("2026-02-28T12:00:00Z"),
				},
			];

			const items = buildRecentDirectoryCompletions(recentDirs, "", mockHome, now);
			expect(items).toHaveLength(2);

			expect(items[0].value).toBe("~/projects/backend/");
			expect(items[0].label).toBe("~/projects/backend/");
			expect(items[0].description).toBe("Recent (2h ago)");

			expect(items[1].value).toBe('"~/work with spaces/web app/"');
			expect(items[1].label).toBe("~/work with spaces/web app/");
			expect(items[1].description).toBe("Recent (yesterday)");
		});
	});

	describe("getDirectoryCompletions", () => {
		it("lists subdirectories for relative prefix", () => {
			mkdirSync(join(tempDir, "alpha"), { recursive: true });
			mkdirSync(join(tempDir, "beta"), { recursive: true });
			writeFileSync(join(tempDir, "file.txt"), "hello");

			const completions = getDirectoryCompletions("", tempDir, mockHome);
			expect(completions).not.toBeNull();
			const values = completions!.map((c) => c.value);
			expect(values).toContain("alpha/");
			expect(values).toContain("beta/");
			expect(values).not.toContain("file.txt");
		});

		it("filters matching directory prefix", () => {
			mkdirSync(join(tempDir, "docs"), { recursive: true });
			mkdirSync(join(tempDir, "data"), { recursive: true });
			mkdirSync(join(tempDir, "src"), { recursive: true });

			const completions = getDirectoryCompletions("d", tempDir, mockHome);
			expect(completions).not.toBeNull();
			const values = completions!.map((c) => c.value);
			expect(values).toContain("data/");
			expect(values).toContain("docs/");
			expect(values).not.toContain("src/");
		});

		it("handles nested directory autocompletion", () => {
			mkdirSync(join(tempDir, "packages", "pkg-a"), { recursive: true });
			mkdirSync(join(tempDir, "packages", "pkg-b"), { recursive: true });

			const completions = getDirectoryCompletions("packages/", tempDir, mockHome);
			expect(completions).not.toBeNull();
			const values = completions!.map((c) => c.value);
			expect(values).toContain("packages/pkg-a/");
			expect(values).toContain("packages/pkg-b/");
		});

		it("handles ~ home directory prefix", () => {
			const fakeHome = join(tempDir, "home");
			mkdirSync(join(fakeHome, "workspace"), { recursive: true });
			mkdirSync(join(fakeHome, "downloads"), { recursive: true });

			const completions = getDirectoryCompletions("~/", tempDir, fakeHome);
			expect(completions).not.toBeNull();
			const values = completions!.map((c) => c.value);
			expect(values).toContain("~/workspace/");
			expect(values).toContain("~/downloads/");
		});

		it("includes recent directories at the top when sessions are provided", () => {
			const recentProject = join(tempDir, "recent-proj");
			mkdirSync(recentProject, { recursive: true });
			mkdirSync(join(tempDir, "local-folder"), { recursive: true });

			const now = new Date("2026-03-01T12:00:00Z");
			const recentSessions = [
				{
					cwd: recentProject,
					modified: new Date("2026-03-01T11:30:00Z"),
				},
			];

			const completions = getDirectoryCompletions("", tempDir, mockHome, recentSessions, now);
			expect(completions).not.toBeNull();

			// First completion item should be the recent directory
			expect(completions![0].label).toBe(`${recentProject}/`);
			expect(completions![0].description).toBe("Recent (30m ago)");

			// Followed by shortcuts and local directory
			const labels = completions!.map((c) => c.label);
			expect(labels).toContain("../");
			expect(labels).toContain("~/");
			expect(labels).toContain("local-folder/");
		});

		it("matches recent directories by regex and substring when typing", () => {
			const backendDir = join(tempDir, "backend-service");
			const frontendDir = join(tempDir, "frontend-app");
			mkdirSync(backendDir, { recursive: true });
			mkdirSync(frontendDir, { recursive: true });

			const now = new Date("2026-03-01T12:00:00Z");
			const recentSessions = [
				{ cwd: backendDir, modified: new Date("2026-03-01T11:00:00Z") },
				{ cwd: frontendDir, modified: new Date("2026-03-01T10:00:00Z") },
			];

			const matchSub = getDirectoryCompletions("service", tempDir, mockHome, recentSessions, now);
			expect(matchSub).not.toBeNull();
			expect(matchSub![0].label).toBe(`${backendDir}/`);

			const matchRegex = getDirectoryCompletions("front.*app", tempDir, mockHome, recentSessions, now);
			expect(matchRegex).not.toBeNull();
			expect(matchRegex![0].label).toBe(`${frontendDir}/`);
		});

		it("includes git worktrees at the top of completions", () => {
			const wtDir = join(tempDir, "worktrees", "feature-auth");
			mkdirSync(wtDir, { recursive: true });

			const mockWorktrees: GitWorktree[] = [
				{
					path: tempDir,
					branch: "main",
					isMain: true,
					isCurrent: true,
				},
				{
					path: wtDir,
					branch: "feature-auth",
					isMain: false,
					isCurrent: false,
				},
			];

			const completions = getDirectoryCompletions(
				"",
				tempDir,
				mockHome,
				[],
				new Date(),
				5,
				mockWorktrees,
			);
			expect(completions).not.toBeNull();
			expect(completions![0].label).toBe("feature-auth/");
			expect(completions![0].description).toContain("Git worktree");
		});
	});

	describe("buildEmptyDirectorySessionOptions", () => {
		it("provides inherit current session and start new options", () => {
			const options = buildEmptyDirectorySessionOptions({
				path: "/sessions/current.jsonl",
			});

			expect(options).toHaveLength(2);
			expect(options[0].isFork).toBe(true);
			expect(options[0].label).toBe(`${NERD_ICONS.git} Inherit current session (fork)`);
			expect(options[0].sourceSessionPath).toBe("/sessions/current.jsonl");
			expect(options[1].isNew).toBe(true);
		});
	});

	describe("buildUnifiedMoveOptions", () => {
		it("includes inherit option when in a linked worktree", () => {
			const mainDir = join(tempDir, "main-repo");
			const linkedDir = join(tempDir, "linked-wt");
			mkdirSync(mainDir, { recursive: true });
			mkdirSync(linkedDir, { recursive: true });

			const worktrees: GitWorktree[] = [
				{ path: mainDir, branch: "main", isMain: true, isCurrent: false },
				{ path: linkedDir, branch: "feature-branch", isMain: false, isCurrent: true },
			];

			const options = buildUnifiedMoveOptions(linkedDir, worktrees, [], mockHome);
			expect(options.length).toBeGreaterThanOrEqual(2);

			// First option should be inherit from main
			expect(options[0].action).toBe("inherit_from_main");
			expect(options[0].label).toContain("Inherit session from main dev folder (main)");
			expect(options[0].dir).toBe(mainDir);

			// Second option should be switch to main repo worktree
			expect(options[1].action).toBe("switch_dir");
			expect(options[1].label).toContain(`${NERD_ICONS.git} main`);
			expect(options[1].dir).toBe(mainDir);
		});

		it("does not offer inherit when in main repo worktree", () => {
			const mainDir = join(tempDir, "main-repo");
			const linkedDir = join(tempDir, "linked-wt");
			mkdirSync(mainDir, { recursive: true });
			mkdirSync(linkedDir, { recursive: true });

			const worktrees: GitWorktree[] = [
				{ path: mainDir, branch: "main", isMain: true, isCurrent: true },
				{ path: linkedDir, branch: "feature-branch", isMain: false, isCurrent: false },
			];

			const options = buildUnifiedMoveOptions(mainDir, worktrees, [], mockHome);
			expect(options.some((o) => o.action === "inherit_from_main")).toBe(false);
			expect(options.some((o) => o.action === "switch_dir" && o.dir === linkedDir)).toBe(true);
		});

		it("includes recent directories deduplicated from worktrees", () => {
			const recentA = join(tempDir, "recent-a");
			mkdirSync(recentA, { recursive: true });

			const options = buildUnifiedMoveOptions(
				tempDir,
				null,
				[{ dir: recentA, modified: new Date() }],
				mockHome,
			);
			expect(options).toHaveLength(1);
			expect(options[0].action).toBe("switch_dir");
			expect(options[0].dir).toBe(recentA);
		});
	});

	describe("createForkedSessionFile", () => {
		it("forks a session into the target directory with new ID and parentSession", () => {
			const srcDir = join(tempDir, "src-repo");
			const dstDir = join(tempDir, "dst-repo");
			mkdirSync(srcDir, { recursive: true });
			mkdirSync(dstDir, { recursive: true });

			const originalFile = createNewSessionFile(srcDir);
			const forkedFile = createForkedSessionFile(originalFile, dstDir);

			expect(existsSync(forkedFile)).toBe(true);
			const content = readFileSync(forkedFile, "utf8");
			const entries = parseSessionEntries(content);
			const header: any = entries[0];
			expect(header.type).toBe("session");
			expect(header.cwd).toBe(dstDir);
			expect(header.parentSession).toBe(originalFile);
		});
	});
});
