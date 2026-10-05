/*
 * Todo tracking for Pi — the `todo` tool, the `/todos` command, and a
 * persistent collapsible overlay above the editor.
 *
 * Task state lives in execution-time snapshot entries on the session branch,
 * so it survives /reload, compaction, forking, and indirect calls. Tracking
 * enablement is per session and starts OFF for every new session; a toggle
 * records a branch entry, so it is remembered across resume/reload and
 * inherited by forks. Every lifecycle event (start, compact, tree — before
 * any UI gating) reconciles the active tool set with the session's
 * enablement, touching only the todo tool. The collapsed/expanded view is a
 * global preference.
 *
 * Adapted from @juicesharp/rpiv-todo (Copyright 2026 juicesharp), MIT.
 * Modified by zle13: /todos control surface, session-scoped enablement,
 * snapshot replay, execution guard, less eager guidance; i18n, locales, and
 * global enablement removed.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TodoOverlay } from "./overlay.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import {
	clearActiveRenderSession,
	evictSession,
	evictSessionEnabled,
	getActiveRenderSession,
	getSessionEnabled,
	replaceState,
	replayFromBranch,
	setActiveRenderSession,
	setSessionEnabled,
	sid,
	enabledFromBranch,
} from "./store.js";
import { ENABLED_ENTRY_TYPE, TOOL_NAME } from "./tasks.js";
import { registerTodoTool, registerTodosCommand, type TodosControl } from "./tool.js";

// pi-core's ExtensionRunner throws this phrase from an invalidated ctx proxy
// after session replacement/reload; such events carry no usable state.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export interface TodoExtensionOptions {
	/** Override the preferences directory (tests). Defaults to the global config dir. */
	prefsDir?: string;
}

export default function todoExtension(pi: ExtensionAPI, options: TodoExtensionOptions = {}): void {
	const prefs = loadPrefs(options.prefsDir);
	let collapsed = prefs.collapsed;
	let uiCtx: ExtensionUIContext | undefined;
	let overlay: TodoOverlay | undefined;
	let foregroundEnabled = false;

	// Add/remove only the todo tool: reconciliation must not clobber unrelated
	// active tools the user or other extensions manage.
	function applyToolActivation(on: boolean): void {
		const active = pi.getActiveTools();
		if (on && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		else if (!on && active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}

	/** Sync the overlay's enablement with the foreground session's state. */
	function syncForeground(enabled: boolean): void {
		foregroundEnabled = enabled;
		if (overlay) overlay.setEnabled(enabled);
		else if (enabled) refreshOverlay();
	}

	function refreshOverlay(): void {
		if (!uiCtx) return;
		overlay ??= new TodoOverlay(collapsed, foregroundEnabled);
		overlay.setUICtx(uiCtx);
		overlay.update();
	}

	const control: TodosControl = {
		isEnabled: getSessionEnabled,
		toggleEnabled(sessionId) {
			const on = !getSessionEnabled(sessionId);
			setSessionEnabled(sessionId, on);
			// Branch entry: remembers the toggle across resume/reload and forks,
			// and keeps the session's own history authoritative.
			pi.appendEntry(ENABLED_ENTRY_TYPE, { enabled: on });
			applyToolActivation(on);
			if (sessionId === getActiveRenderSession()) syncForeground(on);
			return on;
		},
		isCollapsed: () => collapsed,
		setCollapsed(value) {
			if (value === collapsed) return;
			collapsed = value;
			try {
				savePrefs({ collapsed }, options.prefsDir);
			} catch (e) {
				// The in-process change still applies; only future starts lose it.
				console.warn(`[pi-todo] could not save preferences: ${e instanceof Error ? e.message : String(e)}`);
			}
			overlay?.setCollapsed(value);
		},
	};

	registerTodoTool(pi, control);
	registerTodosCommand(pi, control);

	/**
	 * Reconcile a session after its branch changed (start/compact/tree): replay
	 * task state and enablement, then align the active tool set — before any UI
	 * gating, so headless sessions reconcile too. Only the foreground refreshes
	 * the shared overlay; a child (distinct sid) never does.
	 */
	const reconcileSession = async (ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0]): Promise<void> => {
		let id: string | undefined;
		try {
			id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			setSessionEnabled(id, enabledFromBranch(ctx));
			applyToolActivation(getSessionEnabled(id));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (id !== undefined && id === getActiveRenderSession()) {
			syncForeground(getSessionEnabled(id));
			refreshOverlay();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		// Reconcile before the UI guard: headless sessions reconcile too.
		setSessionEnabled(id, enabledFromBranch(ctx));
		applyToolActivation(getSessionEnabled(id));
		if (!ctx.hasUI) return;
		// First UI-bearing session_start claims the foreground (spawn ordering).
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		// Only the foreground binds the shared overlay; children are skipped.
		if (id !== getActiveRenderSession()) return;
		syncForeground(getSessionEnabled(id));
		uiCtx = ctx.ui;
		refreshOverlay();
	});

	pi.on("session_compact", async (_event, ctx) => {
		await reconcileSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reconcileSession(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Disposal can race a stale ctx; an unknown sid resolves to "" and is
		// treated as foreground so teardown still runs.
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		evictSession(s);
		evictSessionEnabled(s);
		// Overlay teardown is sid-gated: a child shutdown must not dispose the
		// foreground's overlay.
		if (s === "" || s === getActiveRenderSession()) {
			uiCtx = undefined;
			try {
				overlay?.dispose();
			} finally {
				overlay = undefined;
				clearActiveRenderSession();
			}
		}
	});

	// Read live state at render time; never replay from here (the branch is
	// stale until message_end).
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		refreshOverlay();
	});
}
