import { Input, type OverlayHandle, Text, type TUI } from "../../engine/tui.js";
import { FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

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

function createAuthDialogController(
	title: string,
	onCancel: () => void,
): {
	box: FocusBox;
	controller: AuthDialogHandle["controller"];
} {
	const titleView = new Text("");
	const bodyView = new Text("");
	const promptView = new Text("");
	const input = new Input();
	const hintView = new Text("");
	let lines: string[] = [];
	let promptLabel: string | null = null;
	let resolver: ((value: string) => void) | undefined;
	let rejecter: ((error: Error) => void) | undefined;

	titleView.setText(title);
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
	};

	function rebuild(): void {
		box.clear();
		box.addChild(titleView);
		bodyView.setText(lines.join("\n"));
		box.addChild(bodyView);
		if (promptLabel) {
			promptView.setText(promptLabel);
			hintView.setText("[Enter] submit  [Esc] cancel");
			box.addChild(promptView);
			box.addChild(input);
			box.addChild(hintView);
		} else {
			hintView.setText("[Esc] cancel");
			box.addChild(hintView);
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
	const { box, controller } = createAuthDialogController(title, onCancel);
	const handle = showClioOverlayFrame(tui, box, { anchor: "center", width: AUTH_DIALOG_WIDTH, title: "Auth" });
	return {
		handle,
		controller,
	};
}
