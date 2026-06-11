import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { lmStudioQuietLogger } from "../../src/domains/providers/runtimes/common/lmstudio-logger.js";

function captureStderr(run: () => void): string[] {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	try {
		run();
	} finally {
		process.stderr.write = original;
	}
	return lines;
}

describe("lmStudioQuietLogger", () => {
	afterEach(() => {
		delete process.env.CLIO_DEBUG_LMSTUDIO;
	});

	it("swallows SDK log output by default so nothing tears the TUI", () => {
		delete process.env.CLIO_DEBUG_LMSTUDIO;
		const lines = captureStderr(() => {
			lmStudioQuietLogger.error("WebSocket error:", new Error("connect ENETUNREACH 192.168.86.143:1234"));
			lmStudioQuietLogger.warn("channel teardown");
			lmStudioQuietLogger.info("connected");
			lmStudioQuietLogger.debug("frame");
		});
		assert.deepEqual(lines, []);
	});

	it("routes SDK log output to stderr when CLIO_DEBUG_LMSTUDIO=1", () => {
		process.env.CLIO_DEBUG_LMSTUDIO = "1";
		const lines = captureStderr(() => {
			lmStudioQuietLogger.error("WebSocket error:", new Error("connect ENETUNREACH"));
		});
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /^\[clio:lmstudio\] error WebSocket error: Error: connect ENETUNREACH/);
	});
});
