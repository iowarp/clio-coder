import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { SettingsValidationError, settingsPath, settingsReloadFailure } from "../../src/core/config.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { createInteractiveEventProjection } from "../../src/interactive/interactive-event-projection.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const audience of ["internal", "shadow"] as const)
	test(`${audience} context helpers follow their origin presentation policy`, () => {
		const bus = createTelemetryHub();
		const notices: string[] = [];
		let islands = 0;
		const noop = (): void => undefined;
		const subscriptions = createInteractiveSubscriptions({
			bus,
			agentTraits: (agentId) => (agentId === "context-bootstrap" ? ["context-generator"] : []),
			refreshFooter: noop,
			renderTaskIsland: noop,
			renderContextIsland: noop,
			requestRender: noop,
			notify: (_level, text) => notices.push(text),
			applyWorkerState: (state) => {
				strictEqual(state.helper, true);
				islands += 1;
			},
		});
		const identity = {
			runId: "helper-1",
			agentId: "context-bootstrap",
			agentAudience: audience,
			requestOrigin: audience === "shadow" ? ("agent" as const) : ("internal" as const),
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai-compat",
			runtimeKind: "http" as const,
		};
		bus.emit("run.started", { ...identity, pid: null, assignmentId: "helper-1", attempt: 0 });
		bus.emit("run.failed", {
			...identity,
			outcome: "failed",
			outcomeDetail: "Invalid handoff",
			reason: "failed",
		});
		deepStrictEqual(
			notices,
			audience === "internal"
				? []
				: // The helper's card says it is working; only its failure reaches the footer.
					["CLIO Coder's Context-bootstrap helper failed; your turn is not affected · /fleet shows why"],
		);
		strictEqual(islands, audience === "internal" ? 0 : 2);
		subscriptions.dispose();
		bus.emit("run.started", { ...identity, pid: null, assignmentId: "helper-1", attempt: 0 });
		strictEqual(notices.length, audience === "internal" ? 0 : 1);
	});

test("S3-01: live hook trust diagnostics reach the footer notice area and unsubscribe on disposal", () => {
	const bus = createTelemetryHub();
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
		notify: (level, text) => notices.push({ level, text }),
		dismissNotification: noop,
		appendTranscriptNotice: () => {
			throw new Error("routine diagnostics must not spill into the transcript");
		},
		refreshSettingsOverlay: noop,
	});
	const message = "/workspace/.clio-coder/hooks.yaml: project hook trust was revoked; hook skipped";
	bus.emit("extension.load_failed", { message });
	deepStrictEqual(notices, [{ level: "warning", text: message }]);
	strictEqual(renders, 1);
	// A safety block is the blocked call's row, live and on /resume; the policy
	// dimension passes through the footer rather than a live-only transcript copy.
	bus.emit("safety.blocked", {
		tool: "bash",
		actionClass: "system_modify",
		ruleId: "rm-recursive-or-force",
		policySource: "damage-control:base",
		reasonCode: "damage-control:rm-recursive-or-force",
	});
	strictEqual(notices.length, 2);
	strictEqual(notices[1]?.level, "warning");
	strictEqual(
		notices[1]?.text,
		"CLIO Coder's safety net blocked bash because it changes the system. This gate applies at every autonomy level, and /view names the rule.",
	);
	projection.dispose();
	bus.emit("extension.load_failed", { message });
	strictEqual(notices.length, 2);
});

test("M-25: a rejected settings reload names its key first in the footer and states file, key and error once in the transcript", async () => {
	const scratch = await isolateClioEnv("clio-coder-reload-failed-");
	try {
		const bus = createTelemetryHub();
		const footer: Array<{ level: string; text: string; key: string | undefined }> = [];
		const transcript: Array<{ level: string; text: string }> = [];
		const dismissed: string[] = [];
		const noop = (): void => undefined;
		const projection = createInteractiveEventProjection({
			bus,
			chat: { onEvent: () => noop, cancel: noop },
			status: { subscribe: () => noop },
			getTerminalColumns: () => 40,
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
			requestRender: noop,
			notify: (level, text, key) => footer.push({ level, text, key }),
			dismissNotification: (key) => dismissed.push(key),
			appendTranscriptNotice: (level, text) => transcript.push({ level, text }),
			refreshSettingsOverlay: noop,
		});
		const failure = settingsReloadFailure(
			new SettingsValidationError([{ path: "safety.liveCheckTargets", message: "unknown key" }]),
		);
		bus.emit("config.reload_failed", failure);
		strictEqual(footer.length, 1);
		strictEqual(footer[0]?.level, "error");
		strictEqual(footer[0]?.key, "config:reload-failed");
		// The pane clamps the footer from the right, so the failing key leads.
		ok(footer[0]?.text.startsWith("safety.liveCheckTargets"), footer[0]?.text);
		strictEqual(transcript.length, 1);
		strictEqual(transcript[0]?.level, "error");
		for (const part of [settingsPath(), "safety.liveCheckTargets", "unknown key", "last good settings"])
			ok(transcript[0]?.text.includes(part), `${part} missing from: ${transcript[0]?.text}`);
		bus.emit("config.reload_failed", { message: null });
		deepStrictEqual(dismissed, ["config:reload-failed"]);
		strictEqual(transcript.length, 2);
		strictEqual(transcript[1]?.level, "info");
		projection.dispose();
	} finally {
		scratch.restore();
	}
});
