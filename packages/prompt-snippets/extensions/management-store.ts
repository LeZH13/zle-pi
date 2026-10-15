/**
 * Storage helpers for writable prompt snippets (global and project scopes).
 *
 * Bundled snippets are never written: mutations refuse symlinks (directories
 * and files) and refuse any target resolving inside the bundled snippets
 * directory. `expected` is the exact prior raw content from `readSnapshot`
 * (`null` = create only); a mismatched snapshot fails instead of clobbering
 * concurrent changes. Every check/write window runs inside
 * `withFileMutationQueue`, which serializes operations on the same file.
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseSnippet, resolveBundledSnippetsDir } from "./loader.js";
import type { LoadSnippetsOptions, SnippetPlacement } from "./types.js";

/** Scopes that may be written. Bundled snippets are read-only. */
export type WritableScope = "global" | "project";

/** A complete snippet definition as produced by editor UIs. */
export interface SnippetDraft {
	/** Filename identifier, must be a safe basename ending in .md */
	id: string;
	/** Display name (single line, non-empty) */
	name: string;
	/** Short description shown in menu (single line, may be empty) */
	description: string;
	/** Placement before or after user message */
	placement: SnippetPlacement;
	/** Sort order within placement group (safe integer) */
	order: number;
	/** Prompt content inserted into message (non-empty) */
	body: string;
}

/** Tombstone frontmatter written by hideSnippet; the loader parses it as disabled. */
const TOMBSTONE_RAW = "---\ndisabled: true\n---\n";

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

interface NormalizedDraft {
	id: string;
	name: string;
	description: string;
	placement: SnippetPlacement;
	order: number;
	body: string;
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Resolve `<agentDir>/snippets` or `<cwd>/.pi/snippets`; project needs a trusted cwd. */
export function snippetDirectory(options: LoadSnippetsOptions, scope: WritableScope): string {
	if (scope !== "global" && scope !== "project") {
		throw new Error(`Unknown writable snippet scope: ${String(scope)}`);
	}
	if (scope === "global") {
		let agentDir: string;
		try {
			agentDir = options.agentDir ?? getAgentDir();
		} catch {
			agentDir = options.agentDir ?? join(process.env.HOME || "", ".pi", "agent");
		}
		return join(agentDir, "snippets");
	}
	if (!options.cwd) {
		throw new Error("Project snippets require a working directory (options.cwd)");
	}
	if (options.isProjectTrusted === false) {
		throw new Error("Project snippets are unavailable because this project is not trusted");
	}
	return join(options.cwd, CONFIG_DIR_NAME || ".pi", "snippets");
}

/** Exact raw content of a snippet file, or `null` only for ENOENT. Refuses symlinks. */
export function readSnapshot(path: string): string | null {
	let stats: Stats;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`Refusing to read a symlink: ${path}`);
	}
	if (!stats.isFile()) {
		throw new Error(`Snippet path is not a regular file: ${path}`);
	}
	return readFileSync(path, "utf-8");
}

/** Create (`expected: null`) or replace (`expected: prior raw`) a snippet file. */
export async function saveSnippet(
	options: LoadSnippetsOptions,
	scope: WritableScope,
	draft: SnippetDraft,
	expected: string | null,
): Promise<void> {
	if (expected !== null && typeof expected !== "string") {
		throw new Error("expected must be null (create only) or the exact prior raw file content");
	}
	const normalized = normalizeDraft(draft);
	const raw = serializeSnippet(normalized);
	verifyRoundTrip(normalized, raw, scope);
	const dir = snippetDirectory(options, scope);
	const filePath = join(dir, normalized.id);
	await withFileMutationQueue(filePath, async () => {
		assertWritableSnippetDirectory(dir, options, true);
		const current = readSnapshot(filePath);
		if (expected === null) {
			if (current !== null) {
				throw new Error(
					`Snippet already exists: ${normalized.id}. Pass its current content as expected to replace it.`,
				);
			}
		} else if (current === null) {
			throw new Error(`Snippet was removed before this save (stale expected content): ${normalized.id}`);
		} else if (current !== expected) {
			throw new Error(`Snippet changed since it was read (stale expected content): ${normalized.id}`);
		}
		writeFileSync(filePath, raw, "utf-8");
	});
}

/** Delete a snippet file; the exact prior raw content is required. */
export async function deleteSnippet(
	options: LoadSnippetsOptions,
	scope: WritableScope,
	id: string,
	expected: string,
): Promise<void> {
	if (typeof expected !== "string") {
		throw new Error("deleteSnippet requires the exact prior raw file content as expected");
	}
	const validatedId = validateSnippetId(id);
	const dir = snippetDirectory(options, scope);
	const filePath = join(dir, validatedId);
	await withFileMutationQueue(filePath, async () => {
		assertWritableSnippetDirectory(dir, options, false);
		const current = readSnapshot(filePath);
		if (current === null) {
			throw new Error(`Snippet not found: ${validatedId}`);
		}
		if (current !== expected) {
			throw new Error(`Snippet changed since it was read (stale expected content): ${validatedId}`);
		}
		unlinkSync(filePath);
	});
}

/**
 * Replace a snippet file with a `disabled: true` tombstone in a writable
 * scope. Hiding a bundled snippet writes the tombstone under the bundled
 * filename in the global/project scope, which makes the loader skip it; the
 * bundled directory is never touched. Reveal with `deleteSnippet` or
 * `saveSnippet` using the tombstone content as `expected`.
 */
