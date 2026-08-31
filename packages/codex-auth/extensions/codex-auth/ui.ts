import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadCodexAuth, loadRegistry, maskEmail, maskId } from "./registry.js";
import type { CodexAccount, CodexAuthConfig, CodexRegistry } from "./types.js";

/** Generate a compact dimmed visual progress bar (e.g. [░░░░] 5%) */
export function formatProgressBar(percent: number, width = 6): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filledChars = Math.round((clamped / 100) * width);
	const emptyChars = width - filledChars;
	const bar = "█".repeat(filledChars) + "░".repeat(emptyChars);
	return `[${bar}] ${clamped}%`;
}

/** Format remaining time until quota reset compactly */
export function formatResetTime(resetsAtSeconds?: number): string {
	if (!resetsAtSeconds) return "";
	const nowSeconds = Math.floor(Date.now() / 1000);
	const diffSeconds = resetsAtSeconds - nowSeconds;
	if (diffSeconds <= 0) return "now";

	const hours = Math.floor(diffSeconds / 3600);
	const minutes = Math.floor((diffSeconds % 3600) / 60);

	if (hours > 24) {
		const days = Math.floor(hours / 24);
		return `in ${days}d`;
	}
	if (hours > 0) {
		return `in ${hours}h ${minutes}m`;
	}
	return `in ${minutes}m`;
}

/** Get active account from registry and current ~/.codex/auth.json */
export function getActiveAccount(registry: CodexRegistry | null): CodexAccount | null {
	if (!registry || registry.accounts.length === 0) return null;

	const codexAuth = loadCodexAuth();
	const currentAccountId = codexAuth?.tokens?.account_id;

	if (currentAccountId) {
		const match = registry.accounts.find((a) => a.chatgpt_account_id === currentAccountId);
		if (match) return match;
	}

	if (registry.active_account_key) {
		const match = registry.accounts.find((a) => a.account_key === registry.active_account_key);
		if (match) return match;
	}

	return registry.accounts[0] ?? null;
}

/** Format an account's display label */
export function getAccountLabel(acc: CodexAccount): string {
	const name = acc.alias || maskEmail(acc.email) || maskId(acc.chatgpt_account_id);
	const plan = acc.plan ? ` (${acc.plan.toLowerCase()})` : "";
	return `${name}${plan}`;
}

/** Update Pi footer status badge & 2nd line widget */
export function refreshUI(ctx: ExtensionContext, config: CodexAuthConfig): void {
	if (!ctx.hasUI) return;

	const registry = loadRegistry();
	const active = getActiveAccount(registry);

	// 1. Pi Footer Status Badge (Compact & Dimmed)
	if (config.footerEnabled) {
		if (active) {
			const label = active.alias || maskEmail(active.email);
			const plan = active.plan ? ` (${active.plan.toLowerCase()})` : "";
			ctx.ui.setStatus("codex-auth", `codex: ${label}${plan}`);
		} else {
			ctx.ui.setStatus("codex-auth", "codex: none");
		}
	} else {
		ctx.ui.setStatus("codex-auth", undefined);
	}

	// 2. Dedicated 2nd Line Widget below editor (With Faint Hairline Divider)
	if (config.widgetEnabled && active) {
		const label = active.alias || maskEmail(active.email);
		const plan = active.plan ? ` (${active.plan.toLowerCase()})` : "";
		const u5h = active.last_usage?.primary?.used_percent ?? 0;
		const r5h = formatResetTime(active.last_usage?.primary?.resets_at);
		const uWeek = active.last_usage?.secondary?.used_percent ?? 0;
		const rWeek = formatResetTime(active.last_usage?.secondary?.resets_at);

		ctx.ui.setWidget(
			"codex-auth",
			(_tui, theme) => {
				const tag = theme.fg("dim", "codex: ");
				const name = theme.fg("muted", `${label}${plan}`);
				const sep = theme.fg("dim", " • ");
				const q5h = theme.fg("dim", `5h ${formatProgressBar(u5h, 5)}${r5h ? ` (${r5h})` : ""}`);
				const qWk = theme.fg("dim", `wk ${formatProgressBar(uWeek, 5)}${rWeek ? ` (${rWeek})` : ""}`);

				const widgetLine = `${tag}${name}${sep}${q5h}${sep}${qWk}`;

				return {
					render: (width) => {
						const dividerLen = Math.max(16, Math.min(typeof width === "number" ? width : 40, 50));
						const faintDivider = theme.fg("borderMuted", "─".repeat(dividerLen));
						return [widgetLine, faintDivider];
					},
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
	} else {
		ctx.ui.setWidget("codex-auth", undefined);
	}
}

/** Show interactive TUI account picker */
export async function promptAccountPicker(
	ctx: ExtensionCommandContext,
	onSelected: (accountKeyOrAlias: string) => Promise<void>,
): Promise<void> {
	const registry = loadRegistry();
	if (!registry || registry.accounts.length === 0) {
		ctx.ui.notify("No registered Codex accounts found in ~/.codex/accounts/registry.json", "warning");
		return;
	}

	const active = getActiveAccount(registry);
	const options = registry.accounts.map((acc, index) => {
		const isActive = active?.account_key === acc.account_key;
		const tag = isActive ? " [ACTIVE]" : "";
		const aliasPart = acc.alias ? `[${acc.alias}] ` : "";
		const emailPart = maskEmail(acc.email);
		const planPart = acc.plan ? ` (${acc.plan.toLowerCase()})` : "";

		const u5h = acc.last_usage?.primary?.used_percent;
		const u5hStr = u5h !== undefined ? ` • 5h: ${u5h}%` : "";
		const uWeek = acc.last_usage?.secondary?.used_percent;
		const uWeekStr = uWeek !== undefined ? ` • wk: ${uWeek}%` : "";

		return {
			id: acc.account_key,
			label: `${index + 1}. ${aliasPart}${emailPart}${planPart}${tag}${u5hStr}${uWeekStr}`,
		};
	});

	const choice = await ctx.ui.select(
		"Select OpenAI Codex Account:",
		options.map((o) => o.label),
	);

	if (!choice) return;

	const selectedIdx = options.findIndex((o) => o.label === choice);
	if (selectedIdx >= 0 && options[selectedIdx]) {
		await onSelected(options[selectedIdx].id);
	}
}
