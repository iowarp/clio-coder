import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";
import { assertLazyToolLoading } from "../harness/tool-module-graph.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("smoke/lazy tool runtime graph", { concurrency: false }, () => {
	const work = mkdtempSync(join(tmpdir(), "clio-tool-lazy-"));
	const home = makeScratchHome("clio-tool-lazy-home-");
	after(() => {
		home.cleanup();
		rmSync(work, { recursive: true, force: true });
	});

	it("advertises stable tool surfaces without implementations and loads only the invoked implementation", {
		timeout: 240_000,
	}, async () => {
		await assertLazyToolLoading({
			packageRoot: REPO_ROOT,
			bin: join(REPO_ROOT, "dist", "cli", "index.js"),
			workRoot: work,
			env: home.env,
		});
	});
});
