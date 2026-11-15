import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const THINKING_THEME_TOKENS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

/** @deprecated Retained for backwards compatibility with earlier footer versions */
export const THINKING_COLORS = {
	minimal: 46,
	low: 82,
	medium: 118,
	high: 220,
	xhigh: 208,
	max: 196,
} as const;

export type ThemeLike = {
	fg(color: string, text: string): string;
	getThinkingBorderColor?(level: string): (text: string) => string;
};

export function formatThinkingLevel(thinking: string, theme: ThemeLike): string {
	if (thinking === "ultra") {
		return rainbow(thinking);
	}
	if (typeof theme.getThinkingBorderColor === "function") {
		return theme.getThinkingBorderColor(thinking)(thinking);
	}
	const token = THINKING_THEME_TOKENS[thinking as keyof typeof THINKING_THEME_TOKENS] ?? "thinkingOff";
	return theme.fg(token, thinking);
}

export function formatModelIdentifier(model?: { id?: string; provider?: string }): string {
	if (!model || !model.id) return "no-model";
	if (model.provider && !model.id.startsWith(`${model.provider}/`)) {
		return `${model.provider}/${model.id}`;
	}
	return model.id;
}

export const CODEX_STATUS_KEYS = ["codex-auth", "pi-multi-codex"] as const;
export const CODEX_COLOR = "#b5bd68";
export const AGENT_TIME_ENTRY = "pi-footer:agent-work";
export const SUBAGENT_BACKGROUND_RESULT = "subagent-background-result";
export const MAX_PLAUSIBLE_TPS = 500;
export const MIN_DECODE_DURATION_SEC = 0.15;

export type FooterStyle = "classic" | "starship";

export interface FooterConfig {
	enabled: boolean;
	style: FooterStyle;
}

export const DEFAULT_CONFIG: FooterConfig = {
	enabled: true,
	style: "classic",
};

export function getFooterConfigPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "footer.json");
}

