/**
 * Process-global readiness marker for integrations that embed pi-bash-guard
 * alongside their own extensions.
 *
 * Pi continues after extension-load errors, so source presence proves nothing.
 * The marker publishes the effective guard state only after `session_start`
 * finished initializing config, restored state, watchdog, and the bash
 * override. Consumers read it from `globalThis` with the exported symbol and
 * never cache the object: a runtime reload publishes a fresh one.
 *
 * This is a capability handshake only. All risk policy (mode resolution,
 * enforcement, escalation) stays inside the guard; consumers check readiness
 * and read the published values, they never re-derive them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalMode } from "./config.js";

/** Key under which the marker is published on `globalThis`. */
export const BASH_GUARD_RUNTIME_SYMBOL = Symbol.for("@zle13/pi-bash-guard/runtime");

/** What consumers see. Getters keep the view live across session starts. */
export interface BashGuardRuntime {
	/** True only after a `session_start` completed initialization. */
	readonly ready: boolean;
	/** Package version; `""` when it could not be read. */
	readonly version: string;
	/** Effective escalation mode after config and environment resolution. */
	readonly approvalMode: ApprovalMode;
	/** Effective guard enablement; true under enforced environment deny. */
	readonly guardEnabled: boolean;
	/** True when the launch environment pins the guard on (valid deny, or invalid value failing closed). */
	readonly envEnforced: boolean;
	/** Non-empty when the launch environment value was invalid (fail-closed deny). */
	readonly error?: string;
}

/** Not-ready marker published at factory entry, before any fallible work. */
const INITIAL: Pick<BashGuardRuntime, "ready" | "approvalMode" | "guardEnabled" | "envEnforced"> = {
	ready: false,
	approvalMode: "ask",
	guardEnabled: false,
	envEnforced: false,
};

interface RuntimeState {
	ready: boolean;
	approvalMode: ApprovalMode;
	guardEnabled: boolean;
	envEnforced: boolean;
	error?: string;
}

export interface RuntimeMarker {
	/** Publish new state (typically ready=true after session_start). */
	set(state: RuntimeState): void;
	/** Remove the marker from `globalThis`, but only while it is still ours. */
	clear(): void;
	readonly marker: BashGuardRuntime;
}

/** Read this package's version from its package.json; `""` on any failure. */
export function readPackageVersion(moduleUrl: string): string {
	try {
		const packageJson = join(dirname(dirname(fileURLToPath(moduleUrl))), "package.json");
		const parsed: unknown = JSON.parse(readFileSync(packageJson, "utf-8"));
		const version = (parsed as { version?: unknown }).version;
		return typeof version === "string" ? version : "";
	} catch {
		return "";
	}
}

/**
 * Publish a fresh not-ready marker under the shared symbol, replacing any
 * previous one (factory entry, including extension runtime reloads).
 */
export function publishRuntimeMarker(globalObject: Record<symbol, unknown>, version: string): RuntimeMarker {
	let state: RuntimeState = { ...INITIAL };
	const marker: BashGuardRuntime = {
		get ready() {
			return state.ready;
		},
		get version() {
			return version;
		},
		get approvalMode() {
			return state.approvalMode;
		},
		get guardEnabled() {
			return state.guardEnabled;
		},
		get envEnforced() {
			return state.envEnforced;
		},
		get error() {
			return state.error;
		},
	};
	globalObject[BASH_GUARD_RUNTIME_SYMBOL] = marker;
	return {
		marker,
		set(next: RuntimeState) {
			state = next;
		},
		clear() {
			// Identity check: a reload may have published a newer marker before
			// the old runtime's session_shutdown ran; never clear that one.
			if (globalObject[BASH_GUARD_RUNTIME_SYMBOL] === marker) {
				delete globalObject[BASH_GUARD_RUNTIME_SYMBOL];
			}
		},
	};
}
