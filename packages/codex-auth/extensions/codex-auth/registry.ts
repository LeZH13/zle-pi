import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexAccount, CodexAuthFile, CodexRegistry } from "./types.js";

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

/** Find an account matching query or key */
export function findAccount(registry: CodexRegistry, query: string): CodexAccount | null {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return null;

	for (const acc of registry.accounts) {
		if (acc.account_key === query) return acc;
		if (acc.alias && acc.alias.toLowerCase() === normalized) return acc;
		if (acc.email && acc.email.toLowerCase().includes(normalized)) return acc;
		if (acc.chatgpt_account_id && acc.chatgpt_account_id.toLowerCase().startsWith(normalized)) return acc;
	}
	return null;
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

	// 1. Try invoking codex-auth CLI first
	try {
		const stdout = execFileSync("codex-auth", ["switch", selector, "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		const result = JSON.parse(stdout);
		if (result && result.active_account_key) {
			const updatedRegistry = loadRegistry() || registry;
			const target = updatedRegistry.accounts.find((a) => a.account_key === result.active_account_key);
			return {
				success: true,
				message: `Switched active Codex account to ${target?.alias || maskEmail(target?.email)}`,
				account: target,
			};
		}
	} catch {
		// Fallback to direct snapshot switch if CLI is unavailable or failed
	}

	// 2. Direct snapshot switch fallback
	const target = findAccount(registry, selector);
	if (!target) {
		return { success: false, message: `Account matching '${selector}' not found` };
	}

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

		// Update registry.json active account key
		registry.active_account_key = target.account_key;
		registry.active_account_activated_at_ms = Date.now();
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
