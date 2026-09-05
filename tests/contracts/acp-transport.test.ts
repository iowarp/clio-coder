import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AcpProcessError } from "../../src/engine/acp/errors.js";
import { ACP_MAX_INPUT_LINE_BYTES, createStdioServerTransport } from "../../src/engine/acp/transport.js";

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
