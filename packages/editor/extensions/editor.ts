import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Visible columns of native border preserved before the badge yields. */
export const BADGE_MIN_KEEP = 8;

/** Minimum truncated name width worth displaying (below this, render native). */
export const BADGE_MIN_NAME = 2;

/** Normalize a session name for display. Returns undefined when there is no explicit name. */
export function sanitizeSessionName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
	return cleaned ? cleaned : undefined;
}

/** Trailing padding after the badge so the name never touches the right edge. */
const BADGE_TRAILING = " ──";

/**
 * Compose the session-name badge over an already-rendered native top border.
 * Badge sits on the right (`──── name ──`), one leading space, two trailing
 * dashes, border-colored.
 * Unnamed, narrow, or overlong inputs fall back to the native border untouched,
 * so working status and scroll indicators always keep priority.
 */
export function renderTopBorderWithBadge(
	nativeBorder: string,
	rawName: string | undefined,
	width: number,
	borderColor: (text: string) => string,
): string {
	const name = sanitizeSessionName(rawName);
	if (!name || width <= 0) return nativeBorder;
	const maxNameWidth = width - 1 - visibleWidth(BADGE_TRAILING) - BADGE_MIN_KEEP;
	if (maxNameWidth < BADGE_MIN_NAME) return nativeBorder;
	const clipped = truncateToWidth(name, maxNameWidth, "…");
	const tag = ` ${clipped}${BADGE_TRAILING}`;
	const keep = width - visibleWidth(tag);
	if (keep < BADGE_MIN_KEEP) return nativeBorder;
	return sliceByColumn(nativeBorder, 0, keep) + borderColor(tag);
}

export class NamedSessionEditor extends CustomEditor {
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private getSessionName: () => string | undefined,
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return renderTopBorderWithBadge(
			super.renderTopBorder(width, hiddenLineCount),
			this.getSessionName(),
			width,
			this.borderColor,
		);
	}
}

export default function editorExtension(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	let ourFactory: EditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const existing = ctx.ui.getEditorComponent();
		if (existing !== undefined && existing !== ourFactory) {
			ctx.ui.notify("Session-name badge deferred: another custom editor is active", "info");
			return;
		}
		const sessionCtx = ctx;
		const factory: EditorFactory = (tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new NamedSessionEditor(tui, theme, keybindings, () =>
				sessionCtx.sessionManager.getSessionName(),
			);
		};
		ourFactory = factory;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_info_changed", () => {
		requestRender?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = undefined;
		if (ctx && ourFactory !== undefined && ctx.ui.getEditorComponent() === ourFactory) {
			ctx.ui.setEditorComponent(undefined);
		}
		ourFactory = undefined;
	});
}
