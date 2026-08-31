import fs from "node:fs";
import path from "node:path";
import { getCodexAuthJsonPath, getCodexHome, getPiAuthJsonPath, loadCodexAuth } from "./registry.js";
import type { CodexAuthFile, PiAuthStore, PiOAuthCredential } from "./types.js";

/** Safely read Pi auth.json */
export function loadPiAuth(): PiAuthStore {
	const p = getPiAuthJsonPath();
	if (!fs.existsSync(p)) return {};
	try {
		const raw = fs.readFileSync(p, "utf8");
		return JSON.parse(raw) as PiAuthStore;
	} catch {
		return {};
	}
}

/** Safely write Pi auth.json atomically */
export function savePiAuth(auth: PiAuthStore): void {
	const p = getPiAuthJsonPath();
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tmpPath = `${p}.tmp.${Date.now()}`;
	fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
	fs.renameSync(tmpPath, p);
}

/**
 * Synchronize credentials from ~/.codex/auth.json into ~/.pi/agent/auth.json
 * Returns true if Pi's auth was updated or changed.
 */
export function syncCodexToPi(): { changed: boolean; accountId?: string } {
	const codexAuth = loadCodexAuth();
	if (!codexAuth || !codexAuth.tokens) {
		return { changed: false };
	}

	const { access_token, refresh_token, account_id } = codexAuth.tokens;
	if (!access_token || !refresh_token || !account_id) {
		return { changed: false };
	}

	const piAuth = loadPiAuth();
	const existing = piAuth["openai-codex"] as PiOAuthCredential | undefined;

	// Check if already in sync
	if (
		existing &&
		existing.type === "oauth" &&
		existing.access === access_token &&
		existing.refresh === refresh_token &&
		existing.accountId === account_id
	) {
		return { changed: false, accountId: account_id };
	}

	// Update Pi auth.json
	piAuth["openai-codex"] = {
		type: "oauth",
		access: access_token,
		refresh: refresh_token,
		expires: Date.now() + 3600 * 1000,
		accountId: account_id,
	};

	savePiAuth(piAuth);
	return { changed: true, accountId: account_id };
}

/**
 * Bi-directional sync: If Pi refreshed tokens in ~/.pi/agent/auth.json,
 * write the updated tokens back to ~/.codex/auth.json and its managed snapshot.
 */
export function syncPiToCodex(): { changed: boolean } {
	const piAuth = loadPiAuth();
	const piCodex = piAuth["openai-codex"] as PiOAuthCredential | undefined;
	if (!piCodex || piCodex.type !== "oauth" || !piCodex.access || !piCodex.refresh || !piCodex.accountId) {
		return { changed: false };
	}

	const codexAuth = loadCodexAuth();
	if (
		codexAuth &&
		codexAuth.tokens &&
		codexAuth.tokens.access_token === piCodex.access &&
		codexAuth.tokens.refresh_token === piCodex.refresh &&
		codexAuth.tokens.account_id === piCodex.accountId
	) {
		return { changed: false };
	}

	// Update ~/.codex/auth.json
	const updatedCodexAuth: CodexAuthFile = {
		auth_mode: codexAuth?.auth_mode || "chatgpt",
		OPENAI_API_KEY: codexAuth?.OPENAI_API_KEY ?? null,
		tokens: {
			id_token: codexAuth?.tokens?.id_token || "",
			access_token: piCodex.access,
			refresh_token: piCodex.refresh,
			account_id: piCodex.accountId,
		},
		last_refresh: new Date().toISOString(),
	};

	try {
		const targetPath = getCodexAuthJsonPath();
		const tmp = `${targetPath}.tmp.${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(updatedCodexAuth, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, targetPath);

		// Also update the account snapshot file under ~/.codex/accounts/
		const accountsDir = path.join(getCodexHome(), "accounts");
		if (fs.existsSync(accountsDir)) {
			const candidateFiles = fs.readdirSync(accountsDir).filter((f) => f.endsWith(".auth.json"));
			for (const file of candidateFiles) {
				const fullPath = path.join(accountsDir, file);
				try {
					const snap = JSON.parse(fs.readFileSync(fullPath, "utf8")) as CodexAuthFile;
					if (snap.tokens?.account_id === piCodex.accountId) {
						snap.tokens.access_token = piCodex.access;
						snap.tokens.refresh_token = piCodex.refresh;
						snap.last_refresh = updatedCodexAuth.last_refresh;
						const snapTmp = `${fullPath}.tmp.${Date.now()}`;
						fs.writeFileSync(snapTmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
						fs.renameSync(snapTmp, fullPath);
					}
				} catch {
					// Ignore invalid snapshot files
				}
			}
		}

		return { changed: true };
	} catch {
		return { changed: false };
	}
}

/**
 * Watch ~/.codex/auth.json and registry.json for external changes (e.g. `codex-auth switch`)
 */
export function setupCodexAuthWatcher(onChanged: () => void): () => void {
	const codexHome = getCodexHome();
	const authPath = getCodexAuthJsonPath();
	const registryPath = path.join(codexHome, "accounts", "registry.json");

	let debounceTimer: NodeJS.Timeout | null = null;
	const trigger = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			onChanged();
		}, 250);
	};

	const watchers: fs.FSWatcher[] = [];

	try {
		if (fs.existsSync(authPath)) {
			watchers.push(fs.watch(authPath, trigger));
		}
	} catch {
		// Ignore watch errors on platforms with restrictive file locking
	}

	try {
		if (fs.existsSync(registryPath)) {
			watchers.push(fs.watch(registryPath, trigger));
		}
	} catch {
		// Ignore watch errors
	}

	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				// Ignore
			}
		}
		watchers.length = 0;
	};
}