export function loadConfig(): FooterConfig {
	const configPath = getFooterConfigPath();
	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}
	try {
		const raw = readFileSync(configPath, "utf8");
		const data = JSON.parse(raw);
		return {
			enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_CONFIG.enabled,
			style: data.style === "classic" || data.style === "starship" ? data.style : DEFAULT_CONFIG.style,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: FooterConfig): void {
	const configPath = getFooterConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${configPath}.tmp.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
	renameSync(tmpPath, configPath);
}

export type CountedUsage = { input: number; output: number; cost: { total: number } };
export type GitSummary = { badges: string; starshipBadges?: string; detachedOid?: string; operation?: string };
export type GitMetrics = { added: number; deleted: number };

export const EMPTY_GIT_SUMMARY: GitSummary = { badges: "", starshipBadges: "" };

export function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function subagentBackgroundUsage(details: unknown): CountedUsage | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return;
	const usage = (details as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
	const record = usage as Record<string, unknown>;
	const cost = record.cost;
	if (!cost || typeof cost !== "object" || Array.isArray(cost)) return;
	const total = (cost as Record<string, unknown>).total;
	if (!isNonNegativeNumber(record.input) || !isNonNegativeNumber(record.output) || !isNonNegativeNumber(total)) return;
	return { input: record.input, output: record.output, cost: { total } };
}

export function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Whole-unit token format for the context window denominator: 500, 200k, 1M. */
export function formatTokensWhole(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

export function boldCyan(text: string): string {
	return `\x1b[1;36m${text}\x1b[22;39m`;
}

export function boldPurple(text: string): string {
	return `\x1b[1;35m${text}\x1b[22;39m`;
}

export function boldRed(text: string): string {
	return `\x1b[1;31m${text}\x1b[22;39m`;
}

export function boldGreen(text: string): string {
	return `\x1b[1;32m${text}\x1b[22;39m`;
}

export function boldYellow(text: string): string {
	return `\x1b[1;33m${text}\x1b[22;39m`;
}

export function parseGitNumstat(stdoutText: string): GitMetrics {
	let added = 0;
	let deleted = 0;
	for (const line of stdoutText.split(/\r?\n/)) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const a = parts[0];
		const d = parts[1];
		if (a === "-" || d === "-") continue;
		const na = Number(a);
		const nd = Number(d);
		if (Number.isFinite(na) && na > 0) added += na;
		if (Number.isFinite(nd) && nd > 0) deleted += nd;
	}
	return { added, deleted };
}

export function formatGitMetrics(metrics: GitMetrics): string {
	const parts: string[] = [];
	if (metrics.added > 0) {
		parts.push(boldGreen(`+${metrics.added}`));
	}
	if (metrics.deleted > 0) {
		parts.push(boldRed(`-${metrics.deleted}`));
	}
	return parts.join(" ");
}

export function formatStarshipStatus(opts: {
	conflicts: number;
	staged: number;
	unstaged: number;
	untracked: number;
	ahead: number;
	behind: number;
	operation?: string;
}): string {
	const glyphs = [
		opts.conflicts > 0 ? "=" : "",
		opts.unstaged > 0 ? "!" : "",
		opts.staged > 0 ? "+" : "",
		opts.untracked > 0 ? "?" : "",
		opts.ahead > 0 && opts.behind > 0 ? "⇕" : opts.ahead > 0 ? "↑" : opts.behind > 0 ? "↓" : "",
	].join("");

	let content = "";
	if (opts.operation && glyphs) {
		content = `${opts.operation} [${glyphs}]`;
	} else if (opts.operation) {
		content = opts.operation;
	} else if (glyphs) {
		content = `[${glyphs}]`;
	}

	return content ? boldRed(content) : "";
}

export function summarizeGitStatus(output: string, operation?: string): GitSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	let ahead = 0;
	let behind = 0;
	let detachedOid: string | undefined;

	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice(13).trim();
			if (oid !== "(initial)") detachedOid = oid.slice(0, 7);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		} else if (line.startsWith("? ")) {
			untracked++;
		} else if (line.startsWith("u ")) {
			conflicts++;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") staged++;
			if (xy[1] !== ".") unstaged++;
		}
	}

	const fileBadges = [
		conflicts ? `!${conflicts}` : undefined,
		staged ? `+${staged}` : undefined,
		unstaged ? `~${unstaged}` : undefined,
		untracked ? `?${untracked}` : undefined,
		ahead ? `↑${ahead}` : undefined,
		behind ? `↓${behind}` : undefined,
	]
		.filter(Boolean)
		.join("");

	let badgeContent = "";
	if (operation && fileBadges) {
		badgeContent = `${operation} ${fileBadges}`;
	} else if (operation) {
		badgeContent = operation;
	} else if (fileBadges) {
		badgeContent = fileBadges;
	}

	const starshipBadges = formatStarshipStatus({
		conflicts,
		staged,
		unstaged,
		untracked,
		ahead,
		behind,
		operation,
	});

	return {
		badges: badgeContent ? `[${badgeContent}]` : "",
		starshipBadges,
		detachedOid,
		operation,
	};
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

function operationProgress(current: string | undefined, total: string | undefined): string {
	const currentStep = Number.parseInt(current ?? "", 10);
	const totalSteps = Number.parseInt(total ?? "", 10);
	return currentStep > 0 && totalSteps > 0 ? ` ${currentStep}/${totalSteps}` : "";
}

export async function readGitOperation(gitDir: string): Promise<string | undefined> {
	const [
		rebaseMergeCurrent,
		rebaseMergeTotal,
		rebaseApplyCurrent,
		rebaseApplyTotal,
		applying,
		mergeHead,
		cherryPickHead,
		revertHead,
		bisectLog,
	] = await Promise.all([
		readOptional(join(gitDir, "rebase-merge", "msgnum")),
		readOptional(join(gitDir, "rebase-merge", "end")),
		readOptional(join(gitDir, "rebase-apply", "next")),
		readOptional(join(gitDir, "rebase-apply", "last")),
		readOptional(join(gitDir, "rebase-apply", "applying")),
		readOptional(join(gitDir, "MERGE_HEAD")),
		readOptional(join(gitDir, "CHERRY_PICK_HEAD")),
		readOptional(join(gitDir, "REVERT_HEAD")),
		readOptional(join(gitDir, "BISECT_LOG")),
	]);
	if (rebaseMergeCurrent !== undefined) return `REBASE${operationProgress(rebaseMergeCurrent, rebaseMergeTotal)}`;
	if (rebaseApplyCurrent !== undefined) {
		return `${applying === undefined ? "REBASE" : "AM"}${operationProgress(rebaseApplyCurrent, rebaseApplyTotal)}`;
	}
	if (mergeHead !== undefined) return "MERGING";
	if (cherryPickHead !== undefined) return "CHERRY-PICKING";
	if (revertHead !== undefined) return "REVERTING";
	if (bisectLog !== undefined) return "BISECTING";
}

