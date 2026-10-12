import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectShellCommands, MAX_COMMAND_REPLIES } from "../lib/shell-commands.js";

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const text = (text: string): TextContent => ({ type: "text", text });
const bashCall = (args: JsonObject): ToolCall => ({ type: "toolCall", id: "t", name: "bash", arguments: args });

/** Markdown for a closed fence whose code content is exactly `code`. */
const fenceMd = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```\n";

function assistant(
	id: string,
	parentId: string | null,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "",
		message: {
			role: "assistant",
			content,
			api: "test",
			provider: "test",
			model: "test-model",
			usage: NO_USAGE,
			stopReason,
			timestamp: 0,
		},
	};
}

function user(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: "", message: { role: "user", content: "hi", timestamp: 0 } };
}

function toolResult(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "",
		message: {
			role: "toolResult",
			toolCallId: "t",
			toolName: "bash",
			content: [text(fenceMd("bash", "echo from-result"))],
			isError: false,
			timestamp: 0,
		},
	};
}

function info(id: string, parentId: string | null): SessionEntry {
	return { type: "session_info", id, parentId, timestamp: "" };
}

/** Scan one assistant reply's content as the leaf of a one-entry branch. */
const commandsOf = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
	collectShellCommands([assistant("e", null, content, stopReason)]);

describe("collectShellCommands", () => {
	it("collects nothing from empty or assistant-less sessions", () => {
		expect(collectShellCommands([])).toEqual([]);
		expect(collectShellCommands([info("i", null), user("u", null)])).toEqual([]);
	});

	it("preserves document order inside a response across fences", () => {
		expect(
			commandsOf([text(fenceMd("bash", "echo first")), text("between\n\n" + fenceMd("sh", "echo second"))]),
		).toEqual([
			{ id: "e:0", text: "echo first", language: "bash", reply: 0 },
			{ id: "e:1", text: "echo second", language: "sh", reply: 0 },
		]);
	});

	it("keeps heredocs, line continuations, and $ markers verbatim", () => {
		const script = "cat <<EOF\nline one\nline two\nEOF\necho done \\\n  continued";
		const prompted = "$ npm run build\necho next";
		expect(commandsOf([text(fenceMd("bash", script)), text(fenceMd("shell", prompted))])).toEqual([
			{ id: "e:0", text: script, language: "bash", reply: 0 },
			{ id: "e:1", text: prompted, language: "shell", reply: 0 },
		]);
	});

	it("collects fenced blocks in lists, quotes, tildes, and larger outer fences", () => {
		expect(
			commandsOf([
				text("- item\n\n  ```zsh\n  echo from-list\n  ```\n- next\n"),
				text("> ```bash\n> echo quoted\n> ```\n"),
				text("~~~sh\nls -la\n~~~\n"),
				text("````bash\n```sh\necho inner\n```\n````\n"),
			]),
		).toEqual([
			{ id: "e:0", text: "echo from-list", language: "zsh", reply: 0 },
			{ id: "e:1", text: "echo quoted", language: "bash", reply: 0 },
			{ id: "e:2", text: "ls -la", language: "sh", reply: 0 },
			{ id: "e:3", text: "```sh\necho inner\n```", language: "bash", reply: 0 },
		]);
	});

	it("ignores fake shell fences inside outer non-shell blocks", () => {
		const fake = "```bash\necho fake\n```";
		expect(
			commandsOf([
				text("````text\n" + fake + "\n````\n"),
				text("````\n" + fake + "\n````\n"),
				text("```python\n" + fake + "\n```\nmore\n```\n"),
			]),
		).toEqual([]);
	});

	it("ignores unlabeled and non-shell fences plus indented code", () => {
		const excluded = [
			"```\necho unlabeled\n```\n",
			"    echo indented\n",
			"```code\necho code\n```\n",
			"```text\necho text\n```\n",
			"```console\n$ ls\n```\n",
			"```js\nconsole.log(1)\n```\n",
			"```python\nprint(1)\n```\n",
			"```shell-session\n$ ls\n```\n",
		].join("\n");
		expect(commandsOf([text(excluded)])).toEqual([]);
	});

	it("skips empty shell fences", () => {
		expect(commandsOf([text(fenceMd("bash", "")), text(fenceMd("sh", "  \n\t"))])).toEqual([]);
	});

	it("requires closed fences: unclosed, mismatched, and stray closers yield nothing", () => {
		expect(commandsOf([text("```bash\necho streaming\n")])).toEqual([]);
		expect(commandsOf([text("~~~bash\necho hi\n```\n")])).toEqual([]);
		const withUnclosed = commandsOf([text("```sh\necho closed\n```\n\n```bash\necho streaming\n")]);
		expect(withUnclosed).toEqual([{ id: "e:0", text: "echo closed", language: "sh", reply: 0 }]);
		// A stray closing fence opens its own unlabeled block, so the following
		// bash fence becomes its content instead of pairing with it.
		expect(commandsOf([text("```bash\necho a\n```\n```\n```bash\necho b\n```\n")])).toEqual([
			{ id: "e:0", text: "echo a", language: "bash", reply: 0 },
		]);
	});

	it("matches case-insensitively and reads the first word of the info string", () => {
		expect(
			commandsOf([
				text(fenceMd("BASH", "echo a")),
				text("```Shell --flag value\necho b\n```\n"),
				text('```zsh title="x"\necho c\n```\n'),
				text(fenceMd("SH", "echo d")),
			]).map((command) => [command.language, command.text]),
		).toEqual([
			["bash", "echo a"],
			["shell", "echo b"],
			["zsh", "echo c"],
			["sh", "echo d"],
		]);
	});

	it("ignores a reply that contains only bash tool calls", () => {
		expect(
			commandsOf([
				bashCall({ command: "npm test" }),
				bashCall({ command: "echo multi\nls -la" }),
				bashCall({}),
				bashCall({ command: "" }),
				bashCall({ command: "   \n\t " }),
				bashCall({ command: 42 }),
				bashCall({ command: null }),
				{ type: "toolCall", id: "r", name: "read", arguments: { command: "echo not-bash" } },
			]),
		).toEqual([]);
	});

	it("ignores thinking, tool calls, tool results, and user text", () => {
		expect(
			collectShellCommands([
				toolResult("r0", "u0"),
				user("u0", null),
				assistant("a0", "u0", [
					{ type: "thinking", thinking: fenceMd("bash", "echo planned") },
					bashCall({ command: "echo from-call" }),
					text(fenceMd("bash", "echo real")),
				]),
			]),
		).toEqual([{ id: "a0:0", text: "echo real", language: "bash", reply: 0 }]);
	});

	it("keeps duplicate commands with distinct per-entry provenance ids", () => {
		const duplicated = fenceMd("bash", "echo dup") + "\n" + fenceMd("bash", "echo dup");
		const commands = commandsOf([text(duplicated)]);
		expect(commands.map((command) => command.id)).toEqual(["e:0", "e:1"]);
		expect(commands.map((command) => command.text)).toEqual(["echo dup", "echo dup"]);
	});

	it("walks the current branch newest reply first, ten replies max, without mutating input", () => {
		const entries: SessionEntry[] = [];
		let parentId: string | null = null;
		for (let i = 1; i <= 10; i++) {
			if (i > 1) {
				entries.push(user(`u${i}`, parentId));
				parentId = `u${i}`;
			}
			entries.push(assistant(`a${i}`, parentId, [text(fenceMd("bash", `echo r${i}`))]));
			parentId = `a${i}`;
		}
		// The caller supplies only the current branch. Non-message entries take no reply slot.
		entries.push(user("u11", "a10"));
		entries.push(info("i11", "u11"));
		entries.push(assistant("a11", "i11", [text(fenceMd("bash", "echo r11"))]));

		const commands = collectShellCommands(entries);
		expect(commands).toHaveLength(MAX_COMMAND_REPLIES);
		expect(commands.map((command) => command.text)).toEqual(
			Array.from({ length: MAX_COMMAND_REPLIES }, (_, slot) => `echo r${11 - slot}`),
		);
		expect(commands.map((command) => command.reply)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(new Set(commands.map((command) => command.id)).size).toBe(MAX_COMMAND_REPLIES);
		expect(commands[0]!.id).toBe("a11:0");

		const snapshot = structuredClone(entries);
		collectShellCommands(entries);
		expect(entries).toEqual(snapshot);
	});

	it("counts error and aborted replies in the window but extracts nothing from them", () => {
		expect(
			collectShellCommands([
				assistant("old", null, [text(fenceMd("bash", "echo old"))]),
				assistant("err", "old", [text(fenceMd("bash", "echo from-error"))], "error"),
				assistant("abort", "err", [text(fenceMd("bash", "echo from-abort"))], "aborted"),
				assistant("new", "abort", [text(fenceMd("bash", "echo new"))]),
			]),
		).toEqual([
			{ id: "new:0", text: "echo new", language: "bash", reply: 0 },
			{ id: "old:0", text: "echo old", language: "bash", reply: 3 },
		]);
	});

	it("still extracts from replies that stopped for other reasons", () => {
		expect(
			collectShellCommands([
				assistant("used", null, [text(fenceMd("bash", "echo via-toolUse"))], "toolUse"),
				assistant("length", "used", [text(fenceMd("bash", "echo via-length"))], "length"),
			]),
		).toEqual([
			{ id: "length:0", text: "echo via-length", language: "bash", reply: 0 },
			{ id: "used:0", text: "echo via-toolUse", language: "bash", reply: 1 },
		]);
	});
});
