/**
 * The find tool's scenario table and builder. See corpus.ts for the shared
 * contract: every scenario is a pure function of (seed, split, template).
 *
 * find never mutates, so every scenario expects the scratch root unchanged.
 * An ok scenario also expects its entries: every path the call should list,
 * the absence of every ignored, hidden-by-policy, or followed path, and the
 * observation's shown count. fd walks on several threads and does not
 * guarantee an order, so the driver sorts the listed lines before hashing.
 * No scenario lets the result limit or the byte cap cut the listing, since
 * which entries survive a cut would depend on that order.
 */
import {
	buildTree,
	CORPUS_SCHEMA,
	type CorpusEntry,
	type Profile,
	pickDistinct,
	Rng,
	type ScenarioBase,
	type Split,
	scenarioId,
	treeEntry,
	unchangedFiles,
} from "./corpus-core.js";

export interface FindCall {
	pattern: string;
	path?: string;
	limit?: number;
}

export interface FindScenario extends ScenarioBase {
	tool: "find";
	args: FindCall;
}

type FindShape =
	| "name"
	| "extension"
	| "nested"
	| "empty"
	| "hidden"
	| "ignored"
	| "dirs-and-files"
	| "symlink-loop"
	| "symlink-outside"
	| "symlink-outside-path"
	| "missing-root"
	| "order"
	| "tree";

export interface FindTemplate {
	key: string;
	profile: Profile;
	shape: FindShape;
	/** Text files in the tree under data/. */
	tree: number;
	/** Files of the tree that get the matching extension, for extension, order, and tree. */
	matches?: number;
}

export const FIND_TEMPLATES: readonly FindTemplate[] = [
	{ key: "name-100", profile: "default", shape: "name", tree: 100 },
	{ key: "extension-1k", profile: "default", shape: "extension", tree: 1000, matches: 20 },
	{ key: "nested-depth-12", profile: "default", shape: "nested", tree: 10 },
	{ key: "empty-result-1k", profile: "default", shape: "empty", tree: 1000 },
	{ key: "hidden-files", profile: "default", shape: "hidden", tree: 10 },
	{ key: "ignored-dirs", profile: "default", shape: "ignored", tree: 10 },
	{ key: "dirs-and-files", profile: "default", shape: "dirs-and-files", tree: 10 },
	{ key: "symlink-loop", profile: "default", shape: "symlink-loop", tree: 10 },
	{ key: "symlink-dir-outside", profile: "default", shape: "symlink-outside", tree: 10 },
	{ key: "order-200", profile: "default", shape: "order", tree: 1000, matches: 200 },
	{ key: "tree-10", profile: "default", shape: "tree", tree: 10, matches: 2 },
	{ key: "tree-10k", profile: "default", shape: "tree", tree: 10000, matches: 5 },
	{ key: "tree-50k", profile: "full", shape: "tree", tree: 50000, matches: 5 },
	{ key: "err-symlink-outside-path", profile: "default", shape: "symlink-outside-path", tree: 10 },
	{ key: "err-missing-root", profile: "default", shape: "missing-root", tree: 10 },
];

function textFile(path: string, text: string): CorpusEntry {
	return { kind: "file", path, bytes: Buffer.from(text, "utf8"), mode: 0o644 };
}