export interface RuntimeInfo {
	name: string;
	symbol: string;
	version: string;
	style: (text: string) => string;
}

export function extractRuntimeVersion(output: string): string | undefined {
	const trimmed = output.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/([0-9]+\.[0-9]+(?:\.[0-9A-Za-z._-]+)?)/);
	if (!match) return undefined;
	const ver = match[1];
	return ver.startsWith("v") ? ver : `v${ver}`;
}

type RuntimeDef = {
	name: string;
	symbol: string;
	style: (text: string) => string;
	matches: (cwd: string) => boolean;
	cmd: string;
	args: string[];
};

const RUNTIME_DEFS: RuntimeDef[] = [
	{
		name: "bun",
		symbol: "",
		style: boldRed,
		matches: (cwd) =>
			existsSync(join(cwd, "bun.lock")) ||
			existsSync(join(cwd, "bun.lockb")) ||
			existsSync(join(cwd, "bunfig.toml")),
		cmd: "bun",
		args: ["--version"],
	},
	{
		name: "deno",
		symbol: "",
		style: boldGreen,
		matches: (cwd) =>
			existsSync(join(cwd, "deno.json")) ||
			existsSync(join(cwd, "deno.jsonc")) ||
			existsSync(join(cwd, "deno.lock")),
		cmd: "deno",
		args: ["--version"],
	},
	{
		name: "nodejs",
		symbol: "",
		style: boldGreen,
		matches: (cwd) =>
			(existsSync(join(cwd, "package.json")) ||
				existsSync(join(cwd, ".node-version")) ||
				existsSync(join(cwd, ".nvmrc"))) &&
			!existsSync(join(cwd, "bun.lock")) &&
			!existsSync(join(cwd, "bun.lockb")) &&
			!existsSync(join(cwd, "bunfig.toml")),
		cmd: "node",
		args: ["--version"],
	},
	{
		name: "rust",
		symbol: "󱘗",
		style: boldRed,
		matches: (cwd) => existsSync(join(cwd, "Cargo.toml")),
		cmd: "rustc",
		args: ["--version"],
	},
	{
		name: "golang",
		symbol: "",
		style: boldCyan,
		matches: (cwd) => existsSync(join(cwd, "go.mod")),
		cmd: "go",
		args: ["version"],
	},
	{
		name: "python",
		symbol: "",
		style: boldYellow,
		matches: (cwd) =>
			existsSync(join(cwd, "requirements.txt")) ||
			existsSync(join(cwd, ".python-version")) ||
			existsSync(join(cwd, "pyproject.toml")) ||
			existsSync(join(cwd, "Pipfile")) ||
			existsSync(join(cwd, "setup.py")) ||
			existsSync(join(cwd, "environment.yml")),
		cmd: "python3",
		args: ["--version"],
	},
	{
		name: "java",
		symbol: "",
		style: boldRed,
		matches: (cwd) =>
			existsSync(join(cwd, "pom.xml")) ||
			existsSync(join(cwd, "build.gradle")) ||
			existsSync(join(cwd, "build.gradle.kts")) ||
			existsSync(join(cwd, ".java-version")),
		cmd: "java",
		args: ["-version"],
	},
	{
		name: "ruby",
		symbol: "",
		style: boldRed,
		matches: (cwd) => existsSync(join(cwd, "Gemfile")) || existsSync(join(cwd, ".ruby-version")),
		cmd: "ruby",
		args: ["--version"],
	},
	{
		name: "php",
		symbol: "",
		style: boldPurple,
		matches: (cwd) => existsSync(join(cwd, "composer.json")),
		cmd: "php",
		args: ["--version"],
	},
];

