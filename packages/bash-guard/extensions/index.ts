/*
 * bash-guard for Pi: a guard and a watchdog for the bash tool, sharing one
 * Jev (TypeSafe System One) client.
 *
 * - Guard (`tool_call`, bash only): tokenizes the command, matches a curated
 *   risky-pattern table, and asks Jev one noul question - "could this cause
 *   irreversible loss?" - only for risky commands. Anything below
 *   `allowBelow` passes; everything else escalates to a dialog (or blocks
 *   without a UI). Without any Jev classifier the table runs rules-only.
 *
 * - Watchdog (running bash): overrides the bash tool, wraps pi's local shell
 *   operations, keeps a bounded output tail per running command, and asks Jev
 *   periodically whether the command is progressing, waiting, stuck, or
 *   looping. Consecutive stuck/looping checks kill the command; a legitimate
 *   long-lived service is never killed and steers once instead.
 *
 * Internal modules live in `../src/`; this file is the only exposed resource.
 */
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	ToolCallEventResult,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	getAgentDir,
	isBashToolResult,
	isToolCallEventType,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionUIContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, type BashGuardConfig } from "../src/config.js";
import { formatGuardScore, runGuard, type GuardDeps, type GitInfo, type JevScore } from "../src/guard.js";
import { createJev, type Jev } from "../src/jev.js";
import { RISKY_RULES, compilePatterns, type RiskyScan } from "../src/rules.js";
import { ALLOW_ENTRY_TYPE, restoreState, TOGGLES_ENTRY_TYPE } from "../src/state.js";
import { renderStatus, type GuardTally, type StatusStyler } from "../src/status.js";
import { Watchdog, type WatchCheckRecord } from "../src/watchdog.js";

const FLAG_NAME = "no-bash-guard";
const COMMAND_NAME = "bash-guard";
const STATUS_KEY = "bash-guard";

const ARGUMENT_COMPLETIONS = ["status", "on", "off", "guard on", "guard off", "watchdog on", "watchdog off"];

/** Bounded toolCallId → score-label map for the transcript score line. */
const GUARD_SCORE_MAP_LIMIT = 512;

/** Footer clock refresh while watched commands run. */
const STATUS_TICK_MS = 1000;

