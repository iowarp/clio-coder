import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("reports pending publications as incomplete for wiki and refresh, including no-op updates", () => {
	for (const command of ["wiki", "refresh"]) {
		for (const status of ["generated", "noop"]) {
			for (const pending of [0, 1, 3]) {
				const stdout = execFileSync(
					process.execPath,
					[
						"--experimental-test-module-mocks",
						"--import",
						"tsx",
						fileURLToPath(new URL("../fixtures/wiki/terminal-outcome.ts", import.meta.url)),
						command,
						status,
						String(pending),
					],
					{ encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
				);
				assert.match(stdout, new RegExp(`3 published pages; ${3 - pending} complete, ${pending} pending`, "u"));
				if (pending > 0) {
					assert.match(stdout, /: incomplete \(/u);
					assert.match(stdout, /clio-coder context wiki --update/u);
					assert.doesNotMatch(stdout, /: (?:generated|unchanged) \(/u);
				} else {
					assert.match(stdout, new RegExp(`: ${status === "noop" ? "unchanged" : "generated"} \\(`, "u"));
					assert.doesNotMatch(stdout, /incomplete|--update/u);
				}
			}
		}
	}
});
