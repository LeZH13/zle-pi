import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { activeCount, formatExpandedCommand, isActive, renderCompletionLine, renderExpandedOutput, renderJobLine, renderWidgetLine, renderWidgetView, splitOutputFooter, stripOutputTruncationFooter } from "../src/render.js";
import type { JobSnapshot } from "../src/background.js";

const plain = (text: string): string => text;

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		job_id: "bg-588d7673", command: "sleep 8", state: "running",
		wall_time_seconds: 3.2, output: "", truncated: false, ...overrides,
	};
}

describe("job state styles", () => {
	it.each([
		["running", true, "●"],
		["cancelling", true, "◐"],
		["completed", false, "✓"],
		["failed", false, "✗"],
		["cancelled", false, "⊘"],
	] as const)("maps %s to active=%s with glyph %s", (state, active, glyph) => {
		expect(isActive(state)).toBe(active);
		expect(renderJobLine(job({ state }), plain).startsWith(glyph)).toBe(true);
	});

	it("counts only unsettled jobs as active", () => {
		expect(activeCount([job(), job({ state: "cancelling" }), job({ state: "completed" }), job({ state: "failed" })])).toBe(2);
	});
});

describe("renderJobLine", () => {
	it("keeps the job id and advancing clock on a running job", () => {
		expect(renderJobLine(job(), plain)).toBe("● Running in background · 0:03 · bg-588d7673");
	});

	it("drops the job id once settled in place", () => {
		expect(renderJobLine(job({ state: "completed", wall_time_seconds: 8.02, exit_code: 0 }), plain))
			.toBe("✓ Completed · 0:08 · exit 0");
	});

	it("keeps one segment order across states", () => {
		expect(renderJobLine(job({ state: "failed", wall_time_seconds: 1.01, output: "Command timed out after 1 seconds" }), plain))
			.toBe("✗ Failed · 0:01 · timed out after 1s");
		expect(renderJobLine(job({ state: "cancelling", wall_time_seconds: 4 }), plain)).toBe("◐ Cancelling background job · 0:04 · bg-588d7673");
	});

	it("names a timeout instead of a bare failure", () => {
		expect(renderJobLine(job({ state: "failed", wall_time_seconds: 1.01, output: "Command timed out after 1 seconds" }), plain))
			.toContain("timed out after 1s");
	});

	it("names a watchdog kill", () => {
		const output = "bash-guard: `sleep 60` was killed by the watchdog after 3 stuck checks";
		expect(renderJobLine(job({ state: "failed", output }), plain)).toContain("was killed by the watchdog");
	});

	it("reports a nonzero exit", () => {
		expect(renderJobLine(job({ state: "failed", exit_code: 2, output: "" }), plain)).toBe("✗ Failed · 0:03 · exit 2");
	});

	it("shows cancellation as a settled state, not a failure", () => {
		expect(renderJobLine(job({ state: "cancelled", wall_time_seconds: 3.94 }), plain)).toBe("⊘ Cancelled · 0:03");
	});

	it("colors the state and keeps completion metadata muted", () => {
		const styled = renderCompletionLine(job({ state: "completed", exit_code: 0 }), (text, kind) => `[${kind}:${text}]`);
		expect(styled).toBe("[success:✓ Bash completed] [muted:· 0:03 · exit 0]");
	});
});

