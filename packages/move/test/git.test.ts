import { basename, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	findCurrentWorktree,
	findMainWorktree,
	findWorktreeByInput,
	getGitWorktrees,
	parseGitWorktreesPorcelain,
} from "../extensions/git.js";

describe("git worktree parsing and helpers", () => {
	const mockPorcelain = `worktree /Users/testuser/repo
HEAD 62bf5364e4bded05975ac480397dc2707aa8edfa
branch refs/heads/master

worktree /Users/testuser/worktrees/repo/git-alias
HEAD 62bf5364e4bded05975ac480397dc2707aa8edfa
branch refs/heads/git-alias

worktree /Users/testuser/worktrees/repo/detached-fix
HEAD a1b2c3d4e5f6
detached

worktree /Users/testuser/worktrees/repo/prunable-wt
HEAD 1234567890ab
branch refs/heads/old-branch
prunable gitdir file points to non-existent location
`;

	it("parses git worktree porcelain output into structured objects", () => {
		const worktrees = parseGitWorktreesPorcelain(
			mockPorcelain,
			"/Users/testuser/worktrees/repo/git-alias",
		);

		expect(worktrees).toHaveLength(4);

		// First entry is main repo
		expect(worktrees[0]).toEqual({
			path: resolve("/Users/testuser/repo"),
			head: "62bf5364e4bded05975ac480397dc2707aa8edfa",
			branch: "master",
			isMain: true,
			isCurrent: false,
			isBare: undefined,
			isDetached: undefined,
			isLocked: undefined,
			isPrunable: undefined,
		});

		// Second entry is the current worktree
		expect(worktrees[1]).toEqual({
			path: resolve("/Users/testuser/worktrees/repo/git-alias"),
			head: "62bf5364e4bded05975ac480397dc2707aa8edfa",
			branch: "git-alias",
			isMain: false,
			isCurrent: true,
			isBare: undefined,
			isDetached: undefined,
			isLocked: undefined,
			isPrunable: undefined,
		});

		// Detached entry
		expect(worktrees[2].isDetached).toBe(true);
		expect(worktrees[2].branch).toBeUndefined();

		// Prunable entry
		expect(worktrees[3].isPrunable).toBe(true);
		expect(worktrees[3].branch).toBe("old-branch");
	});

	it("finds the main worktree", () => {
		const worktrees = parseGitWorktreesPorcelain(mockPorcelain, "/Users/testuser/repo");
		const main = findMainWorktree(worktrees);
		expect(main).toBeDefined();
		expect(main?.isMain).toBe(true);
		expect(main?.path).toBe(resolve("/Users/testuser/repo"));
	});

	it("finds the current worktree", () => {
		const worktrees = parseGitWorktreesPorcelain(
			mockPorcelain,
			"/Users/testuser/worktrees/repo/git-alias",
		);
		const current = findCurrentWorktree(worktrees);
		expect(current).toBeDefined();
		expect(current?.isCurrent).toBe(true);
		expect(current?.branch).toBe("git-alias");
	});

	it("resolves worktree by branch name", () => {
		const worktrees = parseGitWorktreesPorcelain(mockPorcelain, "/Users/testuser/repo");

		const match = findWorktreeByInput("git-alias", worktrees);
		expect(match).toBeDefined();
		expect(match?.path).toBe(resolve("/Users/testuser/worktrees/repo/git-alias"));

		const caseMatch = findWorktreeByInput("GIT-ALIAS", worktrees);
		expect(caseMatch).toBeDefined();
		expect(caseMatch?.branch).toBe("git-alias");
	});

	it("resolves worktree by folder name / basename", () => {
		const worktrees = parseGitWorktreesPorcelain(mockPorcelain, "/Users/testuser/repo");

		const match = findWorktreeByInput("detached-fix", worktrees);
		expect(match).toBeDefined();
		expect(match?.path).toBe(resolve("/Users/testuser/worktrees/repo/detached-fix"));
	});

	it("resolves worktree by absolute path", () => {
		const worktrees = parseGitWorktreesPorcelain(mockPorcelain, "/Users/testuser/repo");

		const match = findWorktreeByInput("/Users/testuser/repo", worktrees);
		expect(match).toBeDefined();
		expect(match?.isMain).toBe(true);
	});

	it("returns undefined when worktree is not found", () => {
		const worktrees = parseGitWorktreesPorcelain(mockPorcelain, "/Users/testuser/repo");
		expect(findWorktreeByInput("non-existent", worktrees)).toBeUndefined();
		expect(findWorktreeByInput("", worktrees)).toBeUndefined();
	});

	it("getGitWorktrees executes git and returns parsed worktrees", async () => {
		const mockExecutor = vi.fn().mockResolvedValue({
			stdout: `worktree /path/to/main\nHEAD 12345\nbranch refs/heads/main\n`,
		});

		const result = await getGitWorktrees("/path/to/main", mockExecutor);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result![0].branch).toBe("main");
		expect(mockExecutor).toHaveBeenCalledWith("git", ["worktree", "list", "--porcelain"], {
			cwd: "/path/to/main",
			timeout: 3000,
		});
	});

	it("getGitWorktrees returns null on executor error or timeout", async () => {
		const mockExecutor = vi.fn().mockRejectedValue(new Error("fatal: not a git repository"));
		const result = await getGitWorktrees("/not/git", mockExecutor);
		expect(result).toBeNull();
	});
});
