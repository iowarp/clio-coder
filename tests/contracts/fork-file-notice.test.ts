import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TUI } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import type { OpenMessagePickerOverlayDeps } from "../../src/interactive/overlays/message-picker.js";

for (const succeeds of [true, false]) {
	test(`S6-01: ${succeeds ? "successful fork discloses unchanged files" : "failed fork never claims a new conversation"}`, async () => {
		let sessionId = "parent-session";
		let picker: OpenMessagePickerOverlayDeps | undefined;
		const notices: string[] = [];
		let resets = 0;
		const session = {
			current: () => ({ id: sessionId, cwd: process.cwd(), target: null, model: null }),
			fork: () => {
				if (succeeds) sessionId = "child-session";
			},
			tree: () => ({ leafId: "fork-point" }),
		} as unknown as SessionContract;
		const transitions: OverlayTransitions = {
			state: "closed",
			handle: null,
			showPermission: () => false,
			close: () => undefined,
		};
		const lifecycle = createOverlaySessionLifecycle({
			tui: {} as TUI,
			transitions,
			session,
			chatPanel: createChatPanel(),
			chat: {
				cancel: () => undefined,
				isStreaming: () => false,
				whenSettled: async () => undefined,
				resetForSession: () => {
					resets += 1;
				},
				extractHandoff: async () => ({ status: "aborted", text: "" }),
			},
			resetTranscript: () => undefined,
			readStructuredEntries: () => [],
			getSlashNotice: () => (_level, message) => {
				notices.push(message);
			},
			announceTaskMemorySeedOffer: () => undefined,
			refreshFooter: () => undefined,
			requestRender: () => undefined,
			stderr: (message) => {
				throw new Error(message);
			},
			notify: (_level, message) => {
				notices.push(message);
			},
			openMessagePickerOverlay: (_tui, deps) => {
				picker = deps;
				return {
					hide: () => undefined,
					focus: () => undefined,
					unfocus: () => undefined,
					isFocused: () => true,
					setHidden: () => undefined,
					isHidden: () => false,
					getBounds: () => undefined,
				};
			},
		});
		lifecycle.openMessagePicker();
		ok(picker);
		await picker.onFork("fork-point");
		strictEqual(sessionId, succeeds ? "child-session" : "parent-session");
		strictEqual(resets, succeeds ? 1 : 0);
		if (succeeds) match(notices.join("\n"), /Conversation forked.*files were not rewound.*edits remain/);
		else {
			match(notices.join("\n"), /fork failed/);
			strictEqual(
				notices.some((message) => message.includes("Conversation forked")),
				false,
			);
		}
	});
}
