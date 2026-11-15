import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import bashGuardExtension from "../extensions/index.js";

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

function getResolver(): Resolver {
	let resolver: Resolver | undefined;
	const pi = {
		registerFlag: vi.fn(),
		registerTool: vi.fn(),
		registerToolRenderer: (value: Resolver) => { resolver = value; },
		registerShortcut: vi.fn(),
		on: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	bashGuardExtension(pi);
	return resolver!;
}

describe("bash-guard renderer delegation", () => {
	it.each(["codemode", "get_search_content", "read", "unknown_tool"])(
		"preserves the downstream renderer for %s",
		(toolName) => {
			const base = { renderCall: vi.fn(), renderResult: vi.fn() };
			const next = vi.fn(() => base);
			expect(getResolver()(toolName, next)).toBe(base);
			expect(next).toHaveBeenCalledOnce();
		},
	);

	it("delegates even when no downstream renderer exists", () => {
		const next = vi.fn(() => undefined);
		expect(getResolver()("unknown_tool", next)).toBeUndefined();
		expect(next).toHaveBeenCalledOnce();
	});

	it("decorates bash calls and delegates result formatting", () => {
		const base = { renderCall: vi.fn(), renderResult: vi.fn() };
		const next = vi.fn(() => base);
		const result = getResolver()("bash", next);
		expect(next).toHaveBeenCalledOnce();
		expect(result?.renderCall).not.toBe(base.renderCall);
		const rendered = {};
		base.renderResult.mockReturnValue(rendered);
		const context = { executionStarted: false } as never;
		expect(result?.renderResult?.({ content: [], details: undefined }, { expanded: false, isPartial: false }, undefined as never, context)).toBe(rendered);
		expect(base.renderResult).toHaveBeenCalledWith({ content: [], details: undefined }, { expanded: false, isPartial: false }, undefined, context);
	});
});
