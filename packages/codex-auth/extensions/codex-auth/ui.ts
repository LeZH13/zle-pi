import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAccountIdentifier, getDisplayOrderedAccounts, loadCodexAuth, loadRegistry, maskEmail, maskId } from "./registry.js";
import type { CodexAccount, CodexAuthConfig, CodexRegistry } from "./types.js";

/**
 * Calculate remaining quota percentage from used_percent (100% when unused, 0% when depleted).
 * Consistent with codex-auth CLI convention.
 */
export function calculateRemainingPercent(usedPercent?: number | null): number {
	if (typeof usedPercent !== "number" || Number.isNaN(usedPercent)) {
		return 100;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

/** Generate a compact dimmed visual progress bar (e.g. [████░] 80%) */
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
	const name = formatAccountIdentifier(acc);
	const plan = acc.plan ? ` (${acc.plan.toLowerCase()})` : "";
	return `${name}${plan}`;
}

/** Build a single responsive widget status line that fits within available width */
export function buildWidgetLine(
	theme: Theme | { fg: (color: any, text: string) => string },
	active: CodexAccount,
	width: number,
): string {
	if (width <= 0) return "";

	const rawName = formatAccountIdentifier(active);
	const rawPlan = active.plan ? ` (${active.plan.toLowerCase()})` : "";
	const usage = active.usage ?? active.last_usage;
	const u5h = calculateRemainingPercent(usage?.primary?.used_percent);
	const r5h = formatResetTime(usage?.primary?.resets_at);
	const uWeek = calculateRemainingPercent(usage?.secondary?.used_percent);
	const rWeek = formatResetTime(usage?.secondary?.resets_at);

	const tag = theme.fg("dim", "codex: ");
	const sep = theme.fg("dim", " • ");

	const nameWithPlan = theme.fg("muted", `${rawName}${rawPlan}`);
	const nameOnly = theme.fg("muted", rawName);

	const q5hFull = theme.fg("dim", `5h ${formatProgressBar(u5h, 5)}${r5h ? ` (${r5h})` : ""}`);
	const q5hBar = theme.fg("dim", `5h ${formatProgressBar(u5h, 5)}`);
	const q5hPct = theme.fg("dim", `5h ${u5h}%`);

	const qWkFull = theme.fg("dim", `wk ${formatProgressBar(uWeek, 5)}${rWeek ? ` (${rWeek})` : ""}`);
	const qWkBar = theme.fg("dim", `wk ${formatProgressBar(uWeek, 5)}`);
	const qWkPct = theme.fg("dim", `wk ${uWeek}%`);

	// Candidates ordered from richest detail to most compact layout
	const candidates = [
		// 1. Full: codex: work (plus) • 5h [█████] 95% (now) • wk [█████] 99% (in 6d)
		`${tag}${nameWithPlan}${sep}${q5hFull}${sep}${qWkFull}`,
		// 2. Omit weekly reset countdown
		`${tag}${nameWithPlan}${sep}${q5hFull}${sep}${qWkBar}`,
		// 3. Omit reset countdowns: codex: work (plus) • 5h [█████] 95% • wk [█████] 99%
		`${tag}${nameWithPlan}${sep}${q5hBar}${sep}${qWkBar}`,
		// 4. Omit plan: codex: work • 5h [█████] 95% • wk [█████] 99%
		`${tag}${nameOnly}${sep}${q5hBar}${sep}${qWkBar}`,
		// 5. Compact percentages with plan: codex: work (plus) • 5h 95% • wk 99%
		`${tag}${nameWithPlan}${sep}${q5hPct}${sep}${qWkPct}`,
		// 6. Compact percentages: codex: work • 5h 95% • wk 99%
		`${tag}${nameOnly}${sep}${q5hPct}${sep}${qWkPct}`,
		// 7. 5h quota only: codex: work • 5h 95%
		`${tag}${nameOnly}${sep}${q5hPct}`,
		// 8. Name only: codex: work
		`${tag}${nameOnly}`,
	];

	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) {
			return candidate;
		}
	}

	// Always guarantee the returned string never exceeds width
	const shortest = candidates[candidates.length - 1] ?? "";
	return truncateToWidth(shortest, width, "…");
}

