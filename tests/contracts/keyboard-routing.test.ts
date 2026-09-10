import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/index.js";
import type { ProcessTerminal } from "../../src/engine/tui.js";
import {
	type Component,
	getKeybindings,
	Input,
	ScrollView,
	setKeybindings,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
} from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { dispatchInteractiveAction } from "../../src/interactive/interactive-application.js";
import { createInteractiveInputRuntime } from "../../src/interactive/interactive-input-runtime.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { FocusBox, showClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import type { OverlayState } from "../../src/interactive/overlay-key-routing.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import { openExtensionPanel } from "../../src/interactive/overlays/extension-panel.js";
import { openHelpOverlay } from "../../src/interactive/overlays/help-reference.js";
import { openInteropOverlay } from "../../src/interactive/overlays/interop.js";
import { openLibraryReviewOverlay } from "../../src/interactive/overlays/library-review.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { ModelOverlayView } from "../../src/interactive/overlays/model-selector.js";
import { openSessionOverlay } from "../../src/interactive/overlays/session-selector.js";
import { SettingsCenter } from "../../src/interactive/overlays/settings.js";
import type { SlashCommandContext } from "../../src/interactive/slash-commands.js";
import { createProcessTerminalLease } from "../../src/interactive/terminal-lease.js";
import { ViewOverlayView } from "../../src/interactive/view/view-overlay.js";
import { libraryApplyFixture, libraryPlanFixture } from "../harness/library-plan-fixture.js";

