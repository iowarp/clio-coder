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
 * Modules an external runtime reacher may enter inside `src/interactive/**` or
 * `src/engine/**`.
 *
 * The first two Stage 0 splits came from `src/cli/**`; the third came from
 * `src/domains/mux/**`. Esbuild responds to both identically: when a module in
 * the instant shell's closure gains a second, disjoint reacher, it peels that
 * module out of the neighbours it used to share a chunk with. Rule 6 therefore
 * guards every value importer outside the computed Stage 0 closure and the two
 * protected trees, not one directory that happened to contain earlier bugs.
 *
 * Every existing edge is declared here with its architectural reason. A seam
 * still fails the closure walk unless it stays off Stage 0. The only explicit
 * overlap exceptions are the Stage 1 composition-root edges that assemble the
 * complete interactive application and already own those dependencies.
 */
interface Stage0Seam {
	/** Project-relative module path, POSIX-separated. */
	module: string;
	/** Why an external runtime reacher legitimately enters through this module. */
	reason: string;
	/** Existing composition roots allowed to overlap Stage 0 through this seam. */
	allowStage0OverlapFrom?: readonly string[];
}

const ORCHESTRATOR = "src/entry/orchestrator.ts";

const STAGE0_SEAMS: ReadonlyArray<Stage0Seam> = [
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
		reason: "the Stage 1 composition root creates the chat loop; CLI event-shape imports are type-only and erase.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
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
		reason:
			"the canonical session path, atomic-write, and JSONL persistence substrate shared by lifecycle, dispatch, session domains, the CLI, and the Stage 1 composition root; its closure stays off terminal rendering.",
	},
	{
		module: "src/engine/pi-mono-names.ts",
		reason: "the dependency-name table package-root and lifecycle version reporting inspect; a constant-only leaf.",
	},
	{
		module: "src/engine/truncate.ts",
		reason: "surface-neutral byte and display truncation shared by context markers and tools.",
	},
	{
		module: "src/engine/acp/adapter.ts",
		reason: "dispatch translates worker results through the engine-owned ACP protocol adapter.",
	},
	{
		module: "src/engine/acp/server.ts",
		reason: "the Stage 1 composition root owns the ACP server surface.",
	},
	{
		module: "src/engine/acp/transport.ts",
		reason: "the Stage 1 composition root owns ACP stdio transport construction.",
	},
	{
		module: "src/engine/antigravity/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Antigravity subprocess runtime.",
	},
	{
		module: "src/engine/claude/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Claude subprocess runtime.",
	},
	{
		module: "src/engine/claude/tool-safety.ts",
		reason: "dispatch classifies Claude's canonical tool names through the engine adapter that owns them.",
	},
	{
		module: "src/engine/worker-runtime-capabilities.ts",
		reason: "dispatch reads the engine worker's static mediation capability contract.",
	},
	{
		module: "src/engine/env-api-keys.ts",
		reason: "provider authentication uses the engine's environment-key lookup ladder.",
	},
	{
		module: "src/engine/ai.ts",
		reason:
			"provider, session, and tool surfaces use the engine-owned model bridge and error classifiers; its closure is deliberately terminal-free.",
	},
	{
		module: "src/engine/apis/index.ts",
		reason: "the provider extension registers engine API implementations at the domain composition boundary.",
	},
	{
		module: "src/engine/api-registry.ts",
		reason: "the provider plugin loader activates the engine-owned external API bridge.",
	},
	{
		module: "src/engine/prompt-templates.ts",
		reason: "resource loaders share the engine's argument parser and substitution semantics.",
	},
	{
		module: "src/engine/strip-tokenizer-sentinels.ts",
		reason: "session previews reuse the engine's pure tokenizer-sentinel normalizer.",
	},
	{
		module: "src/engine/apis/residency.ts",
		reason: "the orchestrator and worker entry points share engine model-residency policy.",
	},
	{
		module: "src/engine/loop-guard.ts",
		reason: "the Stage 1 composition root wires the engine-owned loop guard.",
	},
	{
		module: "src/engine/worker-runtime.ts",
		reason: "the worker entry point boots the engine-owned worker runtime.",
	},
	{
		module: "src/engine/worker-tools.ts",
		reason: "the worker entry point installs the engine-owned worker tool bridge.",
	},
	{
		module: "src/interactive/index.ts",
		reason: "the Stage 1 composition root assembles the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/keybinding-manager.ts",
		reason: "the Stage 1 composition root supplies the keybinding manager to the application it assembles.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/loop-guard-interrupt.ts",
		reason: "the Stage 1 composition root connects engine loop-guard stops to interactive cancellation.",
	},
	{
		module: "src/interactive/model-session-replay.ts",
		reason: "the Stage 1 composition root projects persisted turns back into interactive model messages.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/panes-runtime.ts",
		reason: "the panes composition root (src/entry/with-panes.ts) creates the optional interactive panes runtime.",
	},
	{
		module: "src/interactive/mux-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the dispatch-to-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/yazi-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the file-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/tool-prose-registration.ts",
		reason: "the Stage 1 composition root registers interactive prose renderers for tool results.",
	},
	{
		module: "src/interactive/watchdog-run.ts",
		reason: "the Stage 1 composition root wires watchdog review into the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
];