/** Format compact footer status badge: e.g. "codex #1 · 5h 95% · 7d 99%" */
export function formatFooterStatus(registry: CodexRegistry | null, active: CodexAccount | null): string {
	if (!active) return "codex: none";
	const ordered = registry ? getDisplayOrderedAccounts(registry) : [];
	const index = ordered.findIndex((a) => a.account_key === active.account_key);
	const accNumber = index >= 0 ? `#${index + 1}` : (active.number ? `#${active.number}` : "");
	const label = accNumber ? `codex ${accNumber}` : `codex: ${formatAccountIdentifier(active)}`;

	const usage = active.usage ?? active.last_usage;
	const parts: string[] = [label];
	if (typeof usage?.primary?.used_percent === "number") {
		const u5h = calculateRemainingPercent(usage.primary.used_percent);
		parts.push(`5h ${u5h}%`);
	}
	if (typeof usage?.secondary?.used_percent === "number") {
		const u7d = calculateRemainingPercent(usage.secondary.used_percent);
		parts.push(`7d ${u7d}%`);
	}
	return parts.join(" · ");
}

export const CODEX_FOOTER_COLOR = "#b5bd68";

export function hexColor(hex: string, text: string): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Update Pi footer status badge & 2nd line widget */
export function refreshUI(ctx: ExtensionContext, config: CodexAuthConfig): void {
	if (!ctx.hasUI) return;

	const registry = loadRegistry();
	const active = getActiveAccount(registry);

	// 1. Pi Footer Status Badge (Compact & Dimmed)
	if (config.footerEnabled) {
		const raw = formatFooterStatus(registry, active);
		ctx.ui.setStatus("codex-auth", raw ? hexColor(CODEX_FOOTER_COLOR, raw) : undefined);
	} else {
		ctx.ui.setStatus("codex-auth", undefined);
	}

	// 2. Dedicated 2nd Line Widget below editor (With Faint Hairline Divider & Width Clamping)
	if (config.widgetEnabled && active) {
		ctx.ui.setWidget(
			"codex-auth",
			(_tui, theme) => {
				return {
					render: (width) => {
						if (typeof width !== "number" || width <= 0) return [];
						const widgetLine = buildWidgetLine(theme, active, width);
						const dividerLen = Math.max(0, Math.min(width, 50));
						const faintDivider = dividerLen > 0 ? theme.fg("borderMuted", "─".repeat(dividerLen)) : "";
						return faintDivider ? [widgetLine, faintDivider] : [widgetLine];
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
	const orderedAccounts = getDisplayOrderedAccounts(registry);
	const options = orderedAccounts.map((acc, index) => {
		const isActive = active?.account_key === acc.account_key;
		const tag = isActive ? " [ACTIVE]" : "";
		const aliasPart = acc.alias ? `[${acc.alias}] ` : "";
		const emailPart = acc.email ? maskEmail(acc.email) : (acc.account_name || maskId(acc.chatgpt_account_id));
		const planPart = acc.plan ? ` (${acc.plan.toLowerCase()})` : "";

		const usage = acc.usage ?? acc.last_usage;
		const rawU5h = usage?.primary?.used_percent;
		const u5hStr = typeof rawU5h === "number" ? ` • 5h: ${calculateRemainingPercent(rawU5h)}%` : "";
		const rawUWeek = usage?.secondary?.used_percent;
		const uWeekStr = typeof rawUWeek === "number" ? ` • wk: ${calculateRemainingPercent(rawUWeek)}%` : "";
		const resetCreditsStr = usage?.reset_credits != null ? ` • reset: ${usage.reset_credits}` : "";
		const creditsStr = usage?.credits?.has_credits && usage.credits.balance ? ` • $${usage.credits.balance}` : "";

		return {
			id: acc.account_key,
			label: `${index + 1}. ${aliasPart}${emailPart}${planPart}${tag}${u5hStr}${uWeekStr}${resetCreditsStr}${creditsStr}`,
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
