import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

test("ACP provider error streamed as text is marked as a failed turn", () => {
	const mapper = new AcpEventMapper();
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Warning: model metadata missing.\n" },
		},
	});
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text:
					'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}',
			},
		},
	});
	const failure = mapper.reportedFailure();
	strictEqual(failure, "ACP peer reported HTTP 400: The model is not supported.");
	const events = mapper.finalEvents({ stopReason: "end_turn" }, failure);
	const terminal = events[0] as { message: { stopReason: string; errorMessage: string } };
	strictEqual(terminal.message.stopReason, "error");
	strictEqual(terminal.message.errorMessage, failure);
});

test("ACP Anthropic error envelope without HTTP status is still a failure", () => {
	const mapper = new AcpEventMapper();
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: '{"type":"error","error":{"type":"invalid_request_error","message":"Unknown model"}}',
			},
		},
	});
	strictEqual(mapper.reportedFailure(), "ACP peer reported error: Unknown model");
});

test("ACP ordinary text and quoted error examples do not become failures", () => {
	for (const text of [
		"The package version is 0.5.5.",
		'An example error is {"type":"error","status":400,"error":{"message":"example"}}',
		'{"type":"error","status":200,"error":{"message":"example"}}',
	]) {
		const mapper = new AcpEventMapper();
		mapper.mapUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
		strictEqual(mapper.reportedFailure(), null);
	}
});

test("ACP adapter fails a peer turn that returns an error envelope with end_turn", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "error-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url))],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP peer reported HTTP 400: The model is not supported.");
});

test("ACP adapter fails a statusless Anthropic error envelope with end_turn", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "anthropic-error-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "anthropic-error"],
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP peer reported error: The model is not supported.");
});

test("ACP adapter selects a requested Codex model before prompting", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-pin"],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		model: "gpt-6-luna",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.stopReason, "end_turn");
	strictEqual(result.delegation.selectedModelId, "gpt-6-luna[medium]");
});

test("ACP adapter uses the requested effort and rejects an ambiguous base model", async () => {
	const cwd = process.cwd();
	const agent = {
		id: "model-fixture",
		command: process.execPath,
		args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-variants"],
		connectTimeoutMs: 5_000,
	};
	const safety = createWorkerSafety({ cwd });
	const pinned = await startAcpDelegationRun({
		agent,
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety,
	}).promise;
	strictEqual(pinned.exitCode, 0, pinned.failureMessage);
	strictEqual(pinned.delegation.selectedModelId, "gpt-6-luna[high]");
	const ambiguous = await startAcpDelegationRun({ agent, task: "report version", model: "gpt-6-luna", cwd, safety })
		.promise;
	strictEqual(ambiguous.exitCode, 1);
	strictEqual(ambiguous.failureMessage?.includes("offers multiple efforts"), true);
});

test("ACP adapter selects model and thinking level through separate peer config options", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-option"],
		},
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.delegation.selectedModelId, "gpt-6-luna");
});

test("ACP adapter selects a peer thinking level without a model request", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-option"],
		},
		task: "report version",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 0, result.failureMessage);
	strictEqual(result.delegation.selectedModelId, "gpt-6-astra");
});

test("ACP adapter fails before prompting when the peer keeps another thinking level", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "thought-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "thought-refuse"],
		},
		task: "report version",
		model: "gpt-6-luna",
		thinkingLevel: "high",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage?.includes("kept thinking level 'medium' after Clio selected 'high'"), true);
});

test("ACP adapter selects models only through the stable config option, never session/set_model", async () => {
	const cwd = process.cwd();
	// A peer that offers only the unstable `models` field has no stable model
	// selector, so an explicit model request fails before prompting, and
	// session/set_model is never sent (the fixture refuses the prompt if it is).
	const legacy = await startAcpDelegationRun({
		agent: {
			id: "legacy-model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "legacy-models"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		model: "gpt-6-luna",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(legacy.exitCode, 1);
	strictEqual(
		legacy.failureMessage?.includes("does not offer requested model 'gpt-6-luna'"),
		true,
		legacy.failureMessage,
	);
	strictEqual(legacy.delegation.selectedModelId, undefined);
	// Without a requested model, the unstable field is not read as the selection either.
	const unrequested = await startAcpDelegationRun({
		agent: {
			id: "legacy-model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "legacy-models"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(unrequested.delegation.selectedModelId, undefined);
});

test("ACP adapter reports the config option's current model when none is requested", async () => {
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-variants"],
			connectTimeoutMs: 5_000,
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.delegation.selectedModelId, "gpt-6-astra[medium]");
});

test("ACP adapter fails a prompt response missing stopReason", async () => {
	const terminal = new AcpEventMapper().finalEvents({})[0] as {
		message: { stopReason: string; errorMessage: string };
	};
	strictEqual(terminal.message.stopReason, "error");
	strictEqual(terminal.message.errorMessage, "ACP prompt response missing stopReason");
	const cwd = process.cwd();
	const result = await startAcpDelegationRun({
		agent: {
			id: "missing-stop-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "missing-stop-reason"],
		},
		task: "report version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	}).promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage, "ACP prompt response missing stopReason");
});

test("ACP adapter fails an unavailable explicit model before prompting", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "model-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url)), "model-pin"],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		model: "gpt-6-unknown",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.stopReason, "error");
	strictEqual(result.failureMessage?.includes("does not offer requested model 'gpt-6-unknown'"), true);
});

test("ACP dispatch seals peer errors as failed and forwards a requested model", async () => {
	await isolateDispatchState();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.fleet.retry.routeCooldownMs = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "peer-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url))],
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	try {
		await bundle.extension.start();
		const request = { agentId: "peer-fixture", task: "report package version", executionRole: "builder" as const };
		const failure = await bundle.contract.dispatch(request);
		const failed = await failure.finalPromise;
		strictEqual(failed.outcome, "failed");
		strictEqual(failed.exitCode, 1);
		strictEqual(failed.failureMessage, "ACP peer reported HTTP 400: The model is not supported.");
		settings.integrations.externalAgents.entries[0]?.args.push("model-pin");
		const selected = await bundle.contract.dispatch({ ...request, model: "gpt-6-luna" });
		const succeeded = await selected.finalPromise;
		strictEqual(succeeded.outcome, "succeeded");
		strictEqual(succeeded.exitCode, 0);
		strictEqual(succeeded.delegation?.selectedModelId, "gpt-6-luna[medium]");
	} finally {
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});
