import {
	type Component,
	Input,
	type OverlayHandle,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { buildHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH, screenTitle } from "../theme/index.js";

export const AUTH_DIALOG_WIDTH = 88;
const ELLIPSIS = "…";
const KEY_WIDTH = 10;

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

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	return truncateToWidth(text, safeWidth, ELLIPSIS, true);
}

function keyCell(label: string): string {
	const theme = clioTheme();
	const key = theme.fg("dim", label);
	const width = visibleWidth(label);
	return `${key}${" ".repeat(Math.max(0, KEY_WIDTH - width))}`;
}

function normalizeAuthLine(line: string): string {
	return line.replace(/\.\.\./g, ELLIPSIS);
}

function formatAuthChoiceLine(line: string): string | null {
	const match = /^(?<marker>[* ])\s*(?<index>\d+)\.\s*(?<label>.+)$/.exec(line);
	if (!match?.groups) return null;
	const theme = clioTheme();
	const markerText = match.groups.marker ?? " ";
	const indexText = match.groups.index ?? "";
	const labelText = match.groups.label ?? "";
	const marker = markerText === "*" ? theme.fg("accent", GLYPH.cursor) : " ";
	const index = theme.fg("dim", `${indexText}.`);
	const label = markerText === "*" ? theme.style("accent", labelText, { bold: true }) : theme.fg("muted", labelText);
	return `${marker} ${index} ${label}`;
}

function formatAuthBodyLine(line: string): string {
	const theme = clioTheme();
	const normalized = normalizeAuthLine(line).trimEnd();
	if (normalized.length === 0) return "";

	const choiceLine = formatAuthChoiceLine(normalized);
	if (choiceLine) return choiceLine;

	if (/^Target ready\b/.test(normalized)) {
		return theme.fg("success", `${GLYPH.ok} ${normalized}`);
	}
	if (/^(Target check failed|Unknown selection:)/.test(normalized)) {
		return theme.fg("error", `${GLYPH.error} ${normalized}`);
	}

	const colonIndex = normalized.indexOf(":");
	if (colonIndex > 0 && colonIndex <= 18 && normalized.slice(colonIndex, colonIndex + 3) !== "://") {
		const key = normalized.slice(0, colonIndex);
		const value = normalized.slice(colonIndex + 1).trimStart();
		if (/^[A-Za-z][A-Za-z ]*$/.test(key)) {
			return `${keyCell(key)} ${theme.fg("muted", value)}`;
		}
	}

	return theme.fg("muted", normalized);
}

function renderInputWithDesignCursor(input: Input, width: number): string[] {
	const theme = clioTheme();
	return input
		.render(width)
		.map((line) =>
			fitLine(line.startsWith("> ") ? `${theme.fg("accent", `${GLYPH.cursor} `)}${line.slice(2)}` : line, width),
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
	const titleView = new Text("");
	const bodyView = new Text("");
	const promptView = new Text("");
	const input = new Input();
	const inputView: Component = {
		render: (width) => renderInputWithDesignCursor(input, width),
		handleInput: (data) => input.handleInput(data),
		invalidate: () => input.invalidate(),
	};
	let lines: string[] = [];
	let promptLabel: string | null = null;
	let resolver: ((value: string) => void) | undefined;
	let rejecter: ((error: Error) => void) | undefined;
	let currentHint = buildHint([]);

	titleView.setText(screenTitle(clioTheme(), title));
	const box = new FocusBox([], {
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
		box.clear();
		box.addChild(titleView);
		bodyView.setText(lines.map(formatAuthBodyLine).join("\n"));
		box.addChild(bodyView);
		if (promptLabel) {
			promptView.setText(clioTheme().fg("dim", normalizeAuthLine(promptLabel)));
			currentHint = buildHint([{ key: "Enter", verb: "submit" }]);
			box.addChild(promptView);
			box.addChild(inputView);
		} else {
			currentHint = buildHint([]);
		}
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
