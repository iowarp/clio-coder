import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { codewikiPath, readCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import { executeCodewikiBuild } from "../../src/domains/context/codewiki/build-operation.js";
import { coordinateCodewikiWrite } from "../../src/domains/context/codewiki/coordinator.js";
import { buildCodewiki, syncCodewiki, updateCodewikiPaths } from "../../src/domains/context/codewiki/indexer.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { readClioState } from "../../src/domains/context/state.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("codewiki global freshness", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-codewiki-freshness-");
	});
	afterEach(() => isolated.restore());

	for (const externalChange of ["edit", "add", "delete"] as const) {
		it(`reconciles an external ${externalChange} alongside a notified edit and survives reload`, async () => {
			const cwd = isolated.dir;
			writeFileSync(join(cwd, "a.ts"), "export function agentBefore() {}\n");
			writeFileSync(join(cwd, "b.ts"), "export function externalBefore() {}\n");
			const initial = await loadCodewikiForTool(cwd);
			ok(initial.ok, initial.ok ? undefined : initial.message);
			if (externalChange === "delete") unlinkSync(join(cwd, "b.ts"));
			else {
				writeFileSync(join(cwd, externalChange === "add" ? "c.ts" : "b.ts"), "export function externalAfterLonger() {}\n");
			}
			writeFileSync(join(cwd, "a.ts"), "export function agentAfterLonger() {}\n");
			const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
			bundle.contract.noteFileChanges(["a.ts"], cwd);
			await bundle.extension.stop?.();
			const indexed = readCodewiki(cwd);
			ok(indexed);
			const names = indexed.symbols.map((symbol) => symbol.name);
			ok(names.includes("agentAfterLonger"));
			strictEqual(names.includes("externalBefore"), externalChange === "add");
			strictEqual(names.includes("externalAfterLonger"), externalChange !== "delete");
			deepStrictEqual(indexed, await buildCodewiki({ cwd, language: indexed.language }));
			deepStrictEqual(readClioState(cwd)?.fingerprint, computeFingerprint(cwd, indexed));
			const artifactBeforeReload = readFileSync(codewikiPath(cwd), "utf8");
			const modifiedBeforeReload = statSync(codewikiPath(cwd), { bigint: true }).mtimeNs;
			const reloaded = await loadCodewikiForTool(cwd);
			ok(reloaded.ok);
			deepStrictEqual(reloaded.codewiki, indexed);
			strictEqual(readFileSync(codewikiPath(cwd), "utf8"), artifactBeforeReload);
			strictEqual(statSync(codewikiPath(cwd), { bigint: true }).mtimeNs, modifiedBeforeReload);
		});
	}

	for (const missingState of [false, true]) {
		it(`repairs external drift after an unchanged notification with ${missingState ? "missing" : "existing"} state`, async () => {
			const cwd = isolated.dir;
			writeFileSync(join(cwd, "a.ts"), "export const unchanged = true;\n");
			writeFileSync(join(cwd, "b.ts"), "export function externalBefore() {}\n");
			ok((await loadCodewikiForTool(cwd)).ok);
			const previous = readClioState(cwd)?.fingerprint;
			if (missingState) unlinkSync(join(cwd, ".clio-coder", "state.json"));
			writeFileSync(join(cwd, "b.ts"), "export function externalAfterLonger() {}\n");
			const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
			bundle.contract.noteFileChanges(["a.ts"], cwd);
			await bundle.extension.stop?.();
			if (!missingState) deepStrictEqual(readClioState(cwd)?.fingerprint, previous);
			const reloaded = await loadCodewikiForTool(cwd);
			ok(reloaded.ok);
			ok(reloaded.codewiki.symbols.some((symbol) => symbol.name === "externalAfterLonger"));
			strictEqual(
				reloaded.codewiki.symbols.some((symbol) => symbol.name === "externalBefore"),
				false,
			);
			deepStrictEqual(readClioState(cwd)?.fingerprint, computeFingerprint(cwd, reloaded.codewiki));
		});
	}

	it("does not rewrite the artifact or freshness state for unchanged and irrelevant notifications", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export const unchanged = true;\n");
		ok((await loadCodewikiForTool(cwd)).ok);
		const artifactBefore = statSync(codewikiPath(cwd), { bigint: true });
		const stateBefore = readFileSync(join(cwd, ".clio-coder", "state.json"), "utf8");
		const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
		bundle.contract.noteFileChanges(["a.ts", "README.md"], cwd);
		await bundle.extension.stop?.();
		strictEqual(statSync(codewikiPath(cwd), { bigint: true }).mtimeNs, artifactBefore.mtimeNs);
		strictEqual(readFileSync(join(cwd, ".clio-coder", "state.json"), "utf8"), stateBefore);
	});

	it("keeps unchanged symbols when reconciling notified and external changes", async () => {
		const cwd = isolated.dir;
		for (const name of ["a", "b", "c"]) writeFileSync(join(cwd, `${name}.ts`), `export const ${name} = true;\n`);
		const initial = await buildCodewiki({ cwd, language: "typescript" });
		const unchanged = initial.symbols.find((symbol) => symbol.name === "c");
		ok(unchanged);
		writeFileSync(join(cwd, "a.ts"), "export const agentChanged = true;\n");
		writeFileSync(join(cwd, "b.ts"), "export const externalChanged = true;\n");
		const partial = await updateCodewikiPaths(cwd, initial, ["a.ts", "c.ts"]);
		const reconciled = await syncCodewiki(cwd, partial);
		strictEqual(
			reconciled.symbols.find((symbol) => symbol.name === "c"),
			unchanged,
		);
		strictEqual(
			reconciled.symbols.find((symbol) => symbol.name === "agentChanged"),
			partial.symbols.find((symbol) => symbol.name === "agentChanged"),
		);
		strictEqual(await syncCodewiki(cwd, reconciled), reconciled);
	});

	it("uses no global indexing work for an irrelevant note and only reads the notified unchanged source", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export const unchanged = true;\n");
		const current = await buildCodewiki({ cwd, language: "typescript" });
		const previous = computeFingerprint(cwd, current);
		for (const paths of [["README.md"], ["a.ts"]]) {
			const reads: string[] = [];
			const result = await executeCodewikiBuild(
				{ kind: "incremental", cwd, current, paths, previous },
				{
					readFile: (path) => {
						reads.push(path);
						return readFileSync(path, "utf8");
					},
					slicer: {
						yields: 0,
						tick: async () => {
							throw new Error("unexpected indexing work");
						},
					},
				},
			);
			strictEqual(result.codewiki, current);
			strictEqual(result.fingerprint, previous);
			strictEqual(result.changed, false);
			deepStrictEqual(reads, paths[0] === "a.ts" ? [join(cwd, "a.ts")] : []);
		}
		const ensured = await executeCodewikiBuild(
			{ kind: "ensure", cwd, current, previous },
			{
				readFile: () => {
					throw new Error("unchanged ensure read source");
				},
			},
		);
		strictEqual(ensured.codewiki, current);
		strictEqual(ensured.changed, false);
	});

	for (const kind of ["build", "ensure", "incremental"] as const) {
		it(`retries a source edit after its ${kind} input was read`, async () => {
			const cwd = isolated.dir;
			const path = join(cwd, "a.ts");
			writeFileSync(path, "export function before() {}\n");
			const current = await buildCodewiki({ cwd, language: "typescript" });
			let reads = 0;
			const result = await executeCodewikiBuild(
				kind === "build"
					? { kind, cwd, language: "typescript" }
					: kind === "ensure"
						? { kind, cwd, current, previous: null }
						: { kind, cwd, current, paths: [], previous: null },
				{
					readFile: (source) => {
						const text = readFileSync(source, "utf8");
						reads += 1;
						if (reads === 1) writeFileSync(path, "export function afterLonger() {}\n");
						return text;
					},
				},
			);
			strictEqual(reads, 2);
			ok(result.codewiki.symbols.some((symbol) => symbol.name === "afterLonger"));
			deepStrictEqual(result.fingerprint, computeFingerprint(cwd, result.codewiki));
		});
	}

	for (const mutation of ["add", "delete"] as const) {
		it(`reconciles a file ${mutation} during a full build`, async () => {
			const cwd = isolated.dir;
			writeFileSync(join(cwd, "a.ts"), "export const a = true;\n");
			if (mutation === "delete") writeFileSync(join(cwd, "b.ts"), "export const b = true;\n");
			let changed = false;
			const result = await executeCodewikiBuild(
				{ kind: "build", cwd, language: "typescript" },
				{
					readFile: (source) => {
						const text = readFileSync(source, "utf8");
						if (!changed) {
							changed = true;
							if (mutation === "delete") unlinkSync(join(cwd, "b.ts"));
							else writeFileSync(join(cwd, "b.ts"), "export const b = true;\n");
						}
						return text;
					},
				},
			);
			deepStrictEqual(result.codewiki, await buildCodewiki({ cwd, language: "typescript" }));
			deepStrictEqual(result.fingerprint, computeFingerprint(cwd, result.codewiki));
		});
	}

	it("refuses continuously changing or unreadable sources without writing the committed artifact", async () => {
		const cwd = isolated.dir;
		const path = join(cwd, "a.ts");
		writeFileSync(path, "export const before = true;\n");
		ok((await loadCodewikiForTool(cwd)).ok);
		const committed = readFileSync(codewikiPath(cwd), "utf8");
		const state = readFileSync(join(cwd, ".clio-coder", "state.json"), "utf8");
		let reads = 0;
		await rejects(
			executeCodewikiBuild(
				{ kind: "build", cwd, language: "typescript" },
				{
					readFile: (source) => {
						const text = readFileSync(source, "utf8");
						reads += 1;
						writeFileSync(path, `${text}// changed\n`);
						return text;
					},
				},
			),
			/did not stabilize after 3 attempts/,
		);
		strictEqual(reads, 3);
		await rejects(
			executeCodewikiBuild({ kind: "build", cwd, language: "typescript" }, { readFile: () => null }),
			/did not stabilize/,
		);
		strictEqual(readFileSync(codewikiPath(cwd), "utf8"), committed);
		strictEqual(readFileSync(join(cwd, ".clio-coder", "state.json"), "utf8"), state);
	});

	it("keeps a post-worker edit detectable after coordinator publication", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export function before() {}\n");
		const built = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }), {
			beforeCommit: () => {
				writeFileSync(join(cwd, "a.ts"), "export function afterLonger() {}\n");
			},
		});
		ok(built);
		strictEqual(built.worker.fingerprint.treeHash === computeFingerprint(cwd, built.codewiki).treeHash, false);
		const ensured = await coordinateCodewikiWrite(cwd, (current) => ({
			kind: "ensure",
			cwd,
			current,
			previous: built.worker.fingerprint,
		}));
		ok(ensured?.codewiki.symbols.some((symbol) => symbol.name === "afterLonger"));
	});
});
