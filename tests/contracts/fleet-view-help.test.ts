/** A selected fleet subcommand owns the help for its own flags and invocation forms. */

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("fleet view help contract", { concurrency: false }, () => {
	it("prints view-specific help instead of the fleet command index", async () => {
		const scratch = makeScratchHome("clio-fleet-view-help-");
		try {
			const result = await runCli(["fleet", "view", "--help"], { env: scratch.env });
			strictEqual(result.code, 0, result.stderr);
			strictEqual(result.stderr, "");
			match(result.stdout, /^clio-coder fleet view <runId\|fleetRootId> \[--follow\]/u);
			match(result.stdout, /clio-coder fleet view --watch <selection-file>/u);
			match(result.stdout, /--follow {4}keep tailing/u);
			match(result.stdout, /--watch {5}follow whichever run id/u);
			ok(!result.stdout.includes("clio-coder fleet <subcommand>"), result.stdout);
		} finally {
			scratch.cleanup();
		}
	});
});
