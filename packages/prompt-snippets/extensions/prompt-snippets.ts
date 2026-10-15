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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadSnippets } from "./loader.js";
import { createSnippetManager } from "./management-ui.js";
import type { LoadSnippetsOptions, Snippet } from "./types.js";

const WIDGET_ID = "prompt-snippets";
const USAGE_ENTRY_TYPE = "prompt-snippets:usage";
const AUDIT_MARKER = "[prompt-snippets audit request]";
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createPromptSnippetsExtension(extensionOptions: LoadSnippetsOptions = {}) {
	return function promptSnippetsExtension(pi: ExtensionAPI) {
		let snippets: Snippet[] = [];
		let enabled = new Set<string>();
		const manageSnippet = createSnippetManager();
		let menuOpen = false;

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
			if (!ctx.hasUI || ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Snippet menu requires interactive mode", "warning");
				return;
			}

			if (menuOpen) return;
			menuOpen = true;
			try {
				snippets = getSnippets(ctx);
				enabled = new Set([...enabled].filter((id) => snippets.some((s) => s.id === id)));
				const working = new Set(enabled);
				let cursor = 0;
				let listScroll = 0;

				while (true) {
					const confirmed = await ctx.ui.custom<boolean | { manage: true; id?: string }>((tui, theme, keybindings, done) => {
						const prepends = snippets.filter((s) => s.placement === "prepend");
						const appends = snippets.filter((s) => s.placement === "append");
						const items = [...prepends, ...appends];

						let mode: "list" | "preview" = "list";
						let previewScroll = 0;
						let finished = false;
						const finish = (result: boolean | { manage: true; id?: string }) => {
							if (finished) return;
							finished = true;
							done(result);
						};

						const isUp = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.up") : matchesKey(data, Key.up));
						const isDown = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.down") : matchesKey(data, Key.down));
						const isPageUp = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.pageUp") : matchesKey(data, Key.pageUp));
						const isPageDown = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.pageDown") : matchesKey(data, Key.pageDown));
						const isConfirm = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.confirm") : matchesKey(data, Key.enter));
						const isCancel = (data: string) =>
							Boolean(keybindings?.matches ? keybindings.matches(data, "tui.select.cancel") : matchesKey(data, Key.escape));

						const itemRow = (snippet: Snippet, idx: number, width: number): string => {
							const pointer = idx === cursor ? theme.fg("accent", "> ") : "  ";
							const checkbox = working.has(snippet.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
							const desc = snippet.description ? theme.fg("dim", ` — ${snippet.description}`) : "";
							return truncateToWidth(`${pointer}${checkbox} ${theme.bold(snippet.name)} ${theme.fg("dim", `[${snippet.source}]`)}${desc}`, width);
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
							if (items.length === 0) rows.push({ text: truncateToWidth("No snippets. Press Ctrl+E to create one or restore hidden snippets.", width), itemIndex: null });
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
										rows.map((r) => truncateToWidth(r.text, width)),
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
									...(mode === "list" ? [truncateToWidth(theme.fg("dim", " Ctrl+E manage snippets (new / edit / delete)"), width)] : []),
									theme.fg("accent", "─".repeat(width)),
								];
							},
							invalidate() {},
							handleInput(data: string) {
								if (finished) return;
								const maxView = Math.max(5, tui.terminal.rows - 10);
								const pageSize = Math.max(1, maxView - 2);

								if (mode === "list") {
									if (matchesKey(data, Key.ctrl("e"))) {
										finish({ manage: true, id: items[cursor]?.id });
									} else if (isConfirm(data)) {
										finish(true);
									} else if (isCancel(data)) {
										finish(false);
									} else if (items.length === 0) {
										return;
									} else if (isUp(data)) {
										cursor = (cursor - 1 + items.length) % items.length;
										tui.requestRender();
									} else if (isDown(data)) {
										cursor = (cursor + 1) % items.length;
										tui.requestRender();
									} else if (isPageUp(data)) {
										cursor = Math.max(0, cursor - pageSize);
										tui.requestRender();
									} else if (isPageDown(data)) {
										cursor = Math.min(items.length - 1, cursor + pageSize);
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
									}
								} else {
									if (isUp(data)) {
										previewScroll = Math.max(0, previewScroll - 1);
										tui.requestRender();
									} else if (isDown(data)) {
										previewScroll++;
										tui.requestRender();
									} else if (isPageUp(data)) {
										previewScroll = Math.max(0, previewScroll - pageSize);
										tui.requestRender();
									} else if (isPageDown(data)) {
										previewScroll += pageSize;
										tui.requestRender();
									} else if (matchesKey(data, Key.tab) || isCancel(data)) {
										mode = "list";
										tui.requestRender();
									}
								}
							},
						};
					});

					if (typeof confirmed === "object" && confirmed?.manage) {
						await manageSnippet(ctx, {
							...extensionOptions,
							cwd: ctx.cwd,
							isProjectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
						}, confirmed.id);
						snippets = getSnippets(ctx);
						const ids = new Set(snippets.map((s) => s.id));
						for (const id of working) if (!ids.has(id)) working.delete(id);
						enabled = new Set([...enabled].filter((id) => ids.has(id)));
						const selectedIndex = snippets.findIndex((s) => s.id === confirmed.id);
						cursor = selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(cursor, snippets.length - 1));
						updateWidget(ctx);
						continue;
					}
					if (confirmed) enabled = working;
					break;
				}
			} finally {
				menuOpen = false;
				updateWidget(ctx);
			}
		}

		pi.on("session_start", (_event, ctx) => {
			enabled = new Set();
			snippets = getSnippets(ctx);
			updateWidget(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			enabled = new Set();
			if (ctx.hasUI && ctx.mode === "tui") {
				ctx.ui.setWidget(WIDGET_ID, undefined);
			}
		});

		pi.on("input", async (event, ctx) => {
			if (event.text.startsWith(AUDIT_MARKER) || enabled.size === 0) return;

			snippets = getSnippets(ctx);
			const active = snippets.filter((s) => enabled.has(s.id));
			enabled = new Set();
			updateWidget(ctx);

			if (active.length === 0) return;

			const prependBodies = active.filter((s) => s.placement === "prepend").map((s) => s.body);
			const appendBodies = active.filter((s) => s.placement === "append").map((s) => s.body);
			pi.appendEntry(USAGE_ENTRY_TYPE, {
				snippets: active.map((s) => ({ id: s.id, source: s.source })),
			});
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

		pi.registerCommand("snippets-audit", {
			description: "Analyze past prompts and recorded snippet usage",
			handler: async (args, ctx) => {
				if (!ctx.isIdle()) {
					if (ctx.hasUI) ctx.ui.notify("Wait for the current turn before auditing snippets", "warning");
					return;
				}
				const instructions = readFileSync(join(packageDir, "audit", "INSTRUCTIONS.md"), "utf8");
				pi.sendUserMessage(`${AUDIT_MARKER}\n${instructions}\n\nBundled script: ${join(packageDir, "audit", "prompts.py")}\nPackage: ${packageDir}\nUser scope: ${args.trim() || "last 30 days, all projects"}`);
			},
		});
	};
}

export default createPromptSnippetsExtension();
