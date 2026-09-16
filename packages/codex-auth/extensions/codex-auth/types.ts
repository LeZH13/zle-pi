/**
 * Type definitions for Codex Auth Extension
 */

export interface CodexUsageWindow {
	used_percent: number;
	window_minutes: number;
	resets_at: number;
}

export interface CodexCredits {
	has_credits: boolean;
	unlimited: boolean;
	balance: string | null;
}

export interface CodexAccountUsage {
	primary?: CodexUsageWindow | null;
	secondary?: CodexUsageWindow | null;
	credits?: CodexCredits | null;
	reset_credits?: number | null;
	plan_type?: string | null;
	source?: "api" | "local" | "cache" | "none" | string;
	updated_at?: number;
}

export interface CodexAccount {
	number?: number;
	account_key: string;
	chatgpt_account_id?: string;
	chatgpt_user_id?: string;
	email?: string;
	alias?: string | null;
	account_name?: string | null;
	plan?: string;
	auth_mode?: string;
	active?: boolean;
	created_at?: number;
	last_used_at?: number;
	last_usage?: CodexAccountUsage;
	usage?: CodexAccountUsage;
	last_usage_at?: number;
}

export interface CodexRegistry {
	schema_version: number;
	active_account_key?: string;
	previous_active_account_key?: string | null;
	interval_seconds?: number;
	active_account_activated_at_ms?: number;
	accounts: CodexAccount[];
}

export interface CodexAuthTokens {
	id_token?: string;
	access_token?: string;
	refresh_token?: string;
	account_id?: string;
}

export interface CodexAuthFile {
	auth_mode?: string;
	OPENAI_API_KEY?: string | null;
	tokens?: CodexAuthTokens;
	last_refresh?: string;
}

export interface PiOAuthCredential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

export type PiAuthStore = Record<string, unknown>;

export interface CodexAuthConfig {
	widgetEnabled: boolean;
	footerEnabled: boolean;
}
