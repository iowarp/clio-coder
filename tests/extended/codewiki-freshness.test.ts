import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { runContextClear } from "../../src/domains/context/clear.js";
import { codewikiPath, readCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import {
	executeCodewikiBuild,
	executeCodewikiBuildOutcome,
} from "../../src/domains/context/codewiki/build-operation.js";
import { coordinateCodewikiWrite } from "../../src/domains/context/codewiki/coordinator.js";
import { buildCodewiki, syncCodewiki, updateCodewikiPaths } from "../../src/domains/context/codewiki/indexer.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { readClioState, statePath, writeClioState } from "../../src/domains/context/state.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("codewiki global freshness", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-codewiki-freshness-");
	});
	afterEach(() => isolated.restore());

	it("resolves Python relative depth, package initializers, and local absolute imports", async () => {
		const cwd = isolated.dir;
		const sources = {
			"__init__.py": "from .root_helper import root\n",
			"root_helper.py": "def root(): pass\n",
			"pkg/__init__.py": "",
			"pkg/helpers.py": "def parent(): pass\n",
			"pkg/core/__init__.py": "from ..helpers import parent\n",
			"pkg/core/helpers.py": "def sibling(): pass\n",
			"pkg/core/tool.py":
				"from ..helpers import parent\nfrom .helpers import sibling\nimport pkg.helpers\nfrom . import helpers\nimport requests\n",
			"src/nested/__init__.py": "",
			"src/nested/helpers.py": "def helper(): pass\n",
			"src/nested/tool.py": "import nested.helpers\nfrom ..pkg import helpers\n",
			"pkg/core/tool.ts": 'import value from "./helpers.js";\n',
			"pkg/core/helpers.ts": "export default 1;\n",
		};
		for (const [path, content] of Object.entries(sources)) {
			mkdirSync(join(cwd, path, ".."), { recursive: true });
			writeFileSync(join(cwd, path), content);
		}
		const wiki = await buildCodewiki({ cwd, language: "python" });
		const paths = new Map(wiki.files.map((file) => [file.id, file.path]));
		const targets = (path: string) =>
			wiki.edges
				.filter((edge) => paths.get(edge.fileId) === path)
				.map((edge) => ("toFileId" in edge ? paths.get(edge.toFileId) : `external:${edge.externalModule}`))
				.sort();
		deepStrictEqual(targets("pkg/core/tool.py"), [
			"external:requests",
			"pkg/core/__init__.py",
			"pkg/core/helpers.py",
			"pkg/helpers.py",
		]);
		deepStrictEqual(targets("__init__.py"), ["root_helper.py"]);
		deepStrictEqual(targets("pkg/core/__init__.py"), ["pkg/helpers.py"]);
		deepStrictEqual(targets("src/nested/tool.py"), ["external:..pkg", "src/nested/helpers.py"]);
		deepStrictEqual(targets("pkg/core/tool.ts"), ["pkg/core/helpers.ts"]);
		deepStrictEqual(await syncCodewiki(cwd, { ...wiki, edges: [] }), wiki);
		strictEqual(await syncCodewiki(cwd, wiki), wiki);
	});

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

	it("reconciles an artifact handed by reference without parsing or returning it", async () => {
		// The coordinator names the committed artifact instead of cloning it into
		// the worker. Unchanged, the worker answers with the fingerprint alone and
		// the same `loc` the artifact's own build stamped; stale, it reads the
		// file itself and returns the reconciled index.
		const cwd = isolated.dir;
		const path = join(cwd, "a.ts");
		writeFileSync(path, "export const one = 1;\n");
		const committed = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }));
		ok(committed);
		const previous = committed.worker.fingerprint;
		const ref = { source: "artifact", needsBackfill: false, loc: previous.loc } as const;
		const unchanged = await executeCodewikiBuildOutcome(
			{ kind: "ensure", cwd, current: ref, previous },
			{
				readFile: () => {
					throw new Error("unchanged ensure read source");
				},
			},
		);
		strictEqual(unchanged.codewiki, null);
		strictEqual(unchanged.changed, false);
		deepStrictEqual(unchanged.fingerprint, previous);
		// The coordinator substitutes the object it already holds.
		const ensured = await coordinateCodewikiWrite(cwd, (current) => ({ kind: "ensure", cwd, current, previous }));
		ok(ensured);
		strictEqual(ensured.worker.changed, false);
		strictEqual(ensured.wrote, false);
		deepStrictEqual(ensured.worker.fingerprint, previous);
		strictEqual(ensured.codewiki.files.length, 1);

		writeFileSync(path, "export const one = 1;\nexport const two = 2;\n");
		const stale = await executeCodewikiBuildOutcome({ kind: "ensure", cwd, current: ref, previous });
		ok(stale.codewiki);
		strictEqual(stale.changed, true);
		strictEqual(
			stale.codewiki.symbols.some((symbol) => symbol.name === "two"),
			true,
		);
		const incremental = await executeCodewikiBuildOutcome({
			kind: "incremental",
			cwd,
			current: ref,
			paths: ["a.ts"],
			previous,
		});
		ok(incremental.codewiki);
		strictEqual(
			incremental.codewiki.symbols.some((symbol) => symbol.name === "two"),
			true,
		);
	});

	it("renders the prompt markers from state and the artifact's presence, not its contents", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export const one = 1;\n");
		const committed = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }));
		ok(committed);
		const fingerprint = committed.worker.fingerprint;
		writeClioState(cwd, { version: 1, projectType: "rust", fingerprint, codewikiVersion: committed.codewiki.version });
		// The artifact file is unparseable, yet its presence plus a fingerprint
		// that matches the tree is what the marker reports; nothing here parses
		// the JSON, which on a large repository is the cost this path shed.
		writeFileSync(codewikiPath(cwd), "{ not json");
		const fresh = renderPromptContext(cwd);
		strictEqual(fresh.supportFragments.includes("<project-type>rust</project-type>"), true);
		strictEqual(fresh.supportFragments.includes("<codewiki>available; use code_nav</codewiki>"), true);
		deepStrictEqual(fresh.warnings, []);
		writeClioState(cwd, { version: 1, projectType: "rust", fingerprint: { ...fingerprint, treeHash: "0".repeat(64) } });
		const stale = renderPromptContext(cwd);
		strictEqual(
			stale.supportFragments.includes("<codewiki>available (stale; run /context refresh); use code_nav</codewiki>"),
			true,
		);
		// What makes "available" truthful for an unparseable file: the tool path
		// reads null for it and rebuilds from source under the lease before
		// answering, and the rebuilt artifact is what later calls read.
		strictEqual(readCodewiki(cwd), null);
		const repaired = await loadCodewikiForTool(cwd);
		ok(repaired.ok);
		strictEqual(
			repaired.codewiki.files.some((file) => file.path === "a.ts"),
			true,
		);
		strictEqual(readCodewiki(cwd)?.files.length, 1);
		deepStrictEqual(readClioState(cwd)?.fingerprint, fingerprint);
	});

	it("rebuilds when a referenced artifact vanished and refuses an incremental over it", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export const one = 1;\n");
		const committed = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }));
		ok(committed);
		const previous = committed.worker.fingerprint;
		const ref = { source: "artifact", needsBackfill: false, loc: previous.loc } as const;
		for (const damage of ["delete", "corrupt"] as const) {
			if (damage === "delete") unlinkSync(codewikiPath(cwd));
			else writeFileSync(codewikiPath(cwd), "{ not json");
			// Same tree, so the unchanged fast path answers first and never needs
			// the artifact: it is exactly as fresh as the fingerprint says.
			const unchanged = await executeCodewikiBuildOutcome({ kind: "ensure", cwd, current: ref, previous });
			strictEqual(unchanged.codewiki, null);
			strictEqual(unchanged.changed, false);
			// A drifted fingerprint needs the contents, and a reference the disk no
			// longer honors becomes a full rebuild from source rather than an error.
			const drifted = { ...previous, treeHash: "0".repeat(64) };
			const rebuilt = await executeCodewikiBuildOutcome({ kind: "ensure", cwd, current: ref, previous: drifted });
			ok(rebuilt.codewiki);
			strictEqual(rebuilt.changed, true);
			strictEqual(
				rebuilt.codewiki.symbols.some((symbol) => symbol.name === "one"),
				true,
			);
			deepStrictEqual(rebuilt.fingerprint, previous);
			await rejects(
				executeCodewikiBuildOutcome({ kind: "incremental", cwd, current: ref, paths: ["a.ts"], previous }),
				/unreadable; rebuild it/,
			);
		}
	});

	it("fences reset behind in-flight writers and lets nothing resurrect the artifact afterwards", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "a.ts"), "export const one = 1;\n");
		const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
		// A build admitted before the reset commits first, under the same lease
		// and queue; the reset then removes what it wrote, and an incremental
		// queued after the reset is a no-op because there is no artifact to update.
		const building = coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }));
		const cleared = runContextClear({ cwd, confirmContext: () => true });
		bundle.contract.noteFileChanges(["a.ts"], cwd);
		const [built, reset] = await Promise.all([building, cleared]);
		ok(built);
		strictEqual(built.wrote, true);
		strictEqual(reset.action, "cleared");
		deepStrictEqual(reset.removed, [".clio-coder/codewiki.json"]);
		await bundle.extension.stop?.();
		strictEqual(existsSync(codewikiPath(cwd)), false);
		strictEqual(existsSync(statePath(cwd)), false);
		// Session start on a never-indexed directory stays that way too.
		const bus = createSafeEventBus();
		const started = createContextBundle({ bus, getContract: () => undefined });
		await started.extension.start?.();
		bus.emit(BusChannels.SessionStart, {} as never);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await started.extension.stop?.();
		strictEqual(existsSync(codewikiPath(cwd)), false);
		strictEqual(existsSync(statePath(cwd)), false);
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
