import { Box, Input, type OverlayHandle, Text, type TUI } from "../../engine/tui.js";

export const AUTH_DIALOG_WIDTH = 88;

class AuthDialogBox extends Box {
	private readonly titleView = new Text("");
	private readonly bodyView = new Text("");
	private readonly promptView = new Text("");
	private readonly input = new Input();
	private readonly hintView = new Text("");
	private lines: string[] = [];
	private promptLabel: string | null = null;
	private resolver: ((value: string) => void) | undefined;
	private rejecter: ((error: Error) => void) | undefined;

	constructor(
		title: string,
		private readonly onCancel: () => void,
	) {
		super(1, 0);
		this.titleView.setText(title);
		this.input.onSubmit = () => {
			if (!this.resolver) return;
			const resolve = this.resolver;
			this.resolver = undefined;
			this.rejecter = undefined;
			const value = this.input.getValue();
			this.promptLabel = null;
			this.input.setValue("");
			this.rebuild();
			resolve(value);
		};
		this.input.onEscape = () => {
			this.cancel();
		};
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(this.titleView);
		this.bodyView.setText(this.lines.join("\n"));
		this.addChild(this.bodyView);
		if (this.promptLabel) {
			this.promptView.setText(this.promptLabel);
			this.hintView.setText("[Enter] submit  [Esc] cancel");
			this.addChild(this.promptView);
			this.addChild(this.input);
			this.addChild(this.hintView);
		} else {
			this.hintView.setText("[Esc] cancel");
			this.addChild(this.hintView);
		}
		this.invalidate();
	}

	private rejectPending(message: string): void {
		if (!this.rejecter) return;
		const reject = this.rejecter;
		this.resolver = undefined;
		this.rejecter = undefined;
		this.promptLabel = null;
		this.input.setValue("");
		this.rebuild();
		reject(new Error(message));
	}

	handleInput(data: string): void {
		if (this.promptLabel) {
			this.input.handleInput(data);
		}
	}

	setLines(lines: ReadonlyArray<string>): void {
		this.lines = [...lines];
		this.rebuild();
	}

	appendLine(line: string): void {
		this.lines = [...this.lines, line];
		this.rebuild();
	}

	prompt(label: string): Promise<string> {
		this.promptLabel = label;
		this.input.setValue("");
		this.rebuild();
		return new Promise((resolve, reject) => {
			this.resolver = resolve;
			this.rejecter = reject;
		});
	}

	cancel(): void {
		this.rejectPending("cancelled");
		this.onCancel();
	}

	dismiss(): void {
		this.rejectPending("dismissed");
	}
}

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

export function openAuthDialog(tui: TUI, title: string, onCancel: () => void): AuthDialogHandle {
	const box = new AuthDialogBox(title, onCancel);
	const handle = tui.showOverlay(box, { anchor: "center", width: AUTH_DIALOG_WIDTH });
	return {
		handle,
		controller: {
			setLines: (lines) => box.setLines(lines),
			appendLine: (line) => box.appendLine(line),
			prompt: (label) => box.prompt(label),
			cancel: () => box.cancel(),
			dismiss: () => box.dismiss(),
		},
	};
}
