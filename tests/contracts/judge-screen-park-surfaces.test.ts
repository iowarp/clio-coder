import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyJudge, type SafetyJudgeConfig } from "../../src/domains/safety/safety-judge.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createOverlayPermissionLifecycle } from "../../src/interactive/overlay-permission-lifecycle.js";
import { createRegistry, type PermissionRequiredMeta, type ToolSpec } from "../../src/tools/registry.js";

const CONFIG: SafetyJudgeConfig = { enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] };
const SOURCE = "web_fetch https://x.test/a";
const COMMAND = "./scripts/sync-assets --all";

/** A main-session registry whose judge allows after the screen has read a result as directing an agent. */
function screenedRegistry() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-park-surfaces-")));
	const judge = createSafetyJudge({
		config: () => CONFIG,
		complete: async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { text: JSON.stringify({ verdict: "allow", rule: "task-local", reason: "Ordinary work." }) };
		},
		operatorMessages: () => ["sync the assets"],
		session: () => "session-1",
		consequences: () => [],
		screen: () => Promise.resolve({ source: SOURCE }),
	});
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		safetyJudge: judge,
	});
	const bash: ToolSpec = {
		name: ToolNames.Bash,
		description: "fake bash",
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "execute",
		run: async () => ({ kind: "ok", output: "ran" }),
	};
	registry.register(bash);
	return registry;
}

test("a headless denial of a screened call names the source, and stays a headless denial", async () => {
	const registry = screenedRegistry();
	registry.onPermissionRequired((_call, _decision, meta) => {
		registry.cancelParkedCall(meta.requestId, HEADLESS_PERMISSION_DENIED_REASON, { denied: true });
	});
	const verdict = await registry.invoke({ tool: ToolNames.Bash, args: { command: COMMAND } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind !== "blocked") return;
	const detail = verdict.decision.kind === "allow" ? "" : verdict.decision.rejection.detail;
	ok(detail.startsWith(HEADLESS_PERMISSION_DENIED_MARKER), detail);
	match(detail, /why it needed a decision: ".*web_fetch https:\/\/x\.test\/a/u);
	match(detail, /This call was denied; no approval is pending\./u);
});

test("a headless denial with no gate behind it says nothing about one", async () => {
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "clio-park-surfaces-"))) }),
		autonomy: () => "default",
	});
	registry.register({
		name: ToolNames.Bash,
		description: "fake bash",
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "execute",
		run: async () => ({ kind: "ok", output: "ran" }),
	});
	registry.onPermissionRequired((_call, _decision, meta) => {
		registry.cancelParkedCall(meta.requestId, HEADLESS_PERMISSION_DENIED_REASON, { denied: true });
	});
	const verdict = await registry.invoke({ tool: ToolNames.Bash, args: { command: COMMAND } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind !== "blocked") return;
	const detail = verdict.decision.kind === "allow" ? "" : verdict.decision.rejection.detail;
	ok(!detail.includes("why it needed a decision"), detail);
});

test("the interactive card shows the same source as its advisory", async () => {
	const registry = screenedRegistry();
	const parks: PermissionRequiredMeta[] = [];
	const shown: string[] = [];
	createOverlayPermissionLifecycle({
		toolRegistry: registry,
		bus: createTelemetryHub(),
		dispatch: {},
		getAutonomy: () => "default",
		getOverlayState: () => "closed",
		openPermissionOverlay: (_view, _inspect, _invocation, advisory) => {
			const read = advisory?.();
			if (typeof read === "string") shown.push(read);
			return true;
		},
		closeOverlay: () => {},
		appendNotice: () => {},
		applyApprovalState: () => {},
		requestRender: () => {},
		stopActiveTurn: () => {},
	});
	registry.onPermissionRequired((_call, _decision, meta) => parks.push(meta));
	const pending = registry.invoke({ tool: ToolNames.Bash, args: { command: COMMAND } });
	while (parks.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	strictEqual(shown.length, 1);
	match(shown[0] ?? "", /System One reads a result from web_fetch https:\/\/x\.test\/a as directing an AI agent/u);
	registry.cancelParkedCall(parks[0]?.requestId ?? "", "denied", { denied: true });
	strictEqual((await pending).kind, "blocked");
});
