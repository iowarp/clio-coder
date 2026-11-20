import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { AcpProcessError } from "../../src/engine/acp/errors.js";
import {
	ACP_MAX_INPUT_LINE_BYTES,
	boundAcpSessionUpdate,
	createStdioServerTransport,
	createStdioTransport,
	routeNonJsonRpcStdout,
	type StdioTransportOptions,
} from "../../src/engine/acp/transport.js";
import { makeScratchHome } from "../harness/scratch-env.js";

for (const scenario of ["drain", "overflow", "initial", "initial-ascii", "write-error", "fast"] as const) {
	test(`ACP guarded production stdout handles ${scenario}`, async () => {
		const home = makeScratchHome("clio-coder-acp-output-");
		try {
			const env = { ...process.env, ...home.env };
			delete env.NODE_TEST_CONTEXT;
			await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/fixtures/acp-output.mjs", scenario], {
				env,
				timeout: 5_000,
			});
		} finally {
			home.cleanup();
		}
	});
}

test("ACP pauses output until drain and delivers queued UTF-8 frames in order", async () => {
	const received: string[] = [];
	let release: (() => void) | undefined;
	const output = new Writable({
		highWaterMark: 1,
		write(chunk, _encoding, callback) {
			received.push(chunk.toString());
			release = callback;
		},
	});
	const input = new PassThrough();
	const transport = createStdioServerTransport({ input, output });
	try {
		const expected: string[] = [];
		let bufferedBytes = 0;
		for (let index = 0; index < 16; index++) {
			const params = { index, text: "界".repeat(10_000) };
			const frame = `${JSON.stringify({ jsonrpc: "2.0", method: "update", params })}\n`;
			expected.push(frame);
			bufferedBytes += Buffer.byteLength(frame);
			transport.notify("update", params);
			assert.ok(bufferedBytes <= ACP_MAX_INPUT_LINE_BYTES);
			assert.equal(output.writableLength, Buffer.byteLength(expected[0] ?? ""));
			assert.equal(received.length, 1);
		}
		for (let index = 0; index < expected.length; index++) {
			assert.ok(release);
			release();
			await setImmediate();
			bufferedBytes -= Buffer.byteLength(expected[index] ?? "");
			assert.ok(output.writableLength <= bufferedBytes);
			assert.equal(received.length, Math.min(index + 2, expected.length));
		}
		assert.deepEqual(received, expected);
		assert.equal(transport.closed, false);
		assert.equal(output.writableLength, 0);
		assert.equal(output.listenerCount("drain"), 0);
	} finally {
		transport.close();
		input.destroy();
		output.destroy();
	}
});

test("ACP closes with a typed error when a sink never drains and its byte budget is crossed", async () => {
	const output = new Writable({ highWaterMark: 1, write() {} });
	const input = new PassThrough();
	const transport = createStdioServerTransport({ input, output });
	let closes = 0;
	transport.onClose(() => closes++);
	try {
		const pending = transport.request("pending", undefined, 10_000);
		const rejected = assert.rejects(pending, (error: unknown) => {
			assert.ok(error instanceof AcpProcessError);
			assert.equal(error.code, "acp_process_error");
			assert.match(error.message, /output buffer exceeded byte limit/);
			return true;
		});
		const sinkBytes = output.writableLength;
		const overhead = Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", method: "update", params: "" })}\n`);
		const available = ACP_MAX_INPUT_LINE_BYTES - sinkBytes - overhead;
		const params = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
		transport.notify("update", params);
		assert.equal(transport.closed, false);
		assert.equal(output.writableLength, sinkBytes);
		transport.notify("overflow");
		await rejected;
		assert.equal(transport.closed, true);
		assert.equal(closes, 1);
		assert.equal(output.listenerCount("drain"), 0);
		output.emit("drain");
		transport.notify("ignored");
		assert.equal(output.writableLength, sinkBytes);
	} finally {
		transport.close();
		input.destroy();
		output.destroy();
	}
});

test("ACP fast sinks receive frames immediately", () => {
	const received: string[] = [];
	const output = new Writable({
		write(chunk, _encoding, callback) {
			received.push(chunk.toString());
			callback();
		},
	});
	const input = new PassThrough();
	const transport = createStdioServerTransport({ input, output });
	try {
		transport.notify("first");
		transport.notify("second");
		assert.deepEqual(
			received.map((line) => JSON.parse(line).method),
			["first", "second"],
		);
		assert.equal(output.listenerCount("drain"), 0);
	} finally {
		transport.close();
		input.destroy();
		output.destroy();
	}
});