class KeyboardTerminal implements Terminal {
	columns = 100;
	rows = 32;
	kittyProtocolActive = false;
	output = "";
	input: (data: string) => void = () => {};
	start(input: (data: string) => void): void {
		this.input = input;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const noop = () => {};
function fixture(overrides: Record<string, string | string[]> = {}) {
	const previousKeys = getKeybindings();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.keybindings = overrides;
	const keys = createKeybindingManager(settings, {});
	cleanups.push(() => setKeybindings(previousKeys));
	const terminal = new KeyboardTerminal();
	const tui = new TuiAltScreen(terminal);
	const overlays: { component: Component; handle: ReturnType<typeof tui.showOverlay> }[] = [];
	const showOverlay = tui.showOverlay.bind(tui);
	tui.showOverlay = (component, options) => {
		const handle = showOverlay(component, options);
		overlays.push({ component, handle });
		return handle;
	};
	const active = { streaming: true, queued: false };
	const editor = new ClioEditor(tui, { getModelLabel: () => "fixture", getThinkingLabel: () => "off" });
	let state: OverlayState = "closed";
	let handle: ReturnType<typeof tui.showOverlay> | null = null;
	const counts = { library: 0, cancel: 0, submit: 0, status: 0, allow: 0, dismiss: 0, shutdown: 0 };
	editor.onSubmit = () => {
		counts.submit++;
	};
	const close = () => {
		handle?.hide();
		handle = null;
		state = "closed";
		tui.setFocus(editor);
	};
	const open = (next: OverlayState, component: Component = new Text("owned", 0, 0)) => {
		state = next;
		handle = showClioOverlayFrame(tui, component, { title: next, markerId: "keyboard-test", width: 70 });
	};
	const openLibrary = () => {
		counts.library++;
		const list = new ListOverlayView(
			{
				title: "Library",
				items: [
					{ id: "a", label: "alpha" },
					{ id: "b", label: "beta" },
				],
				filterable: true,
				explicitSearch: true,
				onClose: close,
			},
			() => tui.requestRender(),
		);
		open("skills-hub", list);
	};
	const controller = createInteractiveInputRuntime({
		tui,
		keybindings: keys,
		dispatchAction: dispatchInteractiveAction,
		actions: {
			canExit: () => !active.streaming && !active.queued && editor.getText().length === 0,
			cycleOutputStyle: noop,
			availableThinkingLevels: () => ["off"],
			onCycleThinking: noop,
			cycleScopedModelForward: noop,
			cycleScopedModelBackward: noop,
			backgroundActiveDispatch: noop,
			toggleFilesPane: noop,
		},
		overlay: {
			getState: () => state,
			closeOverlay: close,
			confirmPermission: () => {
				counts.allow++;
			},
			stopTurnFromPermission: noop,
			canInspectMutation: () => false,
			isInspectingMutation: () => false,
			toggleMutationInspection: noop,
			scrollMutationInspection: noop,
			togglePermissionTerms: noop,
			cancelAskUser: close,
			toggleFooterDashboardState: () => {
				counts.status++;
			},
			toggleDispatchBoardOverlay: noop,
			openModelOverlayState: noop,
			openSkillsHubState: openLibrary,
			openTreeOverlayState: noop,
			openTasksOverlayState: noop,
			openDecisionsOverlayState: noop,
		},
		refreshFooter: noop,
		dispatchBoard: { selectPrevious: noop, selectNext: noop, toggleDetail: noop },
		watchSelectedDispatch: () => false,
		steerSelectedDispatch: noop,
		cancelSelectedDispatch: noop,
		cancelActiveEditorBash: () => false,
		isStreaming: () => active.streaming,
		hasQueuedMessages: () => active.queued,
		cancelActiveRun: () => {
			counts.cancel++;
		},
		editor,
		editorSubmit: {
			openExternalEditorForInput: noop,
			queueFollowUpFromEditor: noop,
			interruptFromEditor: noop,
			restoreQueuedFollowUpsToEditor: noop,
		},
		requestRender: () => tui.requestRender(),
		notifications: {
			list: () => [{ id: "a" }, { id: "b" }],
			dismiss: () => {
				counts.dismiss++;
			},
			dismissAll: () => {
				counts.dismiss += 100;
			},
		},
		shutdown: {
			stopTickers: noop,
			disposeInteractiveTickers: noop,
			disposeBeforeStatus: noop,
			disposeProjectionPrimary: noop,
			disposeStatus: noop,
			disposeProjectionRemaining: noop,
			disposeOverlay: close,
			stopAgentProgress: noop,
			disposeChat: noop,
			disposeSubscriptions: noop,
		},
		stopUi: () => tui.stop(),
		cancelParkedCalls: noop,
		onShutdown: async () => {
			counts.shutdown++;
		},
		registerInputListener: (listener) => {
			tui.setApplicationInputPolicy(listener);
		},
		registerTerminalTeardown: noop,
		signals: { takeInterruptOwnership: () => noop, on: noop, off: noop },
	});
	const root = new VStack();
	root.addChild(new ScrollView(new Text("alpha one\nalpha two\nalpha three", 0, 0), { primary: true, follow: "end" }), {
		grow: 1,
	});
	root.addChild(editor);
	tui.addChild(root);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();
	cleanups.push(() => controller.shutdown());
	return {
		terminal,
		tui,
		editor,
		keys,
		counts,
		controller,
		open,
		close,
		overlays,
		active,
		state: () => state,
		mount(next: OverlayState, factory: () => ReturnType<typeof tui.showOverlay>) {
			state = next;
			handle = factory();
			return handle;
		},
	};
}
it("routes press/repeat/release before viewport and keeps literal paste inert", () => {
	const f = fixture();
	f.terminal.input("\x1b[108;3u");
	assert.equal(f.state(), "skills-hub");
	f.terminal.input("\x1b[108;3:2u");
	f.terminal.input("\x1b[108;3:3u");
	assert.equal(f.counts.library, 1);
	assert.equal(f.state(), "skills-hub");
	f.terminal.input("\x1b[108;3u");
	assert.equal(f.state(), "closed");
	f.terminal.input("\x1b[200~/model\n\x1b[201~");
	assert.equal(f.counts.submit, 0);
	assert.equal(f.editor.getText(), "/model\n");
	f.terminal.input("\r");
	assert.equal(f.counts.submit, 1);
});
it("keeps search focused ahead of globals and Ctrl+C leaves the active run alive", () => {
	const f = fixture();
	f.editor.setText("draft");
	f.terminal.input("\x12");
	assert.equal(f.tui.isSearchFocused, true);
	f.terminal.input("\x1bu");
	f.terminal.input("\x1bl");
	f.terminal.input("\x11");
	assert.equal(f.counts.status, 0);
	assert.equal(f.counts.library, 0);
	assert.equal(f.editor.getText(), "draft");
	f.terminal.input("alpha");
	f.terminal.input("\r");
	f.terminal.input("\x1b[A");
	f.terminal.input("\x03");
	assert.equal(f.tui.isSearchFocused, false);
	assert.equal(f.counts.cancel, 0);
	f.open("permission-confirm");
	f.terminal.input("\x12");
	assert.equal(f.tui.isSearchFocused, false);
	f.terminal.input("\x1b[200~s\nv\n\x03\x1b[201~");
	assert.equal(f.counts.allow, 0);
	assert.equal(f.counts.cancel, 0);
});
it("permission deletion bypasses submit overrides and leaves nonempty Enter inert", () => {
	const f = fixture({ "tui.input.submit": "ctrl+u", "tui.editor.deleteToLineStart": "ctrl+x" });
	f.editor.setText("draft");
	f.open("permission-confirm");
	f.terminal.input("\r");
	assert.equal(f.counts.allow, 0);
	f.terminal.input("\x15");
	assert.equal(f.editor.getText(), "");
	assert.equal(f.counts.submit, 0);
	assert.equal(f.counts.allow, 0);
	f.terminal.input("\n");
	assert.equal(f.counts.allow, 1);
});
it("leader toggles its owner, survives delay/unknown suffix, and Ctrl+C cancels immediately", async () => {
	const f = fixture();
	f.editor.setText("unchanged");
	f.terminal.input("\x07");
	f.terminal.input("?");
	await new Promise((resolve) => setTimeout(resolve, 1700));
	f.tui.renderNow();
	assert.match(f.terminal.output, /No action for this key/u);
	assert.equal(f.editor.getText(), "unchanged");
	f.terminal.input("l");
	assert.equal(f.state(), "skills-hub");
	f.terminal.input("\x07");
	f.terminal.input("l");
	assert.equal(f.state(), "closed");
	f.terminal.input("\x07");
	f.terminal.input("\x03");
	assert.equal(f.counts.cancel, 1);
});
it("permits printable editing repeats and live reload cancels a pending menu", () => {
	const f = fixture();
	f.terminal.input("\x1b[97u");
	f.terminal.input("\x1b[97;1:2u");
	assert.equal(f.editor.getText(), "aa");
	const input = new Input();
	const box = new FocusBox(input);
	f.open("auth", box);
	f.terminal.input("\x1b[98u");
	f.terminal.input("\x1b[98;1:2u");
	assert.equal(input.getValue(), "bb");
	f.close();
	f.terminal.input("\x07");
	f.keys.reload({ "clio-coder.library.toggle": "alt+p" });
	f.terminal.input("l");
	assert.equal(f.editor.getText(), "aal");
	f.terminal.input("\x1bl");
	assert.equal(f.state(), "closed");
	f.terminal.input("\x1bp");
	assert.equal(f.state(), "skills-hub");
});
it("reports genuine effective collisions, disables direct and leader routes, and dismisses one notice per call", () => {
	const f = fixture({
		"clio-coder.library.toggle": [],
		"clio-coder.model.select": "alt+l",
		"tui.input.tab": "ctrl+i",
		toString: "alt+y",
	});
	assert.equal(f.keys.matches("\x1bl", "clio-coder.library.toggle"), false);
	assert.equal(
		f.keys.leaderTargets().some((entry) => entry.id === "clio-coder.library.toggle"),
		false,
	);
	assert.equal(f.keys.invalidCount(), 1);
	assert.equal(
		f.keys.getConflicts().some((entry) => entry.key === "enter"),
		false,
	);
	f.keys.reload({ "clio-coder.model.select": "alt+l" });
	assert.ok(f.keys.getConflicts().some((entry) => entry.key === "alt+l"));
	f.controller.dismissNotifications();
	f.controller.dismissNotifications();
	assert.equal(f.counts.dismiss, 2);
});

const plain = (component: Component | null, width = 100) =>
	component?.render(width).map(stripTerminalSequences).join("\n") ?? "";
it("edits search at Home/End and changes the visible match index in both directions", () => {
	const f = fixture();
	f.editor.setText("composer survives");
	f.terminal.input("\x12");
	f.terminal.input("alpha");
	f.tui.renderNow();
	const search = () => plain(f.tui.getFocusedComponent());
	assert.match(search(), /[123]\/3/);
	const first = search().match(/([123])\/3/)?.[1];
	f.terminal.input("\r");
	f.tui.renderNow();
	assert.notEqual(search().match(/([123])\/3/)?.[1], first);
	f.terminal.input("\x1b[A");
	f.tui.renderNow();
	assert.equal(search().match(/([123])\/3/)?.[1], first);
	f.terminal.input("\x1b[H");
	f.terminal.input("x");
	f.tui.renderNow();
	assert.match(search(), /xalpha/);
	assert.match(search(), /No matches/);
	f.terminal.input("\x7f");
	f.terminal.input("\x1b[F");
	f.terminal.input("z");
	f.tui.renderNow();
	assert.match(search(), /alphaz/);
	f.terminal.input("\x7f");
	f.terminal.input("\x03");
	assert.equal(f.editor.getText(), "composer survives");
});
it("keeps model filter Escape local and edits actual settings and View filters", () => {
	const f = fixture();
	const model = new ModelOverlayView(
		[],
		{ totalModels: 0, targets: 0, localModels: 0, cloudModels: 0, activeRef: "" },
		noop,
		undefined,
		f.close,
	);
	f.open("model", model);
	f.terminal.input("\x1b[97u");
	f.terminal.input("\x1b[98;1:2u");
	assert.equal(model.keyboardScope, "edit");
	f.terminal.input("\x1b");
	assert.equal(f.state(), "model");
	assert.equal(model.keyboardScope, "browse");
	f.terminal.input("\x1b");
	assert.equal(f.state(), "closed");
	const settings = new SettingsCenter([], {
		getBodyHeight: () => 20,
		prepareChange: () => null,
		onApply: noop,
		onCancel: f.close,
	});
	f.open("settings", settings);
	f.terminal.input("/");
	f.terminal.input("\x1b[200~alpha beta\x1b[201~");
	f.terminal.input("\x1bb");
	f.terminal.input("X");
	assert.match(plain(settings), /alpha Xbeta/);
	f.terminal.input("\x1b");
	assert.equal(f.state(), "settings");
	assert.doesNotMatch(plain(settings), /alpha Xbeta/);
	f.close();
	const view = new ViewOverlayView({ providers: [], getBodyHeight: () => 20, onClose: f.close, initialFilter: "alpha" });
	f.open("view", view);
	f.terminal.input("\x1b[F");
	f.terminal.input("\x1b[98u");
	assert.match(plain(view), /filter: alphab/);
	f.terminal.input("\x07");
	f.terminal.input("z");
	assert.match(plain(view), /filter: alpha/);
	assert.doesNotMatch(plain(view), /filter: alphab/);
});
it("keeps interview word editing on its answer and Escape on the local question", async () => {
	const f = fixture();
	const interview = openAskUserOverlay(f.tui, { onCancel: f.close });
	f.mount("ask-user", () => interview);
	const result = interview.ask([
		{ question: "First", options: [{ label: "Choose" }, { label: "Other" }] },
		{ question: "Second" },
	]);
	f.terminal.input("t");
	f.terminal.input("\x1b[200~alpha beta\x1b[201~");
	f.terminal.input("\x1bb");
	f.terminal.input("X");
	assert.match(plain(f.tui.getFocusedComponent()), /alpha Xbeta/);
	assert.doesNotMatch(plain(f.tui.getFocusedComponent()), /Alt\+Left/);
	f.terminal.input("\x1b");
	assert.equal(f.state(), "ask-user");
	assert.doesNotMatch(plain(f.tui.getFocusedComponent()), /alpha Xbeta/);
	interview.cancel();
	await result;
});
it("honors resume selection overrides and refreshes help while it remains open", () => {
	const f = fixture({ "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+y" });
	const sessions: SessionMeta[] = ["first", "second"].map((id) => ({
		id,
		cwd: "/fixture",
		cwdHash: "fixture",
		createdAt: "2026-09-10T00:00:00Z",
		endedAt: null,
		model: "fixture",
		target: "fixture",
		clioCoderVersion: "0.4.7",
		piMonoVersion: "0.85.1",
		platform: "linux",
		nodeVersion: process.version,
	}));
	let resumed = "";
	f.mount("resume", () =>
		openSessionOverlay(f.tui, {
			session: { history: () => sessions } as SessionContract,
			onResume: (id) => {
				resumed = id;
			},
			onClose: f.close,
		}),
	);
	f.terminal.input("\x0e");
	f.terminal.input("\x19");
	assert.equal(resumed, "second");
	f.mount("help", () => openHelpOverlay(f.tui, f.keys, f.close, "Library"));
	assert.match(plain(f.tui.getFocusedComponent(), 120), /Alt\+L/);
	f.keys.reload({ "clio-coder.library.toggle": "alt+p" });
	assert.equal(f.state(), "help");
	assert.match(plain(f.tui.getFocusedComponent(), 120), /Alt\+P/);
	assert.doesNotMatch(plain(f.tui.getFocusedComponent(), 120), /Alt\+L/);
});
it("blocks repeated app actions even when a custom key collides with draft deletion", () => {
	const f = fixture({ "clio-coder.library.toggle": "ctrl+d" });
	f.editor.setText("draft");
	f.terminal.input("\x1b[100;5:2u");
	assert.equal(f.state(), "closed");
	assert.equal(f.editor.getText(), "draft");
});

it("keeps the menu above the draft at normal and small sizes, with live human-facing hints", () => {
	for (const [columns, rows] of [
		[120, 42],
		[80, 24],
	]) {
		const f = fixture();
		f.terminal.columns = columns;
		f.terminal.rows = rows;
		f.editor.setText("draft stays visible");
		f.terminal.input("\x1bl");
		f.keys.reload({ "clio-coder.leader": "ctrl+x" });
		f.terminal.input("\x18");
		f.tui.renderNow();
		const menu = f.overlays.at(-1);
		assert.ok(menu);
		const bounds = menu.handle.getBounds();
		assert.ok(bounds);
		assert.ok(bounds.row + bounds.height < rows - f.editor.render(columns).length);
		const text = plain(menu.component, columns);
		assert.match(text, /Library ·/);
		assert.doesNotMatch(text, /skills-hub|cancel owner/);
		assert.match(text, /Ctrl\+C cancel/);
		assert.match(text, /ctrl\+x or Esc/);
		assert.equal(f.editor.getText(), "draft stays visible");
		f.terminal.input("\x03");
		assert.equal(f.state(), "closed");
	}
});
it("lets held Ctrl+D edit a draft but never quit on repeat, and protects queued work", async () => {
	const f = fixture();
	f.active.streaming = false;
	f.editor.setText("ab");
	f.terminal.input("\x1b[H");
	f.terminal.input("\x04");
	assert.equal(f.editor.getText(), "b");
	f.terminal.input("\x1b[100;5:2u");
	assert.equal(f.editor.getText(), "");
	f.terminal.input("\x1b[100;5:2u");
	assert.equal(f.counts.shutdown, 0);
	f.active.queued = true;
	f.terminal.input("\x04");
	f.terminal.input("\x03");
	f.terminal.input("\x03");
	assert.equal(f.counts.shutdown, 0);
	f.active.queued = false;
	f.terminal.input("\x04");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.counts.shutdown, 1);
});
it("preserves literal boot input and queued submissions across the single-editor adoption", async () => {
	const previousKeys = getKeybindings();
	cleanups.push(() => setKeybindings(previousKeys));
	const terminal = new KeyboardTerminal();
	const tui = new TuiAltScreen(terminal);
	let shutdowns = 0;
	let policyCalls = 0;
	const lease = createProcessTerminalLease({
		settings: structuredClone(DEFAULT_SETTINGS),
		shutdown: () => {
			shutdowns++;
		},
		testing: {
			shell: {
				terminal: terminal as unknown as ProcessTerminal,
				tui,
				mount(root, focus) {
					tui.addChild(root);
					tui.setFocus(focus);
					tui.start();
				},
				anchor: async () => 0,
				releaseAnchor: noop,
				stop: () => tui.stop(),
				settle: async () => {},
				complete: noop,
				commitCurrentFrame: async () => null,
				hasObservedBackpressure: () => false,
				setStreamPacingActive: noop,
				nextCommittedFrame: async () => null,
			},
			termination: {
				installSignalHandlers: noop,
				releaseInterruptOwnership: () => noop,
				onDrain: noop,
				shutdown: async () => {},
			},
			signals: { on: () => process, off: () => process },
			write: noop,
		},
	});
	cleanups.push(() => lease.close());
	terminal.input("\x1b[200~/model\x1b[201~");
	assert.equal(lease.editor.getText(), "/model");
	terminal.input("\x1b[13;1:3u");
	terminal.input("\x1b[13;1:2u");
	assert.equal(lease.editor.getText(), "/model");
	terminal.input("\r");
	assert.equal(lease.editor.getText(), "");
	terminal.input("\x04");
	terminal.input("\x03");
	terminal.input("\x03");
	assert.equal(shutdowns, 0);
	terminal.input("new draft");
	const editor = lease.editor;
	const admitted: string[] = [];
	lease.registerApplicationInput(() => {
		policyCalls++;
		return undefined;
	});
	const root = new VStack();
	root.addChild(editor);
	assert.equal(
		lease.adopt({
			root,
			editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
			admitSubmission: async (record) => {
				admitted.push(record.rawText);
			},
		}),
		true,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(admitted, ["/model"]);
	assert.equal(lease.editor, editor);
	assert.equal(editor.getText(), "new draft");
	terminal.input("\x1b[97;1:3u");
	assert.equal(policyCalls, 0);
	terminal.input("a");
	assert.equal(policyCalls, 1);
	assert.equal(editor.getText(), "new drafta");
});

it("cancels a real Library child review before its parent, without writes or global actions", () => {
	const f = fixture();
	f.editor.setText("draft");
	f.terminal.input("\x1bl");
	let writes = 0;
	let releases = 0;
	const child = openLibraryReviewOverlay(f.tui, {
		plan: libraryPlanFixture(),
		columns: 100,
		commit: () => {
			writes++;
			return libraryApplyFixture();
		},
		retryRefresh: () => libraryApplyFixture().refresh,
		onCancel: () => {
			releases++;
			child.hide();
		},
		onDone: noop,
	});
	cleanups.push(() => child.hide());
	f.terminal.input("\x1bl");
	f.terminal.input("\x07");
	f.terminal.input("l");
	f.terminal.input("\x12");
	f.terminal.input("\x1bu");
	f.terminal.input("\x1b[200~\r\x03\x1b[201~");
	assert.equal(child.isHidden(), false);
	assert.equal(f.tui.isSearchFocused, false);
	assert.equal(f.counts.status, 0);
	assert.equal(writes, 0);
	assert.equal(f.editor.getText(), "draft");
	f.terminal.input("\x03");
	assert.equal(releases, 1);
	assert.equal(f.state(), "skills-hub");
	f.terminal.input("\x03");
	assert.equal(f.state(), "closed");
	assert.equal(writes, 0);
});
it("closes a real extension panel and cycles Interop kinds with encoded c only in browse", () => {
	const f = fixture();
	f.mount("extensions", () =>
		openExtensionPanel(f.tui, "fixture", { title: "Fixture", sections: [] }, () => true, f.close),
	);
	f.terminal.input("\x1b[27u");
	assert.equal(f.state(), "closed");
	const notices: string[] = [];
	const ctx = {
		notice: (_level: string, text: string) => notices.push(text),
		interop: {
			report: () => null,
			proposals: () => [],
			configured: () => [{ id: "fixture", command: "fixture", args: [] }],
			accept: noop,
			decline: noop,
		},
	} as unknown as SlashCommandContext;
	f.mount("interop", () => openInteropOverlay(f.tui, ctx, f.close));
	f.terminal.input("\x1b[27;1;99~");
	assert.ok(notices.includes("Adoption kind: skill."));
	f.terminal.input("j");
	f.terminal.input("k");
	assert.equal(notices.length, 1);
	f.terminal.input("/");
	f.terminal.input("c");
	assert.equal(notices.length, 1);
});
