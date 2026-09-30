import { strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { takeRunCancelRequest, writeRunCancelRequest } from "../../src/domains/dispatch/cancel-requests.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("fleet cancel requests", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-fleet-cancel-");
	});
	afterEach(() => scratch.restore());

	it("hands the owner a request for its run exactly once and removes the file", () => {
		const path = join(clioStateDir(), "cancel-requests", "run-active.json");
		writeRunCancelRequest("run-active", "operator stop");
		strictEqual(existsSync(path), true);
		strictEqual(path.startsWith(scratch.dir), true);
		const taken = takeRunCancelRequest("run-active");
		strictEqual(taken?.runId, "run-active");
		strictEqual(taken?.reason, "operator stop");
		strictEqual(existsSync(path), false);
		strictEqual(takeRunCancelRequest("run-active"), null);
	});
});