const STAGE0_SEAMS_BY_MODULE = new Map(STAGE0_SEAMS.map((seam) => [seam.module, seam]));

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
 *   6. Any value importer outside the computed Stage 0 closure and its
 *      src/interactive/** and src/engine/** trees reaches those trees only
 *      through a declared seam in STAGE0_SEAMS. A seam may not lead back into
 *      Stage 0 unless that existing composition-root overlap is explicitly
 *      declared. CLI type edges retain the older declaration requirement.
 *      Both halves protect the instant shell's cold-start chunk graph, pinned by
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
	const stage0Closure = valueImportClosure(stage0Owner);

	const violations: string[] = [];
	/** Runtime importers by declared seam, so rule 6b can disposition each reacher. */
	const valueReachedSeams = new Map<string, Set<string>>();

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inInteractive = isWithin(filePath, interactiveRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inTools = isWithin(filePath, toolsRoot);
		const isChatLoopModule = inInteractive && isChatLoopTurnModule(filePath);
		const inCli = isWithin(filePath, cliRoot);
		const inStage0Closure = stage0Closure.has(filePath);

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

			const protectedTarget = isWithin(resolved, interactiveRoot) || isWithin(resolved, engineRoot);
			const externalRuntimeReacher = !typeOnly && !inInteractive && !inEngine && !inStage0Closure;
			if (protectedTarget && (inCli || externalRuntimeReacher)) {
				const seamPath = path.relative(projectRoot, resolved).split(path.sep).join("/");
				const seam = STAGE0_SEAMS_BY_MODULE.get(seamPath);
				if (seam === undefined) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule6: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves to ${seamPath}; runtime importers outside the computed Stage 0 closure and its src/interactive/** and src/engine/** trees may enter those protected trees only through a seam declared in STAGE0_SEAMS (tests/boundaries/check-boundaries.ts). A new disjoint reacher makes esbuild split the merged chunk the instant shell's Stage 0 closure sits on. That closure is held to 6 chunks and 110,000 bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the needed value into a leaf seam, route through an existing seam, or declare a legitimate edge with its reason.`,
					);
				} else if (!typeOnly) {
					const importers = valueReachedSeams.get(resolved) ?? new Set<string>();
					importers.add(filePath);
					valueReachedSeams.set(resolved, importers);
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

	// rule6, second half. Declaring a seam is not enough: the imported module
	// drags its own closure along, and that is how the first CLI splits happened.
	// A seam may reach domains, core, and the
	// non-terminal half of the engine freely; what it may not reach is anything
	// the Stage 0 owner already reaches, because that is precisely the set whose
	// chunk membership the instant shell is measured on. The owner itself is the
	// reference point, so its own seam edge is skipped rather than special-cased.
	for (const seam of [...valueReachedSeams.keys()].sort()) {
		if (seam === stage0Owner) continue;
		const reached = [...valueImportClosure(seam)]
			.filter((file) => file !== seam && stage0Closure.has(file))
			.filter((file) => isWithin(file, interactiveRoot) || isWithin(file, engineRoot))
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.sort();
		if (reached.length === 0) continue;
		const seamPath = path.relative(projectRoot, seam).split(path.sep).join("/");
		const declaration = STAGE0_SEAMS_BY_MODULE.get(seamPath);
		const allowedOverlapImporters = new Set(declaration?.allowStage0OverlapFrom ?? []);
		const importers = [...(valueReachedSeams.get(seam) ?? [])]
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.filter((file) => !allowedOverlapImporters.has(file))
			.sort();
		if (importers.length === 0) continue;
		violations.push(
			`rule6: seam ${seamPath}, reached by ${importers.join(", ")}, value-imports its way into the Stage 0 closure (${reached.join(", ")}); an external seam must stay off the modules ${STAGE_0_OWNER} already reaches, or its importer becomes a second reacher and esbuild splits their merged chunk. That closure is held to 6 chunks and 110,000 bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the value the seam needs into a leaf module instead of importing the render module that happens to hold it.`,
		);
	}

	return { violations };
}