test("ACP rejects the first oversized frame that stalls an ordinary sink", async () => {
	const input = new PassThrough();
	const output = new Writable({ highWaterMark: 1, write() {} });
	const transport = createStdioServerTransport({ input, output });
	try {
		await assert.rejects(transport.request("large", "界".repeat(400_000), 2_000), (error: unknown) => {
			assert.ok(error instanceof AcpProcessError);
			assert.match(error.message, /output buffer exceeded byte limit/);
			return true;
		});
		assert.equal(transport.closed, true);
		assert.equal(output.listenerCount("drain"), 0);
	} finally {
		transport.close();
		input.destroy();
		output.destroy();
	}
});

test("ACP stdio hooks route stray stdout and bound tool updates, and leave every frame as sent when unset", async () => {
	const update = {
		sessionUpdate: "tool_call_update",
		toolCallId: "call-1",
		status: "completed",
		content: [
			{ type: "content", content: { type: "image", mimeType: "image/png", data: "A".repeat(5_000) } },
			{ type: "content", content: { type: "text", text: "x".repeat(100) } },
		],
		rawOutput: { output: "done", formatted_output: "done", items: [1, 2, 3, 4, 5] },
	};
	const sent = { sessionId: "s-1", update };
	// The peer answers each request after an OAuth line on stdout and one heavy tool update.
	const peer = `
		const payload = JSON.parse(process.argv[1]);
		let buffer = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
				const message = JSON.parse(buffer.slice(0, at));
				buffer = buffer.slice(at + 1);
				process.stdout.write("Open https://auth.example/device?code=XYZ to sign in\\n");
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: payload }) + "\\n");
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
			}
		});
	`;
	const home = makeScratchHome("clio-coder-acp-hooks-");
	const env = Object.fromEntries(
		Object.entries(home.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const exchange = async (options: StdioTransportOptions) => {
		const transport = createStdioTransport(process.execPath, ["-e", peer, JSON.stringify(sent)], { ...options, env });
		const updates: unknown[] = [];
		const stderr: string[] = [];
		transport.onNotification("session/update", (params) => updates.push(params));
		transport.onStderr((chunk) => stderr.push(chunk));
		try {
			const result = await transport.request("initialize", {}, 5_000);
			return { result, updates, stderr: stderr.join("") };
		} finally {
			await transport.forceTerminate();
		}
	};
	try {
		const plain = await exchange({});
		assert.deepEqual(plain.result, { ok: true });
		assert.deepEqual(plain.updates, [sent]);
		assert.equal(plain.stderr, "");

		const hooked = await exchange({
			transformStdout: routeNonJsonRpcStdout,
			transformSessionUpdate: (params) => boundAcpSessionUpdate(params, { maxNodes: 12, maxChars: 40 }),
		});
		assert.deepEqual(hooked.result, { ok: true });
		assert.equal(hooked.stderr, "Open https://auth.example/device?code=XYZ to sign in\n");
		assert.deepEqual(hooked.updates, [
			{
				sessionId: "s-1",
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "call-1",
					status: "completed",
					content: [
						{
							type: "content",
							content: {
								type: "text",
								text: "[image omitted: image/png, 5000 base64 chars]",
								_meta: { "clio-coder/omitted": { kind: "image", mimeType: "image/png", chars: 5_000 } },
							},
						},
						{ type: "content", content: { type: "text", text: `${"x".repeat(22)}[78 chars omitted]` } },
					],
					rawOutput: { output: "[4 chars omitted]", items: ["[5 items omitted]"] },
				},
			},
		]);
		// Nothing to cut, or not a tool update: the same object comes back.
		const small = { sessionId: "s-1", update: { sessionUpdate: "tool_call", toolCallId: "c", rawInput: { a: 1 } } };
		assert.equal(boundAcpSessionUpdate(small), small);
		const chunk = { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: update.content[0] } };
		assert.equal(boundAcpSessionUpdate(chunk), chunk);
	} finally {
		home.cleanup();
	}
});
