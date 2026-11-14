import { dirname, join, relative, resolve } from "node:path";
import type { Metafile, Plugin } from "esbuild";
import { type OutputChunk, type RollupCache, rollup } from "rollup";

/**
 * Merges esbuild's split chunks into the few files each boot path loads.
 *
 * esbuild puts a module in the chunk named by the exact set of entries and
 * `import()` targets that reach it. With about 250 of those the build has 700
 * chunks, an interactive boot loads 425 of them, and Node spends about 0.33 ms
 * resolving, reading and linking each one whatever its size: 262 ms of loader
 * time for the Stage 0 plus composition-root graph against 137 ms when the same
 * code is one file (warm compile cache, median of 10, same host). esbuild has
 * no manual chunking, so this pass regroups its output: every chunk gets a key,
 * chunks with one key become one file, and rollup does the merge because it
 * rewrites the imports, exports and `import()` sites of plain ES modules
 * without touching the code between them.
 *
 * The key has three parts, and each only ever narrows a group:
 *   1. the first session boot stage that loads the chunk, so a stage's file
 *      holds nothing an earlier stage could have done without and the staged
 *      preload in src/entry/stage1-preload.ts keeps its event-loop turns;
 *   2. which exact paths reach it ({@link EXACT_PATHS}), so a headless run, a
 *      native worker and the Stage 0 owner each load exactly the chunks they
 *      loaded before, only in fewer files;
 *   3. guard bits for cold commands. A merged file loads whole, so a command
 *      that needed three chunks of a group now parses and evaluates all of it.
 *      Guards split a group along a command's own closure until no command is
 *      estimated to lose more than {@link GUARD_FLOOR_MS} or
 *      {@link GUARD_SHARE} of its load time, and commands that tolerate one
 *      split share a bit, which keeps the count near six.
 * If chunk A imports chunk B, B's stage is no later and its bits are a
 * superset, so the merged files form a DAG exactly as the chunks did.
 */

/** The interactive session's `import()` crossings, in boot order (src/cli/clio.ts, src/entry/stage1-preload.ts). */
const SESSION_STAGES: ReadonlyArray<readonly [name: string, roots: ReadonlyArray<string>]> = [
	["entry", ["src/cli/index.ts"]],
	// Everything the workspace launcher loads; the pane session repeats it.
	[
		"launch",
		[
			"src/core/compile-cache.ts",
			"src/cli/clio.ts",
			"src/cli/workspace-check.ts",
			"src/domains/lifecycle/boot-migrations.ts",
			"src/cli/workspace-launch.ts",
		],
	],
	// The rest of what runs before the first frame.
	[
		"shell",
		[
			"src/cli/project-trust-card.ts",
			"src/domains/mux/workspace/exit-marker.ts",
			"src/core/terminal-background.ts",
			"src/interactive/terminal-lease.ts",
		],
	],
	["providers", ["src/entry/stage1-preload.ts", "src/domains/providers/index.ts"]],
	["session", ["src/domains/session/index.ts"]],
	[
		"domains",
		[
			"src/domains/telemetry/index.ts",
			"src/domains/dispatch/index.ts",
			"src/domains/memory/index.ts",
			"src/domains/context/index.ts",
			"src/domains/resources/index.ts",
			"src/domains/safety/index.ts",
			"src/tools/bootstrap.ts",
		],
	],
	["orchestrator", ["src/entry/orchestrator.ts"]],
	["interactive", ["src/interactive/index.ts"]],
];

/**
 * Load paths other than the session's that stay exact: each loads the chunks it
 * loaded before the merge and no others. `stage0` is the instant shell's owner
 * and `runHelp` answers `run --help` without the run command; both are pinned
 * by tests/contracts/instant-shell-import-graph.test.ts.
 */
const EXACT_PATHS: ReadonlyArray<readonly [name: string, roots: ReadonlyArray<string>]> = [
	["stage0", ["src/interactive/terminal-lease.ts"]],
	["headless", ["src/core/compile-cache.ts", "src/cli/run.ts", "src/entry/orchestrator.ts"]],
	["worker", ["src/worker/entry.ts"]],
	["runHelp", ["src/cli/run-help.ts"]],
];

/**
 * Load-cost model for the guards, measured on the v081 build (Node 24, 24-core
 * WSL2 host): a megabyte of chunk costs about 25 ms to parse without the
 * compile cache and evaluate, and a file costs about 0.33 ms.
 */
const MS_PER_MEGABYTE = 25;
const MS_PER_FILE = 0.33;
const GUARD_FLOOR_MS = 8;
const GUARD_SHARE = 0.15;

type Outputs = Metafile["outputs"];

