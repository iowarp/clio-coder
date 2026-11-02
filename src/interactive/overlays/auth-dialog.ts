import { type Component, Input, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import { buildHint, FocusBox, fitRow, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, type Fact, factRows, GLYPH, selectionRow, statusChip, titleRow } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";

export const AUTH_DIALOG_WIDTH = 88;

export interface AuthDialogHandle {
	handle: OverlayHandle;
	controller: {
		setLines(lines: ReadonlyArray<string>): void;
		appendLine(line: string): void;
		prompt(label: string): Promise<string>;
		cancel(): void;
		dismiss(): void;
	};
}

function normalizeAuthLine(line: string): string {
	return line.replace(/\.\.\./g, GLYPH.ellipsis);
}

/** `* 1. label` is a choice row; the star marks the one the flow proposes. */
const CHOICE_LINE = /^(?<marker>[* ])\s*(?<index>\d+)\.\s*(?<label>.+)$/u;
/** `Key: value`, with a short word key, is a fact; a URL's `://` is not one. */
const FACT_LINE = /^(?<key>[A-Za-z][A-Za-z ]{0,17}):(?!\/\/)\s*(?<value>.*)$/u;

type AuthRow =
	| { kind: "blank" }
	| { kind: "choice"; focused: boolean; index: string; label: string }
	| { kind: "fact"; label: string; value: string }
	| { kind: "ok"; text: string }
	| { kind: "error"; text: string }
	| { kind: "text"; text: string };

function classifyAuthLine(line: string): AuthRow {
	const normalized = normalizeAuthLine(line).trimEnd();
	if (normalized.length === 0) return { kind: "blank" };
	const choice = CHOICE_LINE.exec(normalized);
	if (choice?.groups) {
		return {
			kind: "choice",
			focused: choice.groups.marker === "*",
			index: choice.groups.index ?? "",
			label: choice.groups.label ?? "",
		};
	}
	if (/^Target ready\b/.test(normalized)) return { kind: "ok", text: normalized };
	if (/^(Target check failed|Unknown selection:)/.test(normalized)) return { kind: "error", text: normalized };
	const fact = FACT_LINE.exec(normalized);
	if (fact?.groups) return { kind: "fact", label: fact.groups.key ?? "", value: fact.groups.value ?? "" };
	return { kind: "text", text: normalized };
}

/**
 * The flow's lines as rows: consecutive facts share one label column, choices
 * draw through the selection rule, outcomes lead with their glyph, and prose
 * wraps. The flow writes plain text; the dialog gives it the dialog grammar.
 */
function renderAuthLines(lines: ReadonlyArray<string>, width: number): string[] {
	const theme = clioTheme();
	const out: string[] = [];
	let facts: Fact[] = [];
	const flushFacts = (): void => {
		if (facts.length > 0) out.push(...factRows(theme, facts, width));
		facts = [];
	};
	for (const line of lines) {
		const row = classifyAuthLine(line);
		if (row.kind === "fact") {
			facts.push({ label: row.label, value: row.value });
			continue;
		}
		flushFacts();
		switch (row.kind) {
			case "blank":
				out.push("");
				break;
			case "choice":
				out.push(...selectionRow(theme, { focused: row.focused, label: `${row.index}. ${row.label}`, width }));
				break;
			case "ok":
				out.push(...wrapTextWithAnsi(statusChip(theme, "ok", row.text), width));
				break;
			case "error":
				out.push(...wrapTextWithAnsi(statusChip(theme, "error", row.text), width));
				break;
			case "text":
				out.push(...wrapTextWithAnsi(theme.fg("body", row.text), width));
				break;
		}
	}
	flushFacts();
	return out;
}

function renderInputWithDesignCursor(input: Input, width: number): string[] {
	const theme = clioTheme();
	return input
		.render(width)
		.map((line) =>
			fitRow(
				theme.base(
					"inputText",
					line.startsWith("> ") ? `${theme.fg("selectedOption", `${GLYPH.cursor} `)}${line.slice(2)}` : line,
				),
				width,
			),
		);
}

function createAuthDialogController(
	title: string,
	onCancel: () => void,
): {
	box: FocusBox;
	controller: AuthDialogHandle["controller"];
	getHint: () => string;
} {
	const input = new Input();
	let lines: string[] = [];
	let promptLabel: string | null = null;
	let resolver: ((value: string) => void) | undefined;
	let rejecter: ((error: Error) => void) | undefined;
	let currentHint = buildHint([]);
	// The static rows are memoized on the lines, the width and the skin; the
	// input row beneath them is the only thing that changes per keystroke.
	let revision = 0;
	let memo: { key: string; rows: string[] } | null = null;

	const view: Component = {
		render(width: number): string[] {
			const key = `${width}|${revision}|${skinEpoch()}`;
			if (memo?.key !== key) {
				memo = { key, rows: [titleRow(clioTheme(), title, width), ...renderAuthLines(lines, width)] };
			}
			if (promptLabel === null) return memo.rows;
			return [
				...memo.rows,
				// The label may carry a default id the operator is meant to read whole.
				...wrapTextWithAnsi(clioTheme().fg("inputPlaceholder", normalizeAuthLine(promptLabel)), Math.max(1, width)),
				...renderInputWithDesignCursor(input, width),
			];
		},
		handleInput: (data) => input.handleInput(data),
		invalidate: () => {
			memo = null;
			input.invalidate();
		},
	};

	const box = new FocusBox(view, {
		onInput: (data) => {
			if (promptLabel) input.handleInput(data);
		},
	});

	input.onSubmit = () => {
		if (!resolver) return;
		const resolve = resolver;
		resolver = undefined;
		rejecter = undefined;
		const value = input.getValue();
		promptLabel = null;
		input.setValue("");
		rebuild();
		resolve(value);
	};
	input.onEscape = () => {
		cancel();
	};
	rebuild();

	return {
		box,
		controller: {
			setLines,
			appendLine,
			prompt,
			cancel,
			dismiss,
		},
		getHint: () => currentHint,
	};

	function rebuild(): void {
		revision += 1;
		currentHint = promptLabel ? buildHint([{ key: "Enter", verb: "submit" }]) : buildHint([]);
		box.invalidate();
	}

	function rejectPending(message: string): void {
		if (!rejecter) return;
		const reject = rejecter;
		resolver = undefined;
		rejecter = undefined;
		promptLabel = null;
		input.setValue("");
		rebuild();
		reject(new Error(message));
	}

	function setLines(nextLines: ReadonlyArray<string>): void {
		lines = [...nextLines];
		rebuild();
	}

	function appendLine(line: string): void {
		lines = [...lines, line];
		rebuild();
	}

	function prompt(label: string): Promise<string> {
		promptLabel = label;
		input.setValue("");
		rebuild();
		return new Promise((resolve, reject) => {
			resolver = resolve;
			rejecter = reject;
		});
	}

	function cancel(): void {
		rejectPending("cancelled");
		onCancel();
	}

	function dismiss(): void {
		rejectPending("dismissed");
	}
}

export function openAuthDialog(tui: TUI, title: string, onCancel: () => void): AuthDialogHandle {
	const { box, controller, getHint } = createAuthDialogController(title, onCancel);
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: AUTH_DIALOG_WIDTH,
		markerId: "auth",
		title: "Authentication",
		footerHint: getHint,
	});
	return {
		handle,
		controller,
	};
}
