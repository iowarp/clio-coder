import { dirname, join, relative, resolve } from "node:path";
import type { Metafile, Plugin } from "esbuild";
import { type OutputChunk, rollup } from "rollup";

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
 *      {@link GUARD_SHARE} of its load time. Commands that tolerate one split
 *      share a bit, and fragments a guard cut for no gain are folded back.
 * If chunk A imports chunk B, B's stage is no later and its bits are a
 * superset, so the merged files form a DAG exactly as the chunks did; the
 * fold-back step re-checks that for every merge it makes.
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
	const index = new Map(names.map((name, at) => [name, at]));
	const at = (name: string): number => {
		const found = index.get(name);
		if (found === undefined) throw new Error(`chunk-merge: ${name} is imported but was not built`);
		return found;
	};
	const size = names.map((name) => outputs[name]?.bytes ?? 0);
	const imports = names.map((name) =>
		(outputs[name]?.imports ?? [])
			.filter((edge) => edge.kind !== "dynamic-import" && !edge.external)
			.map((edge) => at(edge.path)),
	);
	const closures = new Map<number, number[]>();
	const closure = (root: number): number[] => {
		let reached = closures.get(root);
		if (reached) return reached;
		const seen = new Set<number>();
		const stack = [root];
		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			if (seen.has(next)) continue;
			seen.add(next);
			stack.push(...(imports[next] ?? []));
		}
		reached = [...seen];
		closures.set(root, reached);
		return reached;
	};
	const byEntryPoint = new Map<string, number>();
	names.forEach((name, chunk) => {
		const source = outputs[name]?.entryPoint;
		if (source !== undefined) byEntryPoint.set(source, chunk);
	});
	const reach = (roots: ReadonlyArray<string>): Set<number> => {
		const all = new Set<number>();
		for (const root of roots) {
			const chunk = byEntryPoint.get(root);
			// A stale root would silently leave its stage unmerged, so it fails the build instead.
			if (chunk === undefined) {
				throw new Error(
					`chunk-merge: ${root} is no longer an entry or import() target; update the roots in scripts/chunk-merge.ts`,
				);
			}
			for (const reached of closure(chunk)) all.add(reached);
		}
		return all;
	};

	// A chunk's cell is its stage and exact paths. Chunks never merge across cells, which is what keeps those exact.
	const stageOf = new Map<number, string>();
	for (const [stage, roots] of SESSION_STAGES) {
		for (const chunk of reach(roots)) if (!stageOf.has(chunk)) stageOf.set(chunk, stage);
	}
	const exact = EXACT_PATHS.map(([name, roots]) => [name, reach(roots)] as const);
	const cellOf = names.map((name, chunk) => {
		if (entries.has(name)) return undefined;
		const held = exact.filter(([, chunks]) => chunks.has(chunk)).map(([path]) => path);
		return `${stageOf.get(chunk) ?? ""}|${held.join("+")}`;
	});

	// group[chunk] is the group the chunk merges into, or -1 for a file of its own. A group is named by a member.
	const group = new Int32Array(names.length).fill(-1);
	const members = new Map<number, number[]>();
	const weight = (id: number): number => (members.get(id) ?? []).reduce((total, chunk) => total + (size[chunk] ?? 0), 0);
	const guards: Array<{ chunks: Set<number>; roots: ColdRoot[] }> = [];
	const regroup = (): void => {
		const byKey = new Map<string, number[]>();
		cellOf.forEach((cell, chunk) => {
			if (cell === undefined) return;
			const held = guards.flatMap((guard, bit) => (guard.chunks.has(chunk) ? [bit] : []));
			if (cell === "|" && held.length === 0) return;
			const key = `${cell}|${held.join("+")}`;
			const mates = byKey.get(key);
			if (mates) mates.push(chunk);
			else byKey.set(key, [chunk]);
		});
		group.fill(-1);
		members.clear();
		for (const mates of byKey.values()) {
			const id = mates[0] ?? -1;
			members.set(id, mates);
			for (const chunk of mates) group[chunk] = id;
		}
	};

	// A cold root is a command or auxiliary entry that starts its own process and loads its closure from nothing.
	interface ColdRoot {
		chunks: number[];
		bytes: number;
		allowance: number;
	}
	const megabytes = (count: number): number => (count / 1e6) * MS_PER_MEGABYTE;
	const hot = new Set([...SESSION_STAGES, ...EXACT_PATHS].flatMap(([, roots]) => roots));
	const coldChunks = new Set<number>();
	for (const edge of outputs[names[byEntryPoint.get("src/cli/index.ts") ?? -1] ?? ""]?.imports ?? []) {
		if (edge.kind === "dynamic-import" && !edge.external) coldChunks.add(at(edge.path));
	}
	for (const entry of entries) coldChunks.add(at(entry));
	const cold: ColdRoot[] = [];
	for (const root of coldChunks) {
		if (hot.has(outputs[names[root] ?? ""]?.entryPoint ?? "")) continue;
		const chunks = closure(root);
		const bytes = chunks.reduce((total, chunk) => total + (size[chunk] ?? 0), 0);
		const allowance = Math.max(GUARD_FLOOR_MS, GUARD_SHARE * (megabytes(bytes) + chunks.length * MS_PER_FILE));
		cold.push({ chunks, bytes, allowance });
	}
	/** Estimated milliseconds the merge costs a cold root beyond its allowance, or 0 inside it. */
	const excess = (root: ColdRoot): number => {
		const files = new Set<number>();
		let loaded = 0;
		for (const chunk of root.chunks) {
			const id = group[chunk] ?? -1;
			if (id === -1) loaded += size[chunk] ?? 0;
			else if (!files.has(id)) loaded += weight(id);
			files.add(id === -1 ? chunk : id);
		}
		const cost = megabytes(loaded - root.bytes) - (root.chunks.length - files.size) * MS_PER_FILE;
		return cost > root.allowance ? cost : 0;
	};

	// Guards: split along the closure of whichever cold root loses most, until none is over its allowance.
	regroup();
	for (;;) {
		let worst: ColdRoot | undefined;
		let worstExcess = 0;
		for (const root of cold) {
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
			const previous = guard.chunks;
			guard.chunks = new Set([...previous, ...guarded.chunks]);
			regroup();
			if (excess(guarded) === 0 && guard.roots.every((root) => excess(root) === 0)) {
				guard.roots.push(guarded);
				return true;
			}
			guard.chunks = previous;
			return false;
		});
		if (!joined) guards.push({ chunks: new Set(guarded.chunks), roots: [guarded] });
		regroup();
	}

	// A guard splits every group it crosses, including ones where the split saves its command nothing. Undo those:
	// fold the smallest group of a cell into another whenever every cold root stays inside its allowance and the
	// merged files still form a DAG (two groups with a third between them on an import path cannot merge).
	const acyclic = (): boolean => {
		const node = (chunk: number): number => ((group[chunk] ?? -1) === -1 ? chunk : (group[chunk] ?? -1));
		// Kahn's algorithm over the merged files: every file settles exactly when no import cycle joins them.
		const importers = new Map<number, number>();
		const nodes = new Set<number>();
		imports.forEach((targets, chunk) => {
			nodes.add(node(chunk));
			for (const target of targets) {
				if (node(target) !== node(chunk)) importers.set(node(target), (importers.get(node(target)) ?? 0) + 1);
			}
		});
		const ready = [...nodes].filter((id) => !importers.has(id));
		let settled = 0;
		for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
			settled += 1;
			for (const chunk of members.get(id) ?? [id]) {
				for (const target of imports[chunk] ?? []) {
					const other = node(target);
					if (other === id) continue;
					const left = (importers.get(other) ?? 0) - 1;
					importers.set(other, left);
					if (left === 0) ready.push(other);
				}
			}
		}
		return settled === nodes.size;
	};
	if (!acyclic()) throw new Error("chunk-merge: the staged groups import each other in a cycle");
	const bySize = (a: number, b: number): number => weight(a) - weight(b) || a - b;
	for (let folded = true; folded; ) {
		folded = false;
		for (const small of [...members.keys()].sort(bySize)) {
			const chunks = members.get(small);
			if (chunks === undefined) continue;
			const hosts = [...members.keys()].filter((id) => id !== small && cellOf[id] === cellOf[small]).sort(bySize);
			for (const host of hosts.reverse()) {
				const into = members.get(host) ?? [];
				members.delete(small);
				members.set(host, [...into, ...chunks]);
				for (const chunk of chunks) group[chunk] = host;
				if (acyclic() && cold.every((root) => excess(root) === 0)) {
					folded = true;
					break;
				}
				members.set(host, into);
				members.set(small, chunks);
				for (const chunk of chunks) group[chunk] = small;
			}
		}
	}

	const plan = new Map<string, string>();
	const counters = new Map<string, number>();
	const ordered = [...members.keys()].sort((a, b) => (names[a] ?? "").localeCompare(names[b] ?? "", "en"));
	for (const id of ordered) {
		const cell = cellOf[id] ?? "|";
		const stage = cell.slice(0, cell.indexOf("|"));
		const prefix = stage === "" ? "shared" : `boot-${stage}`;
		const count = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, count);
		for (const chunk of members.get(id) ?? []) plan.set(names[chunk] ?? "", `${prefix}-${count}`);
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
}

/** Rollup notes that describe esbuild's output rather than a defect in the merge. */
const EXPECTED_NOTES = new Set(["THIS_IS_UNDEFINED", "EVAL"]);

/**
 * Regroup one build's chunks per {@link planChunkGroups} and return the files
 * to write with a metafile that describes them: each merged output lists the
 * source inputs of every chunk it absorbed, so byte budgets and the release
 * artifact keep reading true numbers.
 */
export async function mergeChunks(options: MergeOptions): Promise<{ files: BuiltFile[]; metafile: Metafile }> {
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
	return { files, metafile: { inputs: metafile.inputs, outputs } };
}

/**
 * Runs the merge on esbuild's in-memory result, before tsup writes anything, so
 * dist/ only ever holds merged files and the metafile tsup saves describes them.
 */
export function chunkMergePlugin(banner: string): Plugin {
	return {
		name: "clio-chunk-merge",
		setup(build) {
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
				});
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
