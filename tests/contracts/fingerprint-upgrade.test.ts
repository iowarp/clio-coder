import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { enumerateWorkspaceFiles } from "../../src/core/workspace-files.js";
import { codewikiPath, writeCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import { executeCodewikiBuild } from "../../src/domains/context/codewiki/build-operation.js";
import { buildCodewiki, updateCodewikiPaths } from "../../src/domains/context/codewiki/indexer.js";
import { isIndexablePath } from "../../src/domains/context/codewiki/paths.js";
import type { Codewiki } from "../../src/domains/context/codewiki/schema.js";
import { EXCLUDED_DIRS } from "../../src/domains/context/excluded-dirs.js";
import {
	computeFingerprint,
	computeFingerprintAsync,
	computeFingerprintCached,
} from "../../src/domains/context/fingerprint.js";
import { readClioState, statePath, writeClioState } from "../../src/domains/context/state.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// Frozen pre-upgrade tree digest from 9214789's fingerprint.ts. This fixture
// deliberately has no dependency on the current fingerprint's hash domain.
function legacyTreeHash(cwd: string): string {
	const hash = createHash("sha256");
	for (const relPath of enumerateWorkspaceFiles(cwd, EXCLUDED_DIRS).filter(isIndexablePath)) {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(join(cwd, relPath));
		} catch {
			continue;
		}
		hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
	}
	return hash.digest("hex");
}

function certifyLegacyIndex(cwd: string, codewiki: Codewiki): void {
	writeCodewiki(cwd, codewiki);
	writeClioState(cwd, {
		version: 1,
		projectType: codewiki.language,
		codewikiVersion: codewiki.version,
		fingerprint: { ...computeFingerprint(cwd, codewiki), treeHash: legacyTreeHash(cwd) },
	});
}

async function assertSecondEnsureDoesNotRewrite(cwd: string, expected: Codewiki): Promise<void> {
	const paths = [codewikiPath(cwd), statePath(cwd)];
	const before = paths.map((path) => ({
		text: readFileSync(path, "utf8"),
		mtimeNs: statSync(path, { bigint: true }).mtimeNs,
	}));
	const loaded = await loadCodewikiForTool(cwd);
	ok(loaded.ok, loaded.ok ? undefined : loaded.message);
	deepStrictEqual(loaded.codewiki, expected);
	deepStrictEqual(
		paths.map((path) => ({ text: readFileSync(path, "utf8"), mtimeNs: statSync(path, { bigint: true }).mtimeNs })),
		before,
	);
}

describe("context fingerprint upgrade", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-fingerprint-upgrade-");
	});
	afterEach(() => isolated.restore());

	it("repairs legacy state that falsely certified an external edit alongside a notified edit", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export function agentBefore() {}\n");
		writeFileSync(join(cwd, "b.ts"), "export function externalBefore() {}\n");
		const original = await buildCodewiki({ cwd, language: "typescript" });
		writeFileSync(join(cwd, "a.ts"), "export function agentAfterLonger() {}\n");
		writeFileSync(join(cwd, "b.ts"), "export function externalAfterLonger() {}\n");
		const partial = await updateCodewikiPaths(cwd, original, ["a.ts"]);
		ok(partial.symbols.some((symbol) => symbol.name === "externalBefore"));
		certifyLegacyIndex(cwd, partial);
		strictEqual(readClioState(cwd)?.fingerprint.treeHash, legacyTreeHash(cwd));

		const loaded = await loadCodewikiForTool(cwd);
		ok(loaded.ok, loaded.ok ? undefined : loaded.message);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "externalAfterLonger"));
		strictEqual(
			loaded.codewiki.symbols.some((symbol) => symbol.name === "externalBefore"),
			false,
		);
		deepStrictEqual(loaded.codewiki, await buildCodewiki({ cwd, language: "typescript" }));
		deepStrictEqual(readClioState(cwd)?.fingerprint, computeFingerprint(cwd, loaded.codewiki));
		notStrictEqual(readClioState(cwd)?.fingerprint.treeHash, legacyTreeHash(cwd));
		await assertSecondEnsureDoesNotRewrite(cwd, loaded.codewiki);
	});

	it("discovers source hidden by a falsely certified empty legacy index", async () => {
		const cwd = isolated.dir;
		const empty = await buildCodewiki({ cwd, language: "typescript" });
		strictEqual(empty.files.length, 0);
		writeFileSync(join(cwd, "new.ts"), "export function newlyDiscovered() {}\n");
		certifyLegacyIndex(cwd, empty);

		const loaded = await loadCodewikiForTool(cwd);
		ok(loaded.ok, loaded.ok ? undefined : loaded.message);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "newlyDiscovered"));
		deepStrictEqual(loaded.codewiki, await buildCodewiki({ cwd, language: "typescript" }));
		deepStrictEqual(readClioState(cwd)?.fingerprint, computeFingerprint(cwd, loaded.codewiki));
		await assertSecondEnsureDoesNotRewrite(cwd, loaded.codewiki);
	});

	it("upgrades a truly empty legacy tree once without changing its empty index", async () => {
		const cwd = isolated.dir;
		const empty = await buildCodewiki({ cwd, language: "typescript" });
		certifyLegacyIndex(cwd, empty);
		strictEqual(legacyTreeHash(cwd), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

		const loaded = await loadCodewikiForTool(cwd);
		ok(loaded.ok, loaded.ok ? undefined : loaded.message);
		deepStrictEqual(loaded.codewiki, empty);
		notStrictEqual(readClioState(cwd)?.fingerprint.treeHash, legacyTreeHash(cwd));
		deepStrictEqual(readClioState(cwd)?.fingerprint, computeFingerprint(cwd, empty));
		await assertSecondEnsureDoesNotRewrite(cwd, empty);
	});

	it("reconciles legacy metadata by reading source and reusing unchanged records", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export function unchanged() {}\n");
		const current = await buildCodewiki({ cwd, language: "typescript" });
		const previous = { ...computeFingerprint(cwd, current), treeHash: legacyTreeHash(cwd) };
		const reads: string[] = [];
		const result = await executeCodewikiBuild(
			{ kind: "ensure", cwd, current, previous },
			{
				readFile: (path) => {
					reads.push(path);
					return readFileSync(path, "utf8");
				},
			},
		);
		deepStrictEqual(reads, [join(cwd, "a.ts")]);
		strictEqual(result.codewiki, current);
		strictEqual(result.changed, true);
		notStrictEqual(result.fingerprint.treeHash, previous.treeHash);
		const next = await executeCodewikiBuild(
			{ kind: "ensure", cwd, current, previous: result.fingerprint },
			{
				readFile: () => {
					throw new Error("second ensure must not read source");
				},
			},
		);
		strictEqual(next.codewiki, current);
		strictEqual(next.changed, false);
	});

	for (const hasSource of [false, true]) {
		it(`keeps sync, async, and cached fingerprints equal for ${hasSource ? "populated" : "empty"} trees`, async () => {
			const cwd = isolated.dir;
			if (hasSource) writeFileSync(join(cwd, "a.ts"), "export const present = true;\n");
			const fingerprint = computeFingerprint(cwd, null);
			deepStrictEqual(await computeFingerprintAsync(cwd, null), fingerprint);
			deepStrictEqual(computeFingerprintCached(cwd, null), fingerprint);
			deepStrictEqual(computeFingerprintCached(cwd, null), fingerprint);
			notStrictEqual(fingerprint.treeHash, legacyTreeHash(cwd));
		});
	}
});
