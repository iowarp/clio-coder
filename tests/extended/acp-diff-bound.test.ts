import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { ACP_MAX_RAW_DIFF_BYTES, ACP_MAX_RAW_RECORD_BYTES, ACP_MAX_STRING_BYTES } from "../../src/engine/acp/types.js";
import { generateDiffString } from "../../src/tools/edit-diff.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/** An in-memory peer: the test plays the client and calls the server's handlers directly. */
function fakeTransport() {
	const handlers = new Map<string, RequestHandler>();
	const notifications: Array<{ method: string; params: unknown }> = [];
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const transport: AcpJsonRpcPeerTransport = {
		get closed() {
			return closed;
		},
		request: async () => {
			throw new Error("the server sends no client requests in this test");
		},
		notify: (method, params) => {
			notifications.push({ method, params });
		},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			closeHandlers.push(handler);
			return () => {};
		},
		close: () => {
			closed = true;
			for (const handler of closeHandlers) handler();
		},
	};
	const call = async (method: string, params: unknown): Promise<unknown> => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`no handler registered for ${method}`);
		return await handler(params);
	};
	return { transport, notifications, call };
}

function scriptedChat(script: (emit: (event: unknown) => void) => void): AcpServerChat {
	let emit: (event: unknown) => void = () => {};
	return {
		submit: async () => {
			script((event) => emit(event));
		},
		cancel: () => {},
		onEvent: (handler) => {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		isStreaming: () => false,
		getSessionId: () => null,
	};
}

/**
 * One `edit` result as the tool actually builds it: `details.diff` from
 * {@link generateDiffString}, the confirmation sentence on `output`, and the
 * publish facts alongside. Nothing here is shaped for the assertion.
 */
function editResult(diff: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "ok",
		output: "edited src/app.ts: 5 replacement(s).",
		details: {
			file: { before: { size: 1024 }, after: { size: 1100 } },
			diff,
			firstChangedLine: 12,
			paths: ["/workspace/src/app.ts"],
			...extra,
		},
	};
}

/** A genuine multi-hunk diff: five separated edits in a 400-line source file. */
function multiHunkDiff(): string {
	const base: string[] = [];
	for (let line = 0; line < 400; line += 1) {
		base.push(`\tconst value${line} = compute(${line}, "a fairly ordinary line of source text");`);
	}
	const next = [...base];
	for (const line of [12, 90, 180, 260, 350]) {
		next[line] = `\tconst value${line} = computeV2(${line}, "a fairly ordinary line of replacement text");`;
		next[line + 1] = `\tassert(value${line} !== undefined, "value${line} must be produced before it is used");`;
	}
	return generateDiffString(base.join("\n"), next.join("\n")).diff;
}

async function terminalRawOutput(result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const peer = fakeTransport();
	const chat = scriptedChat((emit) => {
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts" } });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false });
	});
	const served = serveClioAcpAgent({ transport: peer.transport, chat, cwd: process.cwd() });
	await peer.call("initialize", { protocolVersion: 1 });
	const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await peer.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "edit it" }] });
	peer.transport.close();
	strictEqual(await served, 0);
	const terminal = peer.notifications
		.filter((entry) => entry.method === "session/update")
		.map((entry) => (entry.params as { update: Record<string, unknown> }).update)
		.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
	ok(terminal !== undefined, "the turn produced no terminal tool_call_update");
	return terminal.rawOutput as Record<string, unknown>;
}

function diffOf(rawOutput: Record<string, unknown>): string {
	const result = rawOutput.result as { details: { diff: string } };
	return result.details.diff;
}

describe("contracts/acp keeps a whole multi-hunk diff on the wire", () => {
	it("carries a realistic diff past the generic string cap and still holds the record bound", async () => {
		const diff = multiHunkDiff();
		ok(
			Buffer.byteLength(diff, "utf8") > ACP_MAX_STRING_BYTES,
			"the fixture diff must exceed the generic string cap or it proves nothing",
		);
		const rawOutput = await terminalRawOutput(editResult(diff));
		strictEqual(diffOf(rawOutput), diff);
		ok(!diffOf(rawOutput).includes("…[truncated]"));
		ok(Buffer.byteLength(JSON.stringify(rawOutput), "utf8") <= ACP_MAX_RAW_RECORD_BYTES);
	});

	it("caps a diff that is wider than its own bound, leaving the record intact rather than eliding it", async () => {
		// Wider than any diff the engine can produce: `MAX_DIFF_BYTES` caps it at
		// 32 KiB upstream, so this stands in for a future tool that does not.
		const diff = `${"- a line that was removed from the file\n".repeat(2000)}`;
		const rawOutput = await terminalRawOutput(editResult(diff));
		const wire = diffOf(rawOutput);
		ok(wire.endsWith("…[truncated]"));
		strictEqual(Buffer.byteLength(wire, "utf8"), ACP_MAX_RAW_DIFF_BYTES);
		// The record survived: the whole thing was not replaced by the elision
		// marker, which is what the reserve under the record cap buys.
		strictEqual(rawOutput.truncated, undefined);
		ok(Buffer.byteLength(JSON.stringify(rawOutput), "utf8") <= ACP_MAX_RAW_RECORD_BYTES);
	});

	it("widens only details.diff, so a sibling string and a same-named field elsewhere stay at the generic cap", async () => {
		const long = "x".repeat(ACP_MAX_STRING_BYTES * 2);
		const rawOutput = await terminalRawOutput({
			...editResult(multiHunkDiff(), { notes: long }),
			diff: long,
		});
		const result = rawOutput.result as { diff: string; details: { notes: string } };
		strictEqual(Buffer.byteLength(result.details.notes, "utf8"), ACP_MAX_STRING_BYTES);
		strictEqual(Buffer.byteLength(result.diff, "utf8"), ACP_MAX_STRING_BYTES);
	});
});
