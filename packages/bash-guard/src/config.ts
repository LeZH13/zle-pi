/**
 * Configuration loading and validation.
 *
 * `~/.pi/agent/bash-guard.json` provides user defaults; `<cwd>/.pi/bash-guard.json`
 * overrides per project (deep merge per section). The merged object is validated
 * with TypeBox; anything invalid falls back to defaults so a typo can never break
 * the guard open or shut silently.
 *
 * Registry classifiers use pi's own auth. An optional System One endpoint uses
 * an explicit literal API key or a whole-value environment reference.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalMode = "ask" | "deny";

export interface GuardConfig {
	enabled: boolean;
	/** Escalation behavior for risky commands: "ask" confirms with the user, "deny" blocks immediately. */
	approvalMode: ApprovalMode;
	/** Jev probability below which a risky command is allowed. */
	allowBelow: number;
	/** Extra user risky patterns (regex strings, matched against the full command). */
	extraRiskyPatterns: string[];
	/** User allow patterns (regex strings, matched against the full command; they win). */
	allowPatterns: string[];
}

export const WATCHDOG_STOP_MODES = ["ask", "notify-only", "auto-stop"] as const;
export type WatchdogStopMode = typeof WATCHDOG_STOP_MODES[number];

export function isWatchdogStopMode(value: unknown): value is WatchdogStopMode {
	return WATCHDOG_STOP_MODES.some((mode) => mode === value);
}

export interface WatchdogConfig {
	enabled: boolean;
	stopMode: WatchdogStopMode;
	firstCheckSec: number;
	intervalSec: number;
	/** Minimum probability of a chosen stuck/looping status to count as an agreeing check. */
	confidence: number;
	/** Consecutive agreeing checks required before recommending a stop. */
	agreeChecks: number;
}

export interface JevEndpointConfig {
	/** HTTP(S) System One base URL, without URL credentials. */
	baseUrl: string;
	/** Literal API key, "$NAME", or "${NAME}"; shell commands are not supported. */
	apiKey: string;
	/** Ordered wire model IDs; omitted = jev-latest, then jev-1.13.0. */
	models?: string[];
}

export interface JevConfig {
	/** Timeout budget for each classifier attempt. */
	timeoutMs: number;
	/** "provider/modelId" (e.g. "openrouter/~typesafe/jev-latest"); unset = auto-detect and fail over. */
	model?: string;
	/** Tried before registry candidates in auto mode; mutually exclusive with model. */
	endpoint?: JevEndpointConfig;
}

export interface BashGuardConfig {
	guard: GuardConfig;
	watchdog: WatchdogConfig;
	jev: JevConfig;
}

export const DEFAULT_CONFIG: BashGuardConfig = {
	guard: {
		enabled: true,
		approvalMode: "ask",
		allowBelow: 0.25,
		extraRiskyPatterns: [],
		allowPatterns: [],
	},
	watchdog: {
		enabled: true,
		stopMode: "ask",
		firstCheckSec: 120,
		intervalSec: 300,
		confidence: 0.8,
		agreeChecks: 2,
	},
	jev: {
		timeoutMs: 6000,
		model: undefined,
	},
};

const FileSchema = Type.Object({
	guard: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			approvalMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("deny")])),
			allowBelow: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			extraRiskyPatterns: Type.Optional(Type.Array(Type.String())),
			allowPatterns: Type.Optional(Type.Array(Type.String())),
		}),
	),
	watchdog: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			stopMode: Type.Optional(Type.Union(WATCHDOG_STOP_MODES.map((mode) => Type.Literal(mode)))),
			firstCheckSec: Type.Optional(Type.Number({ minimum: 5 })),
			intervalSec: Type.Optional(Type.Number({ minimum: 5 })),
			confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			agreeChecks: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
	),
	jev: Type.Optional(
		Type.Object({
			timeoutMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 2_147_483_647 })),
			model: Type.Optional(Type.String({ pattern: "^[^/]+/.+" })),
			endpoint: Type.Optional(
				Type.Object({
					baseUrl: Type.String({ minLength: 1 }),
					apiKey: Type.String({ pattern: "^(?:\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{[A-Za-z_][A-Za-z0-9_]*\\})|[^$!\\s][^$\\s]*)$" }),
					models: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "^\\S+$" }), { minItems: 1 })),
				}, { additionalProperties: false }),
			),
		}),
	),
});

