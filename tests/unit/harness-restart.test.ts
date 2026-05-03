import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRestartPlan } from "../../src/selfdev/harness/restart.js";

describe("buildRestartPlan", () => {
	it("captures argv from index 1 onwards and injects CLIO_RESUME_SESSION_ID", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js", "run", "foo"],
			env: { HOME: "/h", CLIO_SELF_DEV: "1" },
			sessionId: "abc-123",
		});
		strictEqual(plan.execPath, "/usr/bin/node");
		deepStrictEqual(plan.argv, ["/app/dist/cli/index.js", "run", "foo"]);
		strictEqual(plan.env.CLIO_RESUME_SESSION_ID, "abc-123");
		strictEqual(plan.env.CLIO_SELF_DEV, "1");
		strictEqual(plan.env.HOME, "/h");
	});

	it("omits CLIO_RESUME_SESSION_ID when sessionId is null", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js"],
			env: { HOME: "/h" },
			sessionId: null,
		});
		strictEqual(plan.env.CLIO_RESUME_SESSION_ID, undefined);
	});

	it("ensures CLIO_SELF_DEV=1 is set in the respawn env", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js"],
			env: { HOME: "/h" },
			sessionId: "s1",
		});
		strictEqual(plan.env.CLIO_SELF_DEV, "1");
	});
});
