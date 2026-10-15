import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadSnippets, parseSnippet } from "./loader.js";
import {
	deleteSnippet, hideSnippet, readSnapshot, saveSnippet, snippetDirectory,
	type SnippetDraft, type WritableScope,
} from "./management-store.js";
import type { LoadSnippetsOptions, Snippet } from "./types.js";

const FIELD_HELP = {
	name: "Display name in the snippet menu. Use a short, recognizable label, e.g. Concise answers.",
	description: "Optional subtitle explaining when to use this snippet. Not sent to the model.",
	placement: "Prepend inserts instructions before your message; append inserts them after your message.",
	order: "Whole number controlling sequence within the prepend or append group. Lower numbers appear first: 10 before 20. Ties sort by name. This is not instruction priority.",
	body: "The instructions inserted into your message when this snippet is active. Multiple lines are allowed.",
	id: "Unique .md filename, e.g. concise-answers.md. This is the snippet ID; matching filenames override lower-priority sources. No folders.",
};

/** A prefilled single-line input, with the host's confirm/cancel bindings. */
async function editText(ctx: ExtensionContext, title: string, value: string, help: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.setValue(value);
		let finished = false;
		const finish = (result: string | undefined) => {
			if (finished) return;
			finished = true;
			done(result);
		};
		input.onSubmit = finish;
		input.onEscape = () => finish(undefined);
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", title), width),
					...wrapTextWithAnsi(theme.fg("dim", `Tip: ${help}`), width),
					"",
					...input.render(width),
					truncateToWidth(theme.fg("dim", "Enter accept field • Esc back • Save in the details screen to persist"), width),
				];
			},
			invalidate() { input.invalidate(); },
			handleInput(data: string) {
				if (finished) return;
				if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) finish(undefined);
				else if (keybindings.matches(data, "tui.select.confirm")) finish(input.getValue());
				else input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export function createSnippetManager() {
	let lastScope: WritableScope = "global";

	async function chooseScope(ctx: ExtensionContext, options: LoadSnippetsOptions): Promise<WritableScope | undefined> {
		const scopes: WritableScope[] = options.isProjectTrusted === false ? ["global"] : [lastScope, lastScope === "global" ? "project" : "global"];
		const labels = scopes.map((scope) => `${scope === "global" ? "Global" : "This project"} — ${snippetDirectory(options, scope)}`);
		const choice = await ctx.ui.select("Save location", labels);
		if (choice === undefined) return;
		lastScope = scopes[labels.indexOf(choice)];
		return lastScope;
	}

	async function editDraft(ctx: ExtensionContext, options: LoadSnippetsOptions, original?: Snippet, duplicate = false) {
		const scope = original && !duplicate && original.source !== "bundled" ? original.source : await chooseScope(ctx, options);
		if (!scope) return;
		const isEdit = original && !duplicate && original.source !== "bundled";
		let expected: string | null = null;
		let source = original;
		if (isEdit) {
			const path = join(snippetDirectory(options, scope), original.id);
			expected = readSnapshot(path);
			if (expected === null) throw new Error("Snippet was removed. Reopen management to refresh.");
			source = parseSnippet(original.id, expected, scope, path).snippet ?? undefined;
			if (!source) throw new Error("Snippet is now hidden or invalid. Reopen management to refresh.");
		}
		const draft: SnippetDraft = {
			id: source ? (duplicate ? source.id.replace(/\.md$/i, "-copy.md") : source.id) : "new-snippet.md",
			name: source ? `${source.name}${duplicate ? " (copy)" : ""}` : "",
			description: source?.description ?? "",
			placement: source?.placement ?? "append",
			order: source?.order ?? 10,
			body: source?.body ?? "",
		};
		const initial = JSON.stringify(draft);
		while (true) {
			const fields = [
				`Name: ${draft.name || "(required)"}`,
				`Description: ${draft.description || "(none)"}`,
				`Placement: ${draft.placement}`,
				`Order: ${draft.order}`,
				`Prompt body: ${draft.body.split("\n")[0] || "(empty)"}`,
				...(!original || duplicate ? [`Filename: ${draft.id}`] : []),
				"Save snippet", "Discard changes",
			];
			const path = join(snippetDirectory(options, scope), draft.id);
			const choice = await ctx.ui.select(`Snippet details [${scope}] — ${path}`, fields);
			const field = fields.indexOf(choice ?? "");
			if (choice === undefined || choice === "Discard changes") {
				if (JSON.stringify(draft) === initial || await ctx.ui.confirm("Discard unsaved snippet?", "No file changes have been saved.")) return;
				continue;
			}
			if (choice === "Save snippet") {
				try {
					await saveSnippet(options, scope, draft, expected);
					const effective = loadSnippets(options).find((s) => s.id === draft.id);
					ctx.ui.notify(`Saved ${path}${effective?.source !== scope ? " (hidden by configuration or a higher-priority snippet)" : ""}`, "info");
					return;
				} catch (error) {
					ctx.ui.notify(String(error), "error");
					continue;
				}
			}
			if (field === 2) {
				const placement = await ctx.ui.select(`Edit placement\n${ctx.ui.theme.fg("dim", `Tip: ${FIELD_HELP.placement}`)}`, ["prepend", "append"]);
				if (placement === "prepend" || placement === "append") draft.placement = placement;
			} else if (field === 4) {
				const body = await ctx.ui.editor(`Edit prompt body\n${ctx.ui.theme.fg("dim", `Tip: ${FIELD_HELP.body} Return to details, then Save snippet.`)}`, draft.body);
				if (body !== undefined) draft.body = body;
			} else if (field >= 0) {
				const key = (["name", "description", "", "order", "", "id"] as const)[field];
				if (!key) continue;
				const value = await editText(ctx, `Edit ${key === "id" ? "filename" : key}`, String(draft[key]), FIELD_HELP[key]);
				if (value === undefined) continue;
				if (key === "order") {
					const order = value.trim() ? Number(value) : NaN;
					if (Number.isSafeInteger(order)) draft.order = order;
					else ctx.ui.notify("Order must be a whole number", "warning");
				} else draft[key] = value;
			}
		}
	}

	async function restoreHidden(ctx: ExtensionContext, options: LoadSnippetsOptions) {
		const hidden: { scope: WritableScope; id: string; raw: string; label: string }[] = [];
		for (const scope of ["global", "project"] as const) {
			if (scope === "project" && options.isProjectTrusted === false) continue;
			const dir = snippetDirectory(options, scope);
			let files;
			try { files = readdirSync(dir, { withFileTypes: true }); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
				const id = entry.name;
				let raw: string | null;
				try { raw = readSnapshot(join(dir, id)); } catch {
					// An unrelated unreadable or concurrently replaced file must not block restoration.
					continue;
				}
				// Only offer tombstones, never delete a disabled user snippet's prompt body.
				const body = raw?.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1];
				if (raw !== null && body?.trim() === "" && parseSnippet(id, raw, scope, join(dir, id)).disabled) {
					hidden.push({ scope, id, raw, label: `${id} [${scope}]` });
				}
			}
		}
		if (!hidden.length) {
			ctx.ui.notify("No file-hidden snippets. Snippets disabled in prompt-snippets.json must be restored there.", "info");
			return;
		}
		const choice = await ctx.ui.select("Restore hidden snippet", hidden.map((h) => h.label));
		const item = hidden.find((h) => h.label === choice);
		if (!item || !await ctx.ui.confirm("Remove hiding file?", `${join(snippetDirectory(options, item.scope), item.id)}\nRemoves this file to reveal any lower-priority snippet. Configuration may still hide it.`)) return;
		await deleteSnippet(options, item.scope, item.id, item.raw);
		ctx.ui.notify("Hiding file removed", "info");
	}

	return async function manageSnippet(ctx: ExtensionContext, options: LoadSnippetsOptions, selectedId?: string) {
		try {
			const selected = loadSnippets(options).find((s) => s.id === selectedId);
			const actions = ["New snippet", ...(selected ? ["Edit snippet", "Duplicate snippet", selected.source === "bundled" ? "Hide snippet" : "Delete snippet"] : []), "Restore hidden snippet", "Back to snippets"];
			const action = await ctx.ui.select(selected ? `Manage: ${selected.name} [${selected.source}] — ${selected.filePath}` : "Manage snippets", actions);
			if (action === "New snippet") await editDraft(ctx, options);
			else if (action === "Edit snippet" && selected) await editDraft(ctx, options, selected);
			else if (action === "Duplicate snippet" && selected) await editDraft(ctx, options, selected, true);
			else if (action === "Restore hidden snippet") await restoreHidden(ctx, options);
			else if (action === "Hide snippet" && selected) {
				const scope = await chooseScope(ctx, options);
				if (!scope) return;
				const path = join(snippetDirectory(options, scope), selected.id);
				if (!await ctx.ui.confirm("Hide bundled snippet?", `Create ${path}\nThe bundled file is never modified. Use Restore hidden snippet to undo.`)) return;
				await hideSnippet(options, scope, selected.id, null);
				ctx.ui.notify(`Hidden ${selected.name} [${scope}]`, "info");
			} else if (action === "Delete snippet" && selected && selected.source !== "bundled") {
				const path = join(snippetDirectory(options, selected.source), selected.id);
				const expected = readSnapshot(path);
				if (expected === null) throw new Error("Snippet was already removed");
				// Resolve a preview without the selected layer; configurations still apply.
				const lower = selected.source === "project"
					? loadSnippets({ ...options, isProjectTrusted: false }).find((s) => s.id === selected.id)
					: undefined;
				const reveal = lower ? `Restore ${lower.source} version: ${lower.name}.` : "Any lower-priority version will become visible unless disabled by configuration.";
				if (!await ctx.ui.confirm("Delete snippet file?", `${path}\n${reveal}\nThis cannot be undone.`)) return;
				await deleteSnippet(options, selected.source, selected.id, expected);
				ctx.ui.notify(`Deleted ${path}`, "info");
			}
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	};
}
