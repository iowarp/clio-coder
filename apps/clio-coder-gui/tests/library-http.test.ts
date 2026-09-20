import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LibraryAgents, LibraryExtensions, LibraryInventory, LibraryVerifiers } from "../contracts/library.js";
import { harness, json } from "./harness/app.js";
import { libraryOracle, seedLibrary } from "./harness/library-fixture.js";

test("all library collections agree with the canonical CLI in the same scratch home and never run a verifier", async () => {
	const h = await harness();
	try {
		await seedLibrary(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path),
			base = `/api/workspaces/${workspace.id}/library`;
		const inventory = await json(await h.request(base), LibraryInventory);
		const agents = await json(await h.request(`${base}/agents`), LibraryAgents);
		const extensions = await json(await h.request(`${base}/extensions`), LibraryExtensions);
		const verifiers = await json(await h.request(`${base}/verifiers`), LibraryVerifiers);
		const oracle = await libraryOracle(h.home.path, h.home.env);
		for (const kind of ["skill", "prompt", "fleet", "agent"]) {
			const actual = inventory.resources.filter((row) => row.kind === kind);
			assert.ok(actual.length > 0, `${kind} collection is seeded`);
			assert.deepEqual(
				actual.map((row) => row.key),
				oracle.recipes.resources
					.filter((row: { kind: string }) => row.kind === kind)
					.map((row: { key: string }) => row.key),
			);
		}
		assert.equal(inventory.packages.length, oracle.packages.entries.length);
		assert.ok(inventory.packages.some((row) => row.kind === "plugin"));
		assert.deepEqual(
			agents.agents.map((row) => row.id),
			oracle.agents.map((row: { id: string }) => row.id),
		);
		assert.equal(extensions.extensions.length, oracle.extensions.extensions.length);
		assert.equal(extensions.extensions[0]?.id, "fixture-extension");
		assert.equal(extensions.extensions[0]?.loadable, true);
		assert.deepEqual(verifiers.checks, oracle.verifiers.checks);
		assert.ok(verifiers.checks.length > 0);
		assert.equal(existsSync(join(h.home.path, "check-ran")), false);
		for (const path of [base, `${base}/agents`, `${base}/extensions`, `${base}/verifiers`])
			assert.equal((await h.post(path)).status, 405);
		assert.equal((await h.request(`${base}?install=yes`)).status, 422);
		await writeFile(join(h.home.path, ".clio-coder/verifiers.yaml"), "version: invalid\nchecks: nope\n");
		const rejected = await json(await h.request(`${base}/verifiers`), LibraryVerifiers);
		assert.equal(rejected.catalogValid, false);
		assert.equal(rejected.discovery, "blocked");
		assert.ok(rejected.rejection);
		await writeFile(join(oracle.extensions.extensions[0].rootPath, "clio-coder-extension.yaml"), "broken");
		const damaged = await json(await h.request(`${base}/extensions`), LibraryExtensions);
		assert.equal(damaged.extensions[0]?.valid, false);
		assert.equal(damaged.extensions[0]?.loadable, false);
		assert.equal(existsSync(join(h.home.path, "check-ran")), false);
		assert.equal(h.cli.activeCount, 0);
	} finally {
		await h.close();
	}
});