const runtimeCache = new Map<string, RuntimeInfo | null>();

export function clearRuntimeCache(): void {
	runtimeCache.clear();
}

export async function detectRuntime(
	cwd: string,
	exec: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr?: string; code: number }>,
): Promise<RuntimeInfo | undefined> {
	if (runtimeCache.has(cwd)) {
		return runtimeCache.get(cwd) ?? undefined;
	}

	for (const def of RUNTIME_DEFS) {
		if (def.matches(cwd)) {
			try {
				let res = await exec(def.cmd, def.args, { cwd });
				let out = (res.stdout || "") + (res.stderr || "");
				if (def.name === "python" && res.code !== 0) {
					res = await exec("python", ["--version"], { cwd });
					out = (res.stdout || "") + (res.stderr || "");
				}
				const version = extractRuntimeVersion(out);
				if (version) {
					const info: RuntimeInfo = {
						name: def.name,
						symbol: def.symbol,
						version,
						style: def.style,
					};
					runtimeCache.set(cwd, info);
					return info;
				}
			} catch {
				// Continue checking next runtime
			}
		}
	}

	runtimeCache.set(cwd, null);
	return undefined;
}

export interface StarshipIdentityOptions {
	repo: string;
	branch?: string;
	detachedOid?: string;
	starshipBadges?: string;
	metrics?: GitMetrics;
	runtime?: RuntimeInfo;
	theme: ThemeLike;
}

export function formatStarshipIdentity(opts: StarshipIdentityOptions): string {
	const parts: string[] = [boldCyan(opts.repo)];

	if (opts.branch) {
		parts.push(opts.theme.fg("dim", "on"), boldPurple(` ${opts.branch}`));
	} else if (opts.detachedOid) {
		parts.push(opts.theme.fg("dim", "on"), boldPurple(` @${opts.detachedOid}`));
	}

	if (opts.starshipBadges) {
		parts.push(opts.starshipBadges);
	}

	if (opts.metrics && (opts.metrics.added > 0 || opts.metrics.deleted > 0)) {
		const metricsText = formatGitMetrics(opts.metrics);
		if (metricsText) {
			parts.push(metricsText);
		}
	}

	if (opts.runtime) {
		const runtimeLabel = `${opts.runtime.symbol} ${opts.runtime.version}`;
		parts.push(opts.theme.fg("dim", "via"), opts.runtime.style(runtimeLabel));
	}

	return parts.join(" ");
}

/** Align left and right contents within width, reserving right content and truncating left */
export function alignRightReserved(left: string, right: string, width: number, ellipsis: string): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) {
		return truncateToWidth(right, width, "");
	}
	const availableForLeft = Math.max(0, width - rightWidth - 1);
	const clippedLeft = availableForLeft > 0 ? truncateToWidth(left, availableForLeft, ellipsis) : "";
	const padding = " ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - rightWidth));
	return truncateToWidth(clippedLeft + padding + right, width, "");
}

export function color(text: string, ansi256: number): string {
	return `\x1b[38;5;${ansi256}m${text}\x1b[39m`;
}

export function rainbow(text: string): string {
	const colors = [196, 220, 46, 39, 201];
	return [...text].map((character, index) => color(character, colors[index % colors.length]!)).join("");
}

