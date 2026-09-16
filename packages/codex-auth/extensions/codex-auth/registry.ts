import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexAccount, CodexAuthConfig, CodexAuthFile, CodexRegistry } from "./types.js";

export type CommandExecutor = (cmd: string, args: string[], options?: any) => string | Buffer;

let currentExecutor: CommandExecutor = (cmd, args, options) => execFileSync(cmd, args, options);

/** Override command executor (for deterministic testing) */
export function setCommandExecutor(executor: CommandExecutor): void {
	currentExecutor = executor;
}

/** Reset command executor to default execFileSync */
export function resetCommandExecutor(): void {
	currentExecutor = (cmd, args, options) => execFileSync(cmd, args, options);
}

/** Resolve Codex home path (~/.codex) */
export function getCodexHome(): string {
	return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Resolve Pi agent home path (~/.pi/agent) */
export function getPiAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** Path to ~/.codex/accounts/registry.json */
export function getRegistryPath(): string {
	return path.join(getCodexHome(), "accounts", "registry.json");
}

/** Path to ~/.codex/auth.json */
export function getCodexAuthJsonPath(): string {
	return path.join(getCodexHome(), "auth.json");
}

/** Path to ~/.pi/agent/auth.json */
export function getPiAuthJsonPath(): string {
	return path.join(getPiAgentDir(), "auth.json");
}

/** Path to ~/.pi/agent/codex-auth.json (persistent extension settings) */
export function getCodexAuthConfigPath(): string {
	return path.join(getPiAgentDir(), "codex-auth.json");
}

const DEFAULT_CONFIG: CodexAuthConfig = {
	widgetEnabled: true,
	footerEnabled: true,
};

/** Load persisted extension UI configuration */
export function loadConfig(): CodexAuthConfig {
	const configPath = getCodexAuthConfigPath();
	if (!fs.existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		return {
			widgetEnabled: typeof parsed.widgetEnabled === "boolean" ? parsed.widgetEnabled : DEFAULT_CONFIG.widgetEnabled,
			footerEnabled: typeof parsed.footerEnabled === "boolean" ? parsed.footerEnabled : DEFAULT_CONFIG.footerEnabled,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Persist extension UI configuration */
export function saveConfig(config: CodexAuthConfig): void {
	const configPath = getCodexAuthConfigPath();
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${configPath}.tmp.${Date.now()}`;
	fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmpPath, configPath);
}

/** Mask email address for safe display (e.g. "user***@domain.com") */
export function maskEmail(email?: string): string {
	if (!email) return "unknown";
	const parts = email.split("@");
	if (parts.length !== 2) return email.length > 3 ? `${email.slice(0, 3)}***` : "***";
	const name = parts[0] ?? "";
	const domain = parts[1] ?? "";
	const maskedName = name.length > 4 ? `${name.slice(0, 4)}***` : `${name.slice(0, 2)}***`;
	return `${maskedName}@${domain}`;
}

/** Mask account ID for safe display (e.g. "e2774859...") */
export function maskId(id?: string): string {
	if (!id) return "unknown";
	return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/** Format account identifier safely falling back to email, account_name, or masked ID */
export function formatAccountIdentifier(acc?: CodexAccount | null): string {
	if (!acc) return "unknown";
	return (
		acc.alias ||
		(acc.email ? maskEmail(acc.email) : null) ||
		acc.account_name ||
		(acc.chatgpt_account_id ? maskId(acc.chatgpt_account_id) : "unknown")
	);
}

/** Read registry.json safely */
export function loadRegistry(): CodexRegistry | null {
	const registryPath = getRegistryPath();
	if (!fs.existsSync(registryPath)) return null;
	try {
		const raw = fs.readFileSync(registryPath, "utf8");
		return JSON.parse(raw) as CodexRegistry;
	} catch {
		return null;
	}
}

/** Read ~/.codex/auth.json safely */
export function loadCodexAuth(): CodexAuthFile | null {
	const authPath = getCodexAuthJsonPath();
	if (!fs.existsSync(authPath)) return null;
	try {
		const raw = fs.readFileSync(authPath, "utf8");
		return JSON.parse(raw) as CodexAuthFile;
	} catch {
		return null;
	}
}

export type AccountResolveResult =
	| { status: "found"; account: CodexAccount }
	| { status: "not_found" }
	| { status: "ambiguous"; candidates: CodexAccount[] };

function compareStringsBytewise(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Parse stored plan type matching codex-auth src/registry/parse.zig parseStoredPlanType():
 * Schema < 4 (legacy migration): team -> business, business -> enterprise
 * Schema >= 4 (current): preserved directly as business, enterprise, edu, plus, pro, etc.
 */
export function parseStoredPlanType(raw?: string | null, schemaVersion: number = 4): string | null {
	if (!raw) return null;
	const lower = raw.trim().toLowerCase();

	if (schemaVersion < 4) {
		if (lower === "free") return "free";
		if (lower === "go") return "go";
		if (lower === "plus") return "plus";
		if (lower === "prolite") return "prolite";
		if (lower === "pro") return "pro";
		if (lower === "team" || lower === "self_serve_business_usage_based") return "business";
		if (
			lower === "business" ||
			lower === "enterprise_cbp_usage_based" ||
			lower === "enterprise" ||
			lower === "hc"
		) {
			return "enterprise";
		}
		if (lower === "education" || lower === "edu") return "edu";
		return "unknown";
	}

	if (lower === "free") return "free";
	if (lower === "go") return "go";
	if (lower === "plus") return "plus";
	if (lower === "prolite") return "prolite";
	if (lower === "pro") return "pro";
	if (lower === "business") return "business";
	if (lower === "enterprise") return "enterprise";
	if (lower === "edu") return "edu";
	return "unknown";
}

/**
 * Resolve display plan matching upstream resolveDisplayPlan():
 * prefers stored usage plan_type (refreshed data), then falls back to account.plan.
 */
export function resolveDisplayPlan(acc: CodexAccount, schemaVersion: number = 4): string | null {
	const usage = acc.usage ?? acc.last_usage;
	if (usage?.plan_type) {
		const parsed = parseStoredPlanType(usage.plan_type, schemaVersion);
		if (parsed) return parsed;
	}
	return parseStoredPlanType(acc.plan, schemaVersion);
}

/**
 * Resolve display label matching upstream displayPlan():
 * returns "API_KEY" for apikey auth_mode, plan label for OAuth, or "-" if unknown.
 */
export function displayPlan(acc: CodexAccount, schemaVersion: number = 4): string {
	if (acc.auth_mode === "apikey") return "API_KEY";
	const resolved = resolveDisplayPlan(acc, schemaVersion);
	return resolved ? resolved.toUpperCase() : "-";
}

function planSortRank(plan?: string | null): number {
	const p = (plan || "").toLowerCase();
	if (["business", "enterprise", "edu"].includes(p)) return 0;
	if (["free", "go", "plus", "prolite", "pro"].includes(p)) return 1;
	return 2;
}

/**
 * Sort accounts by codex-auth v0.3 display order (matching src/tui/display.zig lessThanByDisplayOrder):
 * 1. Email alphabetical (bytewise code-unit order)
 * 2. Active account first within same email
 * 3. Plan sort rank (business/enterprise/edu < individual < unknown) using resolveDisplayPlan()
 * 4. Display plan label alphabetical (bytewise code-unit order)
 * 5. Account key alphabetical (bytewise code-unit order)
 */
export function getDisplayOrderedAccounts(registry: CodexRegistry): CodexAccount[] {
	const activeKey = registry.active_account_key;
	const schemaVersion = registry.schema_version ?? 4;
	return [...registry.accounts].sort((a, b) => {
		const emailA = a.email || "";
		const emailB = b.email || "";
		const emailCmp = compareStringsBytewise(emailA, emailB);
		if (emailCmp !== 0) return emailCmp;

		const aActive = a.account_key === activeKey ? 1 : 0;
		const bActive = b.account_key === activeKey ? 1 : 0;
		if (aActive !== bActive) return bActive - aActive; // active first

		const planA = resolveDisplayPlan(a, schemaVersion);
		const planB = resolveDisplayPlan(b, schemaVersion);
		const rankA = planSortRank(planA);
		const rankB = planSortRank(planB);
		if (rankA !== rankB) return rankA - rankB;

		const labelA = displayPlan(a, schemaVersion);
		const labelB = displayPlan(b, schemaVersion);
		const labelCmp = compareStringsBytewise(labelA, labelB);
		if (labelCmp !== 0) return labelCmp;

		return compareStringsBytewise(a.account_key, b.account_key);
	});
}

/**
 * Resolve an account selector with strict ambiguity detection matching v0.3.0 CLI semantics (src/workflows/query.zig).
 */
export function resolveAccount(registry: CodexRegistry, query: string): AccountResolveResult {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return { status: "not_found" };

	// 1. Exact match by account_key
	for (const acc of registry.accounts) {
		if (acc.account_key === query) return { status: "found", account: acc };
	}

	// 2. Previous account shortcut "-"
	if (normalized === "-") {
		if (registry.previous_active_account_key) {
			const prev = registry.accounts.find((a) => a.account_key === registry.previous_active_account_key);
			if (prev) return { status: "found", account: prev };
		}
		return { status: "not_found" };
	}

	// 3. Display row number (e.g. "1", "02") resolved against display-ordered rows
	if (/^\d+$/.test(normalized)) {
		const rowNum = parseInt(normalized, 10);
		const ordered = getDisplayOrderedAccounts(registry);
		if (rowNum >= 1 && rowNum <= ordered.length) {
			const acc = ordered[rowNum - 1];
			if (acc) return { status: "found", account: acc };
		}
		return { status: "not_found" };
	}

	// 4. Fragment matches across email, alias, and account_name (matching upstream src/workflows/query.zig),
	// with chatgpt_account_id prefix match retained as an intentional Pi extension convenience.
	const candidates = registry.accounts.filter((acc) => {
		const matchesEmail = Boolean(acc.email && acc.email.toLowerCase().includes(normalized));
		const matchesAlias = Boolean(acc.alias && acc.alias.trim().length > 0 && acc.alias.toLowerCase().includes(normalized));
		const matchesName = Boolean(acc.account_name && acc.account_name.trim().length > 0 && acc.account_name.toLowerCase().includes(normalized));
		const matchesId = Boolean(acc.chatgpt_account_id && acc.chatgpt_account_id.toLowerCase().startsWith(normalized));
		return matchesEmail || matchesAlias || matchesName || matchesId;
	});

	if (candidates.length === 1) {
		return { status: "found", account: candidates[0]! };
	}
	if (candidates.length > 1) {
		return { status: "ambiguous", candidates };
	}

	return { status: "not_found" };
}

/** Find an account matching query (returns null if ambiguous or not found) */
export function findAccount(registry: CodexRegistry, query: string): CodexAccount | null {
	const res = resolveAccount(registry, query);
	return res.status === "found" ? res.account : null;
}

/** Encode filename for account snapshot if needed */
function encodeAccountFileKey(accountKey: string): string {
	return Buffer.from(accountKey).toString("base64url");
}

/**
 * Switch active account using codex-auth CLI (or fallback to manual snapshot activation)
 */
export function switchActiveAccount(selector: string): { success: boolean; message: string; account?: CodexAccount } {
	const registry = loadRegistry();
	if (!registry || registry.accounts.length === 0) {
		return { success: false, message: "No registered Codex accounts found in registry.json" };
	}

	const isPrevious = selector.trim() === "-";

	// 1. Try invoking codex-auth CLI first
	try {
		// codex-auth switch - does not accept --json (it's CLI-only), while queries use --json
		const args = isPrevious ? ["switch", "-"] : ["switch", selector, "--json"];
		const stdout = currentExecutor("codex-auth", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		}).toString();

		const updatedRegistry = loadRegistry() || registry;

		if (isPrevious) {
			const activeKey = updatedRegistry.active_account_key;
			const target = updatedRegistry.accounts.find((a) => a.account_key === activeKey);
			const displayName = formatAccountIdentifier(target);
			return {
				success: true,
				message: `Switched active Codex account to ${displayName}`,
				account: target,
			};
		}

		// Parse JSON response (v0.3.0 emits { schema_version: 1, command: "switch", switched_to: { ... } })
		const result = JSON.parse(stdout);
		const targetKey = result?.switched_to?.account_key ?? result?.active_account_key;
		if (targetKey) {
			const target =
				updatedRegistry.accounts.find((a) => a.account_key === targetKey) ||
				result.switched_to;
			const displayName = formatAccountIdentifier(target);
			return {
				success: true,
				message: `Switched active Codex account to ${displayName}`,
				account: target,
			};
		}
	} catch (cliErr: any) {
		// If the CLI binary was executed and failed with an error code, respect the CLI error.
		// Fallback to direct snapshot switch ONLY if the CLI binary is not available (ENOENT).
		// Overriding CLI errors (such as ambiguous_query) with fallback findAccount can activate the wrong account!
		if (cliErr?.code !== "ENOENT") {
			if (cliErr?.stdout) {
				try {
					const errDoc = JSON.parse(cliErr.stdout);
					if (errDoc?.error?.message) {
						return { success: false, message: errDoc.error.message };
					}
				} catch {
					// Ignore parse errors
				}
			}
			const stderrMsg = cliErr?.stderr?.toString().trim();
			if (stderrMsg) {
				return { success: false, message: stderrMsg.replace(/^error:\s*/, "") };
			}
			return { success: false, message: `Switch failed: ${cliErr?.message || String(cliErr)}` };
		}
	}

	// 2. Direct snapshot switch fallback (used only when codex-auth CLI binary is not installed)
	const resolved = resolveAccount(registry, selector);
	if (resolved.status === "ambiguous") {
		return { success: false, message: `multiple accounts match "${selector}"` };
	}
	if (resolved.status === "not_found") {
		if (isPrevious) {
			return { success: false, message: "No previous Codex account to switch to" };
		}
		return { success: false, message: `no account matches "${selector}"` };
	}

	const target = resolved.account;

	const accountsDir = path.join(getCodexHome(), "accounts");
	const fileKey = encodeAccountFileKey(target.account_key);
	let snapshotPath = path.join(accountsDir, `${fileKey}.auth.json`);

	if (!fs.existsSync(snapshotPath)) {
		if (fs.existsSync(accountsDir)) {
			const candidateFiles = fs.readdirSync(accountsDir).filter((f) => f.endsWith(".auth.json"));
			const found = candidateFiles.find((f) => {
				try {
					const content = fs.readFileSync(path.join(accountsDir, f), "utf8");
					return content.includes(target.chatgpt_account_id || target.account_key);
				} catch {
					return false;
				}
			});
			if (found) {
				snapshotPath = path.join(accountsDir, found);
			} else {
				return { success: false, message: "Could not locate account snapshot file on disk" };
			}
		} else {
			return { success: false, message: "Could not locate accounts directory" };
		}
	}

	try {
		// Copy snapshot to ~/.codex/auth.json
		const content = fs.readFileSync(snapshotPath, "utf8");
		const targetAuthPath = getCodexAuthJsonPath();
		const tmpPath = `${targetAuthPath}.tmp.${Date.now()}`;
		fs.writeFileSync(tmpPath, content, { mode: 0o600 });
		fs.renameSync(tmpPath, targetAuthPath);

		// Update registry.json active account key & previous active account key (Schema 4)
		const prevKey = registry.active_account_key;
		if (prevKey && prevKey !== target.account_key) {
			registry.previous_active_account_key = prevKey;
		}
		registry.active_account_key = target.account_key;
		registry.active_account_activated_at_ms = Date.now();
		if (!registry.schema_version) {
			registry.schema_version = 4;
		}
		const regPath = getRegistryPath();
		const tmpRegPath = `${regPath}.tmp.${Date.now()}`;
		fs.writeFileSync(tmpRegPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
		fs.renameSync(tmpRegPath, regPath);

		return {
			success: true,
			message: `Switched active Codex account to ${target.alias || maskEmail(target.email)}`,
			account: target,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, message: `Failed to switch account: ${msg}` };
	}
}

/** Set alias for an account via codex-auth CLI */
export function setAccountAlias(query: string, alias: string): { success: boolean; message: string } {
	try {
		currentExecutor("codex-auth", ["alias", "set", query, alias], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return { success: true, message: `Alias '${alias}' set for '${query}'` };
	} catch (err: any) {
		const stderr = err?.stderr?.toString().trim() || err?.message || String(err);
		return { success: false, message: `Failed to set alias: ${stderr}` };
	}
}

/** Clear alias for an account via codex-auth CLI */
export function clearAccountAlias(query: string): { success: boolean; message: string } {
	try {
		currentExecutor("codex-auth", ["alias", "clear", query], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return { success: true, message: `Alias cleared for '${query}'` };
	} catch (err: any) {
		const stderr = err?.stderr?.toString().trim() || err?.message || String(err);
		return { success: false, message: `Failed to clear alias: ${stderr}` };
	}
}
