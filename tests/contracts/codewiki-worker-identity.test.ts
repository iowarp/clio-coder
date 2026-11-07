/**
 * Read-only code_nav reconciles its snapshot in the codewiki worker on every call and caches its nav index per
 * codewiki object. An unchanged reconcile must hand back the very object the caller passed in: a clone posted back
 * from the worker missed that cache and rebuilt the index on each call. The second case holds the same at the tool
 * layer, for a transient snapshot and for one read from disk.
 */
import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { coordinateCodewikiWrite, reconcileCodewikiCandidate } from "../../src/domains/context/codewiki/coordinator.js";
import { buildCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let isolated: IsolatedClioEnv;
beforeEach(async () => {
	isolated = await isolateClioEnv("clio-coder-codewiki-identity-");
});
afterEach(() => isolated.restore());

it("an unchanged worker reconcile returns the caller's object, and a changed one its replacement", async () => {
	const cwd = isolated.dir;
	writeFileSync(join(cwd, "a.ts"), "export const one = 1;\n");
	const held = await buildCodewiki({ cwd, language: "typescript" });
	const request = { kind: "ensure" as const, cwd, language: "typescript" as const, current: held };

	const unchanged = await reconcileCodewikiCandidate({ ...request, previous: computeFingerprint(cwd, held) });
	strictEqual(unchanged.changed, false);
	strictEqual(unchanged.codewiki, held);

	writeFileSync(join(cwd, "a.ts"), "export const second = 2;\n");
	const changed = await reconcileCodewikiCandidate({ ...request, previous: unchanged.fingerprint });
	strictEqual(changed.changed, true);
	notStrictEqual(changed.codewiki, held);
	ok(changed.codewiki.symbols.some((symbol) => symbol.name === "second"));
});

it("read-only navigation keeps the object it holds when the tree is unchanged", async () => {
	// code_nav caches its index per codewiki object; a clone from the worker
	// rebuilt that index on every call.
	const cwd = isolated.dir;
	writeFileSync(join(cwd, "a.ts"), "export const one = 1;\n");
	const transient = await loadCodewikiForTool(cwd);
	ok(transient.ok);
	const again = await loadCodewikiForTool(cwd);
	ok(again.ok);
	strictEqual(again.codewiki, transient.codewiki);
	ok(await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" })));
	const disk = await loadCodewikiForTool(cwd);
	ok(disk.ok);
	const unchanged = await loadCodewikiForTool(cwd);
	ok(unchanged.ok);
	strictEqual(unchanged.codewiki, disk.codewiki);
	writeFileSync(join(cwd, "a.ts"), "export const two = 2;\n");
	const stale = await loadCodewikiForTool(cwd);
	ok(stale.ok);
	ok(stale.codewiki.symbols.some((symbol) => symbol.name === "two"));
});