export function hexColor(hex: string, text: string): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export default function footerExtension(pi: ExtensionAPI): void {
	let activeMilliseconds = 0;
	let activeStartedAt: number | undefined;
	let promptPaused = false;
	let runtimeTimer: ReturnType<typeof setInterval> | undefined;
	let requestRuntimeRender: (() => void) | undefined;
	let refreshGitStatus: (() => Promise<void>) | undefined;
	let refreshRuntime: (() => Promise<void>) | undefined;
	let currentContext: ExtensionContext | undefined;
	let config: FooterConfig = loadConfig();
	let turnStartedAt: number | undefined;

	let repo = "";
	let gitSummary = EMPTY_GIT_SUMMARY;
	let gitMetrics: GitMetrics | undefined;
	let runtimeInfo: RuntimeInfo | undefined;

	const stopRuntimeTimer = () => {
		if (runtimeTimer === undefined) return;
		clearInterval(runtimeTimer);
		runtimeTimer = undefined;
	};

	const startActive = () => {
		if (activeStartedAt !== undefined || promptPaused) return;
		activeStartedAt = performance.now();
		if (requestRuntimeRender && runtimeTimer === undefined) {
			runtimeTimer = setInterval(requestRuntimeRender, 1_000);
		}
		requestRuntimeRender?.();
	};

	const pauseActive = () => {
		if (activeStartedAt === undefined) return;
		activeMilliseconds += performance.now() - activeStartedAt;
		activeStartedAt = undefined;
		promptPaused = true;
		stopRuntimeTimer();
		requestRuntimeRender?.();
	};

	const resumeActive = () => {
		if (!promptPaused) return;
		promptPaused = false;
		activeStartedAt = performance.now();
		if (requestRuntimeRender && runtimeTimer === undefined) {
			runtimeTimer = setInterval(requestRuntimeRender, 1_000);
		}
		requestRuntimeRender?.();
	};

	const finalizeActive = (): boolean => {
		if (activeStartedAt === undefined && !promptPaused) return false;
		if (activeStartedAt !== undefined) {
			activeMilliseconds += performance.now() - activeStartedAt;
		}
		activeStartedAt = undefined;
		promptPaused = false;
		stopRuntimeTimer();
		requestRuntimeRender?.();
		return true;
	};

	let promptOutputTokens = 0;
	let promptGenerationSeconds = 0;

	pi.on("agent_start", () => {
		startActive();
		promptOutputTokens = 0;
		promptGenerationSeconds = 0;
		turnStartedAt = performance.now();
	});

	pi.on("ui_prompt_start", () => {
		pauseActive();
	});

	pi.on("ui_prompt_end", () => {
		resumeActive();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.isIdle()) return;
		if (finalizeActive()) {
			pi.appendEntry(AGENT_TIME_ENTRY, activeMilliseconds);
		}
		if (turnStartedAt !== undefined && ctx.hasUI) {
			const elapsed = performance.now() - turnStartedAt;
			ctx.ui.notify(`worked for ${formatDuration(elapsed)}`, "info");
		}
		turnStartedAt = undefined;
		await refreshGitStatus?.();
	});

	pi.on("session_shutdown", () => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		refreshGitStatus = undefined;
		refreshRuntime = undefined;
		requestRuntimeRender = undefined;
		currentContext = undefined;
		clearRuntimeCache();
		assistantStartedAt = undefined;
		firstTokenAt = undefined;
	});

	let assistantStartedAt: number | undefined;
	let firstTokenAt: number | undefined;
	let tps: number | undefined;

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			assistantStartedAt = performance.now();
			firstTokenAt = undefined;
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && firstTokenAt === undefined) {
			firstTokenAt = performance.now();
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || assistantStartedAt === undefined) return;
		const output = event.message.usage?.output ?? 0;
		const now = performance.now();
		const totalTurnSeconds = (now - assistantStartedAt) / 1000;
		const decodeSeconds = firstTokenAt !== undefined ? (now - firstTokenAt) / 1000 : undefined;
		assistantStartedAt = undefined;
		firstTokenAt = undefined;

		if (output <= 0 || totalTurnSeconds <= 0) return;

		let turnDurationSeconds: number;
		if (
			decodeSeconds !== undefined &&
			decodeSeconds >= MIN_DECODE_DURATION_SEC &&
			output / decodeSeconds <= MAX_PLAUSIBLE_TPS
		) {
			turnDurationSeconds = decodeSeconds;
		} else if (totalTurnSeconds > 0 && output / totalTurnSeconds <= MAX_PLAUSIBLE_TPS) {
			turnDurationSeconds = totalTurnSeconds;
		} else {
			turnDurationSeconds = Math.max(totalTurnSeconds, output / MAX_PLAUSIBLE_TPS);
		}

		if (turnDurationSeconds > 0) {
			promptOutputTokens += output;
			promptGenerationSeconds += turnDurationSeconds;
			tps = promptOutputTokens / promptGenerationSeconds;
		}
	});

	function applyFooter(
		ctx: ExtensionContext,
		currentRepo: string,
		getGitSummary: () => GitSummary,
		getGitMetrics: () => GitMetrics | undefined,
		getRuntimeInfo: () => RuntimeInfo | undefined,
		getConfig: () => FooterConfig,
	) {
		let usageKey: string | undefined;
		let input = 0;
		let output = 0;
		let cost = 0;
		let cacheRate: number | undefined;

		const computeUsage = () => {
			input = 0;
			output = 0;
			cost = 0;
			cacheRate = undefined;
			const add = (u: CountedUsage | undefined) => {
				if (!u) return;
				input += u.input;
				output += u.output;
				cost += u.cost.total;
			};

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const usage = entry.message.usage;
					const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
					cacheRate = prompt ? (usage.cacheRead / prompt) * 100 : 0;
					add(usage);
				} else if (entry.type === "message" && entry.message.role === "toolResult") {
					add(entry.message.usage);
				} else if (entry.type === "custom_message" && entry.customType === SUBAGENT_BACKGROUND_RESULT) {
					add(subagentBackgroundUsage(entry.details));
				} else if (entry.type === "branch_summary" || entry.type === "compaction") {
					add(entry.usage);
				}
			}
		};

		ctx.ui.setFooter((tui, theme, data) => {
			requestRuntimeRender = () => tui.requestRender();
			if (activeStartedAt !== undefined && runtimeTimer === undefined) {
				runtimeTimer = setInterval(requestRuntimeRender, 1_000);
			}

			const unsubscribe = data.onBranchChange(() => {
				void refreshGitStatus?.();
				void refreshRuntime?.();
				requestRuntimeRender?.();
			});

			return {
				dispose() {
					unsubscribe();
					requestRuntimeRender = undefined;
					stopRuntimeTimer();
				},
				invalidate() {},
				render(width: number): string[] {
					const entries = ctx.sessionManager.getEntries();
					const key = `${entries.length}:${entries.at(-1)?.type}`;
					if (key !== usageKey) {
						usageKey = key;
						computeUsage();
					}

					const activeConfig = getConfig();
					const currentSummary = getGitSummary();
					const currentMetrics = getGitMetrics();
					const currentRuntime = getRuntimeInfo();

					const reportedBranch = data.getGitBranch()?.replace(/^worktree\//, "");
					const branch = reportedBranch === "detached" ? undefined : reportedBranch;
					const contextUsage = ctx.getContextUsage();
					const contextStr =
						contextUsage === undefined
							? "—"
							: `${contextUsage.tokens == null ? "—" : formatTokens(contextUsage.tokens)}/${formatTokensWhole(contextUsage.contextWindow)}`;
					const extensionStatuses = data.getExtensionStatuses();

					// Extract Codex status for Line 1 right
					let codexStatus: string | undefined;
					for (const statusKey of CODEX_STATUS_KEYS) {
						const status = extensionStatuses.get(statusKey);
						if (status) {
							codexStatus = sanitizeStatus(status);
							break;
						}
					}

					// Remaining external statuses for Line 3 left
					const externalStatuses = [...extensionStatuses]
						.filter(([statusKey]) => !CODEX_STATUS_KEYS.includes(statusKey as any))
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);

					const thinking = String(ctx.thinkingLevel ?? "off");
					const ellipsis = theme.fg("dim", "…");

					// Line 1: Identity & Quota
					let identityLine: string;
					if (activeConfig.style === "starship") {
						identityLine = formatStarshipIdentity({
							repo: currentRepo,
							branch,
							detachedOid: currentSummary.detachedOid,
							starshipBadges: currentSummary.starshipBadges,
							metrics: currentMetrics,
							runtime: currentRuntime,
							theme,
						});
					} else {
						const detachedBranch =
							reportedBranch === "detached" && currentSummary.detachedOid
								? `@${currentSummary.detachedOid}`
								: reportedBranch;
						const identityPrefix = detachedBranch ? `${currentRepo} · ` : "";
						const checkout = detachedBranch ? ` ${detachedBranch}` : currentRepo;
						const checkoutStatus = currentSummary.badges
							? `${theme.fg("accent", checkout)} ${theme.fg("dim", currentSummary.badges)}`
							: theme.fg("accent", checkout);
						identityLine = `${theme.fg("dim", identityPrefix)}${checkoutStatus}`;
					}

					const formattedCodex = codexStatus
						? (/\x1b\[[0-9;]*m/.test(codexStatus) ? codexStatus : hexColor(CODEX_COLOR, codexStatus))
						: undefined;
					const line1 = formattedCodex
						? alignRightReserved(identityLine, formattedCodex, width, ellipsis)
						: truncateToWidth(identityLine, width, ellipsis);

					// Line 2: Usage Metrics & Active Model/Thinking
					const tokensStr = `↑ ${formatTokens(input)} ↓ ${formatTokens(output)}`;
					const usage = theme.fg(
						"dim",
						[
							tokensStr,
							`◔ ${contextStr}`,
							`↺ ${cacheRate === undefined ? "—" : `${cacheRate.toFixed(1)}%`}`,
							` ${tps === undefined ? "—" : `${tps.toFixed(1)} t/s`}`,
							`$ ${cost.toFixed(3)}`,
						].join(" · "),
					);

					const thinkingText = formatThinkingLevel(thinking, theme);
					const modelStr = formatModelIdentifier(ctx.model);
					const model = theme.fg("dim", `${modelStr} • `) + thinkingText;
					const line2 = alignRightReserved(usage, model, width, ellipsis);

					// Line 3: External Statuses & Active Agent Timer
					const elapsed =
						activeMilliseconds + (activeStartedAt === undefined ? 0 : performance.now() - activeStartedAt);
					const runtimeStr = theme.fg("dim", `◷ ${formatDuration(elapsed)}`);
					const externalJoined = externalStatuses.join(theme.fg("dim", " | "));
					const line3 = alignRightReserved(externalJoined, runtimeStr, width, ellipsis);

					return [line1, line2, line3];
				},
			};
		});
	}

	async function updateFooterUI(ctx: ExtensionContext) {
		if (!config.enabled) {
			ctx.ui.setFooter(undefined);
			stopRuntimeTimer();
			return;
		}
		if (config.style === "starship") {
			const promises: Promise<void>[] = [];
			if (refreshGitStatus) promises.push(refreshGitStatus());
			if (refreshRuntime) promises.push(refreshRuntime());
			if (promises.length > 0) {
				await Promise.all(promises);
			}
		}
		applyFooter(
			ctx,
			repo,
			() => gitSummary,
			() => gitMetrics,
			() => runtimeInfo,
			() => config,
		);
		requestRuntimeRender?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		requestRuntimeRender = undefined;
		refreshGitStatus = undefined;
		refreshRuntime = undefined;
		currentContext = ctx;
		config = loadConfig();

		// Restore persisted agent work time; latest valid entry wins
		activeMilliseconds = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === AGENT_TIME_ENTRY && isNonNegativeNumber(entry.data)) {
				activeMilliseconds = entry.data;
			}
		}

		if (ctx.mode !== "tui") return;

		gitSummary = EMPTY_GIT_SUMMARY;
		gitMetrics = undefined;
		runtimeInfo = undefined;
		let gitRefreshGeneration = 0;

		const git = await pi.exec(
			"git",
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
			{ cwd: ctx.cwd },
		);

		const [root, commonDir, gitDir] = (git.stdout || "").trim().split(/\r?\n/);
		const rootName = basename(root || ctx.cwd);
		const commonName = commonDir && basename(commonDir) === ".git" ? basename(dirname(commonDir)) : undefined;
		repo = git.code === 0 ? (commonName && commonName !== rootName ? commonName : rootName) : basename(ctx.cwd);

		refreshRuntime = async () => {
			runtimeInfo = await detectRuntime(ctx.cwd, (cmd, args, opts) => pi.exec(cmd, args, opts));
			requestRuntimeRender?.();
		};

		if (git.code === 0 && gitDir) {
			refreshGitStatus = async () => {
				const generation = ++gitRefreshGeneration;
				const isStarship = config.style === "starship";
				const promises: [
					Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>,
					Promise<string | undefined>,
					Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> | undefined,
				] = [
					pi.exec("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
						cwd: ctx.cwd,
					}),
					readGitOperation(gitDir),
					isStarship ? pi.exec("git", ["diff", "HEAD", "--numstat"], { cwd: ctx.cwd }) : undefined,
				];
				const [status, operation, diff] = await Promise.all(promises);
				if (generation !== gitRefreshGeneration) return;
				gitSummary = status.code === 0 ? summarizeGitStatus(status.stdout, operation) : EMPTY_GIT_SUMMARY;
				gitMetrics = diff && diff.code === 0 ? parseGitNumstat(diff.stdout) : undefined;
				requestRuntimeRender?.();
			};
			if (config.style === "starship") {
				await Promise.all([refreshGitStatus(), refreshRuntime()]);
			} else {
				await refreshGitStatus();
			}
		} else if (config.style === "starship") {
			await refreshRuntime();
		}

		if (config.enabled) {
			await updateFooterUI(ctx);
		}
	});

	pi.registerCommand("footer", {
		description: "Configure or toggle custom footer (styles: starship | classic)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "toggle") {
				config.enabled = !config.enabled;
				saveConfig(config);
				await updateFooterUI(ctx);
				ctx.ui.notify(`Custom footer ${config.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (sub === "on") {
				config.enabled = true;
				saveConfig(config);
				await updateFooterUI(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
				return;
			}

			if (sub === "off") {
				config.enabled = false;
				saveConfig(config);
				await updateFooterUI(ctx);
				ctx.ui.notify("Custom footer disabled (default footer restored)", "info");
				return;
			}

			if (sub === "starship" || sub === "style starship") {
				config.style = "starship";
				config.enabled = true;
				saveConfig(config);
				await updateFooterUI(ctx);
				ctx.ui.notify("Footer style: starship", "info");
				return;
			}

			if (sub === "classic" || sub === "style classic") {
				config.style = "classic";
				config.enabled = true;
				saveConfig(config);
				await updateFooterUI(ctx);
				ctx.ui.notify("Footer style: classic", "info");
				return;
			}

			if (sub === "style") {
				if (typeof ctx.ui.select === "function") {
					const choice = await ctx.ui.select("Select Footer Style", [
						`starship ${config.style === "starship" ? "(active)" : ""}`,
						`classic ${config.style === "classic" ? "(active)" : ""}`,
					]);
					if (!choice) return;
					if (choice.startsWith("starship")) {
						config.style = "starship";
						config.enabled = true;
						saveConfig(config);
						await updateFooterUI(ctx);
						ctx.ui.notify("Footer style: starship", "info");
					} else if (choice.startsWith("classic")) {
						config.style = "classic";
						config.enabled = true;
						saveConfig(config);
						await updateFooterUI(ctx);
						ctx.ui.notify("Footer style: classic", "info");
					}
					return;
				}
			}

			// Interactive selector when no arguments provided and ctx.ui.select is supported
			if (typeof ctx.ui.select === "function") {
				const choice = await ctx.ui.select("Footer Configuration", [
					`Style: Starship ${config.style === "starship" ? "✓" : ""}`,
					`Style: Classic ${config.style === "classic" ? "✓" : ""}`,
					`Footer: ${config.enabled ? "Enabled (click to disable)" : "Disabled (click to enable)"}`,
				]);
				if (!choice) return;
				if (choice.startsWith("Style: Starship")) {
					config.style = "starship";
					config.enabled = true;
					saveConfig(config);
					await updateFooterUI(ctx);
					ctx.ui.notify("Footer style: starship", "info");
				} else if (choice.startsWith("Style: Classic")) {
					config.style = "classic";
					config.enabled = true;
					saveConfig(config);
					await updateFooterUI(ctx);
					ctx.ui.notify("Footer style: classic", "info");
				} else if (choice.startsWith("Footer:")) {
					config.enabled = !config.enabled;
					saveConfig(config);
					await updateFooterUI(ctx);
					ctx.ui.notify(config.enabled ? "Custom footer enabled" : "Default footer restored", "info");
				}
				return;
			}

			// Fallback for non-interactive environments (toggle)
			config.enabled = !config.enabled;
			saveConfig(config);
			await updateFooterUI(ctx);
			ctx.ui.notify(config.enabled ? "Custom footer enabled" : "Default footer restored", "info");
		},
	});
}
