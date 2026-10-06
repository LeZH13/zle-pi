/**
 * Configuration loading and validation.
 *
 * `~/.pi/agent/bash-guard.json` provides user defaults; `<cwd>/.pi/bash-guard.json`
 * overrides per project (deep merge per section). The merged object is validated
 * with TypeBox; anything invalid falls back to defaults so a typo can never break
 * the guard open or shut silently.
 *
 * Classifier credentials come from pi's own auth (/login or the provider's API
 * key env); there is no credential key in this config.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GuardConfig {
	enabled: boolean;
	/** Jev probability below which a risky command is allowed. */
	allowBelow: number;
	/** Extra user risky patterns (regex strings, matched against the full command). */
	extraRiskyPatterns: string[];
	/** User allow patterns (regex strings, matched against the full command; they win). */
	allowPatterns: string[];
}

export interface WatchdogConfig {
	enabled: boolean;
	firstCheckSec: number;
	intervalSec: number;
	/** Minimum probability of a chosen stuck/looping status to count as an agreeing check. */
	confidence: number;
	/** Consecutive agreeing checks required before a kill. */
	agreeChecks: number;
}

export interface JevConfig {
	timeoutMs: number;
	/** "provider/modelId" (e.g. "openrouter/~typesafe/jev-latest"); unset = auto-detect. */
	model?: string;
}

export interface BashGuardConfig {
	guard: GuardConfig;
	watchdog: WatchdogConfig;
	jev: JevConfig;
}

export const DEFAULT_CONFIG: BashGuardConfig = {
	guard: {
		enabled: true,
		allowBelow: 0.5,
		extraRiskyPatterns: [],
		allowPatterns: [],
	},
	watchdog: {
		enabled: true,
		firstCheckSec: 120,
		intervalSec: 300,
		confidence: 0.8,
		agreeChecks: 2,
	},
	jev: {
		timeoutMs: 3000,
		model: undefined,
	},
};

const FileSchema = Type.Object({
	guard: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			allowBelow: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			extraRiskyPatterns: Type.Optional(Type.Array(Type.String())),
			allowPatterns: Type.Optional(Type.Array(Type.String())),
		}),
	),
	watchdog: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			firstCheckSec: Type.Optional(Type.Number({ minimum: 5 })),
			intervalSec: Type.Optional(Type.Number({ minimum: 5 })),
			confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			agreeChecks: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
	),
	jev: Type.Optional(
		Type.Object({
			timeoutMs: Type.Optional(Type.Number({ minimum: 200 })),
			model: Type.Optional(Type.String({ pattern: "^[^/]+/.+" })),
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
	} catch (error) {
		onError?.(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** Deep-merge section objects; scalars and arrays are replaced, not merged. */
export function mergeConfig(base: BashGuardConfig, override: PartialConfig): BashGuardConfig {
	const merged: BashGuardConfig = {
		guard: { ...base.guard, ...(isPlainObject(override.guard) ? override.guard : {}) },
		watchdog: { ...base.watchdog, ...(isPlainObject(override.watchdog) ? override.watchdog : {}) },
		jev: { ...base.jev, ...(isPlainObject(override.jev) ? override.jev : {}) },
	} as unknown as BashGuardConfig;
	return merged;
}

export interface LoadConfigOptions {
	/** The agent config directory (defaults to `getAgentDir()`). */
	agentDir?: string;
	/** The project directory for the project-level config. */
	projectDir: string;
	readFile?: (path: string) => string | undefined;
	/** Called when a file is invalid JSON or the merged config fails validation. */
	onError?: (message: string) => void;
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

	const userPath = userConfigPath(agentDir);
	const userFile = readJsonFile(userPath, options.readFile, options.onError);
	if (userFile) {
		if (Value.Check(FileSchema, userFile)) {
			files.push(userPath);
			merged = mergeConfig(merged, userFile);
		} else {
			options.onError?.(`Invalid ${userPath}: ignoring invalid keys`);
		}
	}
	const projectPath = projectConfigPath(options.projectDir);
	const projectFile = readJsonFile(projectPath, options.readFile, options.onError);
	if (projectFile) {
		if (Value.Check(FileSchema, projectFile)) {
			files.push(projectPath);
			merged = mergeConfig(merged, projectFile);
		} else {
			options.onError?.(`Invalid ${projectPath}: ignoring invalid keys`);
		}
	}

	// Two individually valid files can still merge to something invalid (e.g. a
	// number in one and a string in the other for the same key): fail to defaults.
	if (!Value.Check(FileSchema, merged)) {
		options.onError?.("Invalid merged bash-guard config, using defaults");
		return { config: structuredClone(DEFAULT_CONFIG), files };
	}
	return { config: merged, files };
}
