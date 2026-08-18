/**
 * Admission and disclosure for the ACP server transport (CONTRACT C001 §0).
 *
 * Every frame this transport writes on a failure is part of the wire contract a
 * Workbench-class client branches on, so each case here pins the exact JSON: a
 * standard JSON-RPC code, a bounded single-line message, and `data` holding
 * exactly one namespaced versioned object. The two disclosure regressions this
 * file exists to prevent are a serialized `Error.stack` and an echoed input
 * frame; both used to ride along in `error.data`.
 *
 * The harness is deliberately local. `acp.test.ts` has a similar one, but that
 * file is the server-behavior suite and importing across test files couples two
 * independently evolving contracts.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { ACP_MAX_INPUT_LINE_BYTES, createStdioServerTransport } from "../../src/engine/acp/transport.js";

const CASE_TIMEOUT_MS = 15_000;
const FRAME_WAIT_MS = 5_000;
const ERROR_META_KEY = "clio-coder/error";

interface Frame extends Record<string, unknown> {
	jsonrpc: string;
}

interface Harness {
	transport: AcpJsonRpcPeerTransport;
	frames: Frame[];
	/** Every line the transport sent to its diagnostics sink, in order. */
	diagnostics: string[];
	/** Write one raw line (the newline is appended) to the transport's input. */
	send(line: string): void;
	/** Write raw text with no newline appended. */
	sendRaw(text: string): void;
	waitForFrame(predicate: (frame: Frame) => boolean, message: string): Promise<Frame>;
	/** Resolves once the transport reports the input channel closed. */
	closed: Promise<void>;
	endInput(): void;
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHarness(): Harness {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const diagnostics: string[] = [];
	const transport = createStdioServerTransport({
		input: clientToServer,
		output: serverToClient,
		diagnostics: (line) => diagnostics.push(line),
	});
	const frames: Frame[] = [];
	const waiters: Array<{ predicate(frame: Frame): boolean; resolve(frame: Frame): void }> = [];
	let buffer = "";
	serverToClient.setEncoding("utf8");
	serverToClient.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const idx = buffer.indexOf("\n");
			if (idx === -1) break;
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim().length === 0) continue;
			const frame = JSON.parse(line) as Frame;
			frames.push(frame);
			for (let index = 0; index < waiters.length; index += 1) {
				const waiter = waiters[index];
				if (!waiter?.predicate(frame)) continue;
				waiters.splice(index, 1);
				waiter.resolve(frame);
				break;
			}
		}
	});
	let markClosed: (() => void) | null = null;
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve;
	});
	transport.onClose(() => markClosed?.());
	return {
		transport,
		frames,
		diagnostics,
		send(line: string): void {
			clientToServer.write(`${line}\n`);
		},
		sendRaw(text: string): void {
			clientToServer.write(text);
		},
		waitForFrame(predicate, message): Promise<Frame> {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<Frame>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${message}`)), FRAME_WAIT_MS);
				waiters.push({
					predicate,
					resolve: (frame) => {
						clearTimeout(timer);
						resolve(frame);
					},
				});
			});
		},
		closed,
		endInput(): void {
			clientToServer.end();
		},
		dispose(): void {
			clientToServer.end();
			transport.close();
		},
	};
}

function errorOf(frame: Frame): Record<string, unknown> {
	ok(isRecord(frame.error), `frame carries no error: ${JSON.stringify(frame)}`);
	return frame.error;
}

/** The one shape `error.data` may ever have, unwrapped for assertions. */
function errorDetail(frame: Frame): Record<string, unknown> {
	const data = errorOf(frame).data;
	ok(isRecord(data), `error.data must be an object: ${JSON.stringify(frame)}`);
	ok(isRecord(data._meta), `error.data must carry _meta: ${JSON.stringify(frame)}`);
	deepStrictEqual(Object.keys(data), ["_meta"], "error.data carries nothing besides _meta");
	const detail = data._meta[ERROR_META_KEY];
	ok(isRecord(detail), `error.data._meta must carry ${ERROR_META_KEY}`);
	strictEqual(detail.version, 1, "error detail is versioned");
	return detail;
}

function byId(id: number): (frame: Frame) => boolean {
	return (frame) => frame.id === id;
}

describe("contracts/acp transport admission", () => {
	it("serializes a typed handler failure verbatim", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.transport.onRequest("session/prompt", () => {
				throw new AcpRequestError(-32000, "x", { code: "session_unknown" });
			});
			harness.transport.onRequest("initialize", () => {
				throw new AcpRequestError(-32602, "unsupported protocol version", {
					code: "protocol_version_unsupported",
					supported: [1],
				});
			});

			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} }));
			const failure = await harness.waitForFrame(byId(1), "the typed failure");
			deepStrictEqual(failure, {
				jsonrpc: "2.0",
				id: 1,
				error: {
					code: -32000,
					message: "x",
					data: { _meta: { [ERROR_META_KEY]: { version: 1, code: "session_unknown" } } },
				},
			});

			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 99 } }));
			const rejected = await harness.waitForFrame(byId(2), "the version rejection");
			deepStrictEqual(errorDetail(rejected), {
				version: 1,
				code: "protocol_version_unsupported",
				supported: [1],
			});
			strictEqual(errorOf(rejected).code, -32602, "a typed failure keeps the code its thrower chose");
		} finally {
			harness.dispose();
		}
	});

	it("reduces an untyped handler failure to fixed host text and diverts the original", {
		timeout: CASE_TIMEOUT_MS,
	}, async () => {
		const harness = createHarness();
		try {
			// A real Error, so it carries a real stack whose frames name this file
			// under process.cwd(). That is exactly what must not reach the wire.
			harness.transport.onRequest("session/new", () => {
				throw new Error(`boom\nsecond line\n\tthird line ${"x".repeat(400)}`);
			});

			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/new", params: {} }));
			const frame = await harness.waitForFrame(byId(7), "the internal error");
			const error = errorOf(frame);

			strictEqual(error.code, -32000);
			deepStrictEqual(errorDetail(frame), { version: 1, code: "internal_error" });
			// The client branches on the code, not on prose it cannot parse. The
			// message is host-authored so nothing an unclassified thrower wrote can
			// reach the wire through it.
			strictEqual(error.message, "internal error", "the message is fixed host text");

			const serialized = JSON.stringify(frame);
			strictEqual(serialized.includes("    at "), false, "no stack frames on the wire");
			strictEqual(serialized.includes(process.cwd()), false, "no absolute paths on the wire");
			strictEqual(serialized.includes("boom"), false, "the thrower's prose is not on the wire");

			// The operator still gets the detail, bounded to one line, on stderr.
			strictEqual(harness.diagnostics.length, 1, "one diagnostics line per internal error");
			const diagnostic = harness.diagnostics[0] ?? "";
			strictEqual(diagnostic.includes("\n"), false, "a diagnostics line is single-line");
			ok(diagnostic.startsWith("internal error: boom second line third line"), `unexpected line: ${diagnostic}`);
			ok(diagnostic.endsWith("…"), "the diverted message is bounded too");
		} finally {
			harness.dispose();
		}
	});

	it("keeps an untyped failure's paths, URLs, and tokens off the wire", {
		timeout: CASE_TIMEOUT_MS,
	}, async () => {
		const harness = createHarness();
		const secretPath = "/home/operator/.clio-coder/config/settings.json";
		const secretUrl = "https://user:pw@example.com/x";
		const secretToken = "sk-live-4f9a2c7b1e8d";
		try {
			// The shape a provider client throws: the request it made, the file it
			// read the credential from, and the credential itself.
			harness.transport.onRequest("session/prompt", () => {
				throw new Error(`POST ${secretUrl} failed (key ${secretToken} from ${secretPath})`);
			});

			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 21, method: "session/prompt", params: {} }));
			const frame = await harness.waitForFrame(byId(21), "the internal error");

			strictEqual(errorOf(frame).code, -32000);
			strictEqual(errorOf(frame).message, "internal error");
			deepStrictEqual(errorDetail(frame), { version: 1, code: "internal_error" });

			const serialized = JSON.stringify(frame);
			for (const secret of [secretPath, secretUrl, secretToken]) {
				strictEqual(serialized.includes(secret), false, `frame discloses ${secret}: ${serialized}`);
			}

			const diagnostic = harness.diagnostics[0] ?? "";
			for (const secret of [secretPath, secretUrl, secretToken]) {
				ok(diagnostic.includes(secret), `diagnostics lost ${secret}: ${diagnostic}`);
			}
		} finally {
			harness.dispose();
		}
	});

	it("answers an unparseable line without echoing it", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.send("not json at all");
			const frame = await harness.waitForFrame((candidate) => candidate.id === null, "the parse error");

			strictEqual(frame.id, null);
			strictEqual(errorOf(frame).code, -32700);
			strictEqual(errorOf(frame).message, "parse error");
			deepStrictEqual(errorDetail(frame), { version: 1, code: "parse_error" });
			strictEqual(JSON.stringify(frame).includes("not json at all"), false, "the offending line is not echoed");
		} finally {
			harness.dispose();
		}
	});

	it("rejects a non-2.0 frame without echoing it", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.send(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "initialize" }));
			const frame = await harness.waitForFrame((candidate) => candidate.id === null, "the invalid-request error");

			strictEqual(frame.id, null);
			strictEqual(errorOf(frame).code, -32600);
			deepStrictEqual(errorDetail(frame), { version: 1, code: "invalid_request" });
			strictEqual(JSON.stringify(frame).includes('"1.0"'), false, "the rejected frame is not echoed");
		} finally {
			harness.dispose();
		}
	});

	it("answers a request whose id is null instead of dropping it", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			let handled = 0;
			harness.transport.onRequest("initialize", () => {
				handled += 1;
				return {};
			});

			harness.send(JSON.stringify({ jsonrpc: "2.0", id: null, method: "initialize", params: {} }));
			const frame = await harness.waitForFrame((candidate) => candidate.id === null, "the null-id rejection");

			strictEqual(errorOf(frame).code, -32600);
			deepStrictEqual(errorDetail(frame), { version: 1, code: "invalid_request_id" });
			strictEqual(handled, 0, "a request that cannot be answered never reaches a handler");
		} finally {
			harness.dispose();
		}
	});

	it("discards one oversized line and keeps serving", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.transport.onRequest("initialize", () => ({ protocolVersion: 1 }));

			// One byte past the bound, no newline yet, so the pending-buffer guard is
			// what fires. The newline that follows ends the discard.
			harness.sendRaw("x".repeat(ACP_MAX_INPUT_LINE_BYTES + 1));
			harness.send("");
			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }));

			const answered = await harness.waitForFrame(byId(4), "the request after the oversized line");
			ok(isRecord(answered.result), "the valid request is answered normally");

			const oversized = (): Frame[] =>
				harness.frames.filter((frame) => {
					if (!isRecord(frame.error)) return false;
					const data = frame.error.data;
					if (!isRecord(data) || !isRecord(data._meta)) return false;
					const detail = data._meta[ERROR_META_KEY];
					return isRecord(detail) && detail.code === "input_line_too_large";
				});
			strictEqual(oversized().length, 1, "exactly one report per oversized line");
			const report = oversized()[0];
			ok(report, "expected the oversized-line report");
			strictEqual(report.id, null);
			strictEqual(errorOf(report).code, -32600);
			deepStrictEqual(errorDetail(report), { version: 1, code: "input_line_too_large" });
			strictEqual(harness.transport.closed, false, "the transport stays open");

			// The same line delivered whole, newline included, takes the other path:
			// the pending-buffer guard never sees it, so the completed line is what
			// must be measured. One report either way.
			harness.sendRaw(
				`${"y".repeat(ACP_MAX_INPUT_LINE_BYTES + 1)}\n${JSON.stringify({
					jsonrpc: "2.0",
					id: 8,
					method: "initialize",
					params: {},
				})}\n`,
			);
			const answeredAgain = await harness.waitForFrame(byId(8), "the request after the whole oversized line");
			ok(isRecord(answeredAgain.result), "the valid request after a whole oversized line is answered");
			strictEqual(oversized().length, 2, "one report for each oversized line, however it was chunked");
			strictEqual(harness.transport.closed, false, "the transport stays open");
		} finally {
			harness.dispose();
		}
	});

	it("drops a partial frame at EOF and closes cleanly", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.transport.onRequest("initialize", () => ({}));
			harness.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }).slice(0, 30));
			harness.endInput();

			await harness.closed;
			strictEqual(harness.transport.closed, true);
			strictEqual(harness.frames.length, 0, "a partial frame is answered by nothing");
		} finally {
			harness.dispose();
		}
	});

	it("reports an unregistered method as method_not_found", { timeout: CASE_TIMEOUT_MS }, async () => {
		const harness = createHarness();
		try {
			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session/load", params: {} }));
			const frame = await harness.waitForFrame(byId(6), "the method-not-found error");

			strictEqual(errorOf(frame).code, -32601);
			// Fixed host text. The method the client sent is not echoed: it is
			// peer-controlled text on a channel every other message of which this
			// process authored, and the client already knows what it called.
			strictEqual(errorOf(frame).message, "method not found");
			strictEqual(JSON.stringify(frame).includes("session/load"), false, "the method name is not echoed");
			deepStrictEqual(errorDetail(frame), { version: 1, code: "method_not_found" });

			// A method name as long as a whole input line changes nothing: there is no
			// peer text in the frame to bound.
			harness.send(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "m".repeat(5000), params: {} }));
			const bounded = await harness.waitForFrame(byId(12), "the second method-not-found error");
			const message = errorOf(bounded).message;

			strictEqual(errorOf(bounded).code, -32601);
			strictEqual(message, "method not found", "an oversized method name gets the same fixed text");
			strictEqual(JSON.stringify(bounded).includes("mmm"), false, "no part of the method name is echoed");
			deepStrictEqual(errorDetail(bounded), { version: 1, code: "method_not_found" });
		} finally {
			harness.dispose();
		}
	});
});