export async function hideSnippet(
	options: LoadSnippetsOptions,
	scope: WritableScope,
	id: string,
	expected: string | null,
): Promise<void> {
	if (expected !== null && typeof expected !== "string") {
		throw new Error("expected must be null (create only) or the exact prior raw file content");
	}
	const validatedId = validateSnippetId(id);
	const dir = snippetDirectory(options, scope);
	const filePath = join(dir, validatedId);
	await withFileMutationQueue(filePath, async () => {
		assertWritableSnippetDirectory(dir, options, true);
		const current = readSnapshot(filePath);
		if (expected === null) {
			if (current !== null) {
				throw new Error(
					`File already exists: ${validatedId}. Pass its current content as expected to replace it with a disable tombstone.`,
				);
			}
		} else if (current === null) {
			throw new Error(`Snippet was removed before this change (stale expected content): ${validatedId}`);
		} else if (current !== expected) {
			throw new Error(`Snippet changed since it was read (stale expected content): ${validatedId}`);
		}
		writeFileSync(filePath, TOMBSTONE_RAW, "utf-8");
	});
}

function validateSnippetId(id: unknown): string {
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Snippet filename must be a non-empty string");
	}
	if (id.length > 200) {
		throw new Error(`Snippet filename is too long (max 200 characters): ${id}`);
	}
	if (!/\.md$/i.test(id)) {
		throw new Error(`Snippet filename must end with .md: ${id}`);
	}
	if (id.startsWith(".")) {
		throw new Error(`Snippet filename must not start with a dot: ${id}`);
	}
	if (/[/\\:]/.test(id)) {
		throw new Error(`Snippet filename must be a plain basename without path separators: ${id}`);
	}
	if (/[\0-\x1f]/.test(id)) {
		throw new Error(`Snippet filename must not contain control characters: ${JSON.stringify(id)}`);
	}
	return id;
}

function singleLineField(value: unknown, field: string, required: boolean): string {
	if (typeof value !== "string") {
		throw new Error(`Snippet ${field} must be a string`);
	}
	if (LINE_TERMINATOR.test(value)) {
		throw new Error(`Snippet ${field} must be a single line`);
	}
	const trimmed = value.trim();
	if (required && !trimmed) {
		throw new Error(`Snippet ${field} must be a non-empty string`);
	}
	return trimmed;
}

function normalizeDraft(draft: SnippetDraft): NormalizedDraft {
	if (!draft || typeof draft !== "object") {
		throw new Error("Snippet draft must be an object");
	}
	const id = validateSnippetId(draft.id);
	const name = singleLineField(draft.name, "name", true);
	const description = singleLineField(draft.description, "description", false);
	if (draft.placement !== "prepend" && draft.placement !== "append") {
		throw new Error(`Snippet placement must be "prepend" or "append", got: ${String(draft.placement)}`);
	}
	if (!Number.isSafeInteger(draft.order)) {
		throw new Error(`Snippet order must be a safe integer, got: ${String(draft.order)}`);
	}
	const body = typeof draft.body === "string" ? draft.body.trim() : "";
	if (!body) {
		throw new Error("Snippet body must be a non-empty string");
	}
	return { id, name, description, placement: draft.placement, order: draft.order, body };
}

/**
 * Encode a frontmatter value so the loader's `key: value` parser (which trims
 * the value and strips one leading and one trailing quote) returns it
 * unchanged: values that start or end with a quote are wrapped in an extra
 * pair of double quotes.
 */
function encodeFrontmatterValue(value: string): string {
	if (value === "") return "";
	if (/^["']/.test(value) || /["']$/.test(value)) return `"${value}"`;
	return value;
}

function serializeSnippet(draft: NormalizedDraft): string {
	return [
		"---",
		`name: ${encodeFrontmatterValue(draft.name)}`,
		`description: ${encodeFrontmatterValue(draft.description)}`,
		`placement: ${draft.placement}`,
		`order: ${draft.order}`,
		"---",
		draft.body,
		"",
	].join("\n");
}

/** Fail unless the serialized raw parses back to exactly the drafted fields. */
function verifyRoundTrip(draft: NormalizedDraft, raw: string, scope: WritableScope): void {
	const { snippet, disabled } = parseSnippet(draft.id, raw, scope, "");
	const parsed = disabled ? null : snippet;
	if (!parsed) {
		throw new Error(`Serialized snippet ${draft.id} does not parse as an enabled snippet`);
	}
	if (
		parsed.name !== draft.name ||
		parsed.description !== draft.description ||
		parsed.placement !== draft.placement ||
		parsed.order !== draft.order ||
		parsed.body !== draft.body
	) {
		throw new Error(`Serialized frontmatter for ${draft.id} would not round-trip through the snippet loader`);
	}
}

function isSameOrInside(candidate: string, parent: string): boolean {
	if (candidate === parent) return true;
	const rel = relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Ensure the snippet directory is writable: refuse symlink directories and
 * non-directories, and refuse any target resolving inside the bundled
 * snippets directory. Checks run against the deepest existing ancestor so
 * they happen before any directory is created.
 */
function assertWritableSnippetDirectory(dir: string, options: LoadSnippetsOptions, create: boolean): void {
	let probe = dir;
	let stats: Stats | undefined;
	for (;;) {
		try {
			stats = lstatSync(probe);
			break;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
	}

	if (stats && probe === dir && stats.isSymbolicLink()) {
		throw new Error(`Refusing to write snippets through a symlink directory: ${dir}`);
	}
	if (stats && probe === dir && !stats.isDirectory()) {
		throw new Error(`Snippet directory path is not a directory: ${dir}`);
	}

	const bundledDir = resolveBundledSnippetsDir(options.bundledDir);
	if (stats && bundledDir) {
		const bundledReal = realpathSync(bundledDir);
		const resolved = realpathSync(probe);
		if (isSameOrInside(resolved, bundledReal)) {
			throw new Error(`Refusing to modify bundled snippets via ${dir}`);
		}
	}

	if (create && (!stats || probe !== dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
