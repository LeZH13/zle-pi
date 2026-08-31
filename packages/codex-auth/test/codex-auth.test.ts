import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codexAuthExtension from "../extensions/codex-auth/index.js";
import { findAccount, maskEmail, maskId } from "../extensions/codex-auth/registry.js";
import { syncCodexToPi } from "../extensions/codex-auth/sync.js";
import type { CodexRegistry } from "../extensions/codex-auth/types.js";
import { formatProgressBar, formatResetTime, getActiveAccount } from "../extensions/codex-auth/ui.js";

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

		it("formats reset time countdowns", () => {
			const now = Math.floor(Date.now() / 1000);
			expect(formatResetTime(now + 90)).toBe("in 1m");
			expect(formatResetTime(now + 3600 + 1200)).toBe("in 1h 20m");
			expect(formatResetTime(now - 10)).toBe("now");
			expect(formatResetTime(undefined)).toBe("");
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

	describe("command execution", () => {
		it("handles widget and footer toggles", async () => {
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

			await cmd.handler("footer off", mockCtx);
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Codex footer badge: DISABLED"),
				"info",
			);
		});
	});
});
