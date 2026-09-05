import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { restoreStdout, takeOverStdout, writeRawStdout } from "../../src/cli/output-guard.js";
import { AcpProcessError } from "../../src/engine/acp/errors.js";
import { ACP_MAX_INPUT_LINE_BYTES, createStdioServerTransport } from "../../src/engine/acp/transport.js";

const scenario = process.argv[2];
const received = [];
let release;
const original = process.stdout._write;
process.stdout._write = (chunk, _encoding, callback) => {
	if (scenario === "write-error") throw new Error("fixture write failed");
	received.push(chunk.toString());
	release = callback;
	if (scenario === "fast") callback();
};
takeOverStdout();
const input = new PassThrough();
const transport = createStdioServerTransport({ input, write: writeRawStdout });
let closes = 0;
transport.onClose(() => closes++);
try {
	if (scenario === "fast") {
		transport.notify("first", { text: "界".repeat(400_000) });
		transport.notify("second");
		assert.deepEqual(
			received.map((line) => JSON.parse(line).method),
			["first", "second"],
		);
		assert.equal(transport.closed, false);
		assert.equal(process.stdout.writableLength, 0);
	} else if (scenario === "drain") {
		const expected = [];
		for (let index = 0; index < 4; index++) {
			const params = { index, text: "界".repeat(70_000) };
			expected.push(`${JSON.stringify({ jsonrpc: "2.0", method: "update", params })}\n`);
			transport.notify("update", params);
			assert.equal(process.stdout.writableLength, expected[0].length);
			assert.equal(received.length, 1);
		}
		for (let index = 0; index < expected.length; index++) {
			release();
			await setImmediate();
			assert.equal(received.length, Math.min(index + 2, expected.length));
		}
		assert.deepEqual(received, expected);
		assert.equal(transport.closed, false);
		assert.equal(process.stdout.writableLength, 0);
		assert.equal(process.stdout.listenerCount("drain"), 0);
	} else {
		const text =
			scenario === "initial-ascii"
				? "x".repeat(ACP_MAX_INPUT_LINE_BYTES)
				: "界".repeat(scenario === "initial" ? 400_000 : 70_000);
		const pending = transport.request("fixture/request", { text }, 2_000);
		const rejected = assert.rejects(pending, (error) => {
			assert.ok(error instanceof AcpProcessError);
			assert.equal(error.code, "acp_process_error");
			assert.match(
				error.message,
				scenario === "write-error" ? /output write failed/ : /output buffer exceeded byte limit/,
			);
			return true;
		});
		if (scenario === "overflow") {
			const overhead = Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", method: "update", params: "" })}\n`);
			const available = ACP_MAX_INPUT_LINE_BYTES - Buffer.byteLength(received[0]) - overhead;
			transport.notify("update", "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3));
			assert.equal(transport.closed, false, "the exact byte budget remains admissible");
			transport.notify("overflow");
		}
		await rejected;
		assert.equal(transport.closed, true);
		assert.equal(closes, 1);
		assert.equal(process.stdout.listenerCount("drain"), 0);
		assert.equal(received.length, scenario === "write-error" ? 0 : 1);
	}
} finally {
	transport.close();
	input.destroy();
	restoreStdout();
	process.stdout._write = original;
	if (scenario !== "fast") release?.();
}
