import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { stateStorageFinding } from "../../src/cli/doctor-state-size.js";

describe("doctor state storage", () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-doctor-state-size-"));
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("reports the aggregate bytes and largest top-level contributor", () => {
		mkdirSync(join(scratch, "sessions", "one"), { recursive: true });
		mkdirSync(join(scratch, "receipts"), { recursive: true });
		writeFileSync(join(scratch, "trace.sqlite"), Buffer.alloc(4096));
		writeFileSync(join(scratch, "sessions", "one", "current.jsonl"), Buffer.alloc(3072));
		writeFileSync(join(scratch, "receipts", "run.json"), Buffer.alloc(1024));

		const finding = stateStorageFinding(scratch);
		strictEqual(finding.ok, true);
		strictEqual(finding.name, "state storage");
		match(finding.detail, /^8\.00 KiB \(8,192 bytes\);/u);
		match(finding.detail, /largest contributor trace\.sqlite at 4\.00 KiB \(4,096 bytes\)$/u);
	});
});
