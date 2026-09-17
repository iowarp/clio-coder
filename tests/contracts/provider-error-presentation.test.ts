import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { liteLLMRouteFailureMessage } from "../../src/core/gateway-routing.js";
import type { CustomEntry } from "../../src/domains/session/entries.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { presentProviderError, providerErrorEvidence } from "../../src/interactive/renderers/provider-error.js";
import { formatRetryStatus } from "../../src/interactive/renderers/retry-status.js";
import type { TurnContext } from "../../src/interactive/turn-context.js";
import type { TurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnRecovery, type RetryStatusPayload } from "../../src/interactive/turn-recovery.js";
import type { AgentRuntime, ChatTurnState } from "../../src/interactive/turn-state.js";

const plain = (rows: string[]) => stripVTControlCharacters(rows.join("\n"));
function failure(errorMessage: string): Extract<ChatLoopEvent, { type: "message_end" }> {
	return {
		type: "message_end",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage } as unknown as AgentMessage,
	};
}

test("production panel bounds a provider failure while View and export retain redacted evidence", async () => {
	const raw = `HTTP 503 {"error":{"message":"Model unavailable. Check gateway health.","code":"unavailable"},"api_key":"fixture-secret-value","body":"${"payload ".repeat(10_000)}END-EVIDENCE"}`;
	const event = failure(raw);
	const panel = createChatPanel();
	panel.applyEvent(event);
	const rendered = plain(panel.render(80));
	assert.match(rendered, /\[error\].*HTTP 503/);
	assert.match(rendered, /Model unavailable/);
	assert.ok(rendered.length < 1500);
	assert.doesNotMatch(rendered, /fixture-secret-value|END-EVIDENCE/);
	const artifact = panel.inspectionArtifacts().find((item) => item.title === "Provider or terminal error");
	assert.ok(artifact);
	const evidence = (await artifact.load()).lines.join("\n");
	assert.match(evidence, /END-EVIDENCE/);
	assert.doesNotMatch(evidence, /fixture-secret-value/);
	const exported = createChatPanel({ unboundedToolBodies: true });
	exported.applyEvent(event);
	assert.match(plain(exported.render(120)), /END-EVIDENCE/);
	assert.doesNotMatch(plain(exported.render(120)), /fixture-secret-value/);
	assert.equal((event.message as { errorMessage?: string }).errorMessage, raw);
});

test("retry countdown replaces its row and preserves a visible final failure", async () => {
	const panel = createChatPanel();
	const errorMessage = `HTTP 502 <!doctype html><html><title>Bad Gateway</title>${"<div>noise</div>".repeat(10_000)}</html>`;
	for (const phase of ["scheduled", "waiting", "retrying", "exhausted"] as const) {
		panel.applyEvent({ type: "retry_status", status: { phase, attempt: 1, maxAttempts: 3, errorMessage } });
	}
	const rendered = plain(panel.render(80));
	assert.equal((rendered.match(/\[retry\]/g) ?? []).length, 1);
	assert.match(rendered, /provider retry exhausted/);
	assert.match(rendered, /502/);
	assert.match(rendered, /Bad Gateway/);
	assert.ok(rendered.length < 1000);
	const artifacts = panel.inspectionArtifacts();
	assert.equal(artifacts.length, 1);
	const artifact = artifacts[0];
	assert.ok(artifact, "Expected a retry diagnostic artifact");
	assert.match((await artifact.load()).lines.join("\n"), /<div>noise<\/div>/);
});

test("ordinary remedies, source numeric precision and terminal trust are preserved", () => {
	const prose = "Invalid model. Select a configured target with /model and try again.";
	assert.equal(presentProviderError(prose), prose);
	assert.match(
		presentProviderError('HTTP 400 {"message":"ID 9007199254740993 is invalid","status":400}'),
		/9007199254740993/,
	);
	const hostile = "HTTP 401\u001b[2J\u001b]52;c;clipboard\u0007\rDenied\u202e\nCheck credentials";
	const display = presentProviderError(hostile);
	assert.doesNotMatch(display, /[\p{Cc}\p{Cf}]/u);
	assert.match(display, /401.*Denied.*Check credentials/);
	assert.doesNotMatch(
		providerErrorEvidence("Authorization: Bearer sk-abcdefghijklmnopqrstuv"),
		/sk-abcdefghijklmnopqrstuv/,
	);
	assert.match(
		stripVTControlCharacters(formatRetryStatus({ phase: "cancelled", attempt: 2, maxAttempts: 3 })),
		/provider retry cancelled/,
	);
	assert.match(
		stripVTControlCharacters(formatRetryStatus({ phase: "recovered", attempt: 2, maxAttempts: 3 })),
		/provider retry recovered/,
	);
});

