import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { activeCount, isActive, renderJobLine, renderWidgetLine } from "../src/render.js";
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
		expect(renderJobLine(job(), plain)).toBe("● running · 0:03 · bg-588d7673");
	});

	it("drops the job id once settled in place", () => {
		expect(renderJobLine(job({ state: "completed", wall_time_seconds: 8.02, exit_code: 0 }), plain))
			.toBe("✓ completed · 0:08 · exit 0");
	});

	it("keeps one segment order across states", () => {
		expect(renderJobLine(job({ state: "failed", wall_time_seconds: 1.01, output: "Command timed out after 1 seconds" }), plain))
			.toBe("✗ failed · 0:01 · timed out after 1s");
		expect(renderJobLine(job({ state: "cancelling", wall_time_seconds: 4 }), plain)).toBe("◐ cancelling · 0:04 · bg-588d7673");
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
		expect(renderJobLine(job({ state: "failed", exit_code: 2, output: "" }), plain)).toBe("✗ failed · 0:03 · exit 2");
	});

	it("shows cancellation as a settled state, not a failure", () => {
		expect(renderJobLine(job({ state: "cancelled", wall_time_seconds: 3.94 }), plain)).toBe("⊘ cancelled · 0:03");
	});

	it("routes every segment through the styler", () => {
		const kinds: string[] = [];
		renderJobLine(job(), (text, kind) => { kinds.push(kind); return text; });
		expect(kinds).toEqual(["accent", "accent", "accent"]);
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
		expect(rows[0]).toContain("▾ 16 bg");
		expect(rows.at(-1)).toContain("+8 more");
		expect(renderWidgetLine([job({ state: "completed" })], plain, 80, true)).toEqual([]);
	});

	it("renders nothing when every job has settled", () => {
		expect(renderWidgetLine([job({ state: "completed" })], plain, 80)).toEqual([]);
		expect(renderWidgetLine([], plain, 80)).toEqual([]);
	});

	it("collapses a single job to one elapsed value", () => {
		expect(renderWidgetLine([job({ wall_time_seconds: 12 })], plain, 80)[0]).toContain("1 bg · 0:12");
	});

	it("shows oldest and newest elapsed for several jobs", () => {
		const rows = renderWidgetLine([
			job({ job_id: "a", wall_time_seconds: 12, command: "sleep 60" }),
			job({ job_id: "b", wall_time_seconds: 303, command: "npm start" }),
		], plain, 80);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("2 bg · 0:12 │ 5:03");
	});

	it("appends the newest command tail", () => {
		const rows = renderWidgetLine([job({ command: "  wait-for-db   && npm start " })], plain, 80);
		expect(rows[0]).toContain("wait-for-db && npm start");
		expect(rows[0]?.split("\n")).toHaveLength(1);
	});

	it("never exceeds the available width and drops the tail before the clock", () => {
		for (const width of [1, 5, 10, 20, 40, 80]) {
			for (const row of renderWidgetLine([job({ command: "x".repeat(200) })], plain, width)) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
		const narrow = renderWidgetLine([job({ command: "x".repeat(200) })], plain, 10);
		expect(narrow[0]).toContain("1 bg");
	});

	it("ignores settled jobs when reporting the active spread", () => {
		const rows = renderWidgetLine([
			job({ job_id: "a", state: "completed", wall_time_seconds: 99 }),
			job({ job_id: "b", wall_time_seconds: 4 }),
		], plain, 80);
		expect(rows[0]).toContain("1 bg · 0:04");
	});
});

