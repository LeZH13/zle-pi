import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitWorktree {
	path: string;
	head?: string;
	branch?: string;
	isMain: boolean;
	isCurrent: boolean;
	isBare?: boolean;
	isDetached?: boolean;
	isLocked?: boolean;
	isPrunable?: boolean;
}

/**
 * Parse the output of `git worktree list --porcelain`.
 */
export function parseGitWorktreesPorcelain(output: string, cwd: string): GitWorktree[] {
	const normalizedCwd = resolve(cwd);
	const worktrees: GitWorktree[] = [];
	let current: Partial<GitWorktree> | null = null;

	const flushCurrent = () => {
		if (current && current.path) {
			const resolvedPath = resolve(current.path);
			worktrees.push({
				path: resolvedPath,
				head: current.head,
				branch: current.branch,
				isMain: worktrees.length === 0,
				isCurrent: resolvedPath === normalizedCwd,
				isBare: current.isBare,
				isDetached: current.isDetached,
				isLocked: current.isLocked,
				isPrunable: current.isPrunable,
			});
		}
		current = null;
	};

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			flushCurrent();
			continue;
		}

		if (trimmed.startsWith("worktree ")) {
			flushCurrent();
			current = { path: trimmed.slice("worktree ".length).trim() };
		} else if (current) {
			if (trimmed.startsWith("HEAD ")) {
				current.head = trimmed.slice("HEAD ".length).trim();
			} else if (trimmed.startsWith("branch ")) {
				const branchRef = trimmed.slice("branch ".length).trim();
				current.branch = branchRef.replace(/^refs\/heads\//, "");
			} else if (trimmed === "bare") {
				current.isBare = true;
			} else if (trimmed === "detached") {
				current.isDetached = true;
			} else if (trimmed.startsWith("locked")) {
				current.isLocked = true;
			} else if (trimmed.startsWith("prunable")) {
				current.isPrunable = true;
			}
		}
	}

	flushCurrent();
	return worktrees;
}

/**
 * Execute `git worktree list --porcelain` to discover worktrees for the repository.
 * Returns null if git fails, times out, or the cwd is not in a git repository.
 */
export async function getGitWorktrees(
	cwd: string,
	executor: (cmd: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string }> = async (
		cmd,
		args,
		opts,
	) => {
		return execFileAsync(cmd, args, opts);
	},
): Promise<GitWorktree[] | null> {
	try {
		const { stdout } = await executor("git", ["worktree", "list", "--porcelain"], {
			cwd,
			timeout: 3000,
		});
		const parsed = parseGitWorktreesPorcelain(stdout, cwd);
		return parsed.length > 0 ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Find the primary (main) worktree in a list of worktrees.
 */
export function findMainWorktree(worktrees: GitWorktree[]): GitWorktree | undefined {
	return worktrees.find((w) => w.isMain);
}

/**
 * Find the current worktree that matches the current cwd.
 */
export function findCurrentWorktree(worktrees: GitWorktree[]): GitWorktree | undefined {
	return worktrees.find((w) => w.isCurrent);
}

/**
 * Resolve user input (branch name, folder name, or path) to a matching worktree.
 */
export function findWorktreeByInput(input: string, worktrees: GitWorktree[]): GitWorktree | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;

	const normalizedInput = trimmed.replace(/[/\\]+$/, "");
	const lowerInput = normalizedInput.toLowerCase();

	// 1. Direct branch match
	const branchMatch = worktrees.find((w) => w.branch && w.branch.toLowerCase() === lowerInput);
	if (branchMatch) return branchMatch;

	// 2. Exact folder name / basename match
	const basenameMatch = worktrees.find((w) => basename(w.path).toLowerCase() === lowerInput);
	if (basenameMatch) return basenameMatch;

	// 3. Absolute path match
	try {
		const resolvedInput = resolve(normalizedInput);
		const pathMatch = worktrees.find((w) => resolve(w.path) === resolvedInput);
		if (pathMatch) return pathMatch;
	} catch {}

	return undefined;
}
