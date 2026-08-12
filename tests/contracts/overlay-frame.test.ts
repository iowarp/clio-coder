import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	ClioOverlayFrame,
	diagnosticSeverityToken,
	frameAlignForAnchor,
	runtimeResolutionDiagnosticLine,
	showClioOverlayFrame,
} from "../../src/interactive/overlay-frame.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu");

const stripAnsi = (text: string): string => text.replace(ANSI, "");

function bodyOf(lines: string[]): Component {
	return { render: () => lines, invalidate: () => undefined };
}

describe("contracts/overlay-frame row ownership", () => {
	// The terminal engine composites an overlay across exactly the columns it
	// declares. A frame narrower than the row left the transcript visible on
	// both sides of the border, which spliced two unrelated fragments into one
	// readable sentence. Every row an overlay covers now belongs to it.
	it("blanks the columns beside the box so no transcript survives the row", () => {
		const frame = new ClioOverlayFrame(bodyOf(["one", "two"]), "Allow this action once?", undefined, 40, "center");
		const lines = frame.render(120);

		strictEqual(lines.length, 4);
		for (const line of lines) {
			strictEqual(visibleWidth(line), 120, JSON.stringify(line));
		}
		const stripped = lines.map((line) => stripAnsi(line));
		// 120 columns, a 40-column box, centered: 40 blank columns on each side.
		for (const line of stripped) {
			strictEqual(line.slice(0, 40), " ".repeat(40));
			strictEqual(line.slice(80), " ".repeat(40));
		}
		ok(stripped[0]?.slice(40, 80).startsWith("┌─ Allow this action once? "));
	});

	it("keeps a left-anchored box against the left edge and a right-anchored box against the right", () => {
		const left = new ClioOverlayFrame(bodyOf(["x"]), "T", undefined, 20, "left").render(60).map(stripAnsi);
		const right = new ClioOverlayFrame(bodyOf(["x"]), "T", undefined, 20, "right").render(60).map(stripAnsi);

		ok(left[0]?.startsWith("┌"), left[0]);
		strictEqual(left[0]?.slice(20), " ".repeat(40));
		strictEqual(right[0]?.slice(0, 40), " ".repeat(40));
		ok(right[0]?.slice(40).startsWith("┌"), right[0]);
	});

	// A box wider than the terminal is clamped rather than overflowing, which is
	// what keeps a 100-column overlay legible at 80 and at 40.
	it("clamps a box wider than the row to the row", () => {
		for (const width of [40, 60, 80]) {
			const lines = new ClioOverlayFrame(bodyOf(["body"]), "Tasks", undefined, 100, "center").render(width);
			for (const line of lines) strictEqual(visibleWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
			ok(stripAnsi(lines[0] ?? "").startsWith("┌"), `width ${width} starts at column 0`);
		}
	});

	it("hands the engine the full row and keeps the caller's width as the box width", () => {
		let seen: OverlayOptions | undefined;
		let component: Component | undefined;
		const tui = {
			showOverlay: (child: Component, options?: OverlayOptions): OverlayHandle => {
				component = child;
				seen = options;
				return {} as OverlayHandle;
			},
		} as unknown as TUI;

		showClioOverlayFrame(tui, bodyOf(["body"]), { anchor: "center", width: 44, title: "Memory" });

		strictEqual(seen?.width, "100%");
		strictEqual(seen?.anchor, "center");
		strictEqual(visibleWidth(component?.render(100)[0] ?? ""), 100);
	});

	it("maps every anchor to the horizontal half it names", () => {
		deepStrictEqual((["top-left", "left-center", "bottom-left"] as const).map(frameAlignForAnchor), [
			"left",
			"left",
			"left",
		]);
		deepStrictEqual((["top-right", "right-center", "bottom-right"] as const).map(frameAlignForAnchor), [
			"right",
			"right",
			"right",
		]);
		deepStrictEqual((["top-center", "center", "bottom-center"] as const).map(frameAlignForAnchor), [
			"center",
			"center",
			"center",
		]);
		strictEqual(frameAlignForAnchor(undefined), "center");
	});
});

describe("contracts/overlay-frame diagnostics", () => {
	it("colors a warning diagnostic amber, not red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "warning", code: "thinking-coerced", message: "xhigh coerced to high" },
			60,
		);
		ok(line.startsWith(theme.fgSequence("warning")), "warning severity renders in the amber warning token");
		ok(!line.startsWith(theme.fgSequence("error")), "warning severity must not render red");
	});

	it("colors an error diagnostic red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "error", code: "model-not-configured", message: "no model" },
			60,
		);
		ok(line.startsWith(theme.fgSequence("error")), "error severity renders in the red error token");
	});

	it("maps severity to a stable semantic token", () => {
		strictEqual(diagnosticSeverityToken("error"), "error");
		strictEqual(diagnosticSeverityToken("warning"), "warning");
		strictEqual(diagnosticSeverityToken("info"), "muted");
	});
});
