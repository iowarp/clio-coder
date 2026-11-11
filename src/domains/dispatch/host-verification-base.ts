import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";

/** One node_modules link in a base archive: `target` is linked at `relativePath` under the base root. */
export interface BaseModulesLink {
	relativePath: string;
	target: string;
}

/**
 * The checkout that bounds an upward node_modules search from a task
 * worktree. A task worktree nested under `.clio-coder/worktrees/<id>` resolves
 * packages through its enclosing checkout, so the bound is that checkout;
 * any other worktree is its own bound.
 */
function searchBound(worktreePath: string): string {
	const root = resolve(worktreePath);
	const marker = `${sep}.clio-coder${sep}worktrees${sep}`;
	const at = root.lastIndexOf(marker);
	return at > 0 ? root.slice(0, at) : root;
}

/** The nearest node_modules from `start` upward, never above `bound`. */
export function nearestNodeModules(start: string, bound: string): string | null {
	let dir = resolve(start);
	const limit = resolve(bound);
	for (;;) {
		const candidate = join(dir, "node_modules");
		if (existsSync(candidate)) return candidate;
		if (dir === limit) return null;
		const parent = dirname(dir);
		const within = relative(limit, parent);
		if (parent === dir || within.startsWith("..")) return null;
		dir = parent;
	}
}

/** Directories of the task's tracked workspace packages, relative to the worktree, root excluded. */
function packageDirs(worktreePath: string): string[] {
	try {
		const listed = execFileSync(
			"git",
			internalGitArgv(["-C", worktreePath, "ls-files", "-z", "--", ":(glob)**/package.json"]),
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
		);
		return [
			...new Set(
				listed
					.split("\0")
					.filter((path) => path.endsWith("package.json") && path.includes("/") && !path.includes("node_modules/"))
					.map((path) => dirname(path)),
			),
		].sort();
	} catch {
		return [];
	}
}

/**
 * The dependency view the task had, as links for the base archive: the
 * nearest node_modules from the check cwd upward at the base root, and each
 * workspace package's own node_modules, found the same way, at its path.
 */
export function baseModulesLinks(worktreePath: string, checkCwd: string): BaseModulesLink[] {
	const bound = searchBound(worktreePath);
	const links: BaseModulesLink[] = [];
	const root = nearestNodeModules(checkCwd, bound);
	if (root !== null) links.push({ relativePath: "node_modules", target: root });
	const enclosing = resolve(bound) === resolve(worktreePath) ? null : bound;
	for (const dir of packageDirs(worktreePath)) {
		const own = [join(worktreePath, dir, "node_modules"), ...(enclosing ? [join(enclosing, dir, "node_modules")] : [])];
		const target = own.find((path) => existsSync(path));
		if (target !== undefined && target !== root) links.push({ relativePath: `${dir}/node_modules`, target });
	}
	return links;
}

/**
 * A node script the base replay runs before the check: from the base cwd, the
 * check's runner must be on PATH and every dependency the root and cwd
 * package manifests declare must resolve. It exits {@link BASE_PREFLIGHT_EXIT}
 * when the toolchain does not resolve.
 */
export const BASE_PREFLIGHT_EXIT = 86;
export const BASE_PREFLIGHT_SCRIPT = [
	'const fs = require("node:fs"); const path = require("node:path");',
	"const [baseDir, runner] = process.argv.slice(1);",
	"const fail = (what) => { process.stderr.write('base preflight: ' + what + ' does not resolve\\n'); process.exit(86); };",
	"const onPath = (name) => name.includes('/') ? fs.existsSync(path.resolve(name)) : (process.env.PATH || '').split(':').some((dir) => dir && fs.existsSync(path.join(dir, name)));",
	"if (runner && !onPath(runner)) fail(runner);",
	"for (const dir of new Set([baseDir, process.cwd()])) {",
	"  let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }",
	"  const names = Object.keys({ ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) });",
	"  for (const name of names) {",
	"    const paths = require.resolve.paths(name) || [];",
	"    let at = dir; const found = []; for (;;) { found.push(path.join(at, 'node_modules')); const up = path.dirname(at); if (up === at) break; at = up; }",
	"    if (![...found, ...paths].some((root) => fs.existsSync(path.join(root, name)))) fail(name);",
	"  }",
	"}",
].join("\n");