describe("renderWidgetLine", () => {
	it("bounds expanded job rows and terminal columns", () => {
		const jobs = Array.from({ length: 16 }, (_, i) => job({ job_id: `bg-${i}`, command: "界".repeat(100) }));
		for (const width of [1, 10, 40, 80]) {
			const rows = renderWidgetLine(jobs, plain, width, true);
			expect(rows).toHaveLength(10);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		const rows = renderWidgetLine(jobs, plain, 200, true);
		expect(rows[0]).toContain("▾ 16 background jobs");
		expect(rows.at(-1)).toContain("+8 more");
		expect(renderWidgetLine([job({ state: "completed" })], plain, 80, true)).toEqual([]);
	});

	it("renders nothing when every job has settled", () => {
		expect(renderWidgetLine([job({ state: "completed" })], plain, 80)).toEqual([]);
		expect(renderWidgetLine([], plain, 80)).toEqual([]);
	});

	it("collapses a single job to one elapsed value", () => {
		expect(renderWidgetLine([job({ wall_time_seconds: 12 })], plain, 80)[0]).toContain("1 background job │ 0:12");
	});

	it("separates job chips cleanly in the collapsed bar and skips settled jobs", () => {
		const jobs = [
			job({ job_id: "a", wall_time_seconds: 12, command: "sleep 60" }),
			job({ job_id: "b", wall_time_seconds: 303, command: "npm start" }),
			job({ job_id: "c", wall_time_seconds: 2, command: "npm test" }),
			job({ job_id: "d", wall_time_seconds: 600, state: "completed" }),
		];
		expect(renderWidgetLine(jobs, plain, 100)).toEqual([
			" ▸ 3 background jobs │ ● npm start 5:03 │ ● sleep 60 0:12 │ ● npm test 0:02",
		]);
		expect(renderWidgetLine(jobs, plain, 45)).toEqual([" ▸ 3 bg │ ● npm start 5:03 │ +2 more"]);
		expect(renderWidgetLine(jobs, plain, 20)).toEqual([" ▸ 3 bg │ 5:03 +2"]);
		expect(renderWidgetLine(jobs, plain, 10)).toEqual([" ▸ 3 bg"]);
		expect(renderWidgetLine(jobs, plain, 80, true)).toEqual([
			" ▾ 3 background jobs   click job for details · ctrl+shift+k to cancel",
			"   ▸ #1 ● 5:03  b  npm start",
			"   ▸ #2 ● 0:12  a  sleep 60",
			"   ▸ #3 ● 0:02  c  npm test",
		]);
	});

	it("renders an inline detail drawer with live output and inline confirm targets", () => {
		const jobs = [
			job({ job_id: "bg-1", wall_time_seconds: 303, command: "npm start -- --watch", output: "starting...\nlistening on :3000\n" }),
			job({ job_id: "bg-2", wall_time_seconds: 12, command: "sleep 60" }),
		];
		const view = renderWidgetView(jobs, plain, 80, { expanded: true, expandedJobId: "bg-1" });
		expect(view.lines).toEqual([
			" ▾ 2 background jobs   click job for details · ctrl+shift+k to cancel",
			"   ▾ #1 ● 5:03  bg-1  npm start -- --watch",
			"       $ npm start -- --watch",
			"       starting...",
			"       listening on :3000",
			"       [Cancel job]",
			"   ▸ #2 ● 0:12  bg-2  sleep 60",
		]);
		expect(view.targets).toEqual([
			[{ action: { type: "toggle-widget" } }],
			[{ action: { type: "toggle-job", jobId: "bg-1" } }],
			[],
			[],
			[],
			[{ startX: 7, endX: 19, action: { type: "request-cancel", jobId: "bg-1" } }],
			[{ action: { type: "toggle-job", jobId: "bg-2" } }],
		]);

		const confirming = renderWidgetView(jobs, plain, 80, {
			expanded: true,
			expandedJobId: "bg-1",
			confirmCancelJobId: "bg-1",
		});
		const confirmRow = confirming.lines[5]!;
		expect(confirmRow).toBe("       Cancel bg-1?  [Confirm cancel]  [Keep]");
		const [confirmTarget, keepTarget] = confirming.targets[5]!;
		expect(confirmTarget!.action).toEqual({ type: "confirm-cancel", jobId: "bg-1" });
		expect(confirmRow.slice(confirmTarget!.startX, confirmTarget!.endX)).toBe("[Confirm cancel]");
		expect(keepTarget!.action).toEqual({ type: "dismiss-cancel", jobId: "bg-1" });
		expect(confirmRow.slice(keepTarget!.startX, keepTarget!.endX)).toBe("[Keep]");

		for (let width = 1; width <= 100; width++) {
			const bounded = renderWidgetView(jobs, plain, width, {
				expanded: true,
				expandedJobId: "bg-1",
				confirmCancelJobId: "bg-1",
			});
			for (const row of bounded.lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("omits hit targets when narrow widths clip action buttons to ellipsis", () => {
		const jobs = [job({ job_id: "bg-1", wall_time_seconds: 12, command: "sleep 60" })];
		const narrowRequest = renderWidgetView(jobs, plain, 10, { expanded: true, expandedJobId: "bg-1" });
		expect(stripTerminalSequences(narrowRequest.lines.at(-1)!)).toBe("       ...");
		expect(narrowRequest.targets.at(-1)).toEqual([]);

		const narrowConfirm = renderWidgetView(jobs, plain, 10, {
			expanded: true,
			expandedJobId: "bg-1",
			confirmCancelJobId: "bg-1",
		});
		expect(narrowConfirm.lines.slice(-2).map(stripTerminalSequences)).toEqual(["       ...", "       ..."]);
		expect(narrowConfirm.targets.slice(-2)).toEqual([[], []]);

		const stacked = renderWidgetView(jobs, plain, 25, {
			expanded: true,
			expandedJobId: "bg-1",
			confirmCancelJobId: "bg-1",
		});
		expect(stacked.lines.slice(-2)).toEqual([
			"       [Confirm cancel]",
			"       [Keep]",
		]);
		expect(stacked.targets.slice(-2)).toEqual([
			[{ startX: 7, endX: 23, action: { type: "confirm-cancel", jobId: "bg-1" } }],
			[{ startX: 7, endX: 13, action: { type: "dismiss-cancel", jobId: "bg-1" } }],
		]);
	});

	it("caps the collapsed widget at three chips and counts the rest", () => {
		const jobs = Array.from({ length: 7 }, (_, index) => job({ wall_time_seconds: 20 - index }));
		expect(renderWidgetLine(jobs, plain, 100)).toEqual([
			" ▸ 7 background jobs │ ● sleep 8 0:20 │ ● sleep 8 0:19 │ ● sleep 8 0:18 │ +4 more",
		]);
		for (let width = 1; width <= 100; width++) {
			expect(visibleWidth(renderWidgetLine(jobs, plain, width)[0]!)).toBeLessThanOrEqual(width);
		}
	});

	it("shortens leading binary paths in collapsed multi-job chips", () => {
		const jobs = [
			job({ job_id: "a", wall_time_seconds: 20, command: '"/opt/homebrew/Cellar/node/26.11.1/bin/node" -e "setInterval(() => {}, 1000)"' }),
			job({ job_id: "b", wall_time_seconds: 10, command: "/usr/bin/python3 -m http.server" }),
		];
		const [line] = renderWidgetLine(jobs, plain, 100);
		expect(line).toContain("● node -e");
		expect(line).toContain("● python3 -m");
		expect(line).not.toContain("/opt/homebrew");
	});

	it("appends the command when only one job is active", () => {
		const rows = renderWidgetLine([job({ command: "  wait-for-db   && npm start " })], plain, 80);
		expect(rows[0]).toContain("wait-for-db && npm start");
		expect(rows[0]?.split("\n")).toHaveLength(1);
	});

	it("never exceeds the available width and drops the tail before the clock", () => {
		for (const width of [1, 5, 10, 12, 20, 40, 80]) {
			for (const row of renderWidgetLine([job({ command: "x".repeat(200) })], plain, width)) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
		expect(renderWidgetLine([job({ command: "x".repeat(200) })], plain, 12)[0]).toBe(" ▸ 1 bg 0:03");
		expect(renderWidgetLine([job({ command: "x".repeat(200) })], plain, 10)[0]).toBe(" ▸ 1 bg");
	});

	it("ignores settled jobs when reporting the active spread", () => {
		const rows = renderWidgetLine([
			job({ job_id: "a", state: "completed", wall_time_seconds: 99 }),
			job({ job_id: "b", wall_time_seconds: 4 }),
		], plain, 80);
		expect(rows[0]).toContain("1 background job │ 0:04");
	});
});

describe("completion formatting helpers", () => {
	it("preserves multiline commands with $ prefix and 2-space continuation", () => {
		expect(formatExpandedCommand("\nfor f in a b; do\n  echo \x1b[31m$f\x1b[0m\ndone\n")).toEqual([
			"$ for f in a b; do",
			"    echo $f",
			"  done",
		]);
	});

	it("strips Pi's trailing truncation footer before previewing output", () => {
		const raw = "line 1\nline 2\n\n[Showing lines 1-2 of 50. Full output: /tmp/out.log]";
		expect(stripOutputTruncationFooter(raw)).toBe("line 1\nline 2");
		expect(stripOutputTruncationFooter("line 1\nline 2")).toBe("line 1\nline 2");
		expect(splitOutputFooter(`${raw}\n\nCommand exited with code 2`)).toEqual({
			body: "line 1\nline 2\n\nCommand exited with code 2",
			notice: "[Showing lines 1-2 of 50. Full output: /tmp/out.log]",
		});
		expect(splitOutputFooter(`${raw}\n\nCommand timed out after 5 seconds`)).toEqual({
			body: "line 1\nline 2\n\nCommand timed out after 5 seconds",
			notice: "[Showing lines 1-2 of 50. Full output: /tmp/out.log]",
		});
		expect(stripOutputTruncationFooter(`${raw}\n\nCommand timed out after 5 seconds`)).toBe("line 1\nline 2");
		expect(stripOutputTruncationFooter(`${raw}\n\nCommand aborted`)).toBe("line 1\nline 2");
	});

	it("sanitizes expanded output and shows the full-output notice once", () => {
		const styled = renderExpandedOutput(
			job({
				output: "\x1b[49mhello \x1b[32mworld\x1b[0m\n\n[Showing lines 1-1 of 99. Full output: /tmp/full.log]",
				truncated: true,
				full_output_path: "/tmp/full.log",
			}),
			(text, kind) => `[${kind}:${text}]`,
			"(no output)",
		);
		expect(styled).toBe("[toolOutput:hello world]\n\n[warning:[Showing lines 1-1 of 99. Full output: /tmp/full.log]]");
	});
});