/**
 * The file each esbuild output is merged into, keyed by metafile output name.
 * Outputs left out keep a file of their own; `entries` (the build's real entry
 * outputs) always are.
 */
export function planChunkGroups(outputs: Outputs, entries: ReadonlySet<string>): Map<string, string> {
	const names = Object.keys(outputs);
	const output = (name: string) => {
		const found = outputs[name];
		if (!found) throw new Error(`chunk-merge: ${name} is imported but was not built`);
		return found;
	};
	const closures = new Map<string, Set<string>>();
	const closure = (name: string): Set<string> => {
		let seen = closures.get(name);
		if (seen) return seen;
		seen = new Set<string>();
		const stack = [name];
		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			if (seen.has(next)) continue;
			seen.add(next);
			for (const edge of output(next).imports) {
				if (edge.kind !== "dynamic-import" && !edge.external) stack.push(edge.path);
			}
		}
		closures.set(name, seen);
		return seen;
	};
	const byEntryPoint = new Map<string, string>();
	for (const name of names) {
		const source = output(name).entryPoint;
		if (source !== undefined) byEntryPoint.set(source, name);
	}
	const reach = (roots: ReadonlyArray<string>): Set<string> => {
		const all = new Set<string>();
		for (const root of roots) {
			const name = byEntryPoint.get(root);
			// A stale root would silently leave its stage unmerged, so it fails the build instead.
			if (name === undefined) {
				throw new Error(
					`chunk-merge: ${root} is no longer an entry or import() target; update the roots in scripts/chunk-merge.ts`,
				);
			}
			for (const chunk of closure(name)) all.add(chunk);
		}
		return all;
	};
	const bytes = (chunks: Iterable<string>): number => {
		let total = 0;
		for (const chunk of chunks) total += output(chunk).bytes;
		return total;
	};

	const stageOf = new Map<string, string>();
	for (const [stage, roots] of SESSION_STAGES) {
		for (const chunk of reach(roots)) if (!stageOf.has(chunk)) stageOf.set(chunk, stage);
	}
	const bits = new Map<string, Set<string>>(EXACT_PATHS.map(([name, roots]) => [name, reach(roots)]));

	let keyOf = new Map<string, string>();
	let members = new Map<string, string[]>();
	const regroup = (): void => {
		keyOf = new Map();
		members = new Map();
		for (const name of names) {
			if (entries.has(name)) continue;
			const held = [...bits].filter(([, chunks]) => chunks.has(name)).map(([bit]) => bit);
			const stage = stageOf.get(name);
			if (stage === undefined && held.length === 0) continue;
			const key = `${stage ?? ""}|${held.join("+")}`;
			keyOf.set(name, key);
			const group = members.get(key);
			if (group) group.push(name);
			else members.set(key, [name]);
		}
	};
	regroup();

	// A cold root is a command or auxiliary entry that starts its own process and loads its closure from nothing.
	const hot = new Set([...SESSION_STAGES, ...EXACT_PATHS].flatMap(([, roots]) => roots));
	const cli = byEntryPoint.get("src/cli/index.ts");
	const coldRoots = new Set<string>();
	for (const edge of cli === undefined ? [] : output(cli).imports) {
		if (edge.kind === "dynamic-import" && !edge.external) coldRoots.add(edge.path);
	}
	for (const entry of entries) coldRoots.add(entry);
	for (const root of [...coldRoots]) if (hot.has(output(root).entryPoint ?? "")) coldRoots.delete(root);

	/** Estimated milliseconds the merge costs `root` beyond its allowance, or 0 inside it. */
	const excess = (root: string): number => {
		const before = closure(root);
		const loaded = new Set(before);
		const files = new Set<string>();
		for (const chunk of before) {
			const key = keyOf.get(chunk);
			files.add(key ?? chunk);
			for (const mate of key === undefined ? [] : (members.get(key) ?? [])) loaded.add(mate);
		}
		const megabytes = (count: number): number => (count / 1e6) * MS_PER_MEGABYTE;
		const beforeBytes = bytes(before);
		const cost = megabytes(bytes(loaded) - beforeBytes) - (before.size - files.size) * MS_PER_FILE;
		const allowance = Math.max(GUARD_FLOOR_MS, GUARD_SHARE * (megabytes(beforeBytes) + before.size * MS_PER_FILE));
		return cost > allowance ? cost : 0;
	};
	const guards: Array<{ bit: string; roots: string[] }> = [];
	for (;;) {
		let worst: string | undefined;
		let worstExcess = 0;
		for (const root of coldRoots) {
			const over = excess(root);
			if (over > worstExcess) {
				worst = root;
				worstExcess = over;
			}
		}
		if (worst === undefined) break;
		const guarded = worst;
		// Prefer widening a guard that already exists: every new bit splits every group it crosses.
		const joined = guards.some((guard) => {
			const previous = bits.get(guard.bit) ?? new Set<string>();
			bits.set(guard.bit, new Set([...previous, ...closure(guarded)]));
			regroup();
			if (excess(guarded) === 0 && guard.roots.every((root) => excess(root) === 0)) {
				guard.roots.push(guarded);
				return true;
			}
			bits.set(guard.bit, previous);
			return false;
		});
		if (!joined) {
			const bit = `guard${guards.length}`;
			guards.push({ bit, roots: [guarded] });
			bits.set(bit, new Set(closure(guarded)));
		}
		regroup();
	}

	const plan = new Map<string, string>();
	const counters = new Map<string, number>();
	for (const key of [...members.keys()].sort()) {
		const stage = key.slice(0, key.indexOf("|"));
		const prefix = stage === "" ? "shared" : `boot-${stage}`;
		const index = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, index);
		for (const chunk of members.get(key) ?? []) plan.set(chunk, `${prefix}-${index}`);
	}
	return plan;
}

