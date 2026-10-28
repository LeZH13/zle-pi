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
		expect(config.jev.timeoutMs).toBe(6000);
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

describe("Jev endpoint configuration", () => {
	const endpoint = { baseUrl: "https://api.relayrouter.ai/v1", apiKey: "$RELAYROUTER_JEV_API_KEY" };

	function load(jev: unknown) {
		const onError = vi.fn();
		return {
			...loadConfig({
				agentDir: "/agent", projectDir: "/proj",
				readFile: file({ [userConfigPath("/agent")]: JSON.stringify({ jev }) }), onError,
			}),
			onError,
		};
	}

	it.each(["literal-key", "$RELAYROUTER_JEV_API_KEY", "${RELAYROUTER_JEV_API_KEY}"])("accepts key %s without resolving credentials at config load", (apiKey) => {
		const { config, onError } = load({ endpoint: { ...endpoint, apiKey } });
		expect(config.jev.endpoint).toEqual({ ...endpoint, apiKey });
		expect(config.jev.model).toBeUndefined();
		expect(onError).not.toHaveBeenCalled();
	});

	it("accepts a local HTTP base URL and explicit ordered models", () => {
		const custom = { ...endpoint, baseUrl: "http://127.0.0.1:1234/v1/", models: ["jev-1.13.0", "jev-latest"] };
		const { config, onError } = load({ timeoutMs: 1200, endpoint: custom });
		expect(config.jev).toEqual({ timeoutMs: 1200, model: undefined, endpoint: custom });
		expect(onError).not.toHaveBeenCalled();
	});

	it.each([
		null,
		{},
		{ ...endpoint, baseUrl: undefined },
		{ ...endpoint, apiKey: undefined },
		{ ...endpoint, baseUrl: 12 },
		{ ...endpoint, baseUrl: "not a URL" },
		{ ...endpoint, baseUrl: "ftp://example.com/v1" },
		{ ...endpoint, baseUrl: "https://" },
		{ ...endpoint, baseUrl: " https://example.com/v1 " },
		{ ...endpoint, baseUrl: "https://user:private-password@example.com/v1" },
		{ ...endpoint, baseUrl: "https://private-user@example.com/v1" },
		{ ...endpoint, apiKey: 12 },
		{ ...endpoint, apiKey: "" },
		{ ...endpoint, apiKey: "   " },
		{ ...endpoint, apiKey: "!echo private-key" },
		{ ...endpoint, apiKey: "$NAME/suffix" },
		{ ...endpoint, apiKey: "prefix-${NAME}" },
		{ ...endpoint, apiKey: "${}" },
		{ ...endpoint, apiKey: "$1KEY" },
		{ ...endpoint, apiKey: "$NAME\n" },
		{ ...endpoint, models: [] },
		{ ...endpoint, models: "jev-latest" },
		{ ...endpoint, models: ["jev-latest", 12] },
		{ ...endpoint, models: [""] },
		{ ...endpoint, models: ["   "] },
		{ ...endpoint, models: ["jev-latest\n"] },
		{ ...endpoint, unexpected: "value" },
	])("rejects invalid endpoint %# without disclosing its contents", (invalid) => {
		const { config, files, onError } = load({ endpoint: invalid });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(files).toEqual([]);
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("ignoring invalid keys"));
		expect(JSON.stringify(onError.mock.calls)).not.toContain("private-");
	});

	it("rejects a pin and endpoint in one file", () => {
		const { config, onError } = load({ model: "typesafe/jev-latest", endpoint });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(onError).toHaveBeenCalled();
	});

	it("rejects a project model pin layered over a user endpoint", () => {
		const onError = vi.fn();
		const userPath = userConfigPath("/agent");
		const projectPath = projectConfigPath("/proj");
		const { config, files } = loadConfig({
			agentDir: "/agent", projectDir: "/proj", onError,
			readFile: file({
				[userPath]: JSON.stringify({ jev: { endpoint } }),
				[projectPath]: JSON.stringify({ jev: { model: "typesafe/jev-latest" } }),
			}),
		});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(files).toEqual([userPath, projectPath]);
		expect(onError).toHaveBeenCalledWith("Invalid merged bash-guard config, using defaults");
	});

	it("ignores a project endpoint instead of letting a repo choose where commands are sent", () => {
		const onIgnored = vi.fn();
		const projectPath = projectConfigPath("/proj");
		const projectEndpoint = { baseUrl: "https://attacker.example/v1", apiKey: "attacker-key" };
		const { config } = loadConfig({
			agentDir: "/agent", projectDir: "/proj", onIgnored,
			readFile: file({ [projectPath]: JSON.stringify({ jev: { endpoint: projectEndpoint } }) }),
		});
		expect(config.jev.endpoint).toBeUndefined();
		expect(onIgnored).toHaveBeenCalledWith(["jev.endpoint"], projectPath);
	});

	it("ignores a project endpoint even when the user pinned a registry model", () => {
		const projectPath = projectConfigPath("/proj");
		const { config } = loadConfig({
			agentDir: "/agent", projectDir: "/proj",
			readFile: file({
				[userConfigPath("/agent")]: JSON.stringify({ jev: { model: "typesafe/jev-latest" } }),
				[projectPath]: JSON.stringify({ jev: { endpoint } }),
			}),
		});
		expect(config).toEqual({ ...DEFAULT_CONFIG, jev: { timeoutMs: 6000, endpoint: undefined, model: "typesafe/jev-latest" } });
	});

	it("keeps the user endpoint when a project file also declares one", () => {
		const userEndpoint = { ...endpoint, models: ["user-model"] };
		const { config } = loadConfig({
			agentDir: "/agent", projectDir: "/proj",
			readFile: file({
				[userConfigPath("/agent")]: JSON.stringify({ jev: { timeoutMs: 4500, endpoint: userEndpoint } }),
				[projectConfigPath("/proj")]: JSON.stringify({ jev: { endpoint: { baseUrl: "https://other.example/v1", apiKey: "other-key" } } }),
			}),
		});
		expect(config.jev.endpoint).toEqual(userEndpoint);
		expect(config.jev.timeoutMs).toBe(4500);
	});

	it.each([199, 250.5, 2_147_483_648, 4_294_967_296])("rejects timeout %s outside the Node timer's integer range", (timeoutMs) => {
		expect(load({ timeoutMs }).config).toEqual(DEFAULT_CONFIG);
	});

	it("does not expose API keys through JSON parser error snippets", () => {
		const onError = vi.fn();
		loadConfig({
			agentDir: "/agent", projectDir: "/proj", onError,
			readFile: file({ [userConfigPath("/agent")]: '{"jev":{"endpoint":{"apiKey":"private-key" BREAK}}}' }),
		});
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"));
		expect(JSON.stringify(onError.mock.calls)).not.toContain("private-key");
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


describe("project config may only tighten", () => {
	function project(guard: Record<string, unknown>, base?: Record<string, unknown>) {
		const onIgnored = vi.fn();
		const result = loadConfig({
			agentDir: "/agent", projectDir: "/proj", onIgnored,
			readFile: file({
				...(base ? { [userConfigPath("/agent")]: JSON.stringify(base) } : {}),
				[projectConfigPath("/proj")]: JSON.stringify({ guard }),
			}),
		});
		return { ...result, onIgnored };
	}

	it("ignores a project that disables the guard", () => {
		const { config, onIgnored } = project({ enabled: false });
		expect(config.guard.enabled).toBe(true);
		expect(onIgnored).toHaveBeenCalledWith(["guard.enabled"], projectConfigPath("/proj"));
	});

	it("ignores project allow patterns, which would whitelist commands unconditionally", () => {
		const { config, onIgnored } = project({ allowPatterns: ["npm run build"] });
		expect(config.guard.allowPatterns).toEqual([]);
		expect(onIgnored).toHaveBeenCalledWith(["guard.allowPatterns"], projectConfigPath("/proj"));
	});

	it("ignores a project that raises allowBelow above the inherited value", () => {
		const { config, onIgnored } = project({ allowBelow: 0.9 }, { guard: { allowBelow: 0.3 } });
		expect(config.guard.allowBelow).toBe(0.3);
		expect(onIgnored).toHaveBeenCalledWith(["guard.allowBelow"], projectConfigPath("/proj"));
	});

	it("keeps a project that tightens allowBelow", () => {
		const { config, onIgnored } = project({ allowBelow: 0.2 }, { guard: { allowBelow: 0.4 } });
		expect(config.guard.allowBelow).toBe(0.2);
		expect(onIgnored).not.toHaveBeenCalled();
	});

	it("ignores a project that relaxes deny back to ask, but allows ask -> deny", () => {
		expect(project({ approvalMode: "ask" }, { guard: { approvalMode: "deny" } }).config.guard.approvalMode).toBe("deny");
		const tightened = project({ approvalMode: "deny" }, { guard: { approvalMode: "ask" } });
		expect(tightened.config.guard.approvalMode).toBe("deny");
		expect(tightened.onIgnored).not.toHaveBeenCalled();
	});

	it("keeps a project that tightens with extra risky patterns and explicit enable", () => {
		const { config, onIgnored } = project({ enabled: true, extraRiskyPatterns: ["^helm uninstall"], allowBelow: 0.1 });
		expect(config.guard.enabled).toBe(true);
		expect(config.guard.extraRiskyPatterns).toEqual(["^helm uninstall"]);
		expect(config.guard.allowBelow).toBe(0.1);
		expect(onIgnored).not.toHaveBeenCalled();
	});

	it("drops only the loosening keys and keeps the rest of the project section", () => {
		const { config, onIgnored } = project({ enabled: false, allowPatterns: ["rm"], extraRiskyPatterns: ["^helm"] });
		expect(config.guard.enabled).toBe(true);
		expect(config.guard.allowPatterns).toEqual([]);
		expect(config.guard.extraRiskyPatterns).toEqual(["^helm"]);
		expect(onIgnored).toHaveBeenCalledWith(["guard.enabled", "guard.allowPatterns"], projectConfigPath("/proj"));
	});

	it("leaves untrusted tuning that cannot loosen the guard untouched", () => {
		const onIgnored = vi.fn();
		const { config } = loadConfig({
			agentDir: "/agent", projectDir: "/proj", onIgnored,
			readFile: file({ [projectConfigPath("/proj")]: JSON.stringify({ watchdog: { intervalSec: 60 }, jev: { timeoutMs: 2000 } }) }),
		});
		expect(config.watchdog.intervalSec).toBe(60);
		expect(config.jev.timeoutMs).toBe(2000);
		expect(onIgnored).not.toHaveBeenCalled();
	});

	it("leaves the trusted user config free to disable and whitelist", () => {
		const onIgnored = vi.fn();
		const { config } = loadConfig({
			agentDir: "/agent", projectDir: "/proj", onIgnored,
			readFile: file({
				[userConfigPath("/agent")]: JSON.stringify({ guard: { enabled: false, allowPatterns: ["^rm"], allowBelow: 0.9 } }),
			}),
		});
		expect(config.guard.enabled).toBe(false);
		expect(config.guard.allowPatterns).toEqual(["^rm"]);
		expect(config.guard.allowBelow).toBe(0.9);
		expect(onIgnored).not.toHaveBeenCalled();
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
