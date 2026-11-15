/*
 * bash-guard for Pi: a guard and a watchdog for the bash tool, sharing one
 * Jev (TypeSafe System One) client.
 *
 * - Guard (`tool_call`, bash only): tokenizes the command, matches a curated
 *   risky-pattern table, and asks Jev one noul question - "could this cause
 *   irreversible loss?" - only for risky commands. Anything below
 *   `allowBelow` passes; everything else escalates to a dialog (or blocks
 *   without a UI). In deny mode (`guard.approvalMode` or the
 *   PI_BASH_GUARD_APPROVAL_MODE launch override) every escalation is blocked
 *   without a dialog and restored session approvals are ignored; a valid env
 *   deny pins the guard on. Without any Jev classifier the table runs
 *   rules-only.
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
	ToolRenderers,
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
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text, truncateToWidth, type AutocompleteItem, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BackgroundBash, type JobSnapshot } from "../src/background.js";
import {
	APPROVAL_MODE_ENV,
	DEFAULT_CONFIG,
	loadConfig,
	resolveApprovalMode,
	type ApprovalMode,
	type BashGuardConfig,
} from "../src/config.js";
import { formatGuardScore, runGuard, type GuardDeps, type GitInfo, type JevScore } from "../src/guard.js";
import { createJev, type Jev } from "../src/jev.js";
import { RISKY_RULES, compilePatterns, type RiskyScan } from "../src/rules.js";
import { publishRuntimeMarker, readPackageVersion } from "../src/runtime.js";
import { ALLOW_ENTRY_TYPE, restoreState, SETTINGS_ENTRY_TYPE, type GuardMode, type SessionSettings } from "../src/state.js";
import { renderStatus, type GuardTally, type StatusStyler, formatElapsed } from "../src/status.js";
import { activeCount, isActive, renderJobLine, renderWidgetLine, type JobStyler } from "../src/render.js";
import { Watchdog, type WatchCheckRecord } from "../src/watchdog.js";

const FLAG_NAME = "no-bash-guard";
const COMMAND_NAME = "bash-guard";
const STATUS_KEY = "bash-guard";

const VERSION = readPackageVersion(import.meta.url);

const ARGUMENT_COMPLETIONS = ["ask", "deny", "off", "watchdog on", "watchdog off"];

/** Bounded toolCallId → score-label map for the transcript score line. */
const GUARD_SCORE_MAP_LIMIT = 512;

/** Footer clock refresh while watched commands run. */
const STATUS_TICK_MS = 1000;

/** Above-editor row for background jobs; the widget factory recreates it after reload. */
const WIDGET_KEY = "bash-guard-background";

