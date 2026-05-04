import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isStdoutTakenOver, restoreStdout, takeOverStdout, writeRawStdout } from "../../src/cli/output-guard.js";

describe("cli/output-guard", () => {
	it("routes normal stdout writes to stderr while raw stdout stays clean", () => {
		const originalStdout = process.stdout.write;
		const originalStderr = process.stderr.write;
		let stdout = "";
		let stderr = "";
		process.stdout.write = ((chunk: string | Uint8Array, cb?: (error?: Error | null) => void): boolean => {
			stdout += String(chunk);
			cb?.();
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array, cb?: (error?: Error | null) => void): boolean => {
			stderr += String(chunk);
			cb?.();
			return true;
		}) as typeof process.stderr.write;

		try {
			takeOverStdout();
			strictEqual(isStdoutTakenOver(), true);
			process.stdout.write("diagnostic");
			writeRawStdout("answer");
			strictEqual(stdout, "answer");
			strictEqual(stderr, "diagnostic");
		} finally {
			restoreStdout();
			process.stdout.write = originalStdout;
			process.stderr.write = originalStderr;
		}
		strictEqual(isStdoutTakenOver(), false);
	});
});
