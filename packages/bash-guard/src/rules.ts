/**
 * The risky-command rule table and the command tokenizer.
 *
 * The tokenizer splits a bash command string into leaf "script" strings
 * (compound separators, command substitutions, backticks, `bash -c` / `eval`
 * payloads) and tokenizes each leaf with shell-quote, so rules always match in
 * command position. A quoted `echo "rm -rf /"` therefore does not match, while
 * `bash -c 'rm -rf /'` does.
 *
 * Matching is deliberately lenient: the table names recognizable destructive
 * shapes, Jev (or the user) decides whether a match is actually dangerous.
 */
import { parse } from "shell-quote";

/** A curated built-in risky pattern. */
export interface RiskyRule {
	/** Stable identifier, shown in reasons and usable in allow-pattern notes. */
	id: string;
	/** Human-readable description used in block reasons and dialogs. */
	description: string;
	/** Tested against the basename of argv[0]. */
	command: RegExp;
	/** When set, tested against argv[1] (the subcommand, e.g. `push` for git). */
	sub?: RegExp;
	/** Tested against the remaining argv joined with spaces. */
	args: RegExp;
	/** When set, tested against unquoted glob arguments only (quoting provenance). */
	globs?: RegExp;
}

export const RISKY_RULES: readonly RiskyRule[] = [
	{
		id: "rm-recursive-force-glob",
		description: "rm with recursive/force flags or a glob target",
		command: /^rm$/,
		args: /(^|\s)-[a-zA-Z]*[rRf]|--recursive\b|--force\b/,
		// Quoting provenance: only unquoted globs become shell-quote glob tokens,
		// so `rm 'literal*file'` is not flagged.
		globs: /[*?]/,
	},
	{
		id: "git-reset-hard",
		description: "git reset --hard discards uncommitted changes",
		command: /^git$/,
		sub: /^reset$/,
		args: /(^|\s)--hard\b/,
	},
	{
		id: "git-push-force",
		description: "force push / branch deletion on a remote",
		command: /^git$/,
		sub: /^push$/,
		// `git push origin +main` forces a ref update just as `--force` does.
		args: /--force\b|--force-with-lease\b|--delete\b|(^|\s)[+:][^\s]+|(^|\s)-f\b/,
	},
	{
		id: "git-clean-force",
		description: "git clean -f removes untracked files",
		command: /^git$/,
		sub: /^clean$/,
		// -n / --dry-run make any force flag a dry run; flag clusters containing
		// n (e.g. -nf, -dn) are excluded before the force flag is searched for.
		args: /^(?![\s\S]*(?:^|\s)-[a-zA-Z]*n[a-zA-Z]*(?![a-zA-Z])|[\s\S]*--dry-run\b)[\s\S]*(?:^|\s)-[a-zA-Z]*f|--force\b/,
	},
	{
		id: "git-checkout-paths",
		description: "git checkout -- discards working-tree changes",
		command: /^git$/,
		sub: /^checkout$/,
		args: /(^|\s)--(\s|$)|^--$|(^|\s)\.(\s|$)|^\.$/,
	},
	{
		id: "git-restore-paths",
		description: "git restore discards working-tree changes",
		command: /^git$/,
		sub: /^restore$/,
		args: /^(?![\s\S]*--staged\b)[\s\S]/,
	},
	{
		id: "git-branch-force-delete",
		description: "git branch -D force-deletes a branch",
		command: /^git$/,
		sub: /^branch$/,
		args: /(^|\s)-[a-zA-Z]*D/,
	},
	{
		id: "git-stash-drop-clear",
		description: "git stash drop/clear discards stashes",
		command: /^git$/,
		sub: /^stash$/,
		args: /^(drop|clear)\b/,
	},
	{
		id: "git-filter-branch",
		description: "git filter-branch/filter-repo rewrites history",
		command: /^git$/,
		sub: /^(filter-branch|filter-repo)$/,
		args: /^/,
	},
	{
		id: "git-reflog-expire",
		description: "git reflog expire discards the recovery trail",
		command: /^git$/,
		sub: /^reflog$/,
		args: /^expire\b/,
	},
	{
		id: "git-checkout-force",
		description: "force checkout/switch discards uncommitted changes",
		command: /^git$/,
		sub: /^(checkout|switch)$/,
		args: /(^|\s)(?:-[a-zA-Z]*f|--force)\b/,
	},
	{
		id: "dd",
		description: "dd writes raw blocks, a classic disk clobber",
		command: /^dd$/,
		args: /^/,
	},
	{
		id: "mkfs",
		description: "mkfs formats a filesystem",
		command: /^mkfs/,
		args: /^/,
	},
	{
		id: "shred",
		description: "shred overwrites file contents in place",
		command: /^shred$/,
		args: /^/,
	},
	{
		id: "wipefs",
		description: "wipefs erases filesystem signatures",
		command: /^wipefs$/,
		args: /^/,
	},
	{
		id: "truncate",
		description: "truncate resizes files, destroying contents",
		command: /^truncate$/,
		args: /^/,
	},
	{
		id: "find-delete-exec-rm",
		description: "find -delete / -exec rm deletes matched paths",
		command: /^find$/,
		args: /(^|\s)-delete\b|(^|\s)-exec(dir)?\s+\S*rm\b/,
	},
	{
		id: "sql-drop-truncate",
		description: "SQL client runs DROP/TRUNCATE",
		command: /^(psql|mysql)$/,
		args: /(?:^|\s)-(?:c|e)(?:\s|=)[\s\S]*\b(?:DROP|TRUNCATE)\b/,
	},
	{
		id: "sql-delete-no-where",
		description: "SQL client runs DELETE without WHERE",
		command: /^(psql|mysql)$/,
		args: /(?:^|\s)-(?:c|e)(?:\s|=)[\s\S]*\bDELETE\b(?![\s\S]*\bWHERE\b)/,
	},
	{
		id: "sqlite-destructive",
		description: "sqlite3 runs DROP/TRUNCATE/DELETE-without-WHERE",
		command: /^sqlite3$/,
		args: /\b(?:DROP|TRUNCATE)\b|\bDELETE\b(?![\s\S]*\bWHERE\b)/,
	},
	{
		id: "terraform-destroy",
		description: "terraform destroy tears down managed infrastructure",
		command: /^terraform$/,
		sub: /^destroy$/,
		args: /^/,
	},
	{
		id: "terraform-apply-auto-approve",
		description: "terraform apply -auto-approve applies without confirmation",
		command: /^terraform$/,
		sub: /^apply$/,
		args: /-auto-approve\b/,
	},
	{
		id: "kubectl-delete",
		description: "kubectl delete removes cluster resources",
		command: /^kubectl$/,
		sub: /^delete$/,
		args: /^/,
	},
	{
		id: "docker-rm",
		description: "docker rm/rmi removes containers or images",
		command: /^docker$/,
		sub: /^(rm|rmi)$/,
		args: /^/,
	},
	{
		id: "docker-volume-rm",
		description: "docker volume rm removes volumes",
		command: /^docker$/,
		sub: /^volume$/,
		args: /^rm\b/,
	},
	{
		id: "docker-system-prune",
		description: "docker system prune removes unused objects",
		command: /^docker$/,
		sub: /^system$/,
		args: /^prune\b/,
	},
	{
		id: "chmod-recursive",
		description: "chmod -R changes permissions recursively",
		command: /^chmod$/,
		args: /(^|\s)-[a-zA-Z]*R\b|--recursive\b/,
	},
	{
		id: "chown-recursive",
		description: "chown -R changes ownership recursively",
		command: /^chown$/,
		args: /(^|\s)-[a-zA-Z]*R\b|--recursive\b/,
	},
	{
		id: "npm-unpublish",
		description: "npm unpublish removes a published package version",
		command: /^npm$/,
		sub: /^unpublish$/,
		args: /^/,
	},
	{
		id: "gh-repo-delete",
		description: "gh repo delete removes a GitHub repository",
		command: /^gh$/,
		sub: /^repo$/,
		args: /^delete\b/,
	},
	{
		id: "aws-s3-rm-recursive",
		description: "aws s3 rm --recursive deletes many objects",
		command: /^aws$/,
		sub: /^s3$/,
		args: /^rm\b[\s\S]*(--recursive\b|\s-r\b)/,
	},
	{
		id: "aws-s3-rb",
		description: "aws s3 rb deletes an S3 bucket",
		command: /^aws$/,
		sub: /^s3$/,
		args: /^rb\b/,
	},
	{
		id: "rsync-delete",
		description: "rsync --delete removes files absent from the source",
		command: /^rsync$/,
		args: /(^|\s)--delete(?:-\w+)?\b|(^|\s)--remove-source-files\b/,
	},
	{
		id: "docker-compose-down-volumes",
		description: "docker compose down -v destroys named volumes",
		// Covers both the plugin (`docker compose down -v`) and the standalone
		// binary (`docker-compose down -v`).
		command: /^docker(-compose)?$/,
		args: /^(?:compose\s+)?down\b[\s\S]*(?:(^|\s)-[a-zA-Z]*v\b|--volumes\b)/,
	},
	{
		id: "helm-uninstall",
		description: "helm uninstall removes a release and its resources",
		command: /^helm$/,
		sub: /^(uninstall|del|delete)$/,
		args: /^/,
	},
	{
		id: "psql-file",
		description: "psql -f runs a script file, which the guard cannot inspect",
		// Only psql spells the file flag `-f`; for mysql `-f` means --force.
		command: /^psql$/,
		args: /(^|\s)(?:-f|--file)[\s=]*\S/,
	},
	{
		id: "sql-client-script-file",
		description: "a SQL client runs a script file, which the guard cannot inspect",
		command: /^(mysql|sqlite3)$/,
		args: /(^|\s)--file[\s=]*\S|(^|\s)\.read\b/,
	},
];

