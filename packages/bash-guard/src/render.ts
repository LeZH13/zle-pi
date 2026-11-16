/**
 * Presentation for background bash jobs. Pure and style-agnostic: callers pass
 * a styler so tests assert plain text while the wiring blends with the active
 * theme.
 *
 * The native bash renderer freezes a tool block once its result is final, and a
 * background acknowledgement *is* final. So the block would sit motionless
 * while the process is alive. These helpers re-render the settled block from
 * live job state, and compose the single aggregate row shown above the editor.
 * Motion is the advancing clock; nothing spins, because the agent's own working
 * indicator already owns spinners in this transcript.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { JobSnapshot, JobState } from "./background.js";
import { formatElapsed } from "./status.js";

export type JobStyler = (text: string, kind: "accent" | "success" | "warning" | "error" | "muted") => string;

export interface StateStyle {
	glyph: string;
	kind: "accent" | "success" | "warning" | "error" | "muted";
	/** Active states keep the block's clock running. */
	active: boolean;
}

export const JOB_STYLES: Record<JobState, StateStyle> = {
	running: { glyph: "●", kind: "accent", active: true },
	cancelling: { glyph: "◐", kind: "warning", active: true },
	completed: { glyph: "✓", kind: "success", active: false },
	failed: { glyph: "✗", kind: "error", active: false },
	cancelled: { glyph: "⊘", kind: "muted", active: false },
};

export function isActive(state: JobState): boolean {
	return JOB_STYLES[state].active;
}

export function activeCount(jobs: readonly JobSnapshot[]): number {
	return jobs.filter((job) => isActive(job.state)).length;
}

/** The reason a job failed, when the snapshot says enough to name it. */
function failureLabel(job: JobSnapshot): string {
	const text = job.output.trim();
	const timeout = text.match(/Command timed out after ([\d.]+) seconds?/);
	if (timeout) return `timed out after ${timeout[1]}s`;
	if (text.startsWith("Command aborted")) return "aborted";
	const kill = text.match(/^bash-guard: (.+)$/m);
	if (kill) return kill[1]!.slice(0, 80);
	return job.exit_code !== undefined && job.exit_code !== 0 ? `exit ${job.exit_code}` : "failed";
}

/** The single line under a background job's command. Uniform shape: state, clock, then detail. */
export function renderJobLine(job: JobSnapshot, styler: JobStyler): string {
	const style = JOB_STYLES[job.state];
	const head = `${styler(style.glyph, style.kind)} ${styler(`${job.state} · ${formatElapsed(job.wall_time_seconds)}`, style.kind)}`;
	const detail = jobDetail(job);
	return detail === undefined ? head : `${head} ${styler(`· ${detail}`, style.kind)}`;
}

function jobDetail(job: JobSnapshot): string | undefined {
	switch (job.state) {
		case "running":
		case "cancelling":
			// The id is what a user types into bash_jobs, so only live jobs carry it.
			return job.job_id;
		case "completed":
			return job.exit_code === undefined ? undefined : `exit ${job.exit_code}`;
		case "failed":
			return failureLabel(job);
		case "cancelled":
			return undefined;
	}
}

/**
 * The aggregate row above the editor, with a bounded job list when expanded.
 * `12s │ 5m03s` is oldest │ newest elapsed, which shows the spread at a glance.
 */
export function renderWidgetLine(jobs: readonly JobSnapshot[], styler: JobStyler, width: number, expanded = false): string[] {
	const active = jobs.filter((job) => isActive(job.state));
	if (active.length === 0) return [];
	const glyph = expanded ? "▾" : "▸";
	const spread = active.length === 1
		? formatElapsed(active[0]!.wall_time_seconds)
		: `${formatElapsed(active[0]!.wall_time_seconds)} │ ${formatElapsed(active[active.length - 1]!.wall_time_seconds)}`;
	const head = `${styler(glyph, "accent")} ${styler(`${active.length} bg · ${spread}`, "accent")}`;
	if (expanded) {
		const rows = [truncateToWidth(head, width)];
		for (const job of active.slice(0, 8)) {
			const command = job.command.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
			rows.push(truncateToWidth(`  ${renderJobLine(job, styler)}   ${styler(command, "muted")}`, width));
		}
		if (active.length > 8) rows.push(truncateToWidth(styler(`  +${active.length - 8} more`, "muted"), width));
		return rows;
	}
	const newest = active[active.length - 1]!.command.replace(/\s+/g, " ").trim();
	const plainHead = `${glyph} ${active.length} bg · ${spread}`;
	// The command tail is decoration: drop it rather than squeeze the clock.
	if (width <= 0 || plainHead.length + 4 >= width) return [truncateToWidth(head, width)];
	const room = width - plainHead.length - 3;
	const tail = styler(`   ${newest}`.slice(0, room + 3), "muted");
	return [truncateToWidth(`${head}${tail}`, width)];
}
