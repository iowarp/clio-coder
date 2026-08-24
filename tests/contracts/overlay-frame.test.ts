import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, Terminal, TUI } from "../../src/engine/tui.js";
import { TuiAltScreen, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { buildLayout } from "../../src/interactive/layout.js";
import {
	ClioOverlayFrame,
	diagnosticSeverityToken,
	frameAlignForAnchor,
	runtimeResolutionDiagnosticLine,
	showClioOverlayFrame,
} from "../../src/interactive/overlay-frame.js";
import {
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
	permissionOverlayPlacement,
	permissionOverlayTitle,
	permissionOverlayTone,
} from "../../src/interactive/permission-overlay.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu");

const stripAnsi = (text: string): string => text.replace(ANSI, "");

function bodyOf(lines: string[]): Component {
	return { render: () => lines, invalidate: () => undefined };
}

class OverlayLayoutTerminal implements Terminal {
	columns = 140;
	rows = 120;
	readonly kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class OverlayLayoutProbe extends TuiMainScreen {
	override requestRender(): void {}

	composite(lines: string[], width: number, height: number): string[] {
		return this.compositeOverlays(lines, width, height);
	}
}

class FullscreenOverlayLayoutProbe extends TuiAltScreen {
	override requestRender(): void {}
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

	// The engine takes the top of an overlay and drops the rest, so a box taller
	// than the terminal lost its bottom border and with it the "[Esc] close"
	// hint. Measured at 40x12, where the memory overlay is nineteen rows: the
	// operator was left inside a modal with no visible way out.
	it("keeps the border and hint when the body is taller than the terminal", () => {
		const body = Array.from({ length: 17 }, (_, index) => `row ${index}`);
		const frame = new ClioOverlayFrame(bodyOf(body), "Memory", "[Esc] close", 40, "center");
		frame.setRowBudget(12);
		const lines = frame.render(40).map(stripAnsi);

		strictEqual(lines.length, 12, "the box fits the rows it was given");
		ok(lines[0]?.startsWith("┌─ Memory"), lines[0]);
		ok(lines[11]?.includes("[Esc] close"), lines[11]);
		ok(lines[10]?.includes("more rows"), `dropped rows are counted, got: ${lines[10]}`);
		ok(lines[1]?.includes("row 0"), "the body starts at its first row");
	});

	it("does not trim a body that already fits, and does not trim without a budget", () => {
		const body = ["a", "b", "c"];
		const fits = new ClioOverlayFrame(bodyOf(body), "T", "[Esc] close", 30, "center");
		fits.setRowBudget(12);
		strictEqual(fits.render(30).length, 5);

		const unknown = new ClioOverlayFrame(bodyOf(Array.from({ length: 40 }, () => "x")), "T", undefined, 30, "center");
		strictEqual(unknown.render(30).length, 42, "no budget means no clamp");
	});

