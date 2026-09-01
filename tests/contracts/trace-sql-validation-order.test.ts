/** SQL safety is an invocation contract, not a fact contingent on trace database availability. */

import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("trace SQL validation order", { concurrency: false }, () => {
	for (const query of ["DELETE FROM runs", "WITH rows AS (SELECT 1) DELETE FROM runs"]) {
		it(`rejects ${JSON.stringify(query)} before a database exists`, async () => {
			const scratch = makeScratchHome("clio-trace-sql-order-");
			try {
				const result = await runCli(["trace", "sql", query], { env: scratch.env });
				strictEqual(result.code, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
				strictEqual(result.stdout, "");
				match(result.stderr, /read-only|accepts SELECT/u);
			} finally {
				scratch.cleanup();
			}
		});
	}
});