/** Cast a theme into background-job styles; a UI without a usable theme still renders. */
function jobStyler(theme: ExtensionUIContext["theme"]): JobStyler {
	return (text, kind) => {
		try {
			if (theme?.fg) return theme.fg(kind, text);
		} catch {
			// Fall through to plain text.
		}
		return text;
	};
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	// Capability marker for embedded consumers: not-ready until session_start
	// completes; replaced on reload; cleared on session_shutdown.
	const runtime = publishRuntimeMarker(globalThis as Record<symbol, unknown>, VERSION);

	pi.registerFlag(FLAG_NAME, {
		description: "Disable the bash-guard guard and watchdog for this run",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("bash-background-after", {
		description: "Automatically background bash after this many seconds (0 disables; default 60)",
		type: "string",
		default: "60",
	});
	pi.registerFlag("bash-bg-animation", {
		description: "Background job clock: clock (1 Hz) or off (static snapshot)",
		type: "string",
		default: "clock",
	});
	const background = new BackgroundBash(notifySettle);
	/**
	 * Deliver a completion to the agent. The model sees the job's state, its
	 * bounded output tail, and where full output lives; `details` carries the
	 * whole snapshot for the transcript renderer.
	 */
	function notifySettle(job: JobSnapshot): void {
		const tail = job.output.trim() === "" ? "(no output)" : job.output;
		const truncated = job.truncated ? "\n[output is a bounded tail; read full_output_path for the rest]" : "";
		const where = job.full_output_path ? `\nFull output: ${job.full_output_path}` : "";
		try {
			pi.sendMessage({
				customType: "bash-guard-background",
				content: `Background bash ${job.job_id}: ${job.state} after ${job.wall_time_seconds.toFixed(1)}s\n${job.command}\n${tail}${truncated}${where}`,
				details: job,
				display: true,
			}, { deliverAs: "steer", triggerTurn: true });
		} catch (error) {
			notifySafe(`Background result delivery failed: ${String(error)}. Use bash_jobs to inspect.`, "error");
		}
	}
	const jobSchema = Type.Object({
		job_id: Type.String(), command: Type.String(),
		state: StringEnum(["running", "cancelling", "completed", "failed", "cancelled"]),
		wall_time_seconds: Type.Number(), output: Type.String(), truncated: Type.Boolean(),
		exit_code: Type.Optional(Type.Number()), full_output_path: Type.Optional(Type.String()),
	});
	pi.registerTool({
		name: "bash_jobs", label: "Bash jobs",
		description: "List, inspect, or cancel background bash jobs. Completion arrives automatically; do not poll. Output is a bounded tail; read full_output_path when present for full output.",
		parameters: Type.Object({ action: StringEnum(["list", "status", "cancel"]), job_id: Type.Optional(Type.String()) }),
		outputSchema: Type.Object({ jobs: Type.Array(jobSchema) }),
		async execute(_id, { action, job_id }) {
			if (action !== "list" && !job_id) throw new Error("job_id is required for status and cancel");
			const jobs = action === "cancel" ? background.cancel(job_id!) : background.list(action === "status" ? job_id : undefined);
			return { content: [{ type: "text", text: JSON.stringify({ jobs }) }], details: undefined, structuredContent: { jobs } };
		},
	});

	// --- shared session state -------------------------------------------------
	let ui: ExtensionUIContext | undefined;
	let config: BashGuardConfig = structuredClone(DEFAULT_CONFIG);
	let configFiles: string[] = [];
	/** Guard keys a project config asked to loosen; shown so a weakened guard is never silent. */
	let ignoredProjectKeys: { path: string; keys: readonly string[] } | undefined;
	let sessionSettings: SessionSettings = {};
	let launchApprovalMode: string | undefined;
	let approvalMode: ApprovalMode = "ask";
	let approvalSource: "env" | "session" | "config" = "config";
	let envEnforced = false;
	let envError: string | undefined;
	let allowedCommands = new Set<string>();
	let currentRegistry: ModelRegistry | undefined;
	let jev: Jev = createJev({
		getRegistry: () => currentRegistry,
		modelSpec: DEFAULT_CONFIG.jev.model,
		endpoint: DEFAULT_CONFIG.jev.endpoint,
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
	/** One ticker drives the widget row and every running block's clock. */
	let jobTick: ReturnType<typeof setInterval> | undefined;
	let widgetMounted = false;
	let tui: TUI | undefined;
	const blockRefreshers = new Set<(() => void) & { jobId?: string }>();
	const syncJobUi = (): void => syncBackgroundUi();
	let runtimeReady = false;
	// Pi announces tool_execution_start before approval. Only our execute
	// wrapper marks a call as actually running; renderer state survives map cleanup.
	type ExecutionTiming = { started: boolean; durationMs?: number };
	const executions = new Map<string, ExecutionTiming>();
	const renderExecutions = new WeakMap<object, ExecutionTiming>();

	function executionState(toolCallId: string): ExecutionTiming {
		let state = executions.get(toolCallId);
		if (!state) {
			state = { started: false };
			executions.set(toolCallId, state);
		}
		return state;
	}

	function executionContext(context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]) {
		if (!bashRegistered || bashConflict || !context.executionStarted) return context;
		let state = renderExecutions.get(context.state);
		if (!state) {
			state = executionState(context.toolCallId);
			renderExecutions.set(context.state, state);
		}
		// Newer Pi renderers prefer durationMs for final results. Its lifecycle
		// duration includes approval, so replace it with our execution-only value.
		return { ...context, executionStarted: state.started, durationMs: state.durationMs };
	}

	const flagDisabled = (): boolean => pi.getFlag(FLAG_NAME) === true;
	// Enforced launch policy: a valid env deny pins the guard on, and an invalid
	// env value fails closed, so config, flags, and session toggles cannot turn
	// the guard off. The watchdog stays independently toggleable.
	const guardOn = (): boolean => envEnforced || (!flagDisabled() && config.guard.enabled && sessionSettings.guard !== "off");
	const watchdogOn = (): boolean => !flagDisabled() && config.watchdog.enabled && (sessionSettings.watchdog ?? true);
	const guardMode = (): GuardMode => (guardOn() ? approvalMode : "off");

	/** Launch policy wins over a session selection, which wins over config. */
	function resolvePolicy(): void {
		const sessionMode = sessionSettings.guard === "ask" || sessionSettings.guard === "deny" ? sessionSettings.guard : undefined;
		const resolved = resolveApprovalMode(sessionMode ?? config.guard.approvalMode, launchApprovalMode);
		approvalMode = resolved.mode;
		envEnforced = resolved.envEnforced;
		envError = resolved.error;
		approvalSource = resolved.envOverride || resolved.error ? "env" : sessionMode ? "session" : "config";
	}

	function restoreSession(ctx: ExtensionContext): void {
		const restored = restoreState(ctx.sessionManager.getBranch());
		sessionSettings = restored.settings ?? {};
		allowedCommands = new Set(restored.allowedCommands);
		resolvePolicy();
	}

	function syncWatchdog(ctx: ExtensionContext): void {
		ensureBashOverride(ctx.cwd);
		bashConflict = detectBashConflict();
		if (watchdogOn()) {
		} else {
			watchdog?.dispose();
			stopStatusTick();
		}
	}

	function notifySafe(message: string, type: "info" | "warning" | "error"): void {
		if (ui) ui.notify(message, type);
	}

	/** Keep the capability marker live: toggles change the effective guard state. */
	function syncRuntime(): void {
		runtime.set({
			ready: runtimeReady,
			approvalMode,
			guardEnabled: guardOn(),
			envEnforced,
			...(envError ? { error: envError } : {}),
		});
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
					guardMode: guardMode(),
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
		// The footer clock follows watched commands and live background jobs, so
		// one timer serves both. `--bash-bg-animation off` freezes job clocks but
		// leaves the watchdog clock accurate.
		const watched = (watchdog?.runningCount() ?? 0) > 0;
		const jobs = animationOn() && hasActiveJobs();
		if (watched || jobs) {
			if (!statusTick) statusTick = setInterval(() => refreshStatus(), STATUS_TICK_MS);
		} else if (statusTick) {
			clearInterval(statusTick);
			statusTick = undefined;
		}
	}

	function stopStatusTick(): void {
		if (statusTick) clearInterval(statusTick);
		statusTick = undefined;
	}

	// --- background job presentation -------------------------------------------

	/** `--bash-bg-animation off` renders a static snapshot and stops the 1 Hz tick. */
	const animationOn = (): boolean => pi.getFlag("bash-bg-animation") !== "off";

	const backgroundJobs = (): JobSnapshot[] => background.backgroundJobs();

	function hasActiveJobs(): boolean {
		return activeCount(backgroundJobs()) > 0;
	}

	/**
	 * One interval redraws the widget row and every running block. A block's own
	 * renderer cannot restart its clock: Pi clears that interval once the
	 * background acknowledgement counts as a final result.
	 */
	function syncJobTick(): void {
		const running = animationOn() && hasActiveJobs();
		if (running && !jobTick) {
			jobTick = setInterval(flushJobUi, STATUS_TICK_MS);
		} else if (!running && jobTick) {
			clearInterval(jobTick);
			jobTick = undefined;
		}
		syncStatusTick();
	}

	/**
	 * Redraw the widget and every running block. Called on each tick and once
	 * more when the last job settles, so a block shows its final state instead
	 * of freezing on the last `running` frame.
	 */
	function flushJobUi(): void {
		tui?.requestRender();
		for (const refresh of [...blockRefreshers]) refresh();
	}

	/** Mount above the editor while jobs run; disappear when the last one settles. */
	function syncBackgroundWidget(ctx?: ExtensionContext): void {
		const sink = ctx?.hasUI ? ctx.ui : ui;
		const wanted = sink !== undefined && activeCount(backgroundJobs()) > 0;
		if (!wanted) {
			if (widgetMounted && sink) sink.setWidget(WIDGET_KEY, undefined);
			widgetMounted = false;
			return;
		}
		if (!sink) return;
		if (!widgetMounted) {
			sink.setWidget(WIDGET_KEY, (nextTui, theme) => {
				tui = nextTui;
				const styler = jobStyler(theme);
				return {
					invalidate() {},
					render(width: number): string[] {
						const rows = renderWidgetLine(backgroundJobs(), styler, width);
						return rows.map((row) => truncateToWidth(row, width));
					},
				};
			}, { placement: "aboveEditor" });
			widgetMounted = true;
		}
		tui?.requestRender();
	}

	function syncBackgroundUi(ctx?: ExtensionContext): void {
		syncBackgroundWidget(ctx);
		syncJobTick();
		// Settling is the last state change a block sees; paint it before the
		// ticker stops, and let the watchdog clock follow live commands.
		flushJobUi();
		refreshStatus(ctx);
	}

	function teardownBackgroundUi(): void {
		if (jobTick) clearInterval(jobTick);
		jobTick = undefined;
		blockRefreshers.clear();
		if (widgetMounted && ui) ui.setWidget(WIDGET_KEY, undefined);
		widgetMounted = false;
		tui = undefined;
	}

	background.onChange(syncJobUi);

	function ensureBashOverride(cwd: string): void {
		if (bashRegistered || (flagDisabled() && !guardOn())) return;
		const inner = createLocalBashOperations();
		const operations: BashOperations = {
			exec: async (command, execCwd, options) => {
				if (!watchdogOn()) return inner.exec(command, execCwd, options);
				const controller = new AbortController();
				const activeWatchdog = watchdog!;
				const entry = activeWatchdog.start(command, execCwd, { abort: () => controller.abort() });
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
							activeWatchdog.recordOutput(entry, data.toString("utf8"));
						},
					});
				} catch (error) {
					if (activeWatchdog.isKilled(entry)) {
						throw new Error(activeWatchdog.killMessage(entry));
					}
					throw error;
				} finally {
					outer?.removeEventListener("abort", onOuterAbort);
					activeWatchdog.finish(entry);
					syncStatusTick();
					refreshStatus();
				}
			},
		};
		const bash = createBashToolDefinition(cwd, { operations });
		pi.registerTool({
			...bash,
			description: `${bash.description}\nSet background:true to return immediately and continue other work. Unspecified background yields after 60s by default; background:false forces foreground. Completion arrives automatically; do not poll. Background commands retain timeout and watchdog enforcement.`,
			parameters: Type.Object({
				...bash.parameters.properties,
				background: Type.Optional(Type.Boolean({ description: "true: background immediately; false: force foreground; omitted: automatic backgrounding" })),
			}),
			outputSchema: Type.Union([bash.outputSchema!, Type.Object({ status: Type.Literal("running"), job_id: Type.String() })]),
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const timing = executionState(toolCallId);
				timing.started = true;
				const startedAt = performance.now();
				try {
					const afterSec = Number(pi.getFlag("bash-background-after") ?? "60");
					if (!Number.isFinite(afterSec) || afterSec < 0 || afterSec > 2_147_483) {
						throw new Error("--bash-background-after must be between 0 and 2147483 seconds");
					}
					const { background: requested, ...nativeParams } = params;
					return await background.execute({
						command: params.command, background: requested, afterMs: afterSec * 1000, signal, onUpdate,
						run: (jobSignal, update) => createBashToolDefinition(ctx.cwd, { operations }).execute(toolCallId, nativeParams, jobSignal, update, ctx),
					});
				} finally {
					timing.durationMs = performance.now() - startedAt;
				}
			},
		});
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
			approvalMode,
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
	//
	// A background acknowledgement also lands here. Pi treats it as a final
	// result and stops the block's own elapsed clock (and hides the default
	// "Took" line), which would leave a running job looking finished. Such
	// blocks render from live job state instead and refresh on the shared tick.
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "bash") return next();
		const base = next();
		const baseRenderCall = base?.renderCall;
		if (!baseRenderCall) return base;
		return {
			...base,
			renderCall: (args, theme, context) => {
				const component = baseRenderCall(args, theme, { ...executionContext(context), lastComponent: undefined });
				const label = guardScores.get(context.toolCallId);
				if (label === undefined) return component;
				const container = new Container();
				container.addChild(component);
				container.addChild(new Text(theme.fg("muted", `⛨ bash-guard: ${label}`), 0, 0));
				return container;
			},
			renderResult: base.renderResult
				? (result, options, theme, context) => {
					const jobId = backgroundJobId(result, options);
					if (jobId === undefined) return base.renderResult!(result, options, theme, executionContext(context));
					return jobComponent(jobId, theme, context);
				}
				: undefined,
		};
	});

	/** The job id behind a background acknowledgement, or undefined for a normal result. */
	function backgroundJobId(result: { structuredContent?: unknown }, options: { isPartial: boolean }): string | undefined {
		if (options.isPartial) return undefined;
		const data = result.structuredContent as { status?: unknown; job_id?: unknown } | undefined;
		return data?.status === "running" && typeof data.job_id === "string" ? data.job_id : undefined;
	}

	/** A block that keeps its clock while the job runs and settles in place. */
	function jobComponent(jobId: string, theme: ExtensionUIContext["theme"], context: { state: Record<string, unknown>; invalidate: () => void }): Container {
		const styler = jobStyler(theme);
		const container = new Container();
		const line = new Text("", 0, 0);
		container.addChild(line);
		const refresh = ((): (() => void) & { jobId?: string } => {
			const registered = (): void => {
				paint();
				context.invalidate();
			};
			registered.jobId = jobId;
			return registered;
		})();
		/** Repaint from live state; detach once the row can no longer change. */
		function paint(): void {
			const job = backgroundJobs().find((entry) => entry.job_id === jobId);
			if (!job) {
				blockRefreshers.delete(refresh);
				line.setText(styler("job result evicted", "muted"));
				return;
			}
			line.setText(renderJobLine(job, styler));
			if (!isActiveJob(job)) blockRefreshers.delete(refresh);
		}
		// Pi may re-invoke this renderer for the same row; one refresher per job.
		for (const registered of [...blockRefreshers]) if (registered.jobId === jobId) blockRefreshers.delete(registered);
		paint();
		if (backgroundJobs().some((job) => job.job_id === jobId && isActiveJob(job))) blockRefreshers.add(refresh);
		return container;
	}

	const isActiveJob = (job: JobSnapshot): boolean => isActive(job.state);

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

	pi.on("tool_execution_end", (event) => {
		executions.delete(event.toolCallId);
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
		await background.dispose();
		ui = ctx.hasUI ? ctx.ui : undefined;
		currentRegistry = ctx.modelRegistry;
		const onError = (message: string): void => {
			if (ctx.hasUI) ctx.ui.notify(`bash-guard: ${message}`, "warning");
		};
		const loaded = loadConfig({
			agentDir: getAgentDir(),
			projectDir: ctx.cwd,
			onError,
			onIgnored: (keys, path) => {
				ignoredProjectKeys = { path, keys };
				onError(`${path} may only tighten the guard; ignored ${keys.join(", ")}`);
			},
		});
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

		launchApprovalMode = process.env[APPROVAL_MODE_ENV];
		restoreSession(ctx);
		if (envError) {
			// A hard configuration failure: surfaced as an error, and the guard
			// runs fail-closed in deny mode instead of falling back to prompts.
			if (ctx.hasUI) ctx.ui.notify(`bash-guard: ${envError}`, "error");
		}
		else if (approvalSource === "env" && (configFiles.length > 0 || sessionSettings.guard !== undefined)) {
			notifySafe(`bash-guard: ${APPROVAL_MODE_ENV}=${approvalMode} overrides the config/session approval mode`, "info");
		}
		jevOffNotified = false;
		guardScores = new Map();
		executions.clear();
		bashConflict = false;
		tally = { passed: 0, asked: 0, blocked: 0 };

		jev = createJev({
			getRegistry: () => currentRegistry,
			modelSpec: config.jev.model,
			endpoint: config.jev.endpoint,
			timeoutMs: config.jev.timeoutMs,
		});
		// Resolve the classifier eagerly so the status line and the one-time
		// notice reflect reality; later calls re-resolve lazily (e.g. after /login).
		if (!(await jev.ensureAvailable())) {
			notifySafe(`bash-guard: ${jev.describeUnavailable()}`, "warning");
		}

		stopStatusTick();
		teardownBackgroundUi();
		watchdog?.dispose();
		watchdog = new Watchdog({
			config,
			jev,
			now: () => Date.now(),
			steer,
			notify: (message, type) => notifySafe(message, type),
		});

		ensureBashOverride(ctx.cwd);
		bashConflict = detectBashConflict();
		if (watchdogOn()) {
			if (bashConflict) {
				notifySafe(
					"bash-guard: another extension already overrides the bash tool, so the watchdog cannot watch commands. The guard still runs.",
					"warning",
				);
			}
		}
		refreshStatus(ctx);
		// Initialization completed: consumers may now trust the marker. Jev being
		// unavailable does not block readiness - the rules-only guard is working.
		runtimeReady = true;
		syncRuntime();
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreSession(ctx);
		syncWatchdog(ctx);
		syncRuntime();
		refreshStatus(ctx);
	});

	pi.on("session_before_switch", () => background.dispose());
	pi.on("session_before_fork", () => background.dispose());
	pi.on("session_before_tree", () => background.dispose());

	pi.on("session_shutdown", async (_event, ctx) => {
		await background.dispose();
		stopStatusTick();
		watchdog?.dispose();
		executions.clear();
		currentRegistry = undefined;
		runtimeReady = false;
		runtime.clear();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// --- /bash-guard command ---------------------------------------------------

	/** The env launch policy cannot be bypassed by session toggles. */
	function notifyEnforced(): void {
		if (envEnforced) {
			notifySafe(
				envError
					? `bash-guard: the guard stays on in deny mode - ${envError}`
					: `bash-guard: the guard stays on in deny mode - enforced by ${APPROVAL_MODE_ENV}`,
				"warning",
			);
		}
	}

	function statusLines(): string {
		const approval = envError
			? `approval: deny (fail closed - ${envError})`
			: `approval: ${approvalMode} (${approvalSource}${envEnforced ? " enforced" : ""}${approvalSource === "env" ? ` via ${APPROVAL_MODE_ENV}` : ""})`;
		const lines = [
			approval,
			`guard: ${guardMode()} (config enabled ${config.guard.enabled}, session ${sessionSettings.guard ?? "default"}, flag ${flagDisabled() ? "off" : "on"})`,
			`watchdog: ${watchdogOn() ? "on" : "off"} (config enabled ${config.watchdog.enabled}, session ${sessionSettings.watchdog === undefined ? "default" : sessionSettings.watchdog ? "on" : "off"}, flag ${flagDisabled() ? "off" : "on"}) - tracking ${watchdog?.runningCount() ?? 0} command(s)` +
				(bashRegistered ? (bashConflict ? " - override lost to another extension" : " - bash override registered") : " - not overriding bash"),
			`jev: ${jev.available ? "on" : "off"} - ${jev.available ? jev.model : jev.describeUnavailable()} (timeout ${config.jev.timeoutMs}ms)` +
				(jev.lastFailure ? ` - last call failed: ${jev.lastFailure}` : ""),
			`guard decisions (session): ${tally.passed} passed by Jev, ${tally.asked} asked and allowed, ${tally.blocked} blocked`,
			`first check ${config.watchdog.firstCheckSec}s, interval ${config.watchdog.intervalSec}s, confidence ${config.watchdog.confidence}, agree checks ${config.watchdog.agreeChecks}`,
			`allowBelow ${config.guard.allowBelow}, session-allowed commands: ${allowedCommands.size}, allow patterns: ${config.guard.allowPatterns.length}, extra risky patterns: ${config.guard.extraRiskyPatterns.length}`,
			`config: ${configFiles.length > 0 ? configFiles.join(", ") : "defaults (no bash-guard.json found)"}`,
		];
		if (ignoredProjectKeys) {
			lines.push(`⚠ ${ignoredProjectKeys.path} ignored ${ignoredProjectKeys.keys.join(", ")} (project config may only tighten)`);
		}
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

	// --- operator controls -----------------------------------------------------

	/**
	 * Stop a job from the keyboard. The model has `bash_jobs`, but ending your own
	 * runaway command should not require spending a turn.
	 */
	async function cancelInteractively(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		const active = backgroundJobs().filter((job) => job.state === "running" || job.state === "cancelling");
		if (active.length === 0) {
			notifySafe("bash-guard: no background jobs are running", "info");
			return;
		}
		if (!ctx.hasUI) {
			notifySafe(`bash-guard: ${active.length} background job(s) running; use bash_jobs to cancel`, "warning");
			return;
		}
		const label = (job: JobSnapshot): string =>
			`${formatElapsed(job.wall_time_seconds).padStart(6)}  ${job.state.padEnd(10)}  ${job.command.replace(/\s+/g, " ").slice(0, 60)}`;
		let target: JobSnapshot | undefined;
		if (active.length === 1) {
			const [only] = active;
			target = await ctx.ui.confirm("Cancel background job?", label(only!)) ? only : undefined;
		} else {
			const chosen = await ctx.ui.select("Cancel which background job?", active.map(label));
			target = active.find((job) => label(job) === chosen);
		}
		if (!target) return;
		const [cancelled] = background.cancel(target.job_id);
		notifySafe(`bash-guard: cancelling ${cancelled!.job_id}`, "info");
	}

	pi.registerShortcut("ctrl+shift+k", {
		description: "Cancel a running background bash job",
		handler: (ctx) => cancelInteractively(ctx),
	});

	pi.registerCommand("bash-jobs", {
		description: "List background bash jobs and cancel one",
		handler: (args, ctx) => {
			void args;
			return cancelInteractively(ctx);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show bash-guard status, set ask/deny/off, or toggle the watchdog",
		getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] =>
			ARGUMENT_COMPLETIONS.filter((argument) => argument.startsWith(argumentPrefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [head, tail] = tokens;
			if (tokens.length === 0) {
				notifySafe(statusLines(), "info");
				refreshStatus(ctx);
				return;
			}

			if (tokens.length === 1 && (head === "ask" || head === "deny" || head === "off")) {
				sessionSettings = { ...sessionSettings, guard: head };
			} else if (tokens.length === 2 && head === "watchdog" && (tail === "on" || tail === "off")) {
				sessionSettings = { ...sessionSettings, watchdog: tail === "on" };
			} else {
				notifySafe("usage: /bash-guard [ask|deny|off|watchdog on|off]", "warning");
				return;
			}

			pi.appendEntry(SETTINGS_ENTRY_TYPE, { ...sessionSettings });
			resolvePolicy();
			syncRuntime();
			syncWatchdog(ctx);
			refreshStatus(ctx);

			if (head === "off") notifyEnforced();
			else if (head === "ask" || head === "deny") {
				if (!guardOn()) {
					notifySafe(`bash-guard: guard remains off - ${flagDisabled() ? "--no-bash-guard" : "guard.enabled=false in config"}`, "warning");
				} else if (approvalMode !== head) {
					if (envEnforced) notifyEnforced();
					else notifySafe(`bash-guard: approval remains ${approvalMode} - set by ${APPROVAL_MODE_ENV}`, "warning");
				}
			} else if (tail === "on" && !watchdogOn()) {
				notifySafe(`bash-guard: watchdog remains off - ${flagDisabled() ? "--no-bash-guard" : "watchdog.enabled=false in config"}`, "warning");
			}
			notifySafe(`Guard: ${guardMode()} · Watchdog: ${watchdogOn() ? "on" : "off"}`, "info");
		},
	});
}
