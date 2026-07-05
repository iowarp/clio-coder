import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCodewiki, writeCodewiki } from "../../src/domains/context/index.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";

// BUG-010: a huge query drove a symbol lookup whose `next` continuation embedded
// the query verbatim (`mode=path query=<256KB>`). finalizeObservation then hit
// the JSON cap and echoed that oversized `next` into the stub, so the "result
// exceeded 16KB" placeholder itself weighed 256KB. The cap stub and the
// observation envelope must stay bounded no matter how large the input is.
describe("contracts/code_nav cap stub bounds a huge query continuation", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-code-nav-cap-"));
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export function main() { return 1; }\n", "utf8");
		writeCodewiki(scratch, await buildCodewiki({ cwd: scratch, language: "polyglot" }));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("does not embed a 256KB query in the next continuation or the stub", async () => {
		const huge = "x".repeat(256_000);
		const result = await codeNavTool.run(
			{ mode: "symbol", query: huge },
			{ sessionId: "code-nav-cap", turnId: "t1", toolCallId: "code-nav-huge" },
		);
		ok(result.kind === "ok", "code_nav returns an ok result for an unmatched huge query");
		const text = result.output;

		// The visible stub must stay small — never grow to the size of the input.
		ok(
			Buffer.byteLength(text, "utf8") < 4096,
			`cap stub should stay compact; got ${Buffer.byteLength(text, "utf8")} bytes`,
		);
		ok(!text.includes(huge), "the stub must not echo the full query verbatim");

		// The structured observation envelope must be bounded too: its `next`
		// continuation is a compact reference, not the raw 256KB argument.
		const observation = result.details?.observation as { next?: unknown } | undefined;
		const next = typeof observation?.next === "string" ? observation.next : "";
		ok(next.length < 512, `observation.next should be bounded; got ${next.length} chars`);
		ok(!next.includes(huge), "observation.next must not embed the full query verbatim");
	});
});
