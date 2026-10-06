import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CONFIG,
	loadConfig,
	mergeConfig,
	projectConfigPath,
	userConfigPath,
	type BashGuardConfig,
} from "../src/config.js";

function file(entries: Record<string, string>): (path: string) => string | undefined {
	return (path) => entries[path];
}

describe("config defaults", () => {
	it("falls back to defaults when no files exist", () => {
		const onError = vi.fn();
		const { config, files } = loadConfig({ agentDir: "/agent", projectDir: "/proj", readFile: () => undefined, onError });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(files).toEqual([]);
		expect(onError).not.toHaveBeenCalled();
	});
});

describe("config merge and validation", () => {
	it("merges project over user per section", () => {
		const userPath = userConfigPath("/agent");
		const projectPath = projectConfigPath("/proj");
		const user: Partial<BashGuardConfig> = {
			guard: { ...DEFAULT_CONFIG.guard, allowBelow: 0.5 },
			jev: { timeoutMs: 5000, model: "typesafe/jev-beta" },
		};
		const project = { watchdog: { firstCheckSec: 60 } };
		const { config, files } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({
				[userPath]: JSON.stringify(user),
				[projectPath]: JSON.stringify(project),
			}),
		});
		expect(config.guard.allowBelow).toBe(0.5);
		expect(config.guard.enabled).toBe(true);
		expect(config.jev).toEqual({ timeoutMs: 5000, model: "typesafe/jev-beta" });
		expect(config.watchdog.firstCheckSec).toBe(60);
		expect(config.watchdog.intervalSec).toBe(DEFAULT_CONFIG.watchdog.intervalSec);
		expect(files).toEqual([userPath, projectPath]);
	});

	it("mergeConfig replaces scalars and arrays wholesale", () => {
		const merged = mergeConfig(DEFAULT_CONFIG, {
			guard: { extraRiskyPatterns: ["danger.*"], allowPatterns: ["safe"] },
		});
		expect(merged.guard.extraRiskyPatterns).toEqual(["danger.*"]);
		expect(merged.guard.allowPatterns).toEqual(["safe"]);
		expect(merged.guard.enabled).toBe(true);
	});

	it("reports invalid JSON and keeps defaults", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const { config, files } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: "{ not json" }),
			onError,
		});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(files).toEqual([]);
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("Invalid"));
	});

	it("rejects out-of-range values with defaults", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ guard: { allowBelow: 7 } }) }),
			onError,
		});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(onError).toHaveBeenCalled();
	});

	it("accepts partial valid files", () => {
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ watchdog: { agreeChecks: 3 } }) }),
		});
		expect(config.watchdog.agreeChecks).toBe(3);
		expect(config.watchdog.enabled).toBe(true);
	});

	it("skips an invalid project file while keeping a valid user config", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const projectPath = projectConfigPath("/proj");
		const { config, files } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({
				[userPath]: JSON.stringify({ jev: { model: "typesafe/jev-beta" } }),
				[projectPath]: JSON.stringify({ guard: { allowBelow: "nope" } }),
			}),
			onError,
		});
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("ignoring invalid keys"));
		expect(files).toEqual([userPath]);
		expect(config.jev.model).toBe("typesafe/jev-beta");
		expect(config.guard.allowBelow).toBe(DEFAULT_CONFIG.guard.allowBelow);
	});
});
