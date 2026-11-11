import { match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { missingChunkNotice } from "../../src/domains/dispatch/worker-spawn.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release builds and pruned chunks", () => {
	it("qualifies a release from a clean build while pnpm run build stays incremental", () => {
		const pkg = JSON.parse(read("package.json"));
		ok(!pkg.scripts.build.includes("--clean"));
		match(pkg.scripts["build:release"], /scripts\/build\.ts --clean/u);
		match(read("scripts/release-candidate.mjs"), /run\("pnpm", \["run", "build:release"\]\)/u);
	});

	it("keeps per-build records out of the package and checks dist against build.json", () => {
		ok(JSON.parse(read("package.json")).files.includes("!dist/builds"));
		match(read("scripts/check-release.mjs"), /checkBuildInventory\(\);/u);
	});

	it("names the parent's build when a worker cannot load a chunk", () => {
		const notice = missingChunkNotice("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/dist/chunk-a.js'", "b-1");
		match(notice ?? "", /parent's build b-1/u);
		strictEqual(missingChunkNotice("TypeError: boom", "b-1"), null);
	});
});