test("huge malformed and multiline diagnostics stay bounded", () => {
	for (const raw of ["x".repeat(5_000_000), '{"message":"unterminated'.repeat(100_000), "line\n".repeat(100_000)]) {
		assert.ok(presentProviderError(raw).length < 700);
		assert.match(presentProviderError(raw), /available diagnostic/);
	}
});

test("43-column primary failures and retries obey style row budgets including inspection hints", () => {
	const raw = `HTTP 503 ${"Gateway unavailable; check the endpoint. ".repeat(80)}`;
	for (const style of ["compact", "standard", "detailed"] as const) {
		const budget = style === "detailed" ? 12 : 4;
		for (const event of [
			failure(raw),
			{ type: "retry_status", status: { phase: "exhausted", attempt: 2, maxAttempts: 2, errorMessage: raw } } as const,
		]) {
			const panel = createChatPanel({ getOutputStyle: () => style, getTerminalRows: () => 40 });
			panel.applyEvent(event);
			const rows = plain(panel.render(43))
				.split("\n")
				.filter((line) => line.trim());
			assert.ok(rows.length <= budget, `${style}: ${rows.length} > ${budget}`);
			assert.match(rows.join("\n"), /503/);
			assert.match(rows.join("\n"), /\/view/);
			const full = createChatPanel({ getOutputStyle: () => style, unboundedToolBodies: true });
			full.applyEvent(event);
			assert.ok(plain(full.render(43)).split("\n").length > budget);
		}
	}
});

test("OSC and CSI spanning the scan boundary cannot expose payloads in primary or full evidence", async () => {
	for (const sequence of [
		`\u001b]0;OSC_PAYLOAD_${"x".repeat(9000)}\u0007`,
		`\u001b]0;OSC_PAYLOAD_${"x".repeat(9000)}\u001b\\`,
		`\u009d0;OSC_PAYLOAD_${"x".repeat(9000)}\u009c`,
		`\u001b[${"1;".repeat(5000)}m`,
		`\u009b${"1;".repeat(5000)}m`,
	]) {
		const raw = `HTTP 503 ${sequence}AFTER_CONTROL`;
		assert.doesNotMatch(presentProviderError(raw), /OSC_PAYLOAD|xxx|1;|AFTER_CONTROL/);
		assert.equal(providerErrorEvidence(raw), "HTTP 503 AFTER_CONTROL");
		const panel = createChatPanel();
		panel.applyEvent(failure(raw));
		const artifact = panel.inspectionArtifacts()[0];
		assert.ok(artifact, "Expected a full diagnostic artifact");
		const evidence = (await artifact.load()).lines.join("\n");
		assert.match(evidence, /AFTER_CONTROL/);
		assert.doesNotMatch(evidence, /OSC_PAYLOAD|xxx|1;/);
	}
	for (const incomplete of ["\u001b]0;HIDDEN", "\u001b[123;", "\u009d0;HIDDEN", "\u001b"]) {
		assert.equal(providerErrorEvidence(`HTTP 503 ${incomplete}`), "HTTP 503 ");
	}
});

