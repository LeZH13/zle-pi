import { describe, expect, it, vi } from "vitest";
import {
	APPROVAL_MODE_ENV,
	DEFAULT_CONFIG,
	loadConfig,
	mergeConfig,
	projectConfigPath,
	resolveApprovalMode,
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
		expect(config.guard.approvalMode).toBe("ask");
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

describe("approvalMode in config files", () => {
	it("reads approvalMode from a config file", () => {
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ guard: { approvalMode: "deny" } }) }),
		});
		expect(config.guard.approvalMode).toBe("deny");
		expect(config.guard.enabled).toBe(true);
	});

	it("accepts approvalMode ask", () => {
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ guard: { approvalMode: "ask" } }) }),
		});
		expect(config.guard.approvalMode).toBe("ask");
		expect(config.guard.enabled).toBe(true);
	});

	it("rejects the retired prompt value with defaults", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ guard: { approvalMode: "prompt" } }) }),
			onError,
		});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.guard.approvalMode).toBe("ask");
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("ignoring invalid keys"));
	});

	it("rejects an invalid approvalMode value with defaults", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const { config } = loadConfig({
			agentDir: "/agent",
			projectDir: "/proj",
			readFile: file({ [userPath]: JSON.stringify({ guard: { approvalMode: "enforce" } }) }),
			onError,
		});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(onError).toHaveBeenCalled();
	});
});

describe("resolveApprovalMode", () => {
	it("uses the config value when the environment is unset", () => {
		expect(resolveApprovalMode("ask", undefined)).toEqual({ mode: "ask", envOverride: false, envEnforced: false });
		expect(resolveApprovalMode("deny", undefined)).toEqual({ mode: "deny", envOverride: false, envEnforced: false });
		expect(resolveApprovalMode("ask", "")).toEqual({ mode: "ask", envOverride: false, envEnforced: false });
		expect(resolveApprovalMode("deny", "   ")).toEqual({ mode: "deny", envOverride: false, envEnforced: false });
	});

	it("lets a valid environment value override the config", () => {
		expect(resolveApprovalMode("deny", "ask")).toEqual({ mode: "ask", envOverride: true, envEnforced: false });
		expect(resolveApprovalMode("ask", "deny")).toEqual({ mode: "deny", envOverride: true, envEnforced: true });
		expect(resolveApprovalMode("ask", "  DENY  ")).toEqual({ mode: "deny", envOverride: true, envEnforced: true });
	});

	it("fails closed on an invalid environment value instead of falling back to ask", () => {
		const resolution = resolveApprovalMode("ask", "yes");
		expect(resolution.mode).toBe("deny");
		expect(resolution.envEnforced).toBe(true);
		expect(resolution.envOverride).toBe(false);
		expect(resolution.error).toContain(APPROVAL_MODE_ENV);
		expect(resolution.error).toContain("yes");
		expect(resolution.error).toContain("ask");
		expect(resolution.error).toContain("deny");
		// Case and whitespace preserved in the error message for diagnosis.
		expect(resolveApprovalMode("deny", "Deny!").error).toContain("Deny!");
	});

	it("fails closed when the launch env carries the retired prompt value", () => {
		const resolution = resolveApprovalMode("ask", "prompt");
		expect(resolution.mode).toBe("deny");
		expect(resolution.envOverride).toBe(false);
		expect(resolution.envEnforced).toBe(true);
		expect(resolution.error).toContain(APPROVAL_MODE_ENV);
		expect(resolution.error).toContain("prompt");
	});
});
