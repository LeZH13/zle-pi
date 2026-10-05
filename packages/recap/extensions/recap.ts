/*
 * Adapted from L2ncE/pi-recap (Copyright 2026 L2ncE), Apache-2.0.
 * Modified by zle13: session naming, settled-run scheduling, per-instance state,
 * trusted settings, mode/subagent exclusions, and cancellable stale-write guards.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildSnapshot, cleanOutput, NAMING_KEY, pickModel, readConfig, similarity, STATE_KEY, extractText } from "../lib/summary.js";

const WIDGET_KEY = "zle-recap";
type Kind = "recap" | "name";
type State = { recap?: string; inputKey?: string; completedRuns: number; lastAutoUpdateAt?: number };
type NamingState = { sessionId: string; eligible: boolean };
type Outcome = { kind: "updated" | "unchanged" | "cancelled" } | { kind: "skipped" | "failed"; reason: string };

export default function recapExtension(pi: ExtensionAPI) {
	// Interactive children are TUI processes too. Their harness owns their names.
	if (process.env.PI_SUBAGENT_ID?.trim() || process.env.PI_SUBAGENT_SESSION?.trim()) return;

	let state: State = emptyState();
	let namingEligible = false;
	let sessionId: string | undefined;
	let epoch = 0;
	let nameRevision = 0;
	let completed = false;
	let controller: AbortController | undefined;
	let widgetPlacement: "aboveEditor" | "belowEditor" | undefined;
	const reportedErrors = new Set<string>();

	function emptyState(): State {
		return { completedRuns: 0 };
	}

	function supported(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" && ctx.hasUI;
	}

	function cancel() {
		completed = false;
		epoch++;
		controller?.abort();
		controller = undefined;
	}

	function restore(ctx: ExtensionContext) {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
			const data = entry.data as Partial<State> | undefined;
			if (!data || typeof data !== "object") continue;
			state = {
				recap: typeof data.recap === "string" ? data.recap : undefined,
				inputKey: typeof data.inputKey === "string" ? data.inputKey : undefined,
				completedRuns: Number.isSafeInteger(data.completedRuns) && data.completedRuns! >= 0 ? data.completedRuns! : 0,
				lastAutoUpdateAt: Number.isSafeInteger(data.lastAutoUpdateAt) && data.lastAutoUpdateAt! >= 0 ? data.lastAutoUpdateAt : undefined,
			};
		}
	}

	function persist() {
		pi.appendEntry(STATE_KEY, { ...state });
	}

	function persistNaming() {
		pi.appendEntry<NamingState>(NAMING_KEY, { sessionId: sessionId!, eligible: namingEligible });
	}

	function render(ctx: ExtensionContext) {
		if (!supported(ctx)) return;
		const placement = readConfig(pi.getSettings()).placement;
		if (widgetPlacement && widgetPlacement !== placement) ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (!state.recap) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetPlacement = undefined;
			return;
		}
		widgetPlacement = placement;
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0 || !state.recap) return [];
				const text = theme.fg("accent", theme.bold("※ recap:")) + " " + theme.fg("muted", theme.italic(state.recap));
				return wrapTextWithAnsi(text, width).map(line => truncateToWidth(line, width));
			},
		}), { placement });
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
		if (controller) return { kind: "skipped", reason: "A recap or title is already being generated; retry once idle" };
		const config = readConfig(pi.getSettings());
		const snapshot = buildSnapshot(ctx);
		if (!snapshot) return { kind: "skipped", reason: "No conversation yet" };
		if (kind === "name" && !force && (!config.autoName || !namingEligible || pi.getSessionName()?.trim())) {
			return { kind: "skipped", reason: "Automatic naming not eligible" };
		}
		if (kind === "recap" && !force) {
			if (snapshot.userCount < config.minTurns) return { kind: "skipped", reason: "Not enough user prompts" };
			if (snapshot.inputKey === state.inputKey) return { kind: "skipped", reason: "Conversation unchanged" };
			if (state.lastAutoUpdateAt !== undefined && state.completedRuns - state.lastAutoUpdateAt < config.cooldownTurns) return { kind: "skipped", reason: "Cooldown" };
			state.lastAutoUpdateAt = state.completedRuns;
			persist();
		}

		const token = epoch;
		const capturedSession = ctx.sessionManager.getSessionId();
		const capturedNameRevision = nameRevision;
		const capturedName = pi.getSessionName();
		const request = new AbortController();
		controller = request;
		const stillCurrent = () => !request.signal.aborted && epoch === token && sessionId === capturedSession
			&& buildSnapshot(ctx)?.inputKey === snapshot.inputKey;
		try {
			const model = pickModel(ctx, config.model);
			const response = await ctx.modelRegistry.streamSimple(model, {
				systemPrompt: kind === "name" ? config.namePrompt : config.recapPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: snapshot.prompt }], timestamp: Date.now() }],
			}, { maxTokens: 512, cacheRetention: "none", signal: request.signal }).result();
			if (!stillCurrent()) return { kind: "cancelled" };
			if (response.stopReason !== "stop") throw new Error(`Model response did not finish (${response.stopReason})`);
			const output = cleanOutput(extractText(response.content), kind, config.maxWords);
			if (kind === "name") {
				// Explicit /autoname permits replacing the captured name, not a
				// newer name supplied while this request was in flight.
				if (nameRevision !== capturedNameRevision || pi.getSessionName() !== capturedName) return { kind: "cancelled" };
				if (!force && pi.getSessionName()?.trim()) return { kind: "cancelled" };
				namingEligible = false;
				persistNaming();
				pi.setSessionName(output);
			} else {
				const unchanged = !force && state.recap && similarity(state.recap, output) >= config.similarityThreshold;
				state.inputKey = snapshot.inputKey;
				if (!unchanged) state.recap = output;
				persist();
				render(ctx);
				if (unchanged) return { kind: "unchanged" };
			}
			return { kind: "updated" };
		} catch (error) {
			if (!stillCurrent()) return { kind: "cancelled" };
			const reason = error instanceof Error ? error.message : String(error);
			report(ctx, kind, reason, force);
			return { kind: "failed", reason };
		} finally {
			if (controller === request) controller = undefined;
		}
	}

	pi.on("session_start", (event, ctx) => {
		cancel();
		nameRevision = 0;
		reportedErrors.clear();
		sessionId = undefined;
		namingEligible = false;
		state = emptyState();
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
		// Record ineligible starts as well: a later /reload must not revive a
		// pending naming marker from before this session was resumed or forked.
		persistNaming();
		render(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!supported(ctx)) return;
		cancel();
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!supported(ctx)) return;
		const lastAssistant = ctx.sessionManager.buildSessionProjection().messages.findLast(message => message.role === "assistant");
		completed = event.outcome === "completed" && lastAssistant?.role === "assistant" && lastAssistant.stopReason === "stop";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!supported(ctx) || !completed) return;
		completed = false;
		state.completedRuns++;
		persist();
		const token = epoch;
		// Do not hold up the main agent's settlement on a side-call. Both
		// requests are serialized and cancelled when a new run/session begins.
		void (async () => {
			await generate("name", ctx, false);
			if (epoch === token) await generate("recap", ctx, false);
		})().catch(error => {
			if (epoch === token) report(ctx, "recap", error instanceof Error ? error.message : String(error), false);
		});
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
		if (supported(ctx)) cancel();
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
				ctx.ui.notify(kind === "name" ? "Generating session name…" : "Generating recap…", "info");
				const outcome = await generate(kind, ctx, true);
				if (outcome.kind === "updated") ctx.ui.notify(kind === "name" ? `Session named: ${pi.getSessionName()}` : "Recap updated", "info");
				else if (outcome.kind === "skipped") ctx.ui.notify(outcome.reason, "warning");
			},
		});
	}

	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		sessionId = undefined;
		namingEligible = false;
		if (supported(ctx) && widgetPlacement) ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetPlacement = undefined;
	});
}