test("persisted retry replay bounds primary rows but View and both export flags retain full safe evidence", async () => {
	const raw = `HTTP 503 ${"gateway failure ".repeat(2000)}\u001b]0;HIDDEN_TITLE\u0007 EVIDENCE_TAIL api_key=fixture-secret-value`;
	const entry: CustomEntry = {
		kind: "custom",
		turnId: "retry-fixture",
		parentTurnId: null,
		timestamp: "2026-09-17T00:00:00Z",
		customType: "retryStatus",
		data: { phase: "exhausted", attempt: 1, maxAttempts: 1, errorMessage: raw },
	};
	for (const style of ["compact", "standard", "detailed"] as const) {
		const panel = createChatPanel({ getOutputStyle: () => style });
		rehydrateChatPanelFromTurns(panel, [entry]);
		const rows = plain(panel.render(43))
			.split("\n")
			.filter((line) => line.trim());
		assert.ok(rows.length <= (style === "detailed" ? 12 : 4));
		assert.match(rows.join("\n"), /\/view/);
		const artifact = panel.inspectionArtifacts()[0];
		assert.ok(artifact, "Expected a full diagnostic artifact");
		const evidence = (await artifact.load()).lines.join("\n");
		assert.match(evidence, /EVIDENCE_TAIL/);
		assert.doesNotMatch(evidence, /HIDDEN_TITLE|fixture-secret-value/);
	}
	for (const flag of ["panel", "rehydrate"] as const) {
		const panel = createChatPanel({ unboundedToolBodies: flag === "panel" });
		rehydrateChatPanelFromTurns(panel, [entry], { unboundedToolBodies: flag === "rehydrate" });
		const exported = plain(panel.render(120));
		assert.match(exported, /EVIDENCE_TAIL/);
		assert.doesNotMatch(exported, /HIDDEN_TITLE|fixture-secret-value/);
	}
	assert.equal((entry.data as RetryStatusPayload).errorMessage, raw);
});

test("thrown exhausted provider retry emits one bounded outcome and persists its full diagnostic", async () => {
	const raw = `HTTP 503 ${"gateway unavailable ".repeat(2000)}EVIDENCE_TAIL`;
	const statuses: RetryStatusPayload[] = [];
	const notices: string[] = [];
	const panel = createChatPanel();
	let calls = 0;
	const recovery = createTurnRecovery({
		state: { activeInterruptReason: null } as ChatTurnState,
		persistence: {
			appendRetryStatus: (status: RetryStatusPayload) => statuses.push(status),
			wasPersisted: () => false,
		} as unknown as TurnPersistence,
		context: {} as TurnContext,
		retrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, streamStallMs: 0 }),
		markPersistedUserEcho: async () => undefined,
		emitRetryStatus: (status) => panel.applyEvent({ type: "retry_status", status }),
		emitFailureMessage: () => assert.fail("No synthetic assistant message should be introduced"),
		emitNotice: (message) => notices.push(message),
	});
	const runtime = {
		runtimeId: "native",
		agent: {
			state: { messages: [] },
			continue: async () => {
				calls++;
				throw new Error(raw);
			},
		},
	} as unknown as AgentRuntime;
	assert.equal(
		await recovery.runTransientRetryChain(runtime, "hello", {
			stopReason: "error",
			errorMessage: "503 service unavailable",
		}),
		true,
	);
	assert.equal(calls, 1);
	assert.deepEqual(notices, []);
	assert.deepEqual(
		statuses.map((status) => status.phase),
		["scheduled", "exhausted"],
	);
	assert.equal(statuses.at(-1)?.errorMessage, raw);
	const rows = plain(panel.render(43))
		.split("\n")
		.filter((line) => line.trim());
	assert.ok(rows.length <= 4);
	assert.match(rows.join("\n"), /exhausted/);
	const artifact = panel.inspectionArtifacts()[0];
	assert.ok(artifact, "Expected the exhausted retry diagnostic artifact");
	assert.match((await artifact.load()).lines.join("\n"), /EVIDENCE_TAIL/);
});

test("actual LiteLLM wrapper keeps route recovery and policy in primary JSON and HTML errors", () => {
	for (const body of [
		'HTTP 503 {"error":{"message":"Backend unavailable"}}',
		"HTTP 503 <html><title>Backend unavailable</title></html>",
	]) {
		const raw = liteLLMRouteFailureMessage(body, "local-target", "chosen-route");
		const panel = createChatPanel();
		panel.applyEvent(failure(raw));
		const output = plain(panel.render(120));
		assert.match(output, /503/);
		assert.match(output, /\/model/);
		assert.match(output.replace(/\s+/g, " "), /did not retry or substitute another model/);
		assert.match(output, /chosen-route/);
		const replay = createChatPanel();
		rehydrateChatPanelFromTurns(replay, [
			{
				kind: "message",
				role: "assistant",
				turnId: "route-failure",
				parentTurnId: null,
				timestamp: "2026-09-17T00:00:00Z",
				payload: { stopReason: "error", errorMessage: raw, content: [] },
			},
		]);
		for (const width of [43, 120]) {
			for (const current of [panel, replay]) {
				const rows = plain(current.render(width))
					.split("\n")
					.filter((row) => row.trim());
				assert.ok(rows.length <= 4);
				assert.match(rows.join("\n"), /\/model/);
			}
		}
	}
});

