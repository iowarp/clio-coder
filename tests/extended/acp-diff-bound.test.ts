import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { ACP_MAX_RAW_DIFF_BYTES, ACP_MAX_RAW_RECORD_BYTES, ACP_MAX_STRING_BYTES } from "../../src/engine/acp/types.js";
import { generateDiffString } from "../../src/tools/edit-diff.js";
import { fakeTransport } from "../harness/acp-fake-transport.js";

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

interface DiffRow {
	name: string;
	result: Record<string, unknown>;
	/** Strings under rawOutput.result: the exact text, or the byte length and whether it ends in the marker. */
	fields: Array<{ path: string[]; equals?: string; bytes?: number; truncated: boolean }>;
}

describe("contracts/acp keeps a whole multi-hunk diff on the wire", () => {
	it("bounds details.diff by its own cap and every other string by the generic one, inside the record bound", async () => {
		const diff = multiHunkDiff();
		ok(
			Buffer.byteLength(diff, "utf8") > ACP_MAX_STRING_BYTES,
			"the fixture diff must exceed the generic string cap or it proves nothing",
		);
		const long = "x".repeat(ACP_MAX_STRING_BYTES * 2);
		const rows: DiffRow[] = [
			{
				name: "carries a realistic diff past the generic string cap and still holds the record bound",
				result: editResult(diff),
				fields: [{ path: ["details", "diff"], equals: diff, truncated: false }],
			},
			{
				// Wider than any diff the engine can produce: `MAX_DIFF_BYTES` caps it at
				// 32 KiB upstream, so this stands in for a future tool that does not.
				name: "caps a diff that is wider than its own bound, leaving the record intact rather than eliding it",
				result: editResult("- a line that was removed from the file\n".repeat(2000)),
				fields: [{ path: ["details", "diff"], bytes: ACP_MAX_RAW_DIFF_BYTES, truncated: true }],
			},
			{
				name: "widens only details.diff, so a sibling string and a same-named field elsewhere stay at the generic cap",
				result: { ...editResult(diff, { notes: long }), diff: long },
				fields: [
					{ path: ["details", "notes"], bytes: ACP_MAX_STRING_BYTES, truncated: true },
					{ path: ["diff"], bytes: ACP_MAX_STRING_BYTES, truncated: true },
				],
			},
		];
		for (const row of rows) {
			const rawOutput = await terminalRawOutput(row.result);
			for (const field of row.fields) {
				const label = `${row.name}: ${field.path.join(".")}`;
				let value: unknown = rawOutput.result;
				for (const key of field.path) value = (value as Record<string, unknown>)[key];
				ok(typeof value === "string", label);
				if (field.equals !== undefined) strictEqual(value, field.equals, label);
				if (field.bytes !== undefined) strictEqual(Buffer.byteLength(value, "utf8"), field.bytes, label);
				strictEqual(value.endsWith("…[truncated]"), field.truncated, label);
			}
			// The record survived: the whole thing was not replaced by the elision
			// marker, which is what the reserve under the record cap buys.
			strictEqual(rawOutput.truncated, undefined, row.name);
			ok(Buffer.byteLength(JSON.stringify(rawOutput), "utf8") <= ACP_MAX_RAW_RECORD_BYTES, row.name);
		}
	});
});
