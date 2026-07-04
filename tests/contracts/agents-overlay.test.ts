import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { openAgentsOverlay } from "../../src/interactive/overlays/agents.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";

function captureListOptions(): { tui: TUI; options: () => ListOverlayOptions } {
	let captured: ListOverlayOptions | null = null;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	return {
		tui: {
			showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
				const frame = component as unknown as { child: { options: ListOverlayOptions } };
				captured = frame.child.options;
				return handle;
			},
			requestRender() {},
		} as unknown as TUI,
		options: () => {
			if (!captured) throw new Error("list overlay options were not captured");
			return captured;
		},
	};
}

describe("contracts/agents-overlay", () => {
	it("mounts fleet and ACP delegation agents as list-overlay groups", () => {
		const mounted = captureListOptions();
		openAgentsOverlay(
			mounted.tui,
			{
				listAgents: () => [
					{
						id: "coder",
						description: "Implement bounded changes",
						audience: "base",
						category: "build",
						capabilityClass: "write",
						skills: ["typescript"],
					},
				],
				listDelegationAgents: () => [
					{
						id: "claude-cli",
						command: "claude",
						args: ["--acp"],
						toolGovernance: "clio-policy",
						labels: { runtime: "acp" },
					},
				],
			} as never,
			() => {},
		);

		const options = mounted.options();
		strictEqual(options.title, "Agents Reference");
		strictEqual(options.mode, "browse");
		strictEqual(options.filterable, true);
		deepStrictEqual(
			options.items.map((item) => item.group),
			["Fleet agents", "ACP delegation agents"],
		);
		ok(options.items[0]?.meta?.includes("base/build/write"));
		ok(options.items[1]?.meta?.includes("governance=clio-policy"));
	});
});
