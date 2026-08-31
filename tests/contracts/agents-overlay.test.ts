import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { openAgentsOverlay } from "../../src/interactive/overlays/agents.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";

function captureListOptions(): { tui: TUI; options: () => ListOverlayOptions; view: () => Component } {
	let captured: ListOverlayOptions | null = null;
	let capturedView: Component | null = null;
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
				const frame = component as unknown as { child: Component & { options: ListOverlayOptions } };
				captured = frame.child.options;
				capturedView = frame.child;
				return handle;
			},
			requestRender() {},
		} as unknown as TUI,
		options: () => {
			if (!captured) throw new Error("list overlay options were not captured");
			return captured;
		},
		view: () => {
			if (!capturedView) throw new Error("list overlay view was not captured");
			return capturedView;
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
					{
						id: "scout",
						description: "Fast reconnaissance",
						audience: "shadow",
						category: "research",
						capabilityClass: "read-only",
						skills: [],
					},
					{
						id: "claude-cli",
						description: "External ACP delegation agent",
						audience: "base",
						category: "build",
						capabilityClass: "write",
						skills: [],
						tags: ["delegation", "acp"],
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
		strictEqual(options.onSelect, undefined);
		strictEqual(options.filterable, true);
		deepStrictEqual(
			options.items.map((item) => item.group),
			["Fleet agents", "Fleet agents", "ACP delegation agents"],
		);
		ok(options.items[0]?.meta?.includes("base/build/write"));
		ok(options.items[1]?.meta?.includes("shadow/research/read-only"));
		ok(options.items[2]?.meta?.includes("governance=clio-policy"));
		strictEqual(
			options.items.filter((item) => item.id === "claude-cli").length,
			1,
			"ACP delegation specs should appear only in their dedicated group",
		);
		strictEqual(options.items.find((item) => item.id === "claude-cli")?.group, "ACP delegation agents");
	});

	it("opens detail with Enter and reserves Esc for closing", () => {
		const mounted = captureListOptions();
		let closes = 0;
		openAgentsOverlay(
			mounted.tui,
			{
				listAgents: () => [
					{
						id: "architect",
						description: "Designs bounded changes",
						audience: "base",
						category: "plan",
						capabilityClass: "artifact-write",
						skills: ["cut-it"],
					},
				],
				listDelegationAgents: () => [],
			} as never,
			() => {
				closes += 1;
			},
		);

		const view = mounted.view();
		ok(!view.render(100).some((line) => line.includes("Fleet Agent: architect")));
		view.handleInput?.("\r");
		ok(view.render(100).some((line) => line.includes("Fleet Agent: architect")));
		strictEqual(closes, 0, "Enter activates the advertised detail pane");

		view.handleInput?.("\r");
		ok(!view.render(100).some((line) => line.includes("Fleet Agent: architect")));
		strictEqual(closes, 0, "a second Enter toggles detail closed without closing the overlay");

		view.handleInput?.("\u001b");
		strictEqual(closes, 1, "Esc is the overlay close key");
	});
});
