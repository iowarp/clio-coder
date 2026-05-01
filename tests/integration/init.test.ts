import { ok, strictEqual } from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseClioMd } from "../../src/domains/context/clio-md.js";
import { runBootstrap } from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "sample-ts-project");

describe("clio init", () => {
	it("writes CLIO.md, .clio/state.json, and .gitignore for a fixture repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-init-"));
		try {
			cpSync(fixture, dir, { recursive: true });
			const result = await runBootstrap({
				cwd: dir,
				confirmGitignore: () => true,
				modelId: "stub-model",
				now: () => new Date("2026-05-01T00:00:00.000Z"),
				generate: () => ({
					projectName: "Sample Ts Project",
					identity: "Sample Ts Project is a TypeScript project. It is a small fixture for init tests.",
					conventions: ["Local imports end in `.js`. Tests use `node:test`."],
					invariants: [],
				}),
			});

			ok(existsSync(join(dir, "CLIO.md")));
			ok(existsSync(join(dir, ".clio", "state.json")));
			ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(".clio/"));
			strictEqual(result.projectType, "typescript");
			const parsed = parseClioMd(readFileSync(join(dir, "CLIO.md"), "utf8"));
			ok(parsed.ok);
			if (parsed.ok) strictEqual(parsed.value.fingerprint?.model, "stub-model");
			const state = readClioState(dir);
			strictEqual(state?.projectType, "typescript");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
