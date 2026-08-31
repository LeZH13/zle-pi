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
	balance: string;
}

export interface CodexAccountUsage {
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	credits?: CodexCredits;
	plan_type?: string;
}

export interface CodexAccount {
	account_key: string;
	chatgpt_account_id?: string;
	chatgpt_user_id?: string;
	email?: string;
	alias?: string;
	account_name?: string | null;
	plan?: string;
	auth_mode?: string;
	created_at?: number;
	last_used_at?: number;
	last_usage?: CodexAccountUsage;
	last_usage_at?: number;
}

export interface CodexRegistry {
	schema_version: number;
	active_account_key?: string;
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
