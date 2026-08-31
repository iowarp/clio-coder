import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface BoundaryCheckResult {
	violations: string[];
}

const jsSuffixRegex = /\.m?jsx?$/;
const piPackagePrefix = "@earendil-works/pi-";
// Since the 0.83.0 engine-boundary rework, no file outside src/engine/** may
// import @earendil-works/* at all, type-only included. Domains take erased
// engine shapes (EngineModel, Api, Model) from src/engine/types.ts.
const allowedPiTypeImportSpecifiersOutsideEngine = new Set<string>();

function walk(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
			continue;
		}
		if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stripComments(source: string): string {
	let out = source.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/(^|[^:/])\/\/.*$/gm, (_match, prefix) => prefix);
	return out;
}

function extractReferenceDirectives(source: string): { kind: "path" | "types"; specifier: string }[] {
	const directives: { kind: "path" | "types"; specifier: string }[] = [];
	const regex = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']\s*\/?>/gm;
	for (const match of source.matchAll(regex)) {
		const kind = match[1] as "path" | "types";
		const specifier = match[2];
		if (specifier) directives.push({ kind, specifier });
	}
	return directives;
}

interface ExtractedSpecifier {
	specifier: string;
	typeOnly: boolean;
	dynamic: boolean;
}

function isTypeOnlyImportOrExportClause(clause: string): boolean {
	return clause.trim().startsWith("type ");
}

function extractSpecifiers(source: string): ExtractedSpecifier[] {
	const stripped = stripComments(source);
	const specifiers: ExtractedSpecifier[] = [];

	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = isTypeOnlyImportOrExportClause(clause);
		specifiers.push({ specifier, typeOnly, dynamic: false });
	}

	const dynRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of stripped.matchAll(dynRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false, dynamic: true });
	}

	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const tsRewrites: string[] = [];
	if (jsSuffixRegex.test(candidate)) {
		const stripped = candidate.replace(jsSuffixRegex, "");
		tsRewrites.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`);
	}
	const candidates = [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
		...tsRewrites,
	];
	for (const item of candidates) {
		try {
			if (statSync(item).isFile()) return item;
		} catch {
			// skip
		}
	}
	return candidate;
}

/**
 * The chat loop's turn state machine and its single-owner turn modules.
 * Other interactive files (overlays, panels, the composition root in
 * index.ts) legitimately know about entry-level wiring; these do not.
 */
function isChatLoopTurnModule(filePath: string): boolean {
	const base = path.basename(filePath);
	return base === "chat-loop.ts" || (base.startsWith("turn-") && base.endsWith(".ts"));
}

/**
 * The instant shell's Stage 0 owner. `tests/contracts/instant-shell-import-graph.test.ts`
 * walks the built chunk that contains this module and holds its static closure
 * to 6 chunks and 110,000 bytes, because that closure is what a cold
 * `clio-coder` start pays before it can draw anything.
 */
const STAGE_0_OWNER = path.join("src", "interactive", "terminal-lease.ts");

/**
 * The only modules `src/cli/**` may reach inside `src/interactive/**` and
 * `src/engine/**`.
 *
 * Twice in one release cycle a CLI command grew an ordinary-looking import into
 * one of those trees and broke the Stage 0 budget without anyone noticing until
 * a full build ran: `src/cli/fleet-view.ts` reached `src/engine/tui.ts`, and
 * `src/cli/run.ts` dynamically imported `src/interactive/slash-commands.ts`.
 * Neither edge is wrong on its own. What breaks is the bundle: esbuild gives a
 * module its own chunk when the set of entry points reaching it stops matching
 * its neighbours', so a CLI path that reaches part of the interactive graph
 * becomes a second, disjoint reacher and splits the one merged chunk the Stage 0
 * closure sits on. A dynamic `await import` does it harder, since a dynamically
 * imported module is a split point by itself.
 *
 * So the edge itself is what gets declared, not the symptom. Every entry names a
 * module that is either a leaf by construction or already inside the closure,
 * and says why that is safe.
 */
interface CliSeam {
	/** Project-relative module path, POSIX-separated. */
	module: string;
	/** Why `src/cli/**` reaching this module does not add a reacher to the render graph. */
	reason: string;
}

const CLI_SEAMS: ReadonlyArray<CliSeam> = [
	{
		module: "src/interactive/terminal-lease.ts",
		reason:
			"the Stage 0 owner itself. src/cli/clio.ts is the surface that opens the instant shell, so this edge is the budget rather than a leak, and the closure guard below skips it.",
	},
	{
		module: "src/interactive/slash-commands.ts",
		reason:
			"one slash parser and one registry-membership source for both surfaces. The headless refusal in src/cli/run.ts and the TUI editor must agree on which tokens name a command, and a second copy of the parser would drift. The registry's own imports are what the closure guard below watches.",
	},
	{
		module: "src/interactive/chat-loop.ts",
		reason:
			"type-only: the event and loop shapes the --json and print modes project. Types erase, so no chunk edge exists.",
	},
	{
		module: "src/interactive/chat-loop-messages.ts",
		reason:
			"sumRunUsage, the one usage fold both the CLI modes and the TUI report from. Its value closure stays on domains and engine/ai, off the render graph.",
	},
	{
		module: "src/engine/tui-primitives.ts",
		reason:
			"a pure re-export of the three pi-tui symbols src/cli/fleet-view.ts needs. It has no relative imports at all, and boundaries rule1 forbids the CLI importing pi-tui directly, so this module is why fleet-view does not touch the engine tui barrel.",
	},
	{
		module: "src/engine/types.ts",
		reason:
			"the erased engine shapes (AgentMessage, ImageContent) domains and the CLI both take. Type-only at every call site.",
	},
	{
		module: "src/engine/oauth.ts",
		reason:
			"OAuth provider registration for `auth`/`configure` and the prompt shape `oauth-select` renders. Reaches only alcf-oauth and env-api-keys, none of it terminal rendering.",
	},
	{
		module: "src/engine/session.ts",
		reason: "cwdHash, the session-directory key `usage` reads. A pure path helper.",
	},
];

const CLI_SEAM_MODULES = new Set(CLI_SEAMS.map((seam) => seam.module));

/**
 * The value-import closure of `entry`. Type-only imports are skipped because
 * they erase before the bundler sees them; dynamic imports are followed because
 * they are exactly what splits a chunk.
 */
function valueImportClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length > 0) {
		const file = stack.pop();
		if (file === undefined || seen.has(file)) continue;
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		seen.add(file);
		for (const { specifier, typeOnly } of extractSpecifiers(source)) {
			if (typeOnly) continue;
			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
			const resolved = resolveRelativeImport(file, specifier);
			if (!seen.has(resolved)) stack.push(resolved);
		}
	}
	return seen;
}

