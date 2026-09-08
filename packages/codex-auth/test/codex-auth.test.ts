import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codexAuthExtension from "../extensions/codex-auth/index.js";
import { findAccount, getCodexAuthConfigPath, loadConfig, maskEmail, maskId, saveConfig } from "../extensions/codex-auth/registry.js";
import { extractJwtExpiry, syncCodexToPi, syncPiToCodex } from "../extensions/codex-auth/sync.js";
import type { CodexAuthFile, CodexRegistry, PiAuthStore } from "../extensions/codex-auth/types.js";
import {
	buildWidgetLine,
	calculateRemainingPercent,
	formatProgressBar,
	formatResetTime,
	getActiveAccount,
	refreshUI,
} from "../extensions/codex-auth/ui.js";
import { visibleWidth } from "@earendil-works/pi-tui";

describe("codex-auth extension", () => {
	let registeredCommands: Map<string, any>;
	let registeredListeners: Map<string, any>;
	let mockPi: ExtensionAPI;

	beforeEach(() => {
		registeredCommands = new Map();
		registeredListeners = new Map();

		mockPi = {
			registerCommand: vi.fn((name, options) => {
				registeredCommands.set(name, options);
			}),
			on: vi.fn((event, handler) => {
				registeredListeners.set(event, handler);
			}),
		} as unknown as ExtensionAPI;

		codexAuthExtension(mockPi);
	});

	it("registers the /codex-auth command with lifecycle listeners", () => {
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"codex-auth",
			expect.objectContaining({
				description: expect.stringContaining("/codex-auth"),
				getArgumentCompletions: expect.any(Function),
			}),
		);
		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("after_provider_response", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	describe("masking & formatting helpers", () => {
		it("masks emails safely", () => {
			expect(maskEmail("alice.dev@example.com")).toBe("alic***@example.com");
			expect(maskEmail("ab@example.org")).toBe("ab***@example.org");
			expect(maskEmail("")).toBe("unknown");
		});

		it("masks account IDs safely", () => {
			expect(maskId("e2774859-949b-4f76-8c93-298e1260ea4e")).toBe("e2774859...");
			expect(maskId("short")).toBe("short");
			expect(maskId(undefined)).toBe("unknown");
		});

		it("formats progress bars properly", () => {
			expect(formatProgressBar(0, 5)).toBe("[░░░░░] 0%");
			expect(formatProgressBar(50, 6)).toBe("[███░░░] 50%");
			expect(formatProgressBar(100, 5)).toBe("[█████] 100%");
		});

		it("calculates remaining percentage consistently with codex-auth (100% when unused, 0% when depleted)", () => {
			expect(calculateRemainingPercent(0)).toBe(100);
			expect(calculateRemainingPercent(100)).toBe(0);
			expect(calculateRemainingPercent(16)).toBe(84);
			expect(calculateRemainingPercent(5)).toBe(95);
			expect(calculateRemainingPercent(undefined)).toBe(100);
			expect(calculateRemainingPercent(null)).toBe(100);
			expect(calculateRemainingPercent(-10)).toBe(100);
			expect(calculateRemainingPercent(150)).toBe(0);
		});

		it("formats reset time countdowns", () => {
			const now = Math.floor(Date.now() / 1000);
			expect(formatResetTime(now + 90)).toBe("in 1m");
			expect(formatResetTime(now + 3600 + 1200)).toBe("in 1h 20m");
			expect(formatResetTime(now - 10)).toBe("now");
			expect(formatResetTime(undefined)).toBe("");
		});
	});

	describe("JWT expiration extraction", () => {
		function createMockJwt(expSeconds: number): string {
			const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(
				JSON.stringify({
					exp: expSeconds,
					"https://api.openai.com/auth": { chatgpt_account_id: "test-id" },
				}),
			).toString("base64url");
			return `${header}.${payload}.signature`;
		}

		it("extracts real expiry timestamp from JWT in milliseconds", () => {
			const expSeconds = 1789025834;
			const jwt = createMockJwt(expSeconds);
			const expiry = extractJwtExpiry(jwt);
			expect(expiry).toBe(expSeconds * 1000);
		});

		it("returns null for malformed or non-JWT tokens", () => {
			expect(extractJwtExpiry("invalid-token")).toBeNull();
			expect(extractJwtExpiry("a.b")).toBeNull();
			expect(extractJwtExpiry("")).toBeNull();
		});
	});

	describe("account lookup", () => {
		const mockRegistry: CodexRegistry = {
			schema_version: 4,
			active_account_key: "acc-1",
			accounts: [
				{
					account_key: "acc-1",
					alias: "work",
					email: "work@example.com",
					chatgpt_account_id: "id-work-123",
					plan: "plus",
				},
				{
					account_key: "acc-2",
					alias: "personal",
					email: "personal@example.com",
					chatgpt_account_id: "id-personal-456",
					plan: "pro",
				},
			],
		};

		it("finds accounts by alias, email, and ID", () => {
			expect(findAccount(mockRegistry, "work")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "personal")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "work@example.com")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "id-personal-456")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "nonexistent")).toBeNull();
		});

		it("gets active account from registry", () => {
			const active = getActiveAccount(mockRegistry);
			expect(active?.account_key).toBe("acc-1");
		});
	});

	describe("responsive widget line rendering", () => {
		const mockTheme = {
			fg: (_color: string, text: string) => text,
		};

		const mockAccount = {
			account_key: "acc-1",
			alias: "work",
			email: "lezh123456789@gmail.com",
			chatgpt_account_id: "id-work-123",
			plan: "plus",
			last_usage: {
				primary: { used_percent: 5, resets_at: Math.floor(Date.now() / 1000), window_minutes: 300 },
				secondary: { used_percent: 1, resets_at: Math.floor(Date.now() / 1000) + 6 * 86400, window_minutes: 10080 },
			},
		};

		it("formats full widget line when sufficient width is available", () => {
			const line = buildWidgetLine(mockTheme, mockAccount, 100);
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			expect(line).toContain("codex: work (plus)");
			expect(line).toContain("5h [");
			expect(line).toContain("wk [");
		});

		it("shows 100% when unused (used_percent=0) and 0% when depleted (used_percent=100)", () => {
			const account = {
				...mockAccount,
				last_usage: {
					primary: { used_percent: 0, resets_at: Math.floor(Date.now() / 1000), window_minutes: 300 },
					secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 6 * 86400, window_minutes: 10080 },
				},
			};
			const line = buildWidgetLine(mockTheme, account, 100);
			expect(line).toContain("5h [█████] 100%");
			expect(line).toContain("wk [░░░░░] 0%");
		});

		it("never exceeds terminal width for any width from 0 to 120", () => {
			for (let w = 0; w <= 120; w++) {
				const line = buildWidgetLine(mockTheme, mockAccount, w);
				expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		});

		it("handles narrow terminal width (width=65 crash scenario) gracefully", () => {
			const line = buildWidgetLine(mockTheme, mockAccount, 65);
			expect(visibleWidth(line)).toBeLessThanOrEqual(65);
			expect(line).toContain("codex:");
		});

		it("handles very narrow widths (width < 20) without crashing", () => {
			const line15 = buildWidgetLine(mockTheme, mockAccount, 15);
			expect(visibleWidth(line15)).toBeLessThanOrEqual(15);

			const line5 = buildWidgetLine(mockTheme, mockAccount, 5);
			expect(visibleWidth(line5)).toBeLessThanOrEqual(5);

			const line0 = buildWidgetLine(mockTheme, mockAccount, 0);
			expect(line0).toBe("");
		});

		it("ensures widget render() lines never exceed width including divider", () => {
			let capturedFactory: any;
			const mockCtx = {
				hasUI: true,
				ui: {
					setStatus: vi.fn(),
					setWidget: vi.fn((_id, factory) => {
						capturedFactory = factory;
					}),
				},
			} as any;

			refreshUI(mockCtx, { widgetEnabled: true, footerEnabled: true });
			expect(capturedFactory).toBeDefined();

			const widgetComponent = capturedFactory({}, mockTheme);
			for (const width of [65, 50, 30, 15, 5, 0, -1]) {
				const lines = widgetComponent.render(width);
				expect(Array.isArray(lines)).toBe(true);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
				}
			}
		});
	});

	describe("autocomplete suggestions", () => {
		it("provides subcommand and account suggestions", () => {
			const cmd = registeredCommands.get("codex-auth");
			expect(cmd).toBeDefined();

			const completions = cmd.getArgumentCompletions("");
			expect(completions).toBeInstanceOf(Array);
			const values = completions.map((c: any) => c.value);
			expect(values).toContain("switch");
			expect(values).toContain("status");
			expect(values).toContain("sync");
			expect(values).toContain("widget");
			expect(values).toContain("footer");
		});

		it("provides toggle options when typing widget or footer", () => {
			const cmd = registeredCommands.get("codex-auth");
			const widgetOpts = cmd.getArgumentCompletions("widget ");
			expect(widgetOpts?.map((o: any) => o.value)).toEqual(["widget on", "widget off"]);

			const footerOpts = cmd.getArgumentCompletions("footer ");
			expect(footerOpts?.map((o: any) => o.value)).toEqual(["footer on", "footer off"]);
		});
	});

	describe("command execution & configuration persistence", () => {
		const testDir = join(tmpdir(), `codex-auth-config-test-${Date.now()}`);
		const piHome = join(testDir, ".pi", "agent");

		beforeEach(() => {
			process.env.PI_CODING_AGENT_DIR = piHome;
			mkdirSync(piHome, { recursive: true });
		});

		afterEach(() => {
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(testDir, { recursive: true, force: true });
		});

		it("loads default config when file does not exist", () => {
			const config = loadConfig();
			expect(config.widgetEnabled).toBe(true);
			expect(config.footerEnabled).toBe(true);
		});

		it("saves and loads configuration across sessions", () => {
			saveConfig({ widgetEnabled: false, footerEnabled: true });
			const loaded = loadConfig();
			expect(loaded.widgetEnabled).toBe(false);
			expect(loaded.footerEnabled).toBe(true);

			saveConfig({ widgetEnabled: false, footerEnabled: false });
			const reloaded = loadConfig();
			expect(reloaded.widgetEnabled).toBe(false);
			expect(reloaded.footerEnabled).toBe(false);
		});

		it("handles widget and footer toggles with persistence across sessions", async () => {
			const cmd = registeredCommands.get("codex-auth");
			const mockCtx = {
				hasUI: true,
				ui: {
					notify: vi.fn(),
					setStatus: vi.fn(),
					setWidget: vi.fn(),
				},
			} as unknown as ExtensionCommandContext;

			await cmd.handler("widget off", mockCtx);
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Codex 2nd-line widget: DISABLED"),
				"info",
			);
			expect(loadConfig().widgetEnabled).toBe(false);

			await cmd.handler("footer off", mockCtx);
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Codex footer badge: DISABLED"),
				"info",
			);
			expect(loadConfig().footerEnabled).toBe(false);

			// Simulate starting a new session with persisted config
			let sessionStartHandler: any;
			const freshMockPi = {
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: any) => {
					if (event === "session_start") {
						sessionStartHandler = handler;
					}
				}),
			} as any;
			codexAuthExtension(freshMockPi);

			expect(sessionStartHandler).toBeDefined();

			const newSessionCtx = {
				hasUI: true,
				ui: {
					notify: vi.fn(),
					setStatus: vi.fn(),
					setWidget: vi.fn(),
				},
			} as any;

			await sessionStartHandler({}, newSessionCtx);
			expect(newSessionCtx.ui.setWidget).toHaveBeenCalledWith("codex-auth", undefined);
			expect(newSessionCtx.ui.setStatus).toHaveBeenCalledWith("codex-auth", undefined);
		});
	});

	describe("synchronization with custom directories", () => {
		const testDir = join(tmpdir(), `codex-auth-test-${Date.now()}`);
		const codexHome = join(testDir, ".codex");
		const piHome = join(testDir, ".pi", "agent");

		function createMockJwt(expSeconds: number): string {
			const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(
				JSON.stringify({
					exp: expSeconds,
					"https://api.openai.com/auth": { chatgpt_account_id: "test-acc-id" },
				}),
			).toString("base64url");
			return `${header}.${payload}.sig`;
		}

		beforeEach(() => {
			process.env.CODEX_HOME = codexHome;
			process.env.PI_CODING_AGENT_DIR = piHome;
			mkdirSync(join(codexHome, "accounts"), { recursive: true });
			mkdirSync(piHome, { recursive: true });
		});

		afterEach(() => {
			delete process.env.CODEX_HOME;
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(testDir, { recursive: true, force: true });
		});

		it("syncs codex auth to pi using real JWT expiry timestamp", () => {
			const expSeconds = Math.floor(Date.now() / 1000) + 10 * 86400; // 10 days
			const jwtAccess = createMockJwt(expSeconds);

			const codexAuth: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: {
					id_token: "id-token",
					access_token: jwtAccess,
					refresh_token: "refresh-token-123",
					account_id: "test-acc-id",
				},
				last_refresh: new Date().toISOString(),
			};
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(codexAuth, null, 2));

			const res = syncCodexToPi();
			expect(res.changed).toBe(true);

			const piAuth: PiAuthStore = JSON.parse(readFileSync(join(piHome, "auth.json"), "utf8"));
			const cred = piAuth["openai-codex"] as { type: "oauth"; access: string; refresh: string; accountId: string; expires: number } | undefined;
			expect(cred).toBeDefined();
			expect(cred?.type).toBe("oauth");
			if (cred?.type === "oauth") {
				expect(cred.access).toBe(jwtAccess);
				expect(cred.refresh).toBe("refresh-token-123");
				expect(cred.accountId).toBe("test-acc-id");
				expect(cred.expires).toBe(expSeconds * 1000);
			}
		});

		it("syncs pi auth back to codex auth and snapshot files", () => {
			const accountKey = "user-123::test-acc-id";
			const fileKey = Buffer.from(accountKey).toString("base64url");
			const snapshotPath = join(codexHome, "accounts", `${fileKey}.auth.json`);

			const initialCodexAuth: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: {
					id_token: "id-1",
					access_token: "old-access",
					refresh_token: "old-refresh",
					account_id: "test-acc-id",
				},
				last_refresh: "2026-01-01T00:00:00.000Z",
			};
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(initialCodexAuth, null, 2));
			writeFileSync(snapshotPath, JSON.stringify(initialCodexAuth, null, 2));

			const piAuth: PiAuthStore = {
				"openai-codex": {
					type: "oauth",
					access: "new-access-from-pi",
					refresh: "new-refresh-from-pi",
					expires: Date.now() + 10 * 86400 * 1000,
					accountId: "test-acc-id",
				},
			};
			writeFileSync(join(piHome, "auth.json"), JSON.stringify(piAuth, null, 2));

			const res = syncPiToCodex();
			expect(res.changed).toBe(true);

			const updatedCodexAuth: CodexAuthFile = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
			expect(updatedCodexAuth.tokens?.access_token).toBe("new-access-from-pi");
			expect(updatedCodexAuth.tokens?.refresh_token).toBe("new-refresh-from-pi");

			const updatedSnap: CodexAuthFile = JSON.parse(readFileSync(snapshotPath, "utf8"));
			expect(updatedSnap.tokens?.access_token).toBe("new-access-from-pi");
			expect(updatedSnap.tokens?.refresh_token).toBe("new-refresh-from-pi");
		});

		it("formats /codex-auth status lines with remaining percentages (100% when unused, 0% when depleted)", async () => {
			const mockRegistry: CodexRegistry = {
				schema_version: 3,
				active_account_key: "acc-1",
				accounts: [
					{
						account_key: "acc-1",
						alias: "work",
						email: "work@example.com",
						chatgpt_account_id: "id-work-123",
						plan: "plus",
						last_usage: {
							primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
							secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					},
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const cmd = registeredCommands.get("codex-auth");
			const mockCtx = {
				hasUI: true,
				ui: {
					notify: vi.fn(),
				},
			} as unknown as ExtensionCommandContext;

			await cmd.handler("status", mockCtx);
			expect(mockCtx.ui.notify).toHaveBeenCalled();
			const output = (mockCtx.ui.notify as any).mock.calls[0][0];
			expect(output).toContain("5h:     [██████████] 100%");
			expect(output).toContain("Weekly: [░░░░░░░░░░] 0%");
		});
	});
});
