/**
 * Prompt Snippets — mix-and-match single-purpose prompt rules for Pi.
 *
 * Originally created by Amos Blomqvist (https://github.com/amosblomqvist/pi-config).
 *
 * Snippets are markdown files with YAML frontmatter stored in:
 * - Bundled package snippets (<package>/snippets/)
 * - Global user snippets (~/.pi/agent/snippets/)
 * - Project snippets (<cwd>/.pi/snippets/)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadSnippets } from "./loader.js";
import type { LoadSnippetsOptions, Snippet } from "./types.js";

const WIDGET_ID = "prompt-snippets";

export function createPromptSnippetsExtension(extensionOptions: LoadSnippetsOptions = {}) {
	return function promptSnippetsExtension(pi: ExtensionAPI) {
		let snippets: Snippet[] = [];
		let enabled = new Set<string>();

		function getSnippets(ctx: ExtensionContext): Snippet[] {
			const isTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
			return loadSnippets({
				...extensionOptions,
				cwd: ctx.cwd,
				isProjectTrusted: isTrusted,
			});
		}

		function updateWidget(ctx: ExtensionContext) {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			const active = snippets.filter((s) => enabled.has(s.id));
			const prepends = active.filter((s) => s.placement === "prepend");
			const appends = active.filter((s) => s.placement === "append");

			if (prepends.length === 0 && appends.length === 0) {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}

			const theme = ctx.ui.theme;
			const lines: string[] = [];
			if (prepends.length > 0) {
				lines.push(theme.fg("accent", `↑ prepend: ${prepends.map((s) => s.name).join(" · ")}`));
			}
			if (appends.length > 0) {
				lines.push(theme.fg("warning", `↓ append: ${appends.map((s) => s.name).join(" · ")}`));
			}
			ctx.ui.setWidget(WIDGET_ID, lines);
		}

		async function openMenu(ctx: ExtensionContext) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Snippet menu requires interactive mode", "warning");
				return;
			}

			snippets = getSnippets(ctx);
			enabled = new Set([...enabled].filter((id) => snippets.some((s) => s.id === id)));

			if (snippets.length === 0) {
				ctx.ui.notify("No snippets found in bundled, global, or project snippet directories", "warning");
				updateWidget(ctx);
				return;
			}

			const working = new Set(enabled);

			const confirmed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
				const prepends = snippets.filter((s) => s.placement === "prepend");
				const appends = snippets.filter((s) => s.placement === "append");
				const items = [...prepends, ...appends];

				let mode: "list" | "preview" = "list";
				let cursor = 0;
				let listScroll = 0;
				let previewScroll = 0;

				const itemRow = (snippet: Snippet, idx: number, width: number): string => {
					const pointer = idx === cursor ? theme.fg("accent", "> ") : "  ";
					const checkbox = working.has(snippet.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					const desc = snippet.description ? theme.fg("dim", ` — ${snippet.description}`) : "";
					return truncateToWidth(`${pointer}${checkbox} ${theme.bold(snippet.name)}${desc}`, width);
				};

				const buildListRows = (width: number): { text: string; itemIndex: number | null }[] => {
					const rows: { text: string; itemIndex: number | null }[] = [];
					if (prepends.length > 0) {
						rows.push({ text: theme.fg("dim", "↑ PREPEND — added before your message"), itemIndex: null });
						prepends.forEach((s, i) => rows.push({ text: itemRow(s, i, width), itemIndex: i }));
					}
					if (prepends.length > 0 && appends.length > 0) {
						rows.push({ text: "", itemIndex: null });
					}
					if (appends.length > 0) {
						rows.push({ text: theme.fg("dim", "↓ APPEND — added after your message"), itemIndex: null });
						appends.forEach((s, i) =>
							rows.push({
								text: itemRow(s, prepends.length + i, width),
								itemIndex: prepends.length + i,
							}),
						);
					}
					return rows;
				};

				const buildPreviewRows = (snippet: Snippet, width: number): string[] => {
					const rows: string[] = [];
					rows.push(truncateToWidth(theme.bold(snippet.name), width));
					const sourceInfo = snippet.source ? ` · [${snippet.source}]` : "";
					rows.push(
						truncateToWidth(
							theme.fg("dim", `${snippet.placement} · order ${snippet.order}${sourceInfo} · ${snippet.id}`),
							width,
						),
					);
					rows.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
					for (const line of snippet.body.split("\n")) {
						for (const wrapped of wrapTextWithAnsi(line, width)) {
							rows.push(truncateToWidth(wrapped, width));
						}
					}
					return rows;
				};

				const viewport = (
					lines: string[],
					scroll: number,
					maxView: number,
					focusRow?: number,
				): { out: string[]; scroll: number } => {
					const clipped = lines.length > maxView;
					const view = clipped ? Math.max(1, maxView - 2) : maxView;

					let s = Math.min(Math.max(0, scroll), Math.max(0, lines.length - view));
					if (focusRow !== undefined) {
						if (focusRow < s) s = focusRow;
						else if (focusRow >= s + view) s = focusRow - view + 1;
					}

					const visible = lines.slice(s, s + view);
					if (!clipped) return { out: visible, scroll: s };

					const above = s;
					const below = lines.length - (s + view);
					return {
						out: [
							above > 0 ? theme.fg("dim", `  ↑ ${above} more`) : "",
							...visible,
							below > 0 ? theme.fg("dim", `  ↓ ${below} more`) : "",
						],
						scroll: s,
					};
				};

				return {
					render(width: number): string[] {
						const maxView = Math.max(5, tui.terminal.rows - 10);

						let content: string[];
						let title: string;
						let hints: string;
						if (mode === "list") {
							const rows = buildListRows(width);
							const cursorRow = rows.findIndex((r) => r.itemIndex === cursor);
							const v = viewport(
								rows.map((r) => r.text),
								listScroll,
								maxView,
								cursorRow >= 0 ? cursorRow : 0,
							);
							content = v.out;
							listScroll = v.scroll;
							title = "Prompt snippets";
							hints = "↑↓ navigate • Space toggle • Tab preview • Enter apply • Esc cancel";
						} else {
							const snippet = items[cursor];
							const rows = buildPreviewRows(snippet, width);
							const v = viewport(rows, previewScroll, maxView);
							content = v.out;
							previewScroll = v.scroll;
							title = `Preview: ${snippet.name}`;
							hints = "↑↓ scroll • Tab/Esc back";
						}

						return [
							theme.fg("accent", "─".repeat(width)),
							truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width),
							"",
							...content,
							"",
							truncateToWidth(theme.fg("dim", ` ${hints}`), width),
							theme.fg("accent", "─".repeat(width)),
						];
					},
					invalidate() {},
					handleInput(data: string) {
						if (mode === "list") {
							if (matchesKey(data, Key.up)) {
								cursor = (cursor - 1 + items.length) % items.length;
								tui.requestRender();
							} else if (matchesKey(data, Key.down)) {
								cursor = (cursor + 1) % items.length;
								tui.requestRender();
							} else if (matchesKey(data, Key.space)) {
								const id = items[cursor].id;
								if (working.has(id)) working.delete(id);
								else working.add(id);
								tui.requestRender();
							} else if (matchesKey(data, Key.tab)) {
								mode = "preview";
								previewScroll = 0;
								tui.requestRender();
							} else if (matchesKey(data, Key.enter)) {
								done(true);
							} else if (matchesKey(data, Key.escape)) {
								done(false);
							}
						} else {
							if (matchesKey(data, Key.up)) {
								previewScroll--;
								tui.requestRender();
							} else if (matchesKey(data, Key.down)) {
								previewScroll++;
								tui.requestRender();
							} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
								mode = "list";
								tui.requestRender();
							}
						}
					},
				};
			});

			if (confirmed) {
				enabled = working;
			}
			updateWidget(ctx);
		}

		pi.on("session_start", (_event, ctx) => {
			enabled = new Set();
			snippets = getSnippets(ctx);
			updateWidget(ctx);
		});

		pi.on("input", async (event, ctx) => {
			if (enabled.size === 0) return;

			snippets = getSnippets(ctx);
			const active = snippets.filter((s) => enabled.has(s.id));
			enabled = new Set();
			updateWidget(ctx);

			if (active.length === 0) return;

			const prependBodies = active.filter((s) => s.placement === "prepend").map((s) => s.body);
			const appendBodies = active.filter((s) => s.placement === "append").map((s) => s.body);
			return {
				action: "transform",
				text: [...prependBodies, event.text, ...appendBodies].join("\n\n"),
			};
		});

		pi.registerShortcut("alt+s", {
			description: "Toggle prompt snippets",
			handler: async (ctx) => {
				await openMenu(ctx);
			},
		});

		pi.registerCommand("snippets", {
			description: "Open the prompt snippet toggle menu",
			handler: async (_args, ctx) => {
				await openMenu(ctx);
			},
		});
	};
}

export default createPromptSnippetsExtension();
