/**
 * Codex Auth Extension for Pi Coding Agent
 *
 * Seamlessly manages and switches OpenAI Codex OAuth accounts with:
 * - Live synchronization between ~/.codex/auth.json and ~/.pi/agent/auth.json
 * - Interactive TUI account picker dialog (/codex-auth)
 * - Autocomplete suggestions for subcommands and registered accounts
 * - Pi footer status badge
 * - Dedicated 2nd line quota progress widget below editor with faint divider
 * - Full secret redaction and safe error handling
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	clearAccountAlias,
	formatAccountIdentifier,
	getDisplayOrderedAccounts,
	loadConfig,
	loadRegistry,
	maskEmail,
	maskId,
	saveConfig,
	setAccountAlias,
	switchActiveAccount,
} from "./registry.js";
import { setupCodexAuthWatcher, syncCodexToPi, syncPiToCodex } from "./sync.js";
import type { CodexAuthConfig } from "./types.js";
import {
	calculateRemainingPercent,
	formatProgressBar,
	formatResetTime,
	getActiveAccount,
	promptAccountPicker,
	refreshUI,
} from "./ui.js";

export default function codexAuthExtension(pi: ExtensionAPI) {
	// Extension display configuration (persisted across sessions in ~/.pi/agent/codex-auth.json)
	const config: CodexAuthConfig = loadConfig();

	let disposeWatcher: (() => void) | null = null;
	let lastContext: ExtensionContext | null = null;

	// Internal helper to perform switch and update state
	async function executeSwitch(selector: string, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		const result = switchActiveAccount(selector);
		if (!result.success) {
			ctx.ui.notify(result.message, "error");
			return;
		}

		// Sync newly activated tokens into Pi's auth.json
		syncCodexToPi();
		refreshUI(ctx, config);

		const accountDesc = formatAccountIdentifier(result.account);
		ctx.ui.notify(`Switched Codex account to '${accountDesc}'`, "info");
	}

	// Register /codex-auth slash command with rich autocomplete
	pi.registerCommand("codex-auth", {
		description: "OpenAI Codex account switcher & quota monitor (/codex-auth [switch|list|status|alias|sync|widget|footer])",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normPrefix = prefix.trimStart().toLowerCase();
			const registry = loadRegistry();
			const accounts = registry ? getDisplayOrderedAccounts(registry) : [];
			const prevKey = registry?.previous_active_account_key;
			const prevAcc = prevKey ? accounts.find((a) => a.account_key === prevKey) : null;
			const prevDesc = formatAccountIdentifier(prevAcc);

			// 1. Subcommand suggestions
			const subcommands: AutocompleteItem[] = [
				{ value: "switch", label: "switch", description: "Switch active Codex account" },
				{ value: "list", label: "list", description: "Show registered accounts and rate limits" },
				{ value: "status", label: "status", description: "Show registered accounts and rate limits" },
				{ value: "alias", label: "alias", description: "Manage account alias (set|clear)" },
				{ value: "sync", label: "sync", description: "Force bi-directional token sync" },
				{ value: "widget", label: "widget", description: "Toggle 2nd-line widget below editor" },
				{ value: "footer", label: "footer", description: "Toggle footer status badge" },
			];

			// 2. If typing after 'switch '
			if (normPrefix.startsWith("switch ")) {
				const query = normPrefix.slice(7).trim();
				const items: AutocompleteItem[] = [];

				if (prevAcc) {
					items.push({
						value: "switch -",
						label: "switch -",
						description: `Switch to previous account (${prevDesc})`,
					});
				}

				for (const acc of accounts) {
					const val = acc.alias || acc.email || acc.account_name || acc.account_key;
					const label = formatAccountIdentifier(acc);
					const plan = acc.plan ? ` (${acc.plan.toUpperCase()})` : "";
					items.push({
						value: `switch ${val}`,
						label: `switch ${label}`,
						description: `${label}${plan}`,
					});
				}

				const matched = items.filter(
					(i) => !query || i.value.toLowerCase().includes(query) || i.label.toLowerCase().includes(query),
				);
				return matched.length > 0 ? matched : null;
			}

			// 3. If typing after 'alias '
			if (normPrefix.startsWith("alias ")) {
				const opts: AutocompleteItem[] = [
					{ value: "alias set", label: "alias set", description: "Set alias: /codex-auth alias set <query> <alias>" },
					{ value: "alias clear", label: "alias clear", description: "Clear alias: /codex-auth alias clear <query>" },
				];
				const matched = opts.filter((o) => o.value.startsWith(normPrefix));
				return matched.length > 0 ? matched : null;
			}

			// 4. If typing after 'widget '
			if (normPrefix.startsWith("widget ")) {
				const opts: AutocompleteItem[] = [
					{ value: "widget on", label: "widget on", description: "Show quota progress line below editor" },
					{ value: "widget off", label: "widget off", description: "Hide quota progress line below editor" },
				];
				const matched = opts.filter((o) => o.value.startsWith(normPrefix));
				return matched.length > 0 ? matched : null;
			}

			// 5. If typing after 'footer '
			if (normPrefix.startsWith("footer ")) {
				const opts: AutocompleteItem[] = [
					{ value: "footer on", label: "footer on", description: "Show footer status badge" },
					{ value: "footer off", label: "footer off", description: "Hide footer status badge" },
				];
				const matched = opts.filter((o) => o.value.startsWith(normPrefix));
				return matched.length > 0 ? matched : null;
			}

			// 6. Default completions: subcommands + previous shortcut + direct switch shortcuts
			const directAccountSuggestions: AutocompleteItem[] = [];

			if (prevAcc) {
				directAccountSuggestions.push({
					value: "-",
					label: "-",
					description: `Switch to previous account (${prevDesc})`,
				});
			}

			for (const acc of accounts) {
				const val = acc.alias || acc.email || acc.account_name || acc.account_key;
				const label = formatAccountIdentifier(acc);
				const plan = acc.plan ? ` (${acc.plan.toUpperCase()})` : "";
				directAccountSuggestions.push({
					value: val,
					label,
					description: `Switch directly to ${label}${plan}`,
				});
			}

			const all = [...subcommands, ...directAccountSuggestions];
			const filtered = all.filter(
				(item) =>
					item.value.toLowerCase().startsWith(normPrefix) || item.label.toLowerCase().startsWith(normPrefix),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastContext = ctx;
			const trimmed = args?.trim() || "";
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			// 1. /codex-auth widget [on|off]
			if (sub === "widget") {
				const val = parts[1]?.toLowerCase();
				if (val === "on") config.widgetEnabled = true;
				else if (val === "off") config.widgetEnabled = false;
				else config.widgetEnabled = !config.widgetEnabled;

				saveConfig(config);
				refreshUI(ctx, config);
				ctx.ui.notify(`Codex 2nd-line widget: ${config.widgetEnabled ? "ENABLED" : "DISABLED"}`, "info");
				return;
			}

			// 2. /codex-auth footer [on|off]
			if (sub === "footer") {
				const val = parts[1]?.toLowerCase();
				if (val === "on") config.footerEnabled = true;
				else if (val === "off") config.footerEnabled = false;
				else config.footerEnabled = !config.footerEnabled;

				saveConfig(config);
				refreshUI(ctx, config);
				ctx.ui.notify(`Codex footer badge: ${config.footerEnabled ? "ENABLED" : "DISABLED"}`, "info");
				return;
			}

			// 3. /codex-auth sync
			if (sub === "sync") {
				const toPi = syncCodexToPi();
				const toCodex = syncPiToCodex();
				refreshUI(ctx, config);

				if (toPi.changed || toCodex.changed) {
					ctx.ui.notify("Synchronized Codex credentials successfully.", "info");
				} else {
					ctx.ui.notify("Codex credentials are already up to date.", "info");
				}
				return;
			}

			// 4. /codex-auth status or /codex-auth list
			if (sub === "status" || sub === "list") {
				const registry = loadRegistry();
				if (!registry || registry.accounts.length === 0) {
					ctx.ui.notify("No registered accounts found in ~/.codex/accounts/registry.json", "warning");
					return;
				}

				const active = getActiveAccount(registry);
				const orderedAccounts = getDisplayOrderedAccounts(registry);
				const lines: string[] = ["\n--- OpenAI Codex Accounts ---"];

				for (let i = 0; i < orderedAccounts.length; i++) {
					const acc = orderedAccounts[i];
					if (!acc) continue;
					const isActive = active?.account_key === acc.account_key;
					const marker = isActive ? " [ACTIVE]" : "";
					const alias = acc.alias ? `[${acc.alias}] ` : "";
					const email = acc.email ? maskEmail(acc.email) : (acc.account_name || maskId(acc.chatgpt_account_id));
					const plan = acc.plan ? `(${acc.plan.toUpperCase()})` : "";
					const usage = acc.usage ?? acc.last_usage;
					const u5h = calculateRemainingPercent(usage?.primary?.used_percent);
					const r5h = formatResetTime(usage?.primary?.resets_at);
					const uWk = calculateRemainingPercent(usage?.secondary?.used_percent);
					const rWk = formatResetTime(usage?.secondary?.resets_at);

					lines.push(
						`  ${i + 1}. ${alias}${email} ${plan}${marker}`,
						`     5h:     ${formatProgressBar(u5h, 10)} ${r5h ? `(${r5h})` : ""}`,
						`     Weekly: ${formatProgressBar(uWk, 10)} ${rWk ? `(${rWk})` : ""}`,
					);

					if (usage?.reset_credits != null || (usage?.credits?.has_credits && usage.credits.balance)) {
						const creditParts: string[] = [];
						if (usage?.credits?.has_credits && usage.credits.balance) {
							creditParts.push(`Balance: $${usage.credits.balance}`);
						}
						if (usage?.reset_credits != null) {
							creditParts.push(`Reset Credits: ${usage.reset_credits}`);
						}
						lines.push(`     Credits: ${creditParts.join(" • ")}`);
					}
				}
				lines.push("-----------------------------\\n");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// 5. /codex-auth alias [set <query> <alias> | clear <query>]
			if (sub === "alias") {
				const action = parts[1]?.toLowerCase();
				if (action === "set") {
					if (parts.length < 4) {
						ctx.ui.notify("Usage: /codex-auth alias set <query> <alias>", "error");
						return;
					}
					const alias = parts[parts.length - 1]!;
					const query = parts.slice(2, -1).join(" ");
					const res = setAccountAlias(query, alias);
					refreshUI(ctx, config);
					ctx.ui.notify(res.message, res.success ? "info" : "error");
					return;
				}
				if (action === "clear") {
					const query = parts.slice(2).join(" ").trim();
					if (!query) {
						ctx.ui.notify("Usage: /codex-auth alias clear <query>", "error");
						return;
					}
					const res = clearAccountAlias(query);
					refreshUI(ctx, config);
					ctx.ui.notify(res.message, res.success ? "info" : "error");
					return;
				}
				ctx.ui.notify("Usage: /codex-auth alias set <query> <alias> | /codex-auth alias clear <query>", "info");
				return;
			}

			// 6. /codex-auth switch <query> (including /codex-auth switch -)
			if (sub === "switch") {
				const query = parts.slice(1).join(" ");
				if (!query) {
					if (ctx.hasUI) {
						await promptAccountPicker(ctx, (key) => executeSwitch(key, ctx));
					} else {
						ctx.ui.notify("Usage: /codex-auth switch <alias|email|number|query|->", "error");
					}
					return;
				}
				await executeSwitch(query, ctx);
				return;
			}

			// 7. /codex-auth - (jump to previous account)
			if (trimmed === "-") {
				await executeSwitch("-", ctx);
				return;
			}

			// 8. Direct query (e.g. `/codex-auth work` or `/codex-auth 1`) or default interactive picker
			if (trimmed) {
				await executeSwitch(trimmed, ctx);
			} else if (ctx.hasUI) {
				await promptAccountPicker(ctx, (key) => executeSwitch(key, ctx));
			} else {
				ctx.ui.notify("Usage: /codex-auth [switch <query>|list|status|alias|sync|widget|footer|-]", "info");
			}
		},
	});

	// Session Start Lifecycle: Sync credentials, setup live watcher, update UI
	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;

		// 0. Refresh in-memory config from disk in case updated elsewhere
		Object.assign(config, loadConfig());

		// 1. Sync from Codex auth into Pi
		syncCodexToPi();

		// 2. Setup debounced filesystem watcher for ~/.codex/auth.json
		if (!disposeWatcher) {
			disposeWatcher = setupCodexAuthWatcher(() => {
				const res = syncCodexToPi();
				if (lastContext) {
					refreshUI(lastContext, config);
					if (res.changed) {
						lastContext.ui.notify("Codex active account updated from external change.", "info");
					}
				}
			});
		}

		// 3. Render UI status and widget
		refreshUI(ctx, config);
	});

	// Model / Request lifecycle: Sync refreshed tokens back to ~/.codex
	pi.on("after_provider_response", async (_event, ctx) => {
		lastContext = ctx;
		syncPiToCodex();
		refreshUI(ctx, config);
	});

	// Session Shutdown Lifecycle: Clean up watchers
	pi.on("session_shutdown", async () => {
		if (disposeWatcher) {
			disposeWatcher();
			disposeWatcher = null;
		}
	});
}