type PartialConfig = Partial<Record<"guard" | "watchdog" | "jev", Record<string, unknown>>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(
	path: string,
	readFile: ((path: string) => string | undefined) | undefined,
	onError?: (message: string) => void,
): PartialConfig | undefined {
	let raw: string | undefined;
	try {
		raw = readFile ? readFile(path) : readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) throw new Error("not a JSON object");
		return parsed as PartialConfig;
	} catch {
		// JSON parser errors can quote the input, including a literal endpoint key.
		onError?.(`Invalid JSON in ${path}: expected a JSON object`);
		return undefined;
	}
}

function validConfig(value: unknown): boolean {
	if (!Value.Check(FileSchema, value)) return false;
	const jev = (value as Partial<BashGuardConfig>).jev;
	if (jev?.model !== undefined && jev.endpoint !== undefined) return false;
	if (jev?.endpoint !== undefined) {
		if (/\s/.test(jev.endpoint.apiKey) || jev.endpoint.models?.some((id) => /\s/.test(id))) return false;
		try {
			const baseUrl = jev.endpoint.baseUrl;
			const url = new URL(baseUrl);
			if (!/^https?:\/\//i.test(baseUrl) || baseUrl !== baseUrl.trim() || url.username || url.password) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Guard keys a project config may tune more strictly, but never more loosely. */
const PROJECT_GUARD_KEYS = ["enabled", "approvalMode", "allowBelow", "allowPatterns"] as const;

/**
 * Drop guard keys a project config used to loosen the guard in its own
 * directory. `<cwd>/.pi/bash-guard.json` arrives with the working tree, so it is
 * exactly what the guard is meant to protect against: a repo must be able to
 * tighten scrutiny for itself, never to switch the guard off or whitelist
 * commands. Tightening is `extraRiskyPatterns`, a lower `allowBelow`, a stricter
 * `approvalMode`, or `enabled: true`. Projects also may not opt into automatic watchdog stops.
 */
export function restrictProjectConfig(
	file: PartialConfig,
	base: BashGuardConfig,
): { override: PartialConfig; ignored: string[] } {
	const override: PartialConfig = { ...file };
	const ignored: string[] = [];
	if (base.watchdog.stopMode !== "auto-stop" && isPlainObject(file.watchdog) && file.watchdog.stopMode === "auto-stop") {
		const { stopMode: _, ...watchdog } = file.watchdog;
		override.watchdog = watchdog;
		ignored.push("watchdog.stopMode");
	}
	const guard: Record<string, unknown> = isPlainObject(file.guard) ? { ...file.guard } : {};
	for (const key of PROJECT_GUARD_KEYS) {
		if (!(key in guard)) continue;
		const value = guard[key];
		const looser =
			key === "enabled" ? value === false
			: key === "approvalMode" ? base.guard.approvalMode === "deny" && value === "ask"
			: key === "allowBelow" ? typeof value === "number" && value > base.guard.allowBelow
			: true; // allowPatterns only ever widen what runs unjudged.
		if (looser) {
			ignored.push(`guard.${key}`);
			delete guard[key];
		}
	}
	if (ignored.length === 0) return { override: file, ignored };
	if (Object.keys(guard).length > 0) override.guard = guard;
	else delete override.guard;
	return { override, ignored };
}

/** Merge section objects; nested endpoint objects, scalars, and arrays are replaced. */
export function mergeConfig(base: BashGuardConfig, override: PartialConfig): BashGuardConfig {
	const merged: BashGuardConfig = {
		guard: { ...base.guard, ...(isPlainObject(override.guard) ? override.guard : {}) },
		watchdog: { ...base.watchdog, ...(isPlainObject(override.watchdog) ? override.watchdog : {}) },
		jev: { ...base.jev, ...(isPlainObject(override.jev) ? override.jev : {}) },
	} as unknown as BashGuardConfig;
	return merged;
}

/** Launch override for the escalation mode; a valid value beats the config file. */
export const APPROVAL_MODE_ENV = "PI_BASH_GUARD_APPROVAL_MODE";

export interface ApprovalModeResolution {
	/** Effective escalation mode. */
	mode: ApprovalMode;
	/** True when a valid environment value decided the mode. */
	envOverride: boolean;
	/**
	 * True when the guard must stay enabled no matter what config, flags, or
	 * session toggles say: a valid env "deny" is enforced launch policy, and an
	 * invalid env value fails closed rather than falling back to ask.
	 */
	envEnforced: boolean;
	/** Non-empty when the environment value is invalid; the mode then fails closed to deny. */
	error?: string;
}

/**
 * Resolve the effective escalation mode from the config value and the launch
 * environment override. The environment wins when valid; an invalid value is a
 * hard error that fails closed (deny, guard pinned on) instead of asking.
 */
export function resolveApprovalMode(configured: ApprovalMode, envValue: string | undefined): ApprovalModeResolution {
	const raw = envValue?.trim() ?? "";
	if (raw === "") {
		return { mode: configured, envOverride: false, envEnforced: false };
	}
	const value = raw.toLowerCase();
	if (value === "ask") {
		return { mode: "ask", envOverride: true, envEnforced: false };
	}
	if (value === "deny") {
		return { mode: "deny", envOverride: true, envEnforced: true };
	}
	return {
		mode: "deny",
		envOverride: false,
		envEnforced: true,
		error: `Invalid ${APPROVAL_MODE_ENV} "${raw}" - expected "ask" or "deny"; failing closed in deny mode (risky commands are blocked, the guard stays enabled)`,
	};
}

export interface LoadConfigOptions {
	/** The agent config directory (defaults to `getAgentDir()`). */
	agentDir?: string;
	/** The project directory for the project-level config. */
	projectDir: string;
	readFile?: (path: string) => string | undefined;
	/** Called when a file is invalid JSON or the merged config fails validation. */
	onError?: (message: string) => void;
	/** Called with the guard keys a project config asked to loosen and that were ignored. */
	onIgnored?: (keys: readonly string[], path: string) => void;
}

/** Global config path, exported for the README and status output. */
export function userConfigPath(agentDir: string): string {
	return join(agentDir, "bash-guard.json");
}

export function projectConfigPath(projectDir: string): string {
	return join(projectDir, ".pi", "bash-guard.json");
}

/**
 * Load and merge configuration. Missing files are fine; invalid JSON in one file
 * is reported and skipped; an invalid merged config falls back to defaults.
 */
export function loadConfig(options: LoadConfigOptions): { config: BashGuardConfig; files: string[] } {
	const agentDir = options.agentDir ?? "";
	const files: string[] = [];
	let merged = structuredClone(DEFAULT_CONFIG);
	/** The user-level endpoint, the only endpoint a project config may keep. */
	let userEndpoint: BashGuardConfig["jev"]["endpoint"];

	const userPath = userConfigPath(agentDir);
	const userFile = readJsonFile(userPath, options.readFile, options.onError);
	if (userFile) {
		if (validConfig(userFile)) {
			files.push(userPath);
			merged = mergeConfig(merged, userFile);
			userEndpoint = merged.jev.endpoint;
		} else {
			options.onError?.(`Invalid ${userPath}: ignoring invalid keys`);
		}
	}
	const projectPath = projectConfigPath(options.projectDir);
	const projectFile = readJsonFile(projectPath, options.readFile, options.onError);
	if (projectFile) {
		if (validConfig(projectFile)) {
			const { override, ignored } = restrictProjectConfig(projectFile, merged);
			if (ignored.length > 0) options.onIgnored?.(ignored, projectPath);
			files.push(projectPath);
			merged = mergeConfig(merged, override);
		} else {
			options.onError?.(`Invalid ${projectPath}: ignoring invalid keys`);
		}
	}

	// A project config may not repoint Jev at an endpoint of its own choosing:
	// committing it would send this machine's commands and cwd to that host.
	if (merged.jev.endpoint !== undefined && merged.jev.endpoint !== userEndpoint) {
		options.onIgnored?.(["jev.endpoint"], projectPath);
		merged.jev = { ...merged.jev, endpoint: userEndpoint };
	}

	// Individually valid files can combine a model pin and an endpoint. Reject
	// that ambiguity too, without printing either endpoint credentials or URL.
	if (!validConfig(merged)) {
		options.onError?.("Invalid merged bash-guard config, using defaults");
		return { config: structuredClone(DEFAULT_CONFIG), files };
	}
	return { config: merged, files };
}