test("Google numeric HTTP code survives production primary projection without numeric coercion", () => {
	const panel = createChatPanel();
	panel.applyEvent(
		failure(
			'{"error":{"code":429,"message":"Quota exceeded. Retry after reset.","status":"RESOURCE_EXHAUSTED","id":9007199254740993}}',
		),
	);
	const output = plain(panel.render(100));
	assert.match(output, /429/);
	assert.match(output, /Quota exceeded/);
});

test("short-height live and replay final retries keep diagnosis within the same two-row budget", () => {
	for (const style of ["compact", "standard", "detailed"] as const) {
		for (const errorMessage of [
			"HTTP 401 Invalid credentials. Update /settings.",
			`HTTP 503 Gateway unavailable. ${"Long detail. ".repeat(100)}`,
		]) {
			const status: RetryStatusPayload = { phase: "exhausted", attempt: 1, maxAttempts: 1, errorMessage };
			const live = createChatPanel({ getTerminalRows: () => 12, getOutputStyle: () => style });
			live.applyEvent({ type: "retry_status", status });
			const replay = createChatPanel({ getTerminalRows: () => 12, getOutputStyle: () => style });
			rehydrateChatPanelFromTurns(replay, [
				{
					kind: "custom",
					turnId: "short-retry",
					parentTurnId: null,
					timestamp: "2026-09-17T00:00:00Z",
					customType: "retryStatus",
					data: status,
				},
			]);
			const output = plain(live.render(43));
			assert.equal(plain(replay.render(43)), output);
			assert.ok(output.split("\n").filter((row) => row.trim()).length <= 2);
			assert.match(output, /exhausted/);
			assert.match(output, errorMessage.includes("401") ? /401.*Invalid credentials/ : /503.*Gateway unavailable/);
			assert.match(output, /\/view/);
		}
	}
});

test("unfinished JSON message projects useful prose and waiting/running do not repeat its body", async () => {
	const raw = `503: {"message":"Backend is unavailable. ${"payload ".repeat(2000)}"}`;
	const output = presentProviderError(raw);
	assert.match(output, /Backend is unavailable/);
	assert.doesNotMatch(output, /\{"message/);
	assert.match(output, /available diagnostic/);
	assert.doesNotMatch(output, /full diagnostic/);
	for (const phase of ["waiting", "retrying"] as const) {
		const panel = createChatPanel();
		panel.applyEvent({ type: "retry_status", status: { phase, attempt: 1, maxAttempts: 2, errorMessage: raw } });
		assert.doesNotMatch(plain(panel.render(43)), /Backend|payload/);
		const artifact = panel.inspectionArtifacts()[0];
		assert.ok(artifact);
		assert.match((await artifact.load()).lines.join("\n"), /Backend/);
	}
});

test("unrelated numeric fields do not become HTTP status and available evidence keeps SDK truncation", async () => {
	const raw = '{"message":"Invalid request","debug":{"code":429},"id":9007199254740993}';
	assert.doesNotMatch(presentProviderError(raw), /HTTP 429/);
	const available = `503: {"message":"Backend unavailable. ${"x".repeat(3950)}... [truncated 380161 chars]`;
	const panel = createChatPanel({ unboundedToolBodies: true });
	panel.applyEvent(failure(available));
	assert.match(plain(panel.render(120)), /\[truncated 380161 chars\]/);
	const artifact = panel.inspectionArtifacts()[0];
	assert.ok(artifact);
	assert.match((await artifact.load()).lines.join("\n"), /\[truncated 380161 chars\]/);
	assert.match(presentProviderError(available), /available diagnostic/);
});