export default function bashGuardExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		description: "Disable the bash-guard guard and watchdog for this run",
		type: "boolean",
		default: false,
	});

	// --- shared session state -------------------------------------------------
	let ui: ExtensionUIContext | undefined;
	let config: BashGuardConfig = structuredClone(DEFAULT_CONFIG);
	let configFiles: string[] = [];
	let sessionGuard = true;
	let sessionWatchdog = true;
	let allowedCommands = new Set<string>();
	let currentRegistry: ModelRegistry | undefined;
	let jev: Jev = createJev({
		getRegistry: () => currentRegistry,
		modelSpec: DEFAULT_CONFIG.jev.model,
		timeoutMs: DEFAULT_CONFIG.jev.timeoutMs,
	});
	let watchdog: Watchdog | undefined;
	let bashRegistered = false;
	let bashConflict = false;
	let jevOffNotified = false;
	let guardScores = new Map<string, string>();
	let risky: RiskyScan = { rules: RISKY_RULES, extra: [], allow: [] };
	let tally: GuardTally = { passed: 0, asked: 0, blocked: 0 };
	let statusTick: ReturnType<typeof setInterval> | undefined;

	const flagDisabled = (): boolean => pi.getFlag(FLAG_NAME) === true;
	const guardOn = (): boolean => !flagDisabled() && config.guard.enabled && sessionGuard;
	const watchdogOn = (): boolean => !flagDisabled() && config.watchdog.enabled && sessionWatchdog;

	function notifySafe(message: string, type: "info" | "warning" | "error"): void {
		if (ui) ui.notify(message, type);
	}

	function steer(message: string): void {
		// During a watched command the agent is streaming; steer delivery queues
		// the message into the current run instead of starting a competing turn.
		try {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} catch {
			notifySafe(message, "warning");
		}
	}

	function refreshStatus(ctx?: ExtensionContext): void {
		const sink = ctx?.hasUI ? ctx.ui : ui;
		if (!sink) return;
		// Blend with pi's default dimmed footer text; problem segments warn.
		// Defensive: a UI without a usable theme still gets plain text.
		const styler: StatusStyler = (text, kind) => {
			try {
				const theme = sink.theme;
				if (theme?.fg) return theme.fg(kind, text);
			} catch {
				// Fall through to plain text.
			}
			return text;
		};
		sink.setStatus(
			STATUS_KEY,
			renderStatus(
				{
					flagDisabled: flagDisabled(),
					guardOn: guardOn(),
					watchdogOn: watchdogOn(),
					jevAvailable: jev.available,
					jevFailure: jev.lastFailure,
					bashConflict,
					tally,
					live: watchdog?.live(),
				},
				styler,
			),
		);
	}

	/** Tick the footer clock only while watched commands run. */
	function syncStatusTick(): void {
		const running = (watchdog?.runningCount() ?? 0) > 0;
		if (running && !statusTick) {
			statusTick = setInterval(() => refreshStatus(), STATUS_TICK_MS);
		} else if (!running && statusTick) {
			clearInterval(statusTick);
			statusTick = undefined;
		}
	}

	function stopStatusTick(): void {
		if (statusTick) clearInterval(statusTick);
		statusTick = undefined;
	}

	function ensureBashOverride(cwd: string): void {
		if (bashRegistered || !watchdogOn()) return;
		const inner = createLocalBashOperations();
		const operations: BashOperations = {
			exec: async (command, execCwd, options) => {
				if (!watchdogOn()) return inner.exec(command, execCwd, options);
				const controller = new AbortController();
				const entry = watchdog!.start(command, execCwd, { abort: () => controller.abort() });
				syncStatusTick();
				refreshStatus();
				const outer = options.signal;
				const onOuterAbort = () => controller.abort();
				if (outer) {
					if (outer.aborted) onOuterAbort();
					else outer.addEventListener("abort", onOuterAbort, { once: true });
				}
				try {
					return await inner.exec(command, execCwd, {
						...options,
						signal: controller.signal,
						onData: (data) => {
							options.onData(data);
							watchdog!.recordOutput(entry, data.toString("utf8"));
						},
					});
				} catch (error) {
					if (watchdog!.isKilled(entry)) {
						throw new Error(watchdog!.killMessage(entry));
					}
					throw error;
				} finally {
					outer?.removeEventListener("abort", onOuterAbort);
					watchdog!.finish(entry);
					syncStatusTick();
					refreshStatus();
				}
			},
		};
		pi.registerTool(createBashToolDefinition(cwd, { operations }));
		bashRegistered = true;
	}

	/** True when another extension won the bash override, so the watchdog is inert. */
	function detectBashConflict(): boolean {
		if (!bashRegistered) return false;
		try {
			const bash = pi.getAllTools().find((tool: ToolInfo) => tool.name === "bash");
			if (!bash) return false;
			return !(bash.sourceInfo?.path ?? "").includes("bash-guard");
		} catch {
			return false;
		}
	}

	async function gitInfo(cwd: string): Promise<GitInfo> {
		try {
			const result = await pi.exec("git", ["status", "--porcelain", "-b"], { cwd, timeout: 2000 });
			if (result.code !== 0) return {};
			const lines = result.stdout.split("\n");
			const head = lines[0] ?? "";
			let branch: string | undefined;
			if (head.startsWith("## ")) {
				branch = head.slice(3).trim().split(/\.\.\.|\s|\[/)[0] || undefined;
			}
			const dirty = lines.slice(1).some((line) => line.trim() !== "");
			return { branch, dirty };
		} catch {
			return {};
		}
	}

	function guardDeps(ctx: ExtensionContext): GuardDeps {
		return {
			config,
			jev,
			risky,
			gitInfo,
			hasUI: ctx.hasUI,
			select: (title, options, opts) =>
				ctx.ui.select(title, [...options], opts?.signal === undefined ? undefined : { signal: opts.signal }),
			notify: (message, type) => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			},
			isSessionAllowed: (command) => allowedCommands.has(command),
			allowForSession: (command) => {
				allowedCommands.add(command);
				pi.appendEntry(ALLOW_ENTRY_TYPE, { command });
			},
			notifyJevOffOnce: () => {
				if (jevOffNotified) return;
				jevOffNotified = true;
				notifySafe(`bash-guard: running rules-only (no Jev classifier) - ${jev.describeUnavailable()}`, "warning");
			},
		};
	}

	function rememberGuardScore(toolCallId: string, score: JevScore): void {
		while (guardScores.size >= GUARD_SCORE_MAP_LIMIT) {
			const oldest = guardScores.keys().next().value;
			if (oldest === undefined) break;
			guardScores.delete(oldest);
		}
		guardScores.set(toolCallId, formatGuardScore(score));
	}

	// --- guard score rendering -------------------------------------------------
	// Under the command line of every bash call the guard judged and allowed,
	// render Jev's verdict in a dim line. The built-in renderCall reuses
	// context.lastComponent (a Text it mutates via setText), so delegate with a
	// fresh component and compose a container whenever a score is present.
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "bash") return undefined;
		const base = next();
		const baseRenderCall = base?.renderCall;
		if (!baseRenderCall) return base;
		return {
			...base,
			renderCall: (args, theme, context) => {
				const component = baseRenderCall(args, theme, { ...context, lastComponent: undefined });
				const label = guardScores.get(context.toolCallId);
				if (label === undefined) return component;
				const container = new Container();
				container.addChild(component);
				container.addChild(new Text(theme.fg("muted", `⛨ bash-guard: ${label}`), 0, 0));
				return container;
			},
		};
	});

	// --- guard ---------------------------------------------------------------

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!isToolCallEventType("bash", event)) return undefined;
		if (!guardOn()) return undefined;
		const outcome = await runGuard(guardDeps(ctx), {
			command: event.input.command,
			cwd: ctx.cwd,
			signal: ctx.signal,
		});
		if (outcome.verdict) {
			tally = { ...tally, [outcome.verdict]: tally[outcome.verdict] + 1 };
		}
		refreshStatus(ctx);
		if (outcome.action === "allow") {
			if (outcome.jev) rememberGuardScore(event.toolCallId, outcome.jev);
			return undefined;
		}
		if (ctx.hasUI) ctx.ui.notify(outcome.reason, "error");
		return { block: true, reason: outcome.reason };
	});

	// Attach the per-check watchdog log to bash tool result details (UI-only;
	// the model-facing content is unchanged and the built-in renderer ignores
	// unknown details fields).
	pi.on("tool_result", (event): ToolResultEventResult | undefined => {
		if (!isBashToolResult(event)) return undefined;
		if (!watchdog) return undefined;
		const command = event.input?.command;
		if (typeof command !== "string") return undefined;
		const checks = watchdog.getLog(command);
		if (checks.length === 0) return undefined;
		return { details: { ...(event.details ?? {}), bashGuardWatchdog: { checks } } };
	});

	// --- session lifecycle ---------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		currentRegistry = ctx.modelRegistry;
		const onError = (message: string): void => {
			if (ctx.hasUI) ctx.ui.notify(`bash-guard: ${message}`, "warning");
		};
		const loaded = loadConfig({ agentDir: getAgentDir(), projectDir: ctx.cwd, onError });
		config = loaded.config;
		configFiles = loaded.files;
		risky = {
			rules: RISKY_RULES,
			extra: compilePatterns(config.guard.extraRiskyPatterns, (source, error) =>
				onError(`invalid extraRiskyPatterns entry "${source}": ${error}`),
			),
			allow: compilePatterns(config.guard.allowPatterns, (source, error) =>
				onError(`invalid allowPatterns entry "${source}": ${error}`),
			),
		};

		const restored = restoreState(ctx.sessionManager.getBranch());
		sessionGuard = restored.toggles?.guard ?? true;
		sessionWatchdog = restored.toggles?.watchdog ?? true;
		allowedCommands = new Set(restored.allowedCommands);
		jevOffNotified = false;
		guardScores = new Map();
		bashConflict = false;
		tally = { passed: 0, asked: 0, blocked: 0 };

		jev = createJev({
			getRegistry: () => currentRegistry,
			modelSpec: config.jev.model,
			timeoutMs: config.jev.timeoutMs,
		});
		// Resolve the classifier eagerly so the status line and the one-time
		// notice reflect reality; later calls re-resolve lazily (e.g. after /login).
		if (!(await jev.ensureAvailable())) {
			notifySafe(`bash-guard: ${jev.describeUnavailable()}`, "warning");
		}

		stopStatusTick();
		watchdog?.dispose();
		watchdog = new Watchdog({
			config,
			jev,
			now: () => Date.now(),
			steer,
			notify: (message, type) => notifySafe(message, type),
		});

		if (watchdogOn()) {
			ensureBashOverride(ctx.cwd);
			bashConflict = detectBashConflict();
			if (bashConflict) {
				notifySafe(
					"bash-guard: another extension already overrides the bash tool, so the watchdog cannot watch commands. The guard still runs.",
					"warning",
				);
			}
		}
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopStatusTick();
		watchdog?.dispose();
		currentRegistry = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// --- /bash-guard command ---------------------------------------------------

	function statusLines(): string {
		const lines = [
			`guard: ${guardOn() ? "on" : "off"} (config ${config.guard.enabled}, session ${sessionGuard}, flag ${flagDisabled() ? "off" : "on"})`,
			`watchdog: ${watchdogOn() ? "on" : "off"} - tracking ${watchdog?.runningCount() ?? 0} command(s)` +
				(bashRegistered ? (bashConflict ? " - override lost to another extension" : " - bash override registered") : " - not overriding bash"),
			`jev: ${jev.available ? "on" : "off"} - ${jev.available ? jev.model : jev.describeUnavailable()} (timeout ${config.jev.timeoutMs}ms)` +
				(jev.lastFailure ? ` - last call failed: ${jev.lastFailure}` : ""),
			`guard decisions (session): ${tally.passed} passed by Jev, ${tally.asked} asked and allowed, ${tally.blocked} blocked`,
			`first check ${config.watchdog.firstCheckSec}s, interval ${config.watchdog.intervalSec}s, confidence ${config.watchdog.confidence}, agree checks ${config.watchdog.agreeChecks}`,
			`allowBelow ${config.guard.allowBelow}, session-allowed commands: ${allowedCommands.size}, allow patterns: ${config.guard.allowPatterns.length}, extra risky patterns: ${config.guard.extraRiskyPatterns.length}`,
			`config: ${configFiles.length > 0 ? configFiles.join(", ") : "defaults (no bash-guard.json found)"}`,
		];
		const usage = jev.usage();
		if (usage.totalTokens > 0) {
			lines.push(
				`classifier usage (session): ${usage.totalTokens} tokens, $${
					usage.cost >= 0.01 ? usage.cost.toFixed(2) : usage.cost.toFixed(4)
				}`,
			);
		}
		if (bashConflict) lines.push("⚠ another extension owns the bash override; the watchdog is inert this session");
		for (const log of watchdog?.recentLogs(5) ?? []) {
			lines.push(`watch log ${log.command.slice(0, 60)}: ${log.checks.map(formatCheck).join(" | ")}`);
		}
		return lines.join("\n");
	}

	function formatCheck(check: WatchCheckRecord): string {
		const verdict =
			check.status === undefined
				? check.outcome
				: `${check.status} p=${check.probabilities?.[check.status]?.toFixed(2)} persistent=${check.persistent?.toFixed(2)} ${check.outcome}`;
		return `[${check.elapsedSeconds}s ${verdict}]`;
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Show or toggle bash-guard (guard + watchdog)",
		getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] =>
			ARGUMENT_COMPLETIONS.filter((argument) => argument.startsWith(argumentPrefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [head, tail] = tokens;
			const apply = (): boolean => {
				switch (head) {
					case undefined: {
						notifySafe(statusLines(), "info");
						return false;
					}
					case "status": {
						notifySafe(statusLines(), "info");
						return false;
					}
					case "on": {
						sessionGuard = true;
						sessionWatchdog = true;
						return true;
					}
					case "off": {
						sessionGuard = false;
						sessionWatchdog = false;
						return true;
					}
					case "guard": {
						if (tail === "on") sessionGuard = true;
						else if (tail === "off") sessionGuard = false;
						else {
							notifySafe("usage: /bash-guard guard on|off", "warning");
							return false;
						}
						return true;
					}
					case "watchdog": {
						if (tail === "on") sessionWatchdog = true;
						else if (tail === "off") sessionWatchdog = false;
						else {
							notifySafe("usage: /bash-guard watchdog on|off", "warning");
							return false;
						}
						return true;
					}
					default: {
						notifySafe("usage: /bash-guard [status|on|off|guard on|off|watchdog on|off]", "warning");
						return false;
					}
				}
			};

			if (!apply()) {
				refreshStatus(ctx);
				return;
			}
			pi.appendEntry(TOGGLES_ENTRY_TYPE, { guard: sessionGuard, watchdog: sessionWatchdog });
			if (watchdogOn()) {
				ensureBashOverride(ctx.cwd);
				bashConflict = detectBashConflict();
			} else {
				watchdog?.dispose();
				stopStatusTick();
			}
			refreshStatus(ctx);
		},
	});
}
