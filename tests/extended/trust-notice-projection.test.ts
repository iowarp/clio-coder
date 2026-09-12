import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createInteractiveEventProjection } from "../../src/interactive/interactive-event-projection.js";

test("S3-01: live hook trust diagnostics reach the interactive transcript and unsubscribe on disposal", () => {
	const bus = createSafeEventBus();
	const notices: Array<{ level: string; text: string }> = [];
	let renders = 0;
	const noop = (): void => undefined;
	const projection = createInteractiveEventProjection({
		bus,
		chat: { onEvent: () => noop, cancel: noop },
		status: { subscribe: () => noop },
		getTerminalColumns: () => 80,
		applyChatEvent: noop,
		setFollowUpMessages: noop,
		isAskUserWaiting: () => false,
		closeAskUserSession: noop,
		resetAskUserCancellation: noop,
		recordToolStart: noop,
		recordToolEnd: noop,

		setLastTurnSummary: noop,
		startTerminalProgress: noop,
		stopTerminalProgress: noop,
		refreshLiveWorkspaceGit: noop,
		refreshFooter: noop,
		requestRender: () => {
			renders += 1;
		},
		notify: noop,
		dismissNotification: noop,
		appendTranscriptNotice: (level, text) => notices.push({ level, text }),
		refreshSettingsOverlay: noop,
	});
	const message = "/workspace/.clio-coder/hooks.yaml: project hook trust was revoked; hook skipped";
	bus.emit(BusChannels.ExtensionsLoadIssue, { message });
	deepStrictEqual(notices, [{ level: "warn", text: message }]);
	strictEqual(renders, 1);
	projection.dispose();
	bus.emit(BusChannels.ExtensionsLoadIssue, { message });
	strictEqual(notices.length, 1);
});
