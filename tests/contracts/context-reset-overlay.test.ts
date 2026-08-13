import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	buildContextResetItems,
	contextResetOptions,
	openContextResetOverlay,
} from "../../src/interactive/overlays/context-reset.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function overlayHarness(): {
	tui: TUI;
	component: () => Component;
} {
	let mounted: Component | null = null;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const tui = {
		showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
			mounted = component;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("context reset overlay was not mounted");
			return mounted;
		},
	};
}

describe("contracts/context-reset overlay", () => {
	it("offers exactly preserve CLIO.md, delete CLIO.md, and cancel", () => {
		deepStrictEqual(
			buildContextResetItems().map((item) => ({ value: item.value, label: item.label })),
			[
				{ value: "preserve-clio-md", label: "Preserve CLIO.md" },
				{ value: "delete-clio-md", label: "Delete CLIO.md" },
				{ value: "cancel", label: "Cancel" },
			],
		);
		deepStrictEqual(contextResetOptions("preserve-clio-md"), { confirmed: true });
		deepStrictEqual(contextResetOptions("delete-clio-md"), {
			all: true,
			confirmed: true,
			confirmedAll: true,
		});
	});

	it("routes both Cancel and Esc away from the mutating callback", () => {
		for (const inputs of [[DOWN, DOWN, "\r"], [ESC]]) {
			const mounted = overlayHarness();
			const mutations: string[] = [];
			let cancellations = 0;
			openContextResetOverlay(mounted.tui, {
				onReset: (choice) => mutations.push(choice),
				onCancel: () => {
					cancellations += 1;
				},
			});

			for (const input of inputs) mounted.component().handleInput?.(input);
			deepStrictEqual(mutations, [], `${JSON.stringify(inputs)} must not request a reset`);
			strictEqual(cancellations, 1, `${JSON.stringify(inputs)} takes the cancellation path once`);
		}
	});

	it("commits the selected preserve or delete choice", () => {
		for (const testCase of [
			{ inputs: ["\r"], expected: "preserve-clio-md" },
			{ inputs: [DOWN, "\r"], expected: "delete-clio-md" },
		]) {
			const mounted = overlayHarness();
			const mutations: string[] = [];
			openContextResetOverlay(mounted.tui, {
				onReset: (choice) => mutations.push(choice),
				onCancel: () => mutations.push("cancel"),
			});
			for (const input of testCase.inputs) mounted.component().handleInput?.(input);
			deepStrictEqual(mutations, [testCase.expected]);
		}
	});

	it("keeps three choices and one footer row at narrow and normal widths", () => {
		const mounted = overlayHarness();
		openContextResetOverlay(mounted.tui, { onReset() {}, onCancel() {} });

		for (const width of [40, 72]) {
			const lines = mounted.component().render(width);
			const clean = lines.map(stripAnsi);
			strictEqual(lines.length, 5, `${width} columns render frame + three choices + one footer`);
			for (const line of lines) {
				strictEqual(visibleWidth(line), width, `${width}-column row must neither wrap nor overflow: ${stripAnsi(line)}`);
			}
			ok(clean.some((line) => line.includes("Preserve CLIO.md")));
			ok(clean.some((line) => line.includes("Delete CLIO.md")));
			ok(clean.some((line) => line.includes("Cancel")));
			strictEqual(clean.filter((line) => line.includes("[Enter] select")).length, 1);
			strictEqual(clean.filter((line) => line.includes("[Esc] close")).length, 1);
		}
	});
});
