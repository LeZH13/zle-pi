/*
 * Adapted from L2ncE/pi-recap (Copyright 2026 L2ncE), Apache-2.0.
 * Modified by zle13: idle recaps, session naming, per-instance state,
 * trusted settings, mode exclusions, and cancellable stale-write guards.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildSnapshot, cleanRecap, cleanTitle, NAMING_KEY, pickModel, readConfig, STATE_KEY, extractText, TITLE_RETRY_PROMPT, validateTitle } from "../lib/summary.js";

const WIDGET_KEY = "zle-recap";
type Kind = "recap" | "name";
type State = { recap?: string; inputKey?: string };
type NamingState = { sessionId: string; eligible: boolean };
type Outcome = { kind: "updated" | "cancelled" } | { kind: "skipped" | "failed"; reason: string };

export default function recapExtension(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_ID?.trim() || process.env.PI_SUBAGENT_SESSION?.trim()) return;

	let state: State = {};
	let namingEligible = false;
	let sessionId: string | undefined;
	let epoch = 0;
	let activityRevision = 0;
	let nameRevision = 0;
	let completed = false;
	let settledKey: string | undefined;
	let controller: AbortController | undefined;
	let generating: Kind | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let namingJob: Promise<Outcome> | undefined;
	let loader: Loader | undefined;
	let widgetPlacement: "aboveEditor" | "belowEditor" | undefined;
	const reportedErrors = new Set<string>();
	let snapshotManager: ExtensionContext["sessionManager"] | undefined;
	let snapshotLeaf: string | null | undefined;
	let cachedSnapshots: Partial<Record<"recap" | "name", ReturnType<typeof buildSnapshot>>> = {};

	function snapshotFor(ctx: ExtensionContext, purpose: "recap" | "name") {
		const manager = ctx.sessionManager;
		const leaf = manager.getLeafId();
		// Session history is append-only; edits and compaction create new leaves.
		// Rendering and raw keystrokes must not re-project the entire conversation,
		// and both purposes share one per-leaf cache so purpose switches never
		// re-project either.
		if (snapshotManager !== manager || snapshotLeaf !== leaf) {
			cachedSnapshots = {};
			snapshotManager = manager;
			snapshotLeaf = leaf;
		}
		if (!(purpose in cachedSnapshots)) cachedSnapshots[purpose] = buildSnapshot(ctx, purpose);
		return cachedSnapshots[purpose];
	}

	function supported(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" && ctx.hasUI;
	}

	function clearTimer() {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
	}

	function stopLoader() {
		loader?.stop();
		loader = undefined;
	}

	function cancel() {
		completed = false;
		settledKey = undefined;
		epoch++;
		activityRevision++;
		clearTimer();
		controller?.abort();
		controller = undefined;
		generating = undefined;
		namingJob = undefined;
		stopLoader();
	}

	function restore(ctx: ExtensionContext) {
		state = {};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
			const data = entry.data as Partial<State> | undefined;
			if (!data || typeof data !== "object") continue;
			state = {
				recap: typeof data.recap === "string" ? data.recap : undefined,
				inputKey: typeof data.inputKey === "string" ? data.inputKey : undefined,
			};
		}
	}

	function persistNaming() {
		pi.appendEntry<NamingState>(NAMING_KEY, { sessionId: sessionId!, eligible: namingEligible });
	}

	function render(ctx: ExtensionContext) {
		if (!supported(ctx)) return;
		stopLoader();
		const placement = readConfig(pi.getSettings()).placement;
		if (widgetPlacement && widgetPlacement !== placement) ctx.ui.setWidget(WIDGET_KEY, undefined);
		const fresh = ctx.isIdle() && state.recap && state.inputKey === snapshotFor(ctx, "recap")?.inputKey;
		if (generating !== "recap" && !fresh) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetPlacement = undefined;
			return;
		}
		widgetPlacement = placement;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			if (generating === "recap") {
				stopLoader();
				const badge = new Loader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), "Generating recap…");
				loader = badge;
				return {
					invalidate: () => badge.invalidate(),
					render: (width: number) => width <= 0 ? [] : badge.render(width).filter(Boolean).map(line => truncateToWidth(line, width)),
				};
			}
			return {
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0 || !ctx.isIdle() || !state.recap || state.inputKey !== snapshotFor(ctx, "recap")?.inputKey) return [];
					const text = theme.fg("accent", theme.bold("※ recap:")) + " " + theme.fg("muted", theme.italic(state.recap));
					return wrapTextWithAnsi(text, width).map(line => truncateToWidth(line, width));
				},
			};
		}, { placement });
	}

	function hide(ctx: ExtensionContext) {
		stopLoader();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetPlacement = undefined;
	}

	function report(ctx: ExtensionContext, kind: Kind, reason: string, force: boolean) {
		reason = stripTerminalSequences(reason).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500);
		const key = `${kind}:${reason}`;
		if (!force && reportedErrors.has(key)) return;
		reportedErrors.add(key);
		ctx.ui.notify(`${kind === "name" ? "Session naming" : "Recap"} failed: ${reason}`, "warning");
	}

	async function generate(kind: Kind, ctx: ExtensionContext, force: boolean): Promise<Outcome> {
		if (!supported(ctx)) return { kind: "skipped", reason: "TUI mode required" };
		if (!ctx.isIdle() || controller) return { kind: "skipped", reason: "Agent or summary generation is busy; retry once idle" };
		const config = readConfig(pi.getSettings());
		// Eligibility is decided before any snapshot work so an already named or
		// ineligible session never pays for a naming projection.
		if (kind === "name" && !force && (!config.autoName || !namingEligible || pi.getSessionName()?.trim())) {
			return { kind: "skipped", reason: "Automatic naming not eligible" };
		}
		const snapshot = snapshotFor(ctx, kind);
		if (!snapshot) return { kind: "skipped", reason: "No conversation yet" };
		if (kind === "recap" && !force) {
			if (snapshot.userCount < config.minTurns) return { kind: "skipped", reason: "Not enough user prompts" };
			if (snapshot.inputKey === state.inputKey) return { kind: "skipped", reason: "Conversation unchanged" };
			if (snapshot.inputKey !== settledKey) return { kind: "skipped", reason: "Conversation has not successfully settled" };
		}
		if (kind === "recap") clearTimer();
		const token = epoch;
		const capturedActivity = activityRevision;
		const capturedSession = ctx.sessionManager.getSessionId();
		const capturedNameRevision = nameRevision;
		const capturedName = pi.getSessionName();
		const request = new AbortController();
		controller = request;
		generating = kind;
		const stillCurrent = () => !request.signal.aborted && epoch === token && sessionId === capturedSession
			&& ctx.isIdle() && (kind === "name" || activityRevision === capturedActivity)
			&& snapshotFor(ctx, kind)?.inputKey === snapshot.inputKey;
		try {
			const model = pickModel(ctx, config.model);
			if (kind === "recap") render(ctx);
			const systemPrompt = kind === "name" ? config.namePrompt : config.recapPrompt;
			const userMessage = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
			const requestSummary = (messages: ReturnType<typeof userMessage>[]) => ctx.modelRegistry.streamSimple(model, {
				systemPrompt,
				messages,
			}, { maxTokens: 512, cacheRetention: "none", signal: request.signal }).result();
			let response = await requestSummary([userMessage(snapshot.prompt)]);
			if (!stillCurrent()) return { kind: "cancelled" };
			if (response.stopReason !== "stop") throw new Error(`Model response did not finish (${response.stopReason})`);
			let output: string;
			if (kind === "name") {
				let title = validateTitle(cleanTitle(extractText(response.content)));
				if (!title.ok) {
					// One corrective request with the same model, system prompt, and
					// original subject snapshot, the instruction sent as its own
					// user message. Never a third call; provider errors are ordinary
					// failures and cancel/staleness still discard results.
					response = await requestSummary([userMessage(snapshot.prompt), userMessage(TITLE_RETRY_PROMPT)]);
					if (!stillCurrent()) return { kind: "cancelled" };
					if (response.stopReason !== "stop") throw new Error(`Model response did not finish (${response.stopReason})`);
					title = validateTitle(cleanTitle(extractText(response.content)));
					if (!title.ok) throw new Error(`Session naming still exceeded the title limits after one correction (${title.reason})`);
				}
				output = title.title;
			} else {
				output = cleanRecap(extractText(response.content), config.maxWords);
			}
			if (kind === "name") {
				if (nameRevision !== capturedNameRevision || pi.getSessionName() !== capturedName) return { kind: "cancelled" };
				if (!force && pi.getSessionName()?.trim()) return { kind: "cancelled" };
				namingEligible = false;
				persistNaming();
				pi.setSessionName(output);
			} else {
				state = { recap: output, inputKey: snapshot.inputKey };
				pi.appendEntry(STATE_KEY, { ...state });
			}
			return { kind: "updated" };
		} catch (error) {
			if (!stillCurrent()) return { kind: "cancelled" };
			if (kind === "recap" && !force) settledKey = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			report(ctx, kind, reason, force);
			return { kind: "failed", reason };
		} finally {
			if (controller === request) {
				controller = undefined;
				generating = undefined;
				if (kind === "recap") render(ctx);
			}
		}
	}

	function schedule(ctx: ExtensionContext) {
		clearTimer();
		const snapshot = snapshotFor(ctx, "recap");
		const config = readConfig(pi.getSettings());
		if (!ctx.isIdle() || !settledKey || snapshot?.inputKey !== settledKey || snapshot.userCount < config.minTurns || state.inputKey === settledKey) return;
		const token = epoch;
		const revision = activityRevision;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			void (async () => {
				// Naming can outlive the idle countdown; it must finish first.
				await namingJob;
				if (epoch !== token || activityRevision !== revision || !ctx.isIdle()) return;
				await generate("recap", ctx, false);
			})().catch(error => {
				if (epoch === token && activityRevision === revision) report(ctx, "recap", error instanceof Error ? error.message : String(error), false);
			});
		}, config.idleDelaySeconds * 1000);
	}

	pi.on("session_start", (event, ctx) => {
		cancel();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		nameRevision = 0;
		reportedErrors.clear();
		sessionId = undefined;
		namingEligible = false;
		state = {};
		widgetPlacement = undefined;
		if (!supported(ctx)) return;
		sessionId = ctx.sessionManager.getSessionId();
		restore(ctx);
		const entries = ctx.sessionManager.getEntries();
		if (event.reason === "reload") {
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== NAMING_KEY) continue;
				const data = entry.data as NamingState | undefined;
				if (data?.sessionId === sessionId) namingEligible = data.eligible === true;
			}
		} else if ((event.reason === "startup" || event.reason === "new") && !ctx.sessionManager.getHeader()?.parentSession
			&& !entries.some(entry => entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary")) {
			namingEligible = true;
		}
		if (pi.getSessionName()?.trim()) namingEligible = false;
		persistNaming();
		unsubscribeInput = ctx.ui.onTerminalInput(data => {
			// Terminal capability replies/focus reports are not user activity.
			if (!data || /^\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[IO]|\[\??[\d;]*[cnR])$/.test(data)) return;
			activityRevision++;
			clearTimer();
			if (generating === "recap") {
				controller?.abort();
				controller = undefined;
				generating = undefined;
				render(ctx);
			}
			schedule(ctx);
			return undefined;
		});
		render(ctx);
	});

	pi.on("input", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
		hide(ctx);
	});
	pi.on("user_bash", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
		hide(ctx);
		return undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
		hide(ctx);
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (!supported(ctx)) return;
		const lastAssistant = ctx.sessionManager.buildSessionProjection().messages.findLast(message => message.role === "assistant");
		completed = event.outcome === "completed" && lastAssistant?.role === "assistant" && lastAssistant.stopReason === "stop";
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!supported(ctx) || !completed) return;
		completed = false;
		const token = epoch;
		try {
			settledKey = snapshotFor(ctx, "recap")?.inputKey;
			namingJob = generate("name", ctx, false);
			void namingJob.catch(error => {
				if (epoch === token) report(ctx, "name", error instanceof Error ? error.message : String(error), false);
			});
			render(ctx);
			schedule(ctx);
		} catch (error) {
			report(ctx, "recap", error instanceof Error ? error.message : String(error), false);
		}
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (!supported(ctx)) return;
		nameRevision++;
		if (event.name?.trim() && namingEligible) {
			namingEligible = false;
			persistNaming();
		}
	});
	pi.on("session_before_tree", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
		hide(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
		restore(ctx);
		render(ctx);
	});

	for (const [command, kind] of [["recap", "recap"], ["autoname", "name"]] as const) {
		pi.registerCommand(command, {
			description: kind === "name" ? "Generate and apply a new session name" : "Generate a session recap now",
			handler: async (args, ctx) => {
				if (!supported(ctx)) return;
				if (args.trim()) {
					ctx.ui.notify(`Usage: /${command} (no arguments)`, "warning");
					return;
				}
				if (!ctx.isIdle() || controller) {
					ctx.ui.notify("Agent or summary generation is busy; retry once idle", "warning");
					return;
				}
				if (kind === "name") ctx.ui.notify("Generating session name…", "info");
				const outcome = await generate(kind, ctx, true);
				if (outcome.kind === "updated") ctx.ui.notify(kind === "name" ? `Session named: ${pi.getSessionName()}` : "Recap updated", "info");
				else if (outcome.kind === "skipped") ctx.ui.notify(outcome.reason, "warning");
			},
		});
	}
	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		sessionId = undefined;
		namingEligible = false;
		if (supported(ctx) && widgetPlacement) hide(ctx);
		widgetPlacement = undefined;
	});
}
