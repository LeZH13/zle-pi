import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LoadSnippetsOptions, Snippet, SnippetConfig, SnippetSource } from "./types.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

/**
 * Parse frontmatter and body from a snippet markdown file.
 */
export function parseSnippet(
	filename: string,
	raw: string,
	source: SnippetSource,
	filePath: string,
): { snippet: Snippet | null; disabled: boolean } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { snippet: null, disabled: false };

	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}

	const disabled =
		meta.disabled === "true" ||
		meta.disabled === "yes" ||
		meta.disabled === "1" ||
		meta.enabled === "false" ||
		meta.enabled === "no" ||
		meta.enabled === "0";

	if (disabled) {
		return { snippet: null, disabled: true };
	}

	const body = match[2].trim();
	if (!body) {
		return { snippet: null, disabled: false };
	}

	const parsedOrder = Number.parseInt(meta.order ?? "", 10);
	return {
		snippet: {
			id: filename,
			name: meta.name || filename.replace(/\.md$/i, ""),
			description: meta.description ?? "",
			placement: meta.placement === "prepend" ? "prepend" : "append",
			order: Number.isFinite(parsedOrder) ? parsedOrder : 9999,
			body,
			source,
			filePath,
		},
		disabled: false,
	};
}

/**
 * Load optional prompt-snippets.json config from a directory.
 */
export function loadSnippetConfigFile(configPath: string): SnippetConfig | null {
	if (!existsSync(configPath)) return null;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return {
				disabled: Array.isArray(parsed.disabled) ? parsed.disabled.map(String) : undefined,
			};
		}
	} catch {
		// Ignore corrupt or unreadable config files
	}
	return null;
}

/**
 * Resolve the directory where bundled default snippets live.
 */
export function resolveBundledSnippetsDir(customDir?: string): string | null {
	if (customDir && existsSync(customDir)) {
		return customDir;
	}
	const candidate1 = join(extensionDir, "snippets");
	if (existsSync(candidate1)) return candidate1;

	const candidate2 = join(extensionDir, "..", "snippets");
	if (existsSync(candidate2)) return candidate2;

	return null;
}

/**
 * Load snippets from a single directory.
 */
export function scanSnippetDirectory(
	dir: string,
	source: SnippetSource,
): { snippets: Snippet[]; disabledIds: Set<string> } {
	const snippets: Snippet[] = [];
	const disabledIds = new Set<string>();

	if (!existsSync(dir)) {
		return { snippets, disabledIds };
	}

	try {
		for (const file of readdirSync(dir)) {
			if (!file.toLowerCase().endsWith(".md")) continue;
			const fullPath = join(dir, file);
			try {
				const content = readFileSync(fullPath, "utf-8");
				const { snippet, disabled } = parseSnippet(file, content, source, fullPath);
				if (disabled) {
					disabledIds.add(file);
				} else if (snippet) {
					snippets.push(snippet);
				}
			} catch {
				// Skip unreadable files
			}
		}
	} catch {
		// Skip unreadable directories
	}

	return { snippets, disabledIds };
}

/**
 * Load all snippets hierarchically:
 * 1. Bundled defaults (<package>/snippets)
 * 2. Global user snippets (~/.pi/agent/snippets)
 * 3. Project snippets (<cwd>/.pi/snippets)
 *
 * Snippets with the same filename override lower-priority ones.
 * Snippets can be disabled via frontmatter (`disabled: true`) or in prompt-snippets.json.
 */
export function loadSnippets(options: LoadSnippetsOptions = {}): Snippet[] {
	const map = new Map<string, Snippet>();
	const disabledConfigs = new Set<string>();

	// 1. Bundled defaults
	const bundledDir = resolveBundledSnippetsDir(options.bundledDir);
	if (bundledDir) {
		const { snippets, disabledIds } = scanSnippetDirectory(bundledDir, "bundled");
		for (const id of disabledIds) map.delete(id);
		for (const s of snippets) map.set(s.id, s);
	}

	// 2. Global snippets & config (~/.pi/agent)
	let agentDir: string;
	try {
		agentDir = options.agentDir ?? getAgentDir();
	} catch {
		agentDir = options.agentDir ?? join(process.env.HOME || "", ".pi", "agent");
	}

	if (agentDir) {
		const globalSnippetsDir = join(agentDir, "snippets");
		const { snippets, disabledIds } = scanSnippetDirectory(globalSnippetsDir, "global");
		for (const id of disabledIds) map.delete(id);
		for (const s of snippets) map.set(s.id, s);

		const globalConfigFile = join(agentDir, "prompt-snippets.json");
		const globalConfig = loadSnippetConfigFile(globalConfigFile);
		if (globalConfig?.disabled) {
			for (const id of globalConfig.disabled) disabledConfigs.add(id);
		}
	}

	// 3. Project snippets & config (<cwd>/.pi)
	const isTrusted = options.isProjectTrusted !== false;
	if (options.cwd && isTrusted) {
		const configDirName = CONFIG_DIR_NAME || ".pi";
		const projectSnippetsDir = join(options.cwd, configDirName, "snippets");
		const { snippets, disabledIds } = scanSnippetDirectory(projectSnippetsDir, "project");
		for (const id of disabledIds) map.delete(id);
		for (const s of snippets) map.set(s.id, s);

		const projectConfigFile = join(options.cwd, configDirName, "prompt-snippets.json");
		const projectConfig = loadSnippetConfigFile(projectConfigFile);
		if (projectConfig?.disabled) {
			for (const id of projectConfig.disabled) disabledConfigs.add(id);
		}
	}

	// Filter out explicitly disabled snippet IDs/names from configuration
	let result = Array.from(map.values()).filter((s) => {
		const idWithoutExt = s.id.replace(/\.md$/i, "");
		return (
			!disabledConfigs.has(s.id) &&
			!disabledConfigs.has(idWithoutExt) &&
			!disabledConfigs.has(s.name)
		);
	});

	const byOrder = (a: Snippet, b: Snippet) =>
		a.order - b.order || a.name.localeCompare(b.name);

	return [
		...result.filter((s) => s.placement === "prepend").sort(byOrder),
		...result.filter((s) => s.placement === "append").sort(byOrder),
	];
}
