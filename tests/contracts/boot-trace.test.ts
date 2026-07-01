import { ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isBootTraceEnabled, traceBoot } from "../../src/core/boot-trace.js";

/**
 * Capture everything written to process.stderr for the duration of `fn`, then
 * restore the original writer. The boot tracer writes straight to stderr so it
 * costs nothing when disabled; the test observes that contract directly.
 */
function captureStderr(fn: () => void): string {
	const original = process.stderr.write.bind(process.stderr);
	let captured = "";
	(process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
		captured += chunk;
		return true;
	};
	try {
		fn();
	} finally {
		(process.stderr as { write: typeof original }).write = original;
	}
	return captured;
}

describe("core/boot-trace", () => {
	const previous = process.env.CLIO_TRACE_BOOT;
	afterEach(() => {
		if (previous === undefined) Reflect.deleteProperty(process.env, "CLIO_TRACE_BOOT");
		else process.env.CLIO_TRACE_BOOT = previous;
	});

	it("writes nothing and reports disabled when CLIO_TRACE_BOOT is unset", () => {
		Reflect.deleteProperty(process.env, "CLIO_TRACE_BOOT");
		strictEqual(isBootTraceEnabled(), false);
		const out = captureStderr(() => traceBoot("cli entry"));
		strictEqual(out, "");
	});

	it("writes nothing for any value other than exactly '1'", () => {
		process.env.CLIO_TRACE_BOOT = "true";
		strictEqual(isBootTraceEnabled(), false);
		const out = captureStderr(() => traceBoot("cli entry"));
		strictEqual(out, "");
	});

	it("stamps a phase marker with elapsed-from-start when enabled", () => {
		process.env.CLIO_TRACE_BOOT = "1";
		strictEqual(isBootTraceEnabled(), true);
		const out = captureStderr(() => traceBoot("domains loaded", "count=14"));
		ok(
			/^\[clio:boot\] \+\d+(\.\d+)?ms domains loaded \(count=14\)\n$/.test(out),
			`unexpected trace line: ${JSON.stringify(out)}`,
		);
	});

	it("omits the detail parenthetical when no detail is given", () => {
		process.env.CLIO_TRACE_BOOT = "1";
		const out = captureStderr(() => traceBoot("first TUI paint"));
		ok(/^\[clio:boot\] \+\d+(\.\d+)?ms first TUI paint\n$/.test(out), `unexpected trace line: ${JSON.stringify(out)}`);
	});
});
