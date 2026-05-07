import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { editTool } from "../../src/tools/edit.js";
import { readTool } from "../../src/tools/read.js";

describe("tools/read ENOENT remediation", () => {
	it("returns a hint pointing at where_is/glob/ls when the path is missing", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-read-enoent-"));
		try {
			const missing = join(scratch, "does-not-exist.ts");
			const result = await readTool.run({ path: missing });
			strictEqual(result.kind, "error");
			if (result.kind === "error") {
				ok(result.message.includes(missing), result.message);
				ok(/ENOENT/.test(result.message), result.message);
				ok(result.message.includes("where_is"), result.message);
				ok(result.message.includes("glob"), result.message);
				ok(result.message.includes("ls"), result.message);
				ok(result.message.includes("File not found"), result.message);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("tools/edit ENOENT remediation", () => {
	it("returns a hint pointing at where_is/glob/ls when the path is missing", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-edit-enoent-"));
		try {
			const missing = join(scratch, "does-not-exist.ts");
			const result = await editTool.run({ path: missing, old_string: "a", new_string: "b" });
			strictEqual(result.kind, "error");
			if (result.kind === "error") {
				ok(result.message.includes(missing), result.message);
				ok(result.message.includes("where_is"), result.message);
				ok(result.message.includes("glob"), result.message);
				ok(result.message.includes("File not found"), result.message);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
