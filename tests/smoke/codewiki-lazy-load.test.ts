import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertCodewikiLazyLoading } from "../harness/codewiki-module-graph.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("smoke/codewiki lazy runtime graph", { concurrency: false }, () => {
	const work = mkdtempSync(join(tmpdir(), "clio-codewiki-lazy-"));
	const home = makeScratchHome("clio-codewiki-lazy-home-");
	after(() => {
		home.cleanup();
		rmSync(work, { recursive: true, force: true });
	});

	it("keeps tree-sitter absent through nested help and loads it for the first real build", async () => {
		await assertCodewikiLazyLoading({
			packageRoot: REPO_ROOT,
			bin: join(REPO_ROOT, "dist", "cli", "index.js"),
			workRoot: work,
			env: home.env,
		});
	});
});