	it("takes its row budget from the engine's visibility probe, honoring margins and maxHeight", () => {
		let probe: ((w: number, h: number) => boolean) | undefined;
		let component: ClioOverlayFrame | undefined;
		const tui = {
			showOverlay: (child: Component, options?: OverlayOptions): OverlayHandle => {
				component = child as ClioOverlayFrame;
				probe = options?.visible;
				return {} as OverlayHandle;
			},
		} as unknown as TUI;
		const body = Array.from({ length: 30 }, (_, index) => `r${index}`);

		showClioOverlayFrame(tui, bodyOf(body), {
			anchor: "center",
			width: 40,
			maxHeight: "50%",
			margin: 1,
			title: "Settings",
			footerHint: "[Esc] close",
		});

		// 24 rows, margin 1 top and bottom leaves 22; maxHeight 50% asks for 12.
		probe?.(80, 24);
		strictEqual(component?.render(40).length, 12);
		// A short terminal wins over the caller's request.
		probe?.(80, 8);
		strictEqual(component?.render(40).length, 4);
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

	it("keeps a permission dialog beside a live composer as its height and the viewport change", () => {
		const terminal = new OverlayLayoutTerminal();
		const tui = new OverlayLayoutProbe(terminal);
		const editor = new ClioEditor(tui, {
			getModelLabel: () => "mini·ornith1.5-35b-moe",
			getThinkingLabel: () => "off",
			isStreaming: () => true,
			isAwaitingApproval: () => true,
			willEnterSteer: (text) => text.trim().length > 0,
		});
		editor.focused = true;
		const footer = bodyOf(["footer primary", "footer secondary"]);
		const transcript = bodyOf(Array.from({ length: 110 }, (_, index) => `transcript row ${index}`));
		tui.addChild(
			buildLayout({
				banner: bodyOf([]),
				chat: transcript,
				editor,
				footer,
			}),
		);
		const view = {
			requestId: "req-layout",
			tool: "bash",
			actionClass: "execute" as const,
			axis: { kind: "net" as const, ruleId: "bash-confirm" },
			origin: { kind: "main" as const },
			reason: "approval required",
			target: "npm test",
		};
		showClioOverlayFrame(tui, createPermissionOverlayBody(view), {
			...permissionOverlayPlacement(tui, editor, footer),
			width: PERMISSION_OVERLAY_WIDTH,
			title: permissionOverlayTitle(view),
			tone: permissionOverlayTone(view),
			footerHint: permissionOverlayHint,
		});

		const placementAt = (
			rows: number,
			draft: string,
		): { composerTop: number; editorHeight: number; first: number; firstInViewport: number; last: number } => {
			terminal.rows = rows;
			editor.setText(draft);
			const base = tui.render(terminal.columns);
			const composerTop = base.map(stripAnsi).findIndex((line) => line.startsWith("CONFIRM "));
			ok(composerTop >= 0, `the live composer is present at ${rows} rows`);
			const editorHeight = editor.render(terminal.columns).length;
			const frame = tui.composite(base, terminal.columns, rows).map(stripAnsi);
			const first = frame.findIndex((line) => line.includes("Safety-net confirmation"));
			let last = frame.length - 1;
			while (last >= 0 && !(frame[last]?.includes("└") && frame[last]?.includes("[Esc] deny"))) last -= 1;
			ok(first >= 0 && last >= first, `permission frame is present at ${rows} rows`);
			const viewportStart = Math.max(0, frame.length - rows);
			return { composerTop, editorHeight, first, firstInViewport: first - viewportStart, last };
		};

		const empty = placementAt(72, "");
		strictEqual(empty.editorHeight, 3, "the empty composer owns its two rails and one input row");
		strictEqual(empty.last, empty.composerTop - 1, "the dialog ends immediately above the empty composer");

		const multiline = placementAt(72, "first line\nsecond line\nthird line\nfourth line");
		strictEqual(multiline.editorHeight, 6, "four draft rows grow the live composer to six rows");
		strictEqual(multiline.last, multiline.composerTop - 1, "the taller composer remains unobscured");
		strictEqual(multiline.last, empty.last, "the dialog follows the stable top edge as the composer grows downward");
		strictEqual(
			empty.firstInViewport - multiline.firstInViewport,
			3,
			"the three added draft rows increase the live bottom clearance by three",
		);

		const resized = placementAt(120, "first line\nsecond line\nthird line\nfourth line");
		strictEqual(resized.last, resized.composerTop - 1, "the dialog remains adjacent after a 48-row resize");
		strictEqual(resized.first, multiline.first, "resizing preserves the frame's attachment to the flowing composer");
	});

	it("derives fullscreen permission clearance from the live composer height", () => {
		const terminal = new OverlayLayoutTerminal();
		const tui = new FullscreenOverlayLayoutProbe(terminal);
		const editor = new ClioEditor(tui, {
			getModelLabel: () => "mini·ornith1.5-35b-moe",
			getThinkingLabel: () => "off",
			isAwaitingApproval: () => true,
		});
		const footer = bodyOf(["footer primary", "footer secondary"]);
		const placement = permissionOverlayPlacement(tui, editor, footer);
		ok(typeof placement.margin === "object" && placement.margin !== null);

		placement.visible?.(terminal.columns, terminal.rows);
		strictEqual(placement.margin.bottom, 5, "an empty three-row composer and two-row footer reserve five rows");

		editor.setText("first line\nsecond line\nthird line\nfourth line");
		placement.visible?.(terminal.columns, terminal.rows);
		strictEqual(placement.margin.bottom, 8, "the four-row draft increases the live dock clearance to eight rows");
	});
});

describe("contracts/overlay-frame diagnostics", () => {
	it("colors a warning diagnostic amber, not red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "warning", code: "thinking-coerced", message: "xhigh coerced to high" },
			60,
		);
		const warning = theme.fgSequence("warning");
		if (warning.length > 0) {
			ok(line.startsWith(warning), "warning severity renders in the amber warning token");
			ok(!line.startsWith(theme.fgSequence("error")), "warning severity must not render red");
		} else {
			ok(stripAnsi(line).includes("xhigh coerced to high"), "NO_COLOR keeps the warning message legible");
		}
	});

	it("colors an error diagnostic red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "error", code: "model-not-configured", message: "no model" },
			60,
		);
		const error = theme.fgSequence("error");
		if (error.length > 0) {
			ok(line.startsWith(error), "error severity renders in the red error token");
		} else {
			ok(stripAnsi(line).includes("no model"), "NO_COLOR keeps the error message legible");
		}
	});

	it("maps severity to a stable semantic token", () => {
		strictEqual(diagnosticSeverityToken("error"), "error");
		strictEqual(diagnosticSeverityToken("warning"), "warning");
		strictEqual(diagnosticSeverityToken("info"), "muted");
	});
});
