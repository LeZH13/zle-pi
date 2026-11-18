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
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { JobSnapshot, JobState } from "./background.js";
import { chipCommand, commandPreview, formatElapsed, sanitizeLine } from "./status.js";

export { commandPreview, sanitizeLine };

export type JobStyleKind = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "toolOutput";
export type JobStyler = (text: string, kind: JobStyleKind) => string;

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
	const text = stripTerminalSequences(job.output).trim();
	const timeout = text.match(/Command timed out after ([\d.]+) seconds?/);
	if (timeout) return `timed out after ${timeout[1]}s`;
	if (/^Command aborted(?:\n|$)/m.test(text)) return "aborted";
	const kill = text.match(/^bash-guard: (?:`[^`]*` )?(.+)$/m);
	if (kill) return kill[1]!.slice(0, 80);
	return job.exit_code !== undefined && job.exit_code !== 0 ? `exit ${job.exit_code}` : "failed";
}

function renderJobStatus(job: JobSnapshot, styler: JobStyler, label: string): string {
	const { glyph, kind } = JOB_STYLES[job.state];
	const detail = jobDetail(job);
	const metadata = `· ${formatElapsed(job.wall_time_seconds)}${detail === undefined ? "" : ` · ${detail}`}`;
	return `${styler(`${glyph} ${label}`, kind)} ${styler(metadata, "muted")}`;
}

function stateLabel(state: JobState): string {
	return state[0]!.toUpperCase() + state.slice(1);
}

export function renderJobLine(job: JobSnapshot, styler: JobStyler): string {
	const label = job.state === "running" ? "Running in background"
		: job.state === "cancelling" ? "Cancelling background job" : stateLabel(job.state);
	return renderJobStatus(job, styler, label);
}

export function renderCompletionLine(job: JobSnapshot, styler: JobStyler): string {
	return renderJobStatus(job, styler, `Bash ${job.state}`);
}

/** Preserve line breaks in multi-line commands for expanded views while sanitizing control chars. */
export function formatExpandedCommand(command: string): string[] {
	const rawLines = stripTerminalSequences(command).split(/\r?\n/);
	while (rawLines.length > 0 && rawLines[0]!.trim() === "") rawLines.shift();
	while (rawLines.length > 0 && rawLines.at(-1)!.trim() === "") rawLines.pop();
	if (rawLines.length === 0) return ["$"];
	return rawLines.map((line, index) => `${index === 0 ? "$ " : "  "}${sanitizeLine(line).trimEnd()}`);
}

/** Split Pi's trailing truncation footer from output so expanded views show the temp path once. */
export function splitOutputFooter(output: string): { body: string; notice?: string } {
	const trimmed = output.trimEnd();
	const footerMatch = trimmed.match(
		/\n\n(\[[^\n]*Full output: [^\n\]]+\])(?:\n\n(?:Command (?:aborted|timed out after [\d.]+ seconds?|terminated without an exit code|exited with code \d+)|bash-guard: [^\n]+))?$/,
	);
	if (!footerMatch) return { body: trimmed };
	const before = trimmed.slice(0, footerMatch.index!).trimEnd();
	const afterStart = footerMatch.index! + 2 + footerMatch[1]!.length;
	const after = trimmed.slice(afterStart).trim();
	return { body: after ? `${before}\n\n${after}` : before, notice: footerMatch[1]! };
}

/** Strip Pi's trailing truncation footer and redundant status trailer before extracting short output previews. */
export function stripOutputTruncationFooter(output: string): string {
	const { body } = splitOutputFooter(output);
	const withoutTrailer = body.replace(
		/\n\n(?:Command (?:aborted|timed out after [\d.]+ seconds?|terminated without an exit code|exited with code \d+)|bash-guard: [^\n]+)$/,
		"",
	).trimEnd();
	return withoutTrailer || body;
}

/** Sanitize and style expanded job output, showing any full-output notice once. */
export function renderExpandedOutput(job: JobSnapshot, styler: JobStyler, emptyLabel: string): string {
	const { body, notice } = splitOutputFooter(job.output);
	const hasOutput = body.trim() !== "" && body.trim() !== "(no output)";
	const renderedBody = !hasOutput
		? styler(emptyLabel, "muted")
		: body.split(/\r?\n/).map((line) => styler(sanitizeLine(line).trimEnd(), "toolOutput")).join("\n");
	const fullNotice = notice ?? (job.full_output_path ? `[Full output: ${job.full_output_path}]` : undefined);
	return fullNotice ? `${renderedBody}\n\n${styler(sanitizeLine(fullNotice), "warning")}` : renderedBody;
}

/** Wrap sanitized text to `width`, capping at `maxLines` from the start. */
function wrapHead(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const lines = wrapTextWithAnsi(text, width);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	kept[maxLines - 1] = truncateToWidth(`${kept[maxLines - 1]!}...`, width);
	return kept;
}

/** Last `maxLines` visual lines of sanitized output, each fitting within `width`. */
export function outputTailLines(output: string, width: number, maxLines = 3): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const rawLines = stripTerminalSequences(output).split(/\r?\n/);
	while (rawLines.length > 0 && rawLines.at(-1)!.trim() === "") rawLines.pop();
	if (rawLines.length === 0) return [];
	const wrapped: string[] = [];
	for (const line of rawLines.slice(-20)) {
		const clean = sanitizeLine(line).trimEnd();
		wrapped.push(...wrapTextWithAnsi(clean === "" ? " " : clean, width));
	}
	return wrapped.slice(-maxLines).map((line) => truncateToWidth(line, width));
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

export type WidgetRowAction =
	| { type: "toggle-widget" }
	| { type: "toggle-job"; jobId: string }
	| { type: "request-cancel"; jobId: string }
	| { type: "confirm-cancel"; jobId: string }
	| { type: "dismiss-cancel"; jobId: string };

export interface WidgetHitTarget {
	/** Inclusive start column (0-based). Undefined covers the full line. */
	startX?: number;
	/** Exclusive end column (0-based). */
	endX?: number;
	action: WidgetRowAction;
}

export interface WidgetRenderOptions {
	expanded?: boolean;
	expandedJobId?: string;
	confirmCancelJobId?: string;
}

export interface WidgetRenderResult {
	lines: string[];
	targets: WidgetHitTarget[][];
}

export function renderWidgetView(
	jobs: readonly JobSnapshot[],
	styler: JobStyler,
	width: number,
	options: WidgetRenderOptions = {},
): WidgetRenderResult {
	if (width <= 0) return { lines: [], targets: [] };
	const active = jobs.filter((job) => isActive(job.state))
		.sort((a, b) => b.wall_time_seconds - a.wall_time_seconds);
	const oldest = active[0];
	if (!oldest) return { lines: [], targets: [] };

	const expanded = options.expanded ?? false;
	const count = active.length;
	const glyph = expanded ? "▾" : "▸";
	const pad = width >= 10 ? " " : "";
	const label = `${glyph} ${count} background ${count === 1 ? "job" : "jobs"}`;
	const compactLabel = `${glyph} ${count} bg`;
	const mutedEllipsis = styler("...", "muted");
	const pickHead = (suffixWidth = 0): string =>
		styler(visibleWidth(pad + label) + suffixWidth <= width ? label : compactLabel, "accent");

	if (expanded) {
		const lines: string[] = [];
		const targets: WidgetHitTarget[][] = [];
		const push = (line: string, rowTargets: WidgetHitTarget[] = []): void => {
			lines.push(truncateToWidth(line, width, mutedEllipsis));
			targets.push(rowTargets);
		};

		const fullHint = count > 1 ? "click job for details · ctrl+shift+k to cancel" : "ctrl+shift+k to cancel";
		const shortHint = "ctrl+shift+k to cancel";
		const baseHeader = `${pad}${pickHead()}`;
		let hint = "";
		if (visibleWidth(baseHeader) + 3 + visibleWidth(fullHint) <= width) hint = styler(`   ${fullHint}`, "muted");
		else if (visibleWidth(baseHeader) + 3 + visibleWidth(shortHint) <= width) hint = styler(`   ${shortHint}`, "muted");
		push(`${baseHeader}${hint}`, [{ action: { type: "toggle-widget" } }]);

		const visible = active.slice(0, 8);
		const clockWidth = Math.max(...visible.map((job) => formatElapsed(job.wall_time_seconds).length));
		const idWidth = Math.max(...visible.map((job) => job.job_id.length));

		for (const [index, job] of visible.entries()) {
			const isRowExpanded = job.job_id === options.expandedJobId;
			const rowGlyph = isRowExpanded ? "▾" : "▸";
			const { glyph: stateGlyph, kind } = JOB_STYLES[job.state];
			const order = count > 1 ? `${styler(`#${index + 1}`, "muted")} ` : "";
			const clock = formatElapsed(job.wall_time_seconds).padStart(clockWidth);
			const idCol = job.job_id.padEnd(idWidth);
			const cancelling = job.state === "cancelling" ? styler(" (cancelling)", "warning") : "";
			const cmdColor: JobStyleKind = isRowExpanded ? "accent" : "muted";
			const rowPrefix = `${pad}  ${styler(rowGlyph, "muted")} ${order}${styler(stateGlyph, kind)} ${styler(clock, "muted")}  ${styler(idCol, "muted")}  `;
			push(`${rowPrefix}${styler(commandPreview(job.command), cmdColor)}${cancelling}`, [{
				action: { type: "toggle-job", jobId: job.job_id },
			}]);

			if (isRowExpanded) {
				const detailIndent = `${pad}      `;
				const detailWidth = Math.max(1, width - visibleWidth(detailIndent));
				const cmdWrapped = wrapHead(commandPreview(job.command), Math.max(1, detailWidth - 2), 3);
				for (const [lineIdx, cmdLine] of cmdWrapped.entries()) {
					const prefix = lineIdx === 0 ? "$ " : "  ";
					push(`${detailIndent}${styler(`${prefix}${cmdLine}`, "toolOutput")}`);
				}
				const tail = outputTailLines(job.output, detailWidth, 3);
				if (tail.length === 0) {
					push(`${detailIndent}${styler("(no output yet)", "muted")}`);
				} else {
					for (const outLine of tail) {
						push(`${detailIndent}${styler(outLine, "muted")}`);
					}
					if (job.truncated) push(`${detailIndent}${styler("(output truncated)", "warning")}`);
				}
				if (job.state === "running") {
					if (options.confirmCancelJobId === job.job_id) {
						const confirmLabel = "[Confirm cancel]";
						const keepLabel = "[Keep]";
						const prompt = `${styler(`Cancel ${job.job_id}?`, "warning")}  `;
						const oneLineWithPrompt = `${detailIndent}${prompt}${styler(confirmLabel, "error")}  ${styler(keepLabel, "toolOutput")}`;
						const oneLineButtons = `${detailIndent}${styler(confirmLabel, "error")}  ${styler(keepLabel, "toolOutput")}`;
						if (visibleWidth(oneLineWithPrompt) <= width || visibleWidth(oneLineButtons) <= width) {
							const prefix = visibleWidth(oneLineWithPrompt) <= width ? `${detailIndent}${prompt}` : detailIndent;
							const confirmStart = visibleWidth(prefix);
							const confirmEnd = confirmStart + confirmLabel.length;
							const keepStart = confirmEnd + 2;
							const keepEnd = keepStart + keepLabel.length;
							push(
								`${prefix}${styler(confirmLabel, "error")}  ${styler(keepLabel, "toolOutput")}`,
								[
									{ startX: confirmStart, endX: confirmEnd, action: { type: "confirm-cancel", jobId: job.job_id } },
									{ startX: keepStart, endX: keepEnd, action: { type: "dismiss-cancel", jobId: job.job_id } },
								],
							);
						} else {
							const indentWidth = visibleWidth(detailIndent);
							const confirmEnd = indentWidth + confirmLabel.length;
							push(
								`${detailIndent}${styler(confirmLabel, "error")}`,
								confirmEnd <= width
									? [{ startX: indentWidth, endX: confirmEnd, action: { type: "confirm-cancel", jobId: job.job_id } }]
									: [],
							);
							const keepEnd = indentWidth + keepLabel.length;
							push(
								`${detailIndent}${styler(keepLabel, "toolOutput")}`,
								keepEnd <= width
									? [{ startX: indentWidth, endX: keepEnd, action: { type: "dismiss-cancel", jobId: job.job_id } }]
									: [],
							);
						}
					} else {
						const cancelLabel = "[Cancel job]";
						const indentWidth = visibleWidth(detailIndent);
						const cancelEnd = indentWidth + cancelLabel.length;
						push(
							`${detailIndent}${styler(cancelLabel, "error")}`,
							cancelEnd <= width
								? [{ startX: indentWidth, endX: cancelEnd, action: { type: "request-cancel", jobId: job.job_id } }]
								: [],
						);
					}
				} else {
					push(`${detailIndent}${styler("Cancelling…", "warning")}`);
				}
			}
		}
		if (count > 8) push(`${pad}  ${styler(`+${count - 8} more`, "muted")}`);
		return { lines, targets };
	}

	const div = styler(" │ ", "dim");
	const divWidth = 3;

	if (count > 1) {
		const maxChips = Math.min(3, count);
		for (let shown = maxChips; shown >= 1; shown--) {
			const hidden = count - shown;
			const chips = active.slice(0, shown).map((job) => {
				const { glyph: stateGlyph, kind } = JOB_STYLES[job.state];
				const cmd = chipCommand(job.command, 16);
				const elapsed = formatElapsed(job.wall_time_seconds);
				return {
					styled: `${styler(stateGlyph, kind)} ${styler(cmd, "toolOutput")} ${styler(elapsed, "muted")}`,
					width: visibleWidth(`${stateGlyph} ${cmd} ${elapsed}`),
				};
			});
			const moreText = hidden > 0 ? `+${hidden} more` : undefined;
			const shortMoreText = hidden > 0 ? `+${hidden}` : undefined;
			for (const overflow of moreText ? [moreText, shortMoreText!] : [undefined]) {
				const overflowWidth = overflow ? divWidth + overflow.length : 0;
				const bodyWidth = chips.reduce((sum, chip) => sum + chip.width, 0) + divWidth * (chips.length - 1) + overflowWidth;
				const suffixWidth = divWidth + bodyWidth;
				if (visibleWidth(pad + compactLabel) + suffixWidth <= width) {
					const overflowStyled = overflow ? `${div}${styler(overflow, "muted")}` : "";
					return {
						lines: [`${pad}${pickHead(suffixWidth)}${div}${chips.map((c) => c.styled).join(div)}${overflowStyled}`],
						targets: [[{ action: { type: "toggle-widget" } }]],
					};
				}
			}
		}
		const oldestElapsed = formatElapsed(oldest.wall_time_seconds);
		const compactSummary = `${oldestElapsed} +${count - 1}`;
		if (visibleWidth(pad + compactLabel) + divWidth + compactSummary.length <= width) {
			return {
				lines: [`${pad}${styler(compactLabel, "accent")}${div}${styler(compactSummary, "muted")}`],
				targets: [[{ action: { type: "toggle-widget" } }]],
			};
		}
		return {
			lines: [truncateToWidth(`${pad}${pickHead()}`, width, mutedEllipsis)],
			targets: [[{ action: { type: "toggle-widget" } }]],
		};
	}

	const elapsed = formatElapsed(oldest.wall_time_seconds);
	if (visibleWidth(pad + compactLabel) + divWidth + elapsed.length <= width) {
		const head = pickHead(divWidth + elapsed.length);
		const summary = `${pad}${head}${div}${styler(elapsed, "toolOutput")}`;
		const room = width - visibleWidth(summary);
		const command = room >= 7 ? `${div}${styler(commandPreview(oldest.command), "muted")}` : "";
		return {
			lines: [truncateToWidth(summary + command, width, mutedEllipsis)],
			targets: [[{ action: { type: "toggle-widget" } }]],
		};
	}
	const tightClock = ` ${elapsed}`;
	if (visibleWidth(pad + compactLabel + tightClock) <= width) {
		return {
			lines: [`${pad}${styler(compactLabel, "accent")}${styler(tightClock, "muted")}`],
			targets: [[{ action: { type: "toggle-widget" } }]],
		};
	}
	return {
		lines: [truncateToWidth(`${pad}${styler(compactLabel, "accent")}`, width, mutedEllipsis)],
		targets: [[{ action: { type: "toggle-widget" } }]],
	};
}

export function renderWidgetLine(
	jobs: readonly JobSnapshot[],
	styler: JobStyler,
	width: number,
	expanded = false,
	expandedJobId?: string,
	confirmCancelJobId?: string,
): string[] {
	return renderWidgetView(jobs, styler, width, { expanded, expandedJobId, confirmCancelJobId }).lines;
}
