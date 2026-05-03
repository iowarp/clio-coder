import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../harness/spawn.js";

describe("CLIO_SELF_DEV public bundle", () => {
	it("clio --dev exits 2 when selfdev is not bundled", async () => {
		const home = mkdtempSync(join(tmpdir(), "clio-selfdev-public-"));
		try {
			const result = await runCli(["--dev"], {
				env: { CLIO_HOME: home },
				timeoutMs: 15_000,
			});
			strictEqual(result.code, 2, `stdout=${result.stdout} stderr=${result.stderr}`);
			ok(
				result.stderr.includes("clio --dev: not bundled in public releases; build from source with CLIO_BUILD_PRIVATE=1"),
				result.stderr,
			);
			ok(!result.stdout.includes("Clio Coder"), result.stdout);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
