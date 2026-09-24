import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = join(import.meta.dirname, "../audit/prompts.py");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "snippet-audit-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("exports only bounded recent main-session user text for the selected project", () => {
	const fresh = new Date().toISOString();
	const old = new Date(Date.now() - 40 * 86400_000).toISOString();
	function session(dir: string, id: string, date: string, cwd: string, text: string) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.jsonl`), [
			JSON.stringify({ type: "session", id, cwd, timestamp: date }),
			"{invalid json",
			JSON.stringify({ type: "message", message: { role: "user", timestamp: 1000, content: [{ type: "text", text }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant words" }] } }),
			JSON.stringify({ type: "custom", customType: "prompt-snippets:usage", timestamp: date, data: { snippets: [{ id: "verify.md", source: "global" }] } }),
		].join("\n"));
	}
	session(join(root, "project"), "recent", fresh, "/work/target", "Please verify all assumptions carefully");
	session(join(root, "project", "recent", "subagent", "run-1"), "child", fresh, "/work/target", "Ignore this agent-authored task");
	session(join(root, "old"), "old", old, "/work/target", "An old prompt should not appear");
	session(join(root, "other"), "other", fresh, "/work/other", "A different project's prompt");
	const flags = [script, "--sessions-dir", root, "--cwd", "TARGET", "--max-prompts", "1"];
	const output = execFileSync("python3", flags, { encoding: "utf8" });
	const report = JSON.parse(output);
	expect(report.scope).toEqual({ sessions_scanned: 1, prompts_sampled: 1, usage_events_sampled: 1 });
	expect(report.snippet_usage[0]).toMatchObject({ id: "verify.md", appearances: 1, sessions: 1 });
	expect(report.repeated_prompts).toEqual([]);
	const raw = execFileSync("python3", [...flags, "--format", "jsonl"], { encoding: "utf8" });
	expect(JSON.parse(raw)).toEqual({ session_id: "recent", cwd: "/work/target", timestamp: 1000, text: "Please verify all assumptions carefully" });
});

it("reports exact repeated prompts by distinct sessions, not just occurrences", () => {
	const date = new Date().toISOString();
	for (const id of ["first", "second"]) {
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.jsonl`), [
			JSON.stringify({ type: "session", id, cwd: `/work/${id}`, timestamp: date }),
			...Array.from({ length: id === "first" ? 2 : 1 }, () => JSON.stringify({
				type: "message", message: { role: "user", content: [{ type: "text", text: "  Verify   the assumptions carefully  " }] },
			})),
		].join("\n"));
	}
	const result = JSON.parse(execFileSync("python3", [script, "--sessions-dir", root], { encoding: "utf8" }));
	expect(result.repeated_prompts).toEqual([{
		text: "verify the assumptions carefully", appearances: 3, sessions: 2, projects: 2,
		example_sessions: ["first", "second"],
	}]);
});

it("finds recurring instruction lines inside different task prompts", () => {
	const date = new Date().toISOString();
	for (const id of ["a", "b"]) {
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.jsonl`), [
			JSON.stringify({ type: "session", id, cwd: "/work/p", timestamp: date }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `Do task ${id}.\nPlease explain the tradeoffs carefully.` }] } }),
		].join("\n"));
	}
	const result = JSON.parse(execFileSync("python3", [script, "--sessions-dir", root], { encoding: "utf8" }));
	expect(result.repeated_prompts).toEqual([{
		text: "please explain the tradeoffs carefully.", appearances: 2, sessions: 2, projects: 1,
		example_sessions: ["a", "b"],
	}]);
});
