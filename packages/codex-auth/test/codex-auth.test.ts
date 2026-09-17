import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codexAuthExtension from "../extensions/codex-auth/index.js";
import {
	findAccount,
	getCodexAuthConfigPath,
	getDisplayOrderedAccounts,
	loadConfig,
	maskEmail,
	maskId,
	resetCommandExecutor,
	resolveAccount,
	saveConfig,
	setCommandExecutor,
	switchActiveAccount,
} from "../extensions/codex-auth/registry.js";
import { extractJwtExpiry, syncCodexToPi, syncPiToCodex } from "../extensions/codex-auth/sync.js";
import type { CodexAuthFile, CodexRegistry, PiAuthStore } from "../extensions/codex-auth/types.js";
import {
	buildWidgetLine,
	calculateRemainingPercent,
	formatFooterStatus,
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
			exec: vi.fn().mockResolvedValue({ code: 0, killed: false, stdout: "{}", stderr: "" }),
			registerCommand: vi.fn((name, options) => {
				registeredCommands.set(name, options);
			}),
			on: vi.fn((event, handler) => {
				registeredListeners.set(event, handler);
			}),
		} as unknown as ExtensionAPI;

		codexAuthExtension(mockPi);
	});

	afterEach(() => {
		resetCommandExecutor();
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

	it("refreshes the active account on demand through codex-auth's API-backed command", async () => {
		const cmd = registeredCommands.get("codex-auth");
		const ctx = {
			hasUI: true,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await cmd.handler("refresh", ctx);

		expect(mockPi.exec).toHaveBeenCalledWith(
			"codex-auth",
			["list", "--active", "--json"],
			expect.objectContaining({ timeout: 15_000 }),
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Refreshed active Codex usage.", "info");
	});

	it("throttles automatic usage refreshes and limits them to Codex provider responses", async () => {
		const handler = registeredListeners.get("after_provider_response");
		const ctx = {
			model: { provider: "openai-codex" },
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
		} as any;

		await handler({}, ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await handler({}, ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(mockPi.exec).toHaveBeenCalledTimes(1);

		await handler({}, { ...ctx, model: { provider: "anthropic" } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(mockPi.exec).toHaveBeenCalledTimes(1);
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

		it("falls back to account_name and ID when email is absent or undefined", () => {
			const accWithName: any = {
				account_key: "acc-no-email",
				account_name: "Acme Org",
				chatgpt_account_id: "e2774859-949b-4f76-8c93-298e1260ea4e",
				plan: "business",
			};
			const mockTheme = { fg: (_c: string, text: string) => text };
			const widgetLine = buildWidgetLine(mockTheme, accWithName, 80);
			expect(widgetLine).toContain("Acme Org (business)");

			const accWithIdOnly: any = {
				account_key: "acc-id-only",
				chatgpt_account_id: "e2774859-949b-4f76-8c93-298e1260ea4e",
			};
			const widgetLineId = buildWidgetLine(mockTheme, accWithIdOnly, 80);
			expect(widgetLineId).toContain("e2774859...");
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

		it("formats compact footer status with account number and 5h/7d usage limits", () => {
			const mockRegistry: any = {
				schema_version: 1,
				accounts: [
					{
						account_key: "acc-1",
						email: "alice@example.com",
						usage: {
							primary: { used_percent: 5 },
							secondary: { used_percent: 1 },
						},
					},
					{
						account_key: "acc-2",
						email: "bob@example.com",
					},
				],
			};

			// Account 1 with full usage (5% used -> 95% remaining; 1% used -> 99% remaining)
			expect(formatFooterStatus(mockRegistry, mockRegistry.accounts[0])).toBe("codex #1 · 5h 95% · 7d 99%");

			// Account 2 without usage yet
			expect(formatFooterStatus(mockRegistry, mockRegistry.accounts[1])).toBe("codex #2");

			// No active account
			expect(formatFooterStatus(mockRegistry, null)).toBe("codex: none");
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
			previous_active_account_key: "acc-2",
			accounts: [
				{
					account_key: "acc-1",
					alias: "work",
					account_name: "Acme Corp",
					email: "work@example.com",
					chatgpt_account_id: "id-work-123",
					plan: "plus",
				},
				{
					account_key: "acc-2",
					alias: "personal",
					account_name: "Personal Projects",
					email: "personal@example.com",
					chatgpt_account_id: "id-personal-456",
					plan: "pro",
				},
			],
		};

		it("finds accounts by alias, email, ID, account_name, row number, and previous shortcut", () => {
			expect(findAccount(mockRegistry, "work")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "personal")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "work@example.com")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "id-personal-456")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "Acme")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "Personal Projects")?.account_key).toBe("acc-2");
			// In v0.3 display order, personal@example.com sorts before work@example.com
			expect(findAccount(mockRegistry, "1")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "2")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "01")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "02")?.account_key).toBe("acc-1");
			expect(findAccount(mockRegistry, "001")?.account_key).toBe("acc-2");
			expect(findAccount(mockRegistry, "-")?.account_key).toBe("acc-2");
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
		it("provides subcommand and account suggestions including list, alias, and shortcuts", () => {
			const cmd = registeredCommands.get("codex-auth");
			expect(cmd).toBeDefined();

			const completions = cmd.getArgumentCompletions("");
			expect(completions).toBeInstanceOf(Array);
			const values = completions.map((c: any) => c.value);
			expect(values).toContain("switch");
			expect(values).toContain("list");
			expect(values).toContain("status");
			expect(values).toContain("alias");
			expect(values).toContain("sync");
			expect(values).toContain("widget");
			expect(values).toContain("footer");
		});

		it("handles multi-word query in alias set and clear commands", async () => {
			const cmd = registeredCommands.get("codex-auth");
			const calls: Array<{ cmd: string; args: string[] }> = [];
			setCommandExecutor((cmdName, args) => {
				calls.push({ cmd: cmdName, args });
				return Buffer.from("");
			});

			const mockCtx = {
				hasUI: true,
				ui: {
					notify: vi.fn(),
					setStatus: vi.fn(),
					setWidget: vi.fn(),
				},
			} as unknown as ExtensionCommandContext;

			// /codex-auth alias set Personal Projects work
			await cmd.handler("alias set Personal Projects work", mockCtx);
			expect(calls[0]).toEqual({
				cmd: "codex-auth",
				args: ["alias", "set", "Personal Projects", "work"],
			});

			// /codex-auth alias clear Personal Projects
			await cmd.handler("alias clear Personal Projects", mockCtx);
			expect(calls[1]).toEqual({
				cmd: "codex-auth",
				args: ["alias", "clear", "Personal Projects"],
			});

			resetCommandExecutor();
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

		it("does not overwrite ~/.codex/auth.json when active Codex account belongs to another user", () => {
			const activeCodexAuth: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: {
					id_token: "id-active",
					access_token: "active-codex-access",
					refresh_token: "active-codex-refresh",
					account_id: "active-account-id",
				},
				last_refresh: "2026-01-01T00:00:00.000Z",
			};
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(activeCodexAuth, null, 2));

			const otherAccountKey = "user-other::other-account-id";
			const fileKey = Buffer.from(otherAccountKey).toString("base64url");
			const otherSnapshotPath = join(codexHome, "accounts", `${fileKey}.auth.json`);
			writeFileSync(otherSnapshotPath, JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					id_token: "id-other",
					access_token: "old-other-access",
					refresh_token: "old-other-refresh",
					account_id: "other-account-id",
				},
			}, null, 2));

			// Pi has credentials for other-account-id
			const piAuth: PiAuthStore = {
				"openai-codex": {
					type: "oauth",
					access: "refreshed-other-access",
					refresh: "refreshed-other-refresh",
					expires: Date.now() + 10 * 86400 * 1000,
					accountId: "other-account-id",
				},
			};
			writeFileSync(join(piHome, "auth.json"), JSON.stringify(piAuth, null, 2));

			const res = syncPiToCodex();
			expect(res.changed).toBe(true);

			// ~/.codex/auth.json MUST remain untouched (active-account-id)
			const codexAuthAfter: CodexAuthFile = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
			expect(codexAuthAfter.tokens?.account_id).toBe("active-account-id");
			expect(codexAuthAfter.tokens?.access_token).toBe("active-codex-access");

			// But other account's snapshot file MUST be updated
			const otherSnapAfter: CodexAuthFile = JSON.parse(readFileSync(otherSnapshotPath, "utf8"));
			expect(otherSnapAfter.tokens?.access_token).toBe("refreshed-other-access");
			expect(otherSnapAfter.tokens?.refresh_token).toBe("refreshed-other-refresh");
		});

		it("formats /codex-auth status lines with remaining percentages (100% when unused, 0% when depleted)", async () => {
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
						last_usage: {
							primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
							secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 },
							reset_credits: 3,
							credits: { has_credits: true, unlimited: false, balance: "15" },
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
			expect(output).toContain("Credits: Balance: $15 • Reset Credits: 3");
		});

		it("does not update ~/.codex/auth.json when registry says account B is active even if auth.json and Pi match account A", () => {
			// Scenario: Contaminated state where registry has active account B (id-2),
			// but auth.json and Pi both currently have account A (id-1).
			// Pi sync MUST NOT write account A back into auth.json, which would perpetuate the contamination.
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-2",
				accounts: [
					{ account_key: "acc-1", alias: "work", email: "work@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", alias: "personal", email: "personal@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const authA: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: { access_token: "old-a", refresh_token: "ref-a", account_id: "id-1" },
			};
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(authA, null, 2));

			// Pi has new refreshed tokens for id-1 (account A)
			const piAuth: PiAuthStore = {
				"openai-codex": {
					type: "oauth",
					access: "new-a-from-pi",
					refresh: "new-ref-a",
					expires: Date.now() + 10 * 86400 * 1000,
					accountId: "id-1",
				},
			};
			writeFileSync(join(piHome, "auth.json"), JSON.stringify(piAuth, null, 2));

			const res = syncPiToCodex();
			// auth.json was NOT updated with new token because registry active is id-2 (acc-2)
			const authAfter: CodexAuthFile = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
			expect(authAfter.tokens?.access_token).toBe("old-a");
		});

		it("switches account using deterministic v0.3.0 CLI switched_to JSON response", () => {
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-1",
				accounts: [
					{ account_key: "acc-1", alias: "work", email: "work@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", alias: "personal", email: "personal@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const v030Response = JSON.stringify({
				schema_version: 1,
				command: "switch",
				switched_to: {
					number: 2,
					account_key: "acc-2",
					email: "personal@example.com",
					alias: "personal",
					plan: "pro",
					auth_mode: "chatgpt",
					active: true,
				},
			});

			const calls: Array<{ cmd: string; args: string[] }> = [];
			setCommandExecutor((cmd, args) => {
				calls.push({ cmd, args });
				return v030Response;
			});

			const res = switchActiveAccount("personal");
			expect(calls[0]).toEqual({
				cmd: "codex-auth",
				args: ["switch", "personal", "--json"],
			});
			expect(res.success).toBe(true);
			expect(res.account?.account_key).toBe("acc-2");
			expect(res.message).toContain("personal");

			resetCommandExecutor();
		});

		it("returns structured CLI error and does not fall back when CLI reports ambiguous_query", () => {
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-1",
				accounts: [
					{ account_key: "acc-1", alias: "work-one", email: "work1@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", alias: "work-two", email: "work2@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			// CLI fails with ambiguous query error document
			const cliError: any = new Error("Command failed");
			cliError.status = 1;
			cliError.stdout = JSON.stringify({
				schema_version: 1,
				error: {
					code: "ambiguous_query",
					message: "multiple accounts match \"work\"",
				},
			});

			setCommandExecutor(() => {
				throw cliError;
			});

			const res = switchActiveAccount("work");
			// Must return the exact CLI error and NOT fall through to fallback (which would pick acc-1!)
			expect(res.success).toBe(false);
			expect(res.message).toBe("multiple accounts match \"work\"");

			resetCommandExecutor();
		});

		it("invokes codex-auth switch - without --json for previous account shortcut", () => {
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-1",
				previous_active_account_key: "acc-2",
				accounts: [
					{ account_key: "acc-1", alias: "work", email: "work@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", alias: "personal", email: "personal@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const calls: Array<{ cmd: string; args: string[] }> = [];
			setCommandExecutor((cmd, args) => {
				calls.push({ cmd, args });
				if (args && args[0] === "switch" && args[1] === "-") {
					// Simulate CLI switching active_account_key to acc-2
					const updated = { ...mockRegistry, active_account_key: "acc-2", previous_active_account_key: "acc-1" };
					writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(updated, null, 2));
					return Buffer.from("Switched to personal(personal@example.com)\n");
				}
				throw new Error("unexpected call");
			});

			const res = switchActiveAccount("-");
			expect(calls[0]).toEqual({
				cmd: "codex-auth",
				args: ["switch", "-"],
			});
			expect(res.success).toBe(true);
			expect(res.account?.account_key).toBe("acc-2");

			resetCommandExecutor();
		});

		it("switches account using direct fallback when codex-auth is not installed (ENOENT)", () => {
			const snap1Key = Buffer.from("acc-1").toString("base64url");
			const snap2Key = Buffer.from("acc-2").toString("base64url");

			const snap1: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: { access_token: "t1", refresh_token: "r1", account_id: "id-1" },
			};
			const snap2: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: { access_token: "t2", refresh_token: "r2", account_id: "id-2" },
			};
			writeFileSync(join(codexHome, "accounts", `${snap1Key}.auth.json`), JSON.stringify(snap1, null, 2));
			writeFileSync(join(codexHome, "accounts", `${snap2Key}.auth.json`), JSON.stringify(snap2, null, 2));
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(snap1, null, 2));

			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-1",
				previous_active_account_key: null,
				accounts: [
					{ account_key: "acc-1", alias: "work", email: "work@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", alias: "personal", email: "personal@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			// Mock ENOENT: codex-auth CLI binary does not exist on PATH
			const enoentError: any = new Error("spawnSync codex-auth ENOENT");
			enoentError.code = "ENOENT";
			setCommandExecutor(() => {
				throw enoentError;
			});

			// Switch to personal by alias via fallback
			const res = switchActiveAccount("personal");
			expect(res.success).toBe(true);

			const regAfter: CodexRegistry = JSON.parse(readFileSync(join(codexHome, "accounts", "registry.json"), "utf8"));
			expect(regAfter.active_account_key).toBe("acc-2");
			expect(regAfter.previous_active_account_key).toBe("acc-1");

			// Switch back to previous account using "-" via fallback
			const resPrev = switchActiveAccount("-");
			expect(resPrev.success).toBe(true);

			const regAfterPrev: CodexRegistry = JSON.parse(readFileSync(join(codexHome, "accounts", "registry.json"), "utf8"));
			expect(regAfterPrev.active_account_key).toBe("acc-1");
			expect(regAfterPrev.previous_active_account_key).toBe("acc-2");

			resetCommandExecutor();
		});

		it("formats autocomplete suggestions using account_name or masked ID when email is absent", () => {
			const cmd = registeredCommands.get("codex-auth");
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-no-email",
				previous_active_account_key: "acc-no-email-2",
				accounts: [
					{
						account_key: "acc-no-email",
						account_name: "Corporate Org",
						chatgpt_account_id: "e2774859-949b-4f76-8c93-298e1260ea4e",
						plan: "enterprise",
					},
					{
						account_key: "acc-no-email-2",
						chatgpt_account_id: "45f10ca5-0ddf-4fe1-9fb9-f571e8deef0a",
						plan: "pro",
					},
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const completions = cmd.getArgumentCompletions("");
			expect(completions).toBeInstanceOf(Array);

			const prevItem = completions.find((c: any) => c.value === "-");
			expect(prevItem).toBeDefined();
			expect(prevItem.description).toContain("45f10ca5...");

			const directItem = completions.find((c: any) => c.value === "Corporate Org");
			expect(directItem).toBeDefined();
			expect(directItem.label).toBe("Corporate Org");
			expect(directItem.description).toContain("Corporate Org (ENTERPRISE)");

			const switchCompletions = cmd.getArgumentCompletions("switch ");
			const switchDirectItem = switchCompletions.find((c: any) => c.value === "switch Corporate Org");
			expect(switchDirectItem).toBeDefined();
			expect(switchDirectItem.label).toBe("switch Corporate Org");
		});

		it("rejects ambiguous selectors in fallback when codex-auth is not installed (ENOENT)", () => {
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-1",
				accounts: [
					{ account_key: "acc-1", email: "work-one@example.com", chatgpt_account_id: "id-1" },
					{ account_key: "acc-2", email: "work-two@example.com", chatgpt_account_id: "id-2" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			// Mock ENOENT: CLI not installed
			const enoentError: any = new Error("spawnSync codex-auth ENOENT");
			enoentError.code = "ENOENT";
			setCommandExecutor(() => {
				throw enoentError;
			});

			const res = switchActiveAccount("work");
			expect(res.success).toBe(false);
			expect(res.message).toBe("multiple accounts match \"work\"");

			resetCommandExecutor();
		});

		it("fails closed during sync when registry declares an active key that cannot be identified", () => {
			// Registry declares active key "acc-ghost" that does not exist in accounts array
			const mockRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-ghost",
				accounts: [
					{ account_key: "acc-1", email: "work@example.com", chatgpt_account_id: "id-1" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(mockRegistry, null, 2));

			const authA: CodexAuthFile = {
				auth_mode: "chatgpt",
				tokens: { access_token: "old-a", refresh_token: "ref-a", account_id: "id-1" },
			};
			writeFileSync(join(codexHome, "auth.json"), JSON.stringify(authA, null, 2));

			const piAuth: PiAuthStore = {
				"openai-codex": {
					type: "oauth",
					access: "new-a",
					refresh: "new-ref-a",
					expires: Date.now() + 10 * 86400 * 1000,
					accountId: "id-1",
				},
			};
			writeFileSync(join(piHome, "auth.json"), JSON.stringify(piAuth, null, 2));

			syncPiToCodex();
			// Since active_account_key could not be identified, fail closed: auth.json must NOT be updated
			const authAfter: CodexAuthFile = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
			expect(authAfter.tokens?.access_token).toBe("old-a");
		});

		it("resolves display numbers using v0.3 display order on unsorted registries", () => {
			// Registry accounts are intentionally stored in reverse/unsorted order
			const unsortedRegistry: CodexRegistry = {
				schema_version: 4,
				active_account_key: "acc-z",
				accounts: [
					{ account_key: "acc-z", email: "zeta@example.com", alias: "zeta", plan: "plus" },
					{ account_key: "acc-a", email: "alpha@example.com", alias: "alpha", plan: "plus" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(unsortedRegistry, null, 2));

			// Display order should sort alpha@ before zeta@
			const ordered = getDisplayOrderedAccounts(unsortedRegistry);
			expect(ordered[0]?.account_key).toBe("acc-a");
			expect(ordered[1]?.account_key).toBe("acc-z");

			// "1" must resolve to alpha@ (row 1 in display), "2" to zeta@
			expect(resolveAccount(unsortedRegistry, "1").status).toBe("found");
			expect(resolveAccount(unsortedRegistry, "1")).toEqual({
				status: "found",
				account: expect.objectContaining({ account_key: "acc-a" }),
			});
			expect(resolveAccount(unsortedRegistry, "2")).toEqual({
				status: "found",
				account: expect.objectContaining({ account_key: "acc-z" }),
			});
		});

		it("treats exact alias as ambiguous when another alias or fragment contains it (upstream query semantics)", () => {
			const ambiguousAliasRegistry: CodexRegistry = {
				schema_version: 4,
				accounts: [
					{ account_key: "acc-1", email: "dev1@example.com", alias: "work" },
					{ account_key: "acc-2", email: "dev2@example.com", alias: "work-two" },
				],
			};
			writeFileSync(join(codexHome, "accounts", "registry.json"), JSON.stringify(ambiguousAliasRegistry, null, 2));

			// Query "work" matches both "work" and "work-two", so it must be ambiguous
			const resAmbiguous = resolveAccount(ambiguousAliasRegistry, "work");
			expect(resAmbiguous.status).toBe("ambiguous");
			if (resAmbiguous.status === "ambiguous") {
				expect(resAmbiguous.candidates).toHaveLength(2);
			}

			// Query "work-two" matches only acc-2, so it must resolve directly
			const resDirect = resolveAccount(ambiguousAliasRegistry, "work-two");
			expect(resDirect.status).toBe("found");
			if (resDirect.status === "found") {
				expect(resDirect.account.account_key).toBe("acc-2");
			}
		});

		it("sorts same-email accounts preferring last_usage.plan_type over plan (resolveDisplayPlan)", () => {
			// Both accounts share the same email "user@example.com".
			// Account 1: plan says "plus" (individual rank 1), but last_usage.plan_type says "business" (rank 0).
			// Account 2: plan says "pro" (individual rank 1), with no usage plan_type.
			// Because last_usage.plan_type wins, Account 1 resolves as "business" (rank 0)
			// and must sort before Account 2 (rank 1).
			const sameEmailRegistry: CodexRegistry = {
				schema_version: 4,
				accounts: [
					{
						account_key: "acc-user-pro",
						email: "user@example.com",
						plan: "pro",
					},
					{
						account_key: "acc-user-team",
						email: "user@example.com",
						plan: "plus",
						last_usage: {
							plan_type: "business",
						},
					},
				],
			};

			const ordered = getDisplayOrderedAccounts(sameEmailRegistry);
			expect(ordered[0]?.account_key).toBe("acc-user-team");
			expect(ordered[1]?.account_key).toBe("acc-user-pro");

			// "1" must resolve to acc-user-team
			expect(resolveAccount(sameEmailRegistry, "1")).toEqual({
				status: "found",
				account: expect.objectContaining({ account_key: "acc-user-team" }),
			});
		});

		it("sorts same-email Business and Enterprise accounts with reversed account keys", () => {
			// In Schema 4, "business" preserves as Business, "enterprise" as Enterprise.
			// Display labels: "BUSINESS" vs "ENTERPRISE". "BUSINESS" < "ENTERPRISE" alphabetically.
			// Account acc-z-biz has a lexicographically later account key than acc-a-ent ("acc-z-biz" > "acc-a-ent").
			// Upstream must sort Business before Enterprise regardless of account key order.
			const bizEntRegistry: CodexRegistry = {
				schema_version: 4,
				accounts: [
					{
						account_key: "acc-a-ent",
						email: "corp@example.com",
						plan: "enterprise",
					},
					{
						account_key: "acc-z-biz",
						email: "corp@example.com",
						plan: "business",
					},
				],
			};

			const ordered = getDisplayOrderedAccounts(bizEntRegistry);
			expect(ordered[0]?.account_key).toBe("acc-z-biz");
			expect(ordered[1]?.account_key).toBe("acc-a-ent");

			expect(resolveAccount(bizEntRegistry, "1")).toEqual({
				status: "found",
				account: expect.objectContaining({ account_key: "acc-z-biz" }),
			});
		});

		it("sorts same-email API key accounts using display label API_KEY", () => {
			const apiKeyRegistry: CodexRegistry = {
				schema_version: 4,
				accounts: [
					{
						account_key: "apikey::org::123456789",
						email: "same@example.com",
						auth_mode: "apikey",
					},
					{
						account_key: "oauth::user::123456789",
						email: "same@example.com",
						plan: "business",
					},
				],
			};

			const ordered = getDisplayOrderedAccounts(apiKeyRegistry);
			// business (rank 0) sorts before API_KEY (unknown plan rank 2)
			expect(ordered[0]?.account_key).toBe("oauth::user::123456789");
			expect(ordered[1]?.account_key).toBe("apikey::org::123456789");
		});
	});
});