export function generateFindScenario(seed: number, split: Split, key: string): FindScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = FIND_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown find scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|find|${split}|${seed}|${key}`);
	const tag = rng.hex(8);
	const chosen = new Set(pickDistinct(rng, template.matches ?? 0, template.tree));
	const ext = template.shape === "order" ? "log" : "cfg";
	const tree = buildTree(rng, template.tree, (index) => (chosen.has(index) ? ext : "txt"));
	const extra: CorpusEntry[] = [];
	const includes: string[] = [];
	const excludes: string[] = [];
	let shown = 0;
	const expectListed = (...paths: string[]): void => {
		includes.push(...paths);
		shown += paths.length;
	};

	let args: FindCall;
	let outcome: "ok" | "error" = "ok";
	switch (template.shape) {
		case "name": {
			const name = `target-${tag}.cfg`;
			const paths = [`data/g000/${name}`, `data/g000/x/${name}`, `data/y/z/${name}`];
			for (const path of paths) extra.push(textFile(path, `${tag}\n`));
			extra.push(textFile(`data/g000/${name}.bak`, `${tag}\n`));
			excludes.push(`${name}.bak`);
			expectListed(...paths);
			args = { pattern: name };
			break;
		}
		case "extension":
		case "order":
		case "tree": {
			expectListed(...tree.filter((file) => file.path.endsWith(`.${ext}`)).map((file) => file.path));
			args = { pattern: `*.${ext}` };
			break;
		}
		case "nested": {
			// Leaves at depths 3, 7, and 12 below data/.
			let dir = "data";
			for (let depth = 1; depth <= 12; depth += 1) {
				dir += `/n${depth}`;
				if (depth === 3 || depth === 7 || depth === 12) {
					const path = `${dir}/leaf-${tag}.txt`;
					extra.push(textFile(path, `${depth} ${tag}\n`));
					expectListed(path);
				}
			}
			args = { pattern: "leaf-*.txt" };
			break;
		}
		case "empty": {
			includes.push("No visible files found matching pattern");
			args = { pattern: `*.${tag}` };
			break;
		}
		case "hidden": {
			const paths = [`data/.env-${tag}.cfg`, `data/.private-${tag}/inner.cfg`, `data/visible-${tag}.cfg`];
			for (const path of paths) extra.push(textFile(path, `${tag}\n`));
			expectListed(...paths);
			args = { pattern: "*.cfg" };
			break;
		}
		case "ignored": {
			// .gitignore, a generated directory, and dist all hide their files.
			extra.push(textFile(".gitignore", `out-${tag}/\n*.min.js\n`));
			const hidden = [
				`data/out-${tag}/a.js`,
				`data/app-${tag}.min.js`,
				`data/node_modules/pkg-${tag}/index.js`,
				`data/dist/b-${tag}.js`,
			];
			for (const path of hidden) extra.push(textFile(path, `${tag}\n`));
			excludes.push(...hidden);
			const visible = `data/src-${tag}/main.js`;
			extra.push(textFile(visible, `${tag}\n`));
			expectListed(visible);
			args = { pattern: "*.js" };
			break;
		}
		case "dirs-and-files": {
			// Directories list with a trailing slash; files inside them do not match.
			extra.push(textFile(`data/pkg-a-${tag}/readme.txt`, `${tag}\n`));
			extra.push(textFile(`data/pkg-b-${tag}/sub/x.txt`, `${tag}\n`));
			extra.push(textFile(`data/pkg-c-${tag}.txt`, `${tag}\n`));
			expectListed(`data/pkg-a-${tag}/`, `data/pkg-b-${tag}/`, `data/pkg-c-${tag}.txt`);
			excludes.push("readme.txt", "sub/x.txt");
			args = { pattern: "pkg-*" };
			break;
		}
		case "symlink-loop": {
			// Two links naming each other and one naming its own parent. The walk
			// lists each link once and follows none.
			extra.push({ kind: "symlink", path: `data/loop-a-${tag}`, target: `loop-b-${tag}` });
			extra.push({ kind: "symlink", path: `data/loop-b-${tag}`, target: `loop-a-${tag}` });
			extra.push({ kind: "symlink", path: `data/g000/up-${tag}`, target: ".." });
			expectListed(`data/loop-a-${tag}`, `data/loop-b-${tag}`, `data/g000/up-${tag}`);
			excludes.push(`up-${tag}/`);
			args = { pattern: `*-${tag}` };
			break;
		}
		case "symlink-outside":
		case "symlink-outside-path": {
			// data/out names the directory holding the scratch root, so a walk
			// through it would list this tree again under root/.
			extra.push({ kind: "symlink", path: "data/out", target: "../.." });
			excludes.push("root/data/");
			if (template.shape === "symlink-outside") {
				expectListed(...tree.map((file) => file.path));
				args = { pattern: "*.txt" };
			} else {
				args = { pattern: "*.txt", path: "data/out" };
				outcome = "error";
			}
			break;
		}
		case "missing-root": {
			args = { pattern: "*.txt", path: `data/absent-${tag}` };
			outcome = "error";
			break;
		}
	}
	if (outcome === "ok") includes.push(`"shownCount":${shown},`);

	const files = [...tree.map(treeEntry), ...extra];
	return {
		id: scenarioId("find", split, key),
		tool: "find",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args,
		expect: {
			outcome,
			files: unchangedFiles(files),
			...(outcome === "ok" ? { output: { includes, excludes } } : {}),
		},
	};
}
