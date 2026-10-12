import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Marked, type Tokens } from "marked";

/**
 * A shell command recovered from the session's recent replies: a labeled
 * fenced block in assistant text.
 */
export interface ShellCommand {
	/** Unique provenance id `<session entry id>:<per-entry counter>`; duplicates keep distinct ids. */
	id: string;
	/** Verbatim command text. Multiline content stays intact; `$` markers are never stripped. */
	text: string;
	/** Lowercased first word of the fence info string. */
	language: string;
	/** 0-based index of the assistant reply within the newest-first scan (0 = newest reply). */
	reply: number;
}

/** Number of most recent assistant replies scanned on the current branch. */
export const MAX_COMMAND_REPLIES = 10;

const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh"]);

/** Isolated parser; extraction never mutates marked's package-global default. */
const parser = new Marked();

/** First whitespace-delimited word of a fence info string, lowercased; "" when unlabeled. */
function fenceLanguage(info: string | undefined): string {
	return info?.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
}

/**
 * True when the fenced block was closed in its markdown, per CommonMark: a
 * later line with the same fence character, at least as many of them, at most
 * three spaces of indent, and nothing but blanks after. Marked ends the token
 * at the first such line, so any match means closed; streaming or truncated
 * fences that never close stay out of the results.
 */
function isClosedFence(token: Tokens.Code): boolean {
	const lines = token.raw.split("\n");
	const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
	if (!opener) return false;
	const marker = opener[1]!;
	const closer = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*$`);
	return lines.slice(1).some((line) => closer.test(line));
}

/** Closed shell-labeled fenced blocks of one markdown text, in document order. */
function fenceCommands(markdown: string): { language: string; text: string }[] {
	const hits: { language: string; text: string }[] = [];
	parser.walkTokens(parser.lexer(markdown), (token) => {
		// Tokens.Generic shares `type: string`, so the literal check cannot narrow.
		if (token.type !== "code") return;
		const code = token as Tokens.Code;
		const language = fenceLanguage(code.lang);
		if (!SHELL_LANGUAGES.has(language) || !isClosedFence(code) || !code.text.trim()) return;
		hits.push({ language, text: code.text });
	});
	return hits;
}

/**
 * Collect shell commands from the current branch's most recent assistant
 * replies, newest reply first. Up to {@link MAX_COMMAND_REPLIES} assistant
 * messages are scanned (other entry types take no slot); replies that ended
 * `error` or `aborted` contribute nothing but keep their reply index. Only
 * closed `bash`/`sh`/`shell`/`zsh` fences in assistant text are returned;
 * thinking, tool calls, tool results, and user text are ignored.
 */
export function collectShellCommands(entries: readonly SessionEntry[]): ShellCommand[] {
	// The caller supplies ctx.sessionManager.getBranch(), not the complete session tree.
	const commands: ShellCommand[] = [];
	let taken = 0;
	for (let i = entries.length - 1; i >= 0 && taken < MAX_COMMAND_REPLIES; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const reply = taken++;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		let perEntry = 0;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			for (const { language, text } of fenceCommands(part.text)) {
				commands.push({ id: `${entry.id}:${perEntry++}`, text, language, reply });
			}
		}
	}
	return commands;
}