export interface BuiltFile {
	/** Absolute path under the build's output directory. */
	path: string;
	text: string;
}

export interface MergeOptions {
	files: ReadonlyArray<BuiltFile>;
	metafile: Metafile;
	/** Absolute output directory the files and the metafile's output names live under. */
	outdir: string;
	/** Output names of the build's real entries, as the metafile spells them. */
	entries: ReadonlySet<string>;
	/** The banner esbuild put on every chunk; it is removed from each and written once per merged file. */
	banner: string;
	/** The previous merge's parsed chunks; a watch rebuild then parses only the chunks that changed. */
	cache?: RollupCache;
}

/** Rollup notes that describe esbuild's output rather than a defect in the merge. */
const EXPECTED_NOTES = new Set(["THIS_IS_UNDEFINED", "EVAL"]);

/**
 * Regroup one build's chunks per {@link planChunkGroups} and return the files
 * to write with a metafile that describes them: each merged output lists the
 * source inputs of every chunk it absorbed, so byte budgets and the release
 * artifact keep reading true numbers.
 */
export async function mergeChunks(
	options: MergeOptions,
): Promise<{ files: BuiltFile[]; metafile: Metafile; cache: RollupCache | undefined }> {
	const { metafile, outdir, entries, banner } = options;
	const stray = options.files.find((file) => !file.path.endsWith(".js"));
	// Source maps would need composing through the merge; the build ships none.
	if (stray) throw new Error(`chunk-merge: cannot carry ${stray.path} through the merge`);
	const nameOf = new Map<string, string>();
	for (const name of Object.keys(metafile.outputs)) nameOf.set(resolve(name), name);
	const prefix = relative(process.cwd(), outdir).replaceAll("\\", "/");
	const code = new Map<string, string>();
	const hashbangs = new Map<string, string>();
	for (const file of options.files) {
		if (!nameOf.has(file.path)) throw new Error(`chunk-merge: ${file.path} is missing from the metafile`);
		let text = file.text;
		if (text.startsWith("#!")) {
			const end = text.indexOf("\n");
			hashbangs.set(file.path, text.slice(0, end));
			text = text.slice(end + 1);
		}
		if (text.startsWith(`${banner}\n`)) text = text.slice(banner.length + 1);
		code.set(file.path, text);
	}
	const plan = planChunkGroups(metafile.outputs, entries);
	// Every chunk is placed by hand, single ones under their own name: left to its own chunking rollup may fold a
	// chunk into an entry file in a subdirectory, and code that resolves paths from import.meta.url would move with it.
	const alias = (id: string): string | undefined => {
		const name = nameOf.get(id);
		if (name === undefined || entries.has(name)) return undefined;
		return plan.get(name) ?? name.slice(name.lastIndexOf("/") + 1, -".js".length);
	};
	for (const [id, name] of nameOf) {
		if (entries.has(name)) continue;
		for (const edge of metafile.outputs[name]?.imports ?? []) {
			if (edge.kind !== "dynamic-import" && entries.has(edge.path)) {
				throw new Error(`chunk-merge: ${name} statically imports the entry ${edge.path}; ${id} cannot be placed`);
			}
		}
	}

	const input: Record<string, string> = {};
	for (const entry of entries) input[relative(prefix, entry).slice(0, -".js".length)] = resolve(entry);
	const bundle = await rollup({
		input,
		...(options.cache === undefined ? {} : { cache: options.cache }),
		treeshake: false,
		preserveEntrySignatures: "strict",
		plugins: [
			{
				name: "esbuild-chunks",
				resolveId(source, importer) {
					if (importer === undefined) return source;
					if (!source.startsWith(".")) return { id: source, external: true };
					const id = resolve(dirname(importer), source);
					if (!code.has(id)) throw new Error(`chunk-merge: ${importer} imports ${source}, which was not built`);
					return id;
				},
				load: (id) => code.get(id) ?? null,
			},
		],
		onLog(level, log) {
			if (level !== "warn" || (log.code !== undefined && EXPECTED_NOTES.has(log.code))) return;
			throw new Error(`chunk-merge: ${log.code ?? "rollup"}: ${log.message}`);
		},
	});
	const generated = await bundle.generate({
		format: "es",
		dir: outdir,
		entryFileNames: "[name].js",
		// esbuild's own content hash comes off the name; rollup's covers the merged file and everything it imports.
		chunkFileNames: (chunk) => `${chunk.name.replace(/-[0-9A-Z]{8}$/u, "")}-[hash].js`,
		hashCharacters: "base36",
		manualChunks: alias,
		hoistTransitiveImports: false,
		minifyInternalExports: false,
		compact: true,
		generatedCode: { preset: "es2015", symbols: true },
		banner,
	});
	await bundle.close();

	const chunks = generated.output.filter((item): item is OutputChunk => item.type === "chunk");
	const built = new Set(chunks.map((chunk) => chunk.fileName));
	const outputs: Outputs = {};
	const files: BuiltFile[] = [];
	for (const chunk of chunks) {
		const absorbed = chunk.moduleIds.map((id) => nameOf.get(id)).filter((name) => name !== undefined);
		// An entry's file holds that entry alone; every other file holds exactly the chunks planned for its name.
		const placed = new Set(chunk.moduleIds.map(alias));
		const [only] = placed;
		if (placed.size > 1 || (only === undefined ? chunk.moduleIds.length > 1 : chunk.name !== only)) {
			throw new Error(`chunk-merge: ${chunk.fileName} does not hold the chunks planned for it`);
		}
		const hashbang = chunk.isEntry && chunk.facadeModuleId !== null ? hashbangs.get(chunk.facadeModuleId) : undefined;
		const text = hashbang === undefined ? chunk.code : `${hashbang}\n${chunk.code}`;
		files.push({ path: join(outdir, chunk.fileName), text });
		const inputs: Outputs[string]["inputs"] = {};
		for (const name of absorbed) {
			for (const [source, share] of Object.entries(metafile.outputs[name]?.inputs ?? {})) {
				inputs[source] = { bytesInOutput: (inputs[source]?.bytesInOutput ?? 0) + share.bytesInOutput };
			}
		}
		const edge = (path: string, kind: "import-statement" | "dynamic-import"): Outputs[string]["imports"][number] =>
			built.has(path) ? { path: `${prefix}/${path}`, kind } : { path, kind, external: true };
		const facade = chunk.facadeModuleId === null ? undefined : nameOf.get(chunk.facadeModuleId);
		const entryPoint = facade === undefined ? undefined : metafile.outputs[facade]?.entryPoint;
		outputs[`${prefix}/${chunk.fileName}`] = {
			bytes: Buffer.byteLength(text),
			inputs,
			imports: [
				...chunk.imports.map((path) => edge(path, "import-statement")),
				...chunk.dynamicImports.map((path) => edge(path, "dynamic-import")),
			],
			exports: chunk.exports,
			...(entryPoint === undefined ? {} : { entryPoint }),
		};
	}
	return { files, metafile: { inputs: metafile.inputs, outputs }, cache: bundle.cache };
}

/**
 * Runs the merge on esbuild's in-memory result, before tsup writes anything, so
 * dist/ only ever holds merged files and the metafile tsup saves describes them.
 */
export function chunkMergePlugin(banner: string): Plugin {
	return {
		name: "clio-chunk-merge",
		setup(build) {
			let cache: RollupCache | undefined;
			build.onEnd(async (result) => {
				if (result.errors.length > 0 || !result.metafile || !result.outputFiles) return;
				const outdir = resolve(build.initialOptions.outdir ?? "dist");
				const prefix = relative(process.cwd(), outdir).replaceAll("\\", "/");
				const entries = new Set(
					Object.keys(build.initialOptions.entryPoints as Record<string, string>).map((name) => `${prefix}/${name}.js`),
				);
				const merged = await mergeChunks({
					files: result.outputFiles.map((file) => ({ path: file.path, text: file.text })),
					metafile: result.metafile,
					outdir,
					entries,
					banner,
					...(cache === undefined ? {} : { cache }),
				});
				cache = merged.cache;
				result.metafile = merged.metafile;
				result.outputFiles = merged.files.map((file) => ({
					path: file.path,
					text: file.text,
					contents: Buffer.from(file.text),
					hash: "",
				}));
			});
		},
	};
}