/** One rule match on one leaf segment of the command. */
export interface RiskyMatch {
	ruleId: string;
	description: string;
	/** The leaf script text the rule matched. */
	segment: string;
}

/** Compile user-configured regex strings; skip (and report) invalid ones. */
export function compilePatterns(patterns: readonly string[], onError?: (source: string, error: string) => void): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of patterns) {
		try {
			compiled.push(new RegExp(source));
		} catch (error) {
			onError?.(source, error instanceof Error ? error.message : String(error));
		}
	}
	return compiled;
}

/** Shell interpreters whose `-c` argument is a script. */
const SHELL_INTERPRETERS = /^(bash|sh|zsh|dash|ksh)$/;

/** Cap recursion so pathological nesting cannot loop the matcher. */
const MAX_DEPTH = 8;

/** Maximum leaves inspected for one command. */
const MAX_LEAVES = 64;

/**
 * Control keywords that may prefix a command word-list (from `if`, `while`,
 * brace groups, and negation). Stripped before matching so `if true; then
 * rm -rf /x; fi` reaches the rm rule.
 */
const CONTROL_KEYWORDS = new Set([
	"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "in", "!", "{", "}",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** sudo/doas flags whose next word is their value. */
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-p", "-C", "-D", "-R", "-T"]);

/** xargs flags whose next word is their value. */
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-s", "-d", "-E", "-L", "-a", "-S", "-p"]);

/** Skip a leading run of option tokens; returns the index of the first non-option. */
function skipOptions(words: string[], start: number, valueFlags: Set<string> = new Set()): number {
	let i = start;
	while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
		if (words[i] === "--") return i + 1;
		if (valueFlags.has(words[i])) i += 2;
		else i++;
	}
	return i;
}

/**
 * Unwrap one command wrapper (sudo, env, timeout, xargs, ...) by returning the
 * words from the wrapped command onward, or undefined when the head is not a
 * wrapper (or nothing is left to match).
 */
function unwrapWrapper(words: string[]): string[] | undefined {
	if (words.length === 0) return undefined;
	const head = basename(words[0]);
	switch (head) {
		case "sudo":
		case "doas": {
			const i = skipOptions(words, 1, SUDO_VALUE_FLAGS);
			return i < words.length ? words.slice(i) : undefined;
		}
		case "env": {
			let i = 1;
			while (i < words.length && (ASSIGNMENT.test(words[i]) || words[i].startsWith("-"))) {
				if (words[i] === "-u" || words[i] === "--unset") i += 2;
				else if (words[i] === "--") {
					i++;
					break;
				} else i++;
			}
			return i < words.length ? words.slice(i) : undefined;
		}
		case "command": {
			// `command -v cmd` only locates a command; it runs nothing.
			if (words[1] === "-v" || words[1] === "-V" || (words[1]?.startsWith("--") ?? false)) return undefined;
			return words[1] === "-p" ? words.slice(2) : words.slice(1);
		}
		case "timeout": {
			let i = skipOptions(words, 1, new Set(["-k", "-s", "--kill-after", "--signal"]));
			if (i < words.length && /^[\d.]+(?:ms|s|m|h|d)?$/.test(words[i])) i++; // duration
			return i < words.length ? words.slice(i) : undefined;
		}
		case "nice": {
			let i = 1;
			if (words[i] === "-n" || words[i] === "--adjustment") i += 2;
			else if (words[i]?.startsWith("-")) i++;
			return i < words.length ? words.slice(i) : undefined;
		}
		case "nohup":
		case "time":
		case "exec":
			return words.slice(1);
		case "xargs": {
			const i = skipOptions(words, 1, XARGS_VALUE_FLAGS);
			return i < words.length ? words.slice(i) : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Strip git global options (`-C`, `-c`, `--git-dir`, `--work-tree`, ...) so the
 * subcommand lands in argv[1]. Leading env assignments are already gone.
 */
function stripGitGlobalOptions(words: string[]): string[] {
	if (basename(words[0]) !== "git") return words;
	let i = 1;
	for (;;) {
		const w = words[i];
		if (w === undefined) break;
		if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--super-prefix") {
			i += 2;
			continue;
		}
		if (
			/^--(git-dir|work-tree|namespace|super-prefix)=/.test(w) ||
			w === "--no-pager" ||
			w === "--bare" ||
			w === "--no-replace-objects" ||
			w === "--no-optional-locks" ||
			w === "-p" ||
			w === "-P" ||
			w === "--paginate" ||
			w === "--exec-path" ||
			/^--exec-path=/.test(w)
		) {
			i++;
			continue;
		}
		if (w === "--") {
			i++;
			break;
		}
		break;
	}
	return [words[0], ...words.slice(i)];
}

/**
 * Normalize one command word-list: strip control keywords, leading env
 * assignments, command wrappers, and git global options, so the table matches
 * on the command that actually runs.
 */
function normalizeCommand(words: string[]): string[] {
	let rest = [...words];
	for (;;) {
		while (rest.length > 0 && CONTROL_KEYWORDS.has(rest[0])) rest.shift();
		while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest.shift();
		const unwrapped = unwrapWrapper(rest);
		if (unwrapped === undefined || unwrapped.length === 0) break;
		rest = unwrapped;
	}
	if (rest.length === 0) return rest;
	return stripGitGlobalOptions(rest);
}

interface Token {
	text: string;
}

function basename(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash >= 0 ? word.slice(slash + 1) : word;
}

/**
 * Quote-aware split of a raw script into lines. shell-quote treats newlines as
 * plain whitespace, which would glue `foo\nrm -rf /` into one command.
 */
function splitLines(script: string): string[] {
	const lines: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i];
		if (ch === "\\" && quote !== "'") {
			current += ch + (script[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = quote === ch ? undefined : quote === undefined ? ch : quote;
			current += ch;
			continue;
		}
		if (ch === "\n" && quote === undefined) {
			lines.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	lines.push(current);
	return lines;
}

/**
 * Quote-aware extraction of substitution bodies from one line: `$(...)`
 * (balanced parens) and backtick spans. Single quotes are literal, so
 * `echo 'literal $(rm x)'` extracts nothing; double quotes allow both, so
 * `echo "$(rm -rf /x)"` and double-quoted backticks are extracted. shell-quote
 * leaves double-quoted substitutions inside plain string tokens, so this raw
 * scan is the only reliable source for quoting provenance.
 */
function extractSubstitutions(line: string): string[] {
	const spans: string[] = [];
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = quote === undefined ? ch : quote === ch ? undefined : quote;
			continue;
		}
		if (ch === "`") {
			let body = "";
			i++;
			for (; i < line.length; i++) {
				if (line[i] === "\\" && i + 1 < line.length) {
					body += line[i] + line[i + 1];
					i++;
					continue;
				}
				if (line[i] === "`") break;
				body += line[i];
			}
			spans.push(body);
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			let depth = 0;
			let body = "";
			let j = i + 1;
			for (; j < line.length; j++) {
				const c = line[j];
				body += c;
				if (c === "(") depth++;
				else if (c === ")") {
					depth--;
					if (depth === 0) break;
				}
			}
			if (depth === 0) spans.push(body.slice(1, -1));
			i = j;
		}
	}
	return spans;
}

type ParsedToken = string | { op: string; pattern?: string; comment?: string };

function parseTokens(script: string): ParsedToken[] {
	try {
		return parse(script) as ParsedToken[];
	} catch {
		// Fall back to naive whitespace tokenization; matching then errs toward
		// flagging rather than silently allowing.
		return script.trim().split(/\s+/).filter(Boolean);
	}
}

function tokenText(token: ParsedToken): string {
	if (typeof token === "string") return token;
	if (token.op === "glob") return token.pattern ?? "";
	return "";
}

/** Separators that end one command's word list. */
const CONTROL_OPS = new Set(["&&", "||", ";", "|", "&"]);

/**
 * Redirection operators. shell-quote returns these as their own tokens; a
 * redirect ends the current command's word list and the word that follows it is
 * a target, not a command word. Both facts have to be boundaries: otherwise
 * `npm run build > /tmp/log 2>&1 && rm -rf ~` collapses into the first command
 * and the trailing `rm` is never matched.
 */
const REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>", "<", "<<", "<<<", ">&", "<&"]);

/** Redirects that write (and can therefore destroy) their target. */
const WRITE_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

/**
 * Paths whose truncation loses data. A redirect onto any of these is the same
 * damage as `truncate`, which the table already blocks.
 */
const DESTRUCTIVE_REDIRECT_TARGET = /^(?:\/dev\/(?:sd|disk|hd|nvme|vd|mmcblk|md)[a-z0-9]*|.*\.(?:db|sqlite3?|mdb)$|proc\.db)$/;

/**
 * The one rule that is not matched against a command word. `: > prod.db` and
 * `cat /dev/null > prod.db` have no destructive command at all - the redirect
 * alone truncates the file - so this fires on the target and takes its segment
 * from the line that carried the redirect.
 */
export const REDIRECT_RULE: RiskyRule = {
	id: "redirect-truncate",
	description: "a redirect truncates a database or raw device",
	command: /.*/,
	args: /^/,
};

/** One command's words plus the unquoted glob patterns it contains. */
interface CommandGroup {
	words: string[];
	globs: string[];
	/** Text of the command as the user wrote it, before redirects split it. */
	segment: string;
}

/** Group parsed tokens into one word-list per command. */
function commandsOf(tokens: ParsedToken[]): { commands: CommandGroup[]; subshells: string[]; redirects: string[] } {
	const commands: CommandGroup[] = [];
	const subshells: string[] = [];
	// Unquoted targets of write redirects, as the segment they occurred in.
	const redirects: string[] = [];
	let words: string[] = [];
	let globs: string[] = [];
	let current = "";
	const flush = () => {
		if (words.length > 0 || globs.length > 0) {
			commands.push({ words, globs, segment: current });
			words = [];
			globs = [];
		}
	};
	let depth = 0;
	let subshell: string[] = [];
	// Set after a redirect operator: the next word is that operator's target.
	// Heredocs are not modeled, so a `<<` body is still scanned as script text
	// and over-flags rather than under-flags.
	let skipTarget = false;
	let targetWrites = false;
	for (const token of tokens) {
		if (skipTarget) {
			if (typeof token === "string" || token.op === "glob") {
				if (targetWrites) redirects.push(tokenText(token));
				skipTarget = false;
				continue;
			}
		}
		if (typeof token !== "string" && token.op === "(") {
			depth++;
			if (depth > 1) subshell.push("(");
			continue;
		}
		if (typeof token !== "string" && token.op === ")") {
			depth--;
			if (depth <= 0) {
				if (depth === 0 && subshell.length > 0) subshells.push(subshell.join(" "));
				depth = 0;
				subshell = [];
			} else {
				subshell.push(")");
			}
			continue;
		}
		if (depth > 0) {
			const text = tokenText(token);
			if (text) subshell.push(text);
			else if (typeof token !== "string" && CONTROL_OPS.has(token.op)) subshell.push(token.op);
			continue;
		}
		if (typeof token === "string") {
			words.push(token);
			current += ` ${token}`;
		} else if (token.op === "glob") {
			globs.push(token.pattern ?? "");
			current += ` ${token.pattern ?? ""}`;
		} else if (CONTROL_OPS.has(token.op)) {
			flush();
			current = "";
		} else if (token.op === "(" || token.op === ")") {
			continue;
		} else if (REDIRECT_OPS.has(token.op)) {
			flush();
			current = "";
			skipTarget = true;
			targetWrites = WRITE_REDIRECT_OPS.has(token.op);
		}
		// Comments are ignored.
	}
	flush();
	return { commands, subshells, redirects };
}

function matchRules(group: CommandGroup, rules: readonly RiskyRule[], segment: string, matches: RiskyMatch[]): void {
	const { words, globs } = group;
	if (words.length === 0) return;
	const command = basename(words[0]);
	for (const rule of rules) {
		if (!rule.command.test(command)) continue;
		if (rule.sub && !rule.sub.test(words[1] ?? "")) continue;
		// When the rule declares `globs`, unquoted glob arguments are matched
		// there (with quoting provenance) instead of in the joined args text.
		const argsOk = rule.args.test(words.slice(rule.sub ? 2 : 1).join(" "));
		const globPattern = rule.globs;
		const globsOk = globPattern !== undefined && globs.some((g) => globPattern.test(g));
		if (!argsOk && !globsOk) continue;
		matches.push({ ruleId: rule.id, description: rule.description, segment });
	}
}

function collectMatches(
	script: string,
	rules: readonly RiskyRule[],
	matches: RiskyMatch[],
	visited: Set<string>,
	depth: number,
): void {
	if (matches.length >= MAX_LEAVES) return;
	// The depth cap must not become a silent allow: past it the guard cannot see
	// the nested script at all, so escalate and let Jev (or the user) decide.
	if (depth > MAX_DEPTH) {
		matches.push({
			ruleId: "nesting-too-deep",
			description: `command nesting exceeds ${MAX_DEPTH} levels; the nested script was not inspected`,
			segment: script.slice(0, 120),
		});
		return;
	}
	for (const line of splitLines(script)) {
		if (visited.has(line)) continue;
		visited.add(line);
		const { commands, subshells, redirects } = commandsOf(parseTokens(line));
		for (const group of commands) {
			const words = normalizeCommand(group.words);
			if (words.length > 0) {
				matchRules({ words, globs: group.globs, segment: group.segment.trim() }, rules, group.segment.trim() || line, matches);
				// Recurse into `bash -c <script>` / `eval <script>` wherever they
				// appear (xargs, sudo, env prefixes normalize away first). Option
				// clusters containing c (-lc, -ec, -xc) also carry the script.
				for (let i = 0; i < words.length; i++) {
					if (!SHELL_INTERPRETERS.test(basename(words[i]))) continue;
					let j = i + 1;
					while (j < words.length && /^-{1,2}[A-Za-z]+$/.test(words[j]) && !/[cC]/.test(words[j].slice(1))) j++;
					if (j < words.length && /^-[A-Za-z]*[cC]/.test(words[j])) {
						if (j + 1 < words.length) collectMatches(words[j + 1], rules, matches, visited, depth + 1);
						break;
					}
				}
				for (let i = 0; i < words.length; i++) {
					if (basename(words[i]) === "eval" && i + 1 < words.length) {
						collectMatches(words.slice(i + 1).join(" "), rules, matches, visited, depth + 1);
						break;
					}
				}
			}
		}
		// Truncating a database or raw device is destructive whatever the command
		// word was, so redirect targets are judged on their own.
		for (const target of redirects) {
			if (!DESTRUCTIVE_REDIRECT_TARGET.test(target)) continue;
			matches.push({ ruleId: REDIRECT_RULE.id, description: REDIRECT_RULE.description, segment: line.trim() });
		}
		for (const subshell of subshells) {
			collectMatches(subshell, rules, matches, visited, depth + 1);
		}
		for (const span of extractSubstitutions(line)) {
			collectMatches(span, rules, matches, visited, depth + 1);
		}
	}
}

export interface RiskyScan {
	rules: readonly RiskyRule[];
	/** Extra user-configured patterns, matched against the full command. */
	extra: readonly RegExp[];
	/** User-configured allow patterns, matched against the full command; they win. */
	allow: readonly RegExp[];
}

/** Scan a command for risky shapes. Allow patterns win over everything. */
export function findRisky(command: string, scan: RiskyScan): { allowed: boolean; matches: RiskyMatch[] } {
	for (const pattern of scan.allow) {
		if (pattern.test(command)) return { allowed: true, matches: [] };
	}
	const matches: RiskyMatch[] = [];
	collectMatches(command, scan.rules, matches, new Set(), 0);
	// The same subshell can be reached through the token capture and the raw
	// substitution scan; keep one match per rule per segment.
	const seen = new Set<string>();
	const unique = matches.filter((match) => {
		const key = `${match.ruleId}\u0000${match.segment}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	for (const pattern of scan.extra) {
		if (pattern.test(command)) {
			unique.push({ ruleId: "user-pattern", description: `matches user risky pattern ${pattern.source}`, segment: command });
		}
	}
	return { allowed: false, matches: unique };
}