function domainOf(filePath: string, domainsRoot: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

function isAllowedWorkerProviderValueImport(resolved: string, providersDomainRoot: string): boolean {
	const allowedFiles = new Set([
		path.join(providersDomainRoot, "plugins.ts"),
		path.join(providersDomainRoot, "registry.ts"),
		path.join(providersDomainRoot, "runtimes", "builtins.ts"),
	]);
	return allowedFiles.has(resolved);
}

/**
 * Enforce the static isolation rules:
 *   1. Only src/engine/** may import @earendil-works/pi-* at all. Since the
 *      0.83.0 engine-boundary rework there is no type-only exception either:
 *      domains take erased engine shapes from src/engine/types.ts.
 *   2. src/worker/** never value-imports src/domains/** EXCEPT the worker-safe
 *      provider runtime registry, builtin descriptors, and plugin loader used
 *      to rehydrate runtime descriptors from stdin. Type-only imports are
 *      allowed because they erase at compile time.
 *   3. src/domains/<x> never imports src/domains/<y>/extension.ts for y != x.
 *   4. src/tools/** never imports src/interactive/**. The tool substrate is
 *      surface-agnostic: headless, interactive, ACP, and worker runs share it,
 *      so a tool reaching into TUI code would make one surface's presentation
 *      a dependency of every surface's execution.
 *   5. The chat loop's turn modules (src/interactive/turn-*.ts, chat-loop.ts)
 *      never import src/entry/**. Composition flows one way: the entry point
 *      composes the loop, never the reverse.
 *   6. src/cli/** reaches src/interactive/** and src/engine/** only through the
 *      declared seams in CLI_SEAMS, and a seam some CLI file value-imports may
 *      not reach the Stage 0 closure. Both halves protect one budget: the
 *      instant shell's cold-start chunk graph, pinned by
 *      tests/contracts/instant-shell-import-graph.test.ts.
 */
export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");
	const providersDomainRoot = path.join(domainsRoot, "providers");
	const toolsRoot = path.join(srcRoot, "tools");
	const interactiveRoot = path.join(srcRoot, "interactive");
	const entryRoot = path.join(srcRoot, "entry");
	const cliRoot = path.join(srcRoot, "cli");
	const stage0Owner = path.join(projectRoot, STAGE_0_OWNER);

	const violations: string[] = [];
	/** Seams a src/cli file reaches with a value import, so their closures are worth walking. */
	const valueReachedSeams = new Set<string>();

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inTools = isWithin(filePath, toolsRoot);
		const isChatLoopModule = isWithin(filePath, interactiveRoot) && isChatLoopTurnModule(filePath);
		const inCli = isWithin(filePath, cliRoot);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			if (specifier.startsWith(piPackagePrefix)) {
				if (!inEngine && !typeOnly) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (value import)`,
					);
				}
				if (!inEngine && typeOnly && !allowedPiTypeImportSpecifiersOutsideEngine.has(specifier)) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (type-only import is not explicitly allowed)`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);

			if (inWorker && isWithin(resolved, domainsRoot)) {
				if (!typeOnly && !isAllowedWorkerProviderValueImport(resolved, providersDomainRoot)) {
					violations.push(
						`rule2: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (worker value imports are limited to provider runtime rehydration modules)`,
					);
				}
				return;
			}

			if (inTools && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule4: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; the tool substrate is surface-agnostic`,
				);
				return;
			}

			if (inCli && (isWithin(resolved, interactiveRoot) || isWithin(resolved, engineRoot))) {
				const seam = path.relative(projectRoot, resolved).split(path.sep).join("/");
				if (!CLI_SEAM_MODULES.has(seam)) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule6: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves to ${seam}; src/cli/** reaches src/interactive/** and src/engine/** only through a seam declared in CLI_SEAMS (tests/boundaries/check-boundaries.ts). A new CLI edge into either tree makes the CLI a second, disjoint reacher of the interactive module graph, and esbuild answers by splitting the merged chunk the instant shell's Stage 0 closure sits on. That closure is held to 6 chunks and 110,000 bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Add a leaf seam module or route through an existing one, then declare it with its reason.`,
					);
				} else if (!typeOnly) {
					valueReachedSeams.add(resolved);
				}
				return;
			}

			if (isChatLoopModule && isWithin(resolved, entryRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule5: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/entry; the entry point composes the chat loop, never the reverse`,
				);
				return;
			}

			if (fromDomain) {
				const toDomain = domainOf(resolved, domainsRoot);
				if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule3: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
					);
				}
			}
		};

		for (const { specifier, typeOnly } of specifiers) {
			evaluate(specifier, typeOnly, "import");
		}

		for (const ref of references) {
			if (ref.kind === "types") {
				evaluate(ref.specifier, true, "reference");
			} else {
				const spec = ref.specifier.startsWith(".") || ref.specifier.startsWith("/") ? ref.specifier : `./${ref.specifier}`;
				evaluate(spec, true, "reference");
			}
		}
	}

	// rule6, second half. Declaring a seam is not enough: the module the CLI
	// value-imports drags its own closure along, and that is how the split
	// actually happened both times. A seam may reach domains, core, and the
	// non-terminal half of the engine freely; what it may not reach is anything
	// the Stage 0 owner already reaches, because that is precisely the set whose
	// chunk membership the instant shell is measured on. The owner itself is the
	// reference point, so its own seam edge is skipped rather than special-cased.
	const stage0Closure = valueReachedSeams.size > 0 ? valueImportClosure(stage0Owner) : new Set<string>();
	for (const seam of [...valueReachedSeams].sort()) {
		if (seam === stage0Owner) continue;
		const reached = [...valueImportClosure(seam)]
			.filter((file) => file !== seam && stage0Closure.has(file))
			.filter((file) => isWithin(file, interactiveRoot) || isWithin(file, engineRoot))
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.sort();
		if (reached.length === 0) continue;
		violations.push(
			`rule6: seam ${path.relative(projectRoot, seam).split(path.sep).join("/")} value-imports its way into the Stage 0 closure (${reached.join(", ")}); a seam src/cli/** value-imports must stay off the modules ${STAGE_0_OWNER} already reaches, or the CLI becomes a second reacher of them and esbuild splits their merged chunk. That closure is held to 6 chunks and 110,000 bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the value the seam needs into a leaf module instead of importing the render module that happens to hold it.`,
		);
	}

	return { violations };
}
