import type { ModesContract } from "../domains/modes/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { Editor, ProcessTerminal, TUI } from "../engine/tui.js";
import { buildFooter } from "./footer-panel.js";
import { buildLayout, defaultBanner } from "./layout.js";

export interface InteractiveDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	onShutdown: () => Promise<void>;
}

export const SHIFT_TAB = "\x1b[Z";
export const CTRL_D = "\x04";

export interface KeyBindingDeps {
	cycleMode: () => void;
	requestShutdown: () => void;
}

/** Pure key router: returns true when the input was consumed. */
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	if (data === SHIFT_TAB) {
		deps.cycleMode();
		return true;
	}
	if (data === CTRL_D) {
		deps.requestShutdown();
		return true;
	}
	return false;
}

const IDENTITY = (s: string): string => s;

export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const banner = defaultBanner();
	const footer = buildFooter({ modes: deps.modes, providers: deps.providers });
	const editor = new Editor(tui, {
		borderColor: IDENTITY,
		selectList: {
			selectedPrefix: IDENTITY,
			selectedText: IDENTITY,
			description: IDENTITY,
			scrollInfo: IDENTITY,
			noMatch: IDENTITY,
		},
	});
	editor.focused = true;
	editor.onSubmit = (text: string): void => {
		if (text === "/quit" || text === "/exit") {
			void shutdown();
			return;
		}
		// v0.1 stub: echo to stderr. Dispatch wiring lands post-v0.1.
		process.stderr.write(`[interactive] received: ${text}\n`);
	};

	const root = buildLayout({ banner, body: editor, footer: footer.view });
	tui.addChild(root);
	tui.start();

	let resolveRun: (code: number) => void = () => {};
	const run = new Promise<number>((resolve) => {
		resolveRun = resolve;
	});

	// Anchor the Node event loop while the TUI is alive. Piped or /dev/null
	// stdin (used by diag harnesses) can close early, which would otherwise
	// let the process exit before the termination coordinator runs.
	const keepAlive = setInterval(() => {}, 1 << 30);

	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepAlive);
		try {
			tui.stop();
		} catch {
			// TUI may already be stopped; swallow.
		}
		await deps.onShutdown();
		resolveRun(0);
	};

	tui.addInputListener((data: string) => {
		const consumed = routeInteractiveKey(data, {
			cycleMode: () => {
				deps.modes.cycleNormal();
				footer.refresh();
				tui.requestRender();
			},
			requestShutdown: () => {
				void shutdown();
			},
		});
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
