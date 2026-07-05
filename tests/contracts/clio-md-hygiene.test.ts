import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("contracts/clio-md hygiene", () => {
	it("references code_nav instead of obsolete navigation tool names", () => {
		const clioMd = readFileSync(join(repoRoot, "CLIO.md"), "utf8");

		for (const obsoleteTool of ["entry_points", "where_is", "find_symbol"]) {
			strictEqual(clioMd.includes(obsoleteTool), false, `CLIO.md must not mention ${obsoleteTool}`);
		}
		ok(clioMd.includes("code_nav"), "CLIO.md must mention code_nav");
	});
});
