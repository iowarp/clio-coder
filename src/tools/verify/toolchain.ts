import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { parseTomlDocument, tomlTableAt } from "../../core/toml.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";

/**
 * Readers for the toolchain declarations a repository carries: Cargo, CMake
 * presets, Python runners and Go modules. Verifier authoring turns their
 * proposals into catalog entries after confirmation; the verify tool offers
 * the same proposals as checks it can run, so both read a repository the same
 * way. The module stays free of the verify tool itself so the safety policy
 * engine can resolve a verify call without loading it.
 */

export type VerifierProposalAuthority = "project-declared" | "toolchain-defined";

export type VerifierSignalKind =
	| "package-script"
	| "project-catalog"
	| "cargo"
	| "cmake-preset"
	| "python-runner"
	| "just-recipe"
	| "make-target"
	| "go-module"
	| "validation-contract"
	| "ci-step"
	| "manual-entry";

export interface VerifierProvenance {
	kind: VerifierSignalKind;
	path: string;
	detail: string;
	authority: VerifierProposalAuthority;
}

export interface RawProposal {
	preferredId: string;
	description: string;
	command: string[];
	cwd: string;
	timeoutMs: number;
	tags: string[];
	provenance: VerifierProvenance;
}

export const DECLARED_FILE_CAP_BYTES = 1024 * 1024;

export function regularFileText(filePath: string, workspaceRoot: string): string | null | Error {
	if (!existsSync(filePath)) return null;
	try {
		const realRoot = realpathSync(workspaceRoot);
		const realFilePath = realpathSync(filePath);
		resolveSafeCwd(realFilePath, realRoot);
		const stats = statSync(realFilePath);
		if (!stats.isFile()) return new Error("path is not a regular file");
		if (stats.size > DECLARED_FILE_CAP_BYTES) {
			return new Error(`file exceeds the ${DECLARED_FILE_CAP_BYTES}-byte discovery cap`);
		}
		return readFileSync(realFilePath, "utf8");
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

export function slug(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9._:-]+/gu, "-")
		.replace(/^[^a-z0-9]+/u, "")
		.replace(/[-.:]+$/u, "");
	return normalized.length > 0 ? normalized : fallback;
}

export function cargoProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "Cargo.toml";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; Cargo discovery skipped.`);
		return [];
	}
	const document = parseTomlDocument(text);
	if (document === null) {
		diagnostics.push(`${relative}: invalid TOML; Cargo discovery skipped.`);
		return [];
	}
	const workspace = tomlTableAt(document, ["workspace"]) !== null;
	const packageManifest = tomlTableAt(document, ["package"]) !== null;
	if (!workspace && !packageManifest) {
		diagnostics.push(`${relative}: no [package] or [workspace] declaration was found; Cargo discovery skipped.`);
		return [];
	}
	return [
		{
			preferredId: "cargo-test",
			description: workspace ? "Run the Cargo workspace tests" : "Run the Cargo package tests",
			command: workspace ? ["cargo", "test", "--workspace"] : ["cargo", "test"],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["rust", "test"],
			provenance: {
				kind: "cargo",
				path: relative,
				detail: workspace ? "Cargo [workspace] manifest" : "Cargo package manifest",
				authority: "toolchain-defined",
			},
		},
	];
}

export function cmakeProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "CMakePresets.json";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; CMake preset discovery skipped.`);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		diagnostics.push(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
		return [];
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		diagnostics.push(`${relative}: root is not an object; CMake preset discovery skipped.`);
		return [];
	}
	const record = parsed as Record<string, unknown>;
	const proposals: RawProposal[] = [];
	for (const [field, executable, args, label, tag] of [
		["testPresets", "ctest", ["--preset"], "test", "test"],
		["buildPresets", "cmake", ["--build", "--preset"], "build", "build"],
	] as const) {
		const presets = record[field];
		if (!Array.isArray(presets)) continue;
		for (const preset of presets) {
			if (preset === null || typeof preset !== "object" || Array.isArray(preset)) continue;
			const value = preset as Record<string, unknown>;
			if (value.hidden === true || typeof value.name !== "string" || value.name.length === 0) continue;
			const name = value.name;
			proposals.push({
				preferredId: `cmake-${label}-${slug(name, "preset")}`,
				description: `Run CMake ${label} preset '${name}'`,
				command: [executable, ...args, name],
				cwd: ".",
				timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
				tags: ["cmake", tag],
				provenance: {
					kind: "cmake-preset",
					path: relative,
					detail: `${field} entry '${name}'`,
					authority: "toolchain-defined",
				},
			});
		}
	}
	if (proposals.length === 0) diagnostics.push(`${relative}: no visible buildPresets or testPresets were declared.`);
	return proposals;
}

/**
 * How the project launches Python. A uv project keeps its dependencies in a
 * project environment that a bare `python` on PATH does not see, so every
 * runner goes through `uv run`; agents in uv repositories otherwise ran the
 * suite against the wrong interpreter or gave up on it.
 */
function pythonLauncher(workspaceRoot: string): string[] {
	return existsSync(path.join(workspaceRoot, "uv.lock")) ? ["uv", "run"] : [];
}

const PYTEST_REQUIREMENT_RE = /^\s*pytest(?![\w.-])/u;

/** Whether any dependency list pyproject.toml declares names pytest itself. */
function declaresPytestDependency(document: NonNullable<ReturnType<typeof parseTomlDocument>>): boolean {
	const lists: unknown[] = [];
	const project = tomlTableAt(document, ["project"]);
	if (project !== null) lists.push(project.dependencies);
	for (const table of [
		tomlTableAt(document, ["project", "optional-dependencies"]),
		tomlTableAt(document, ["dependency-groups"]),
	]) {
		if (table !== null) lists.push(...Object.values(table));
	}
	if (
		lists.some(
			(list) =>
				Array.isArray(list) && list.some((entry) => typeof entry === "string" && PYTEST_REQUIREMENT_RE.test(entry)),
		)
	) {
		return true;
	}
	const poetry = [
		tomlTableAt(document, ["tool", "poetry", "dev-dependencies"]),
		tomlTableAt(document, ["tool", "poetry", "dependencies"]),
	];
	const groups = tomlTableAt(document, ["tool", "poetry", "group"]);
	if (groups !== null) {
		for (const name of Object.keys(groups))
			poetry.push(tomlTableAt(document, ["tool", "poetry", "group", name, "dependencies"]));
	}
	return poetry.some((table) => table !== null && Object.hasOwn(table, "pytest"));
}

/** The first conventional test directory holding `test*.py` or `*_test.py` modules. */
function unittestStartDirectory(workspaceRoot: string): string | null {
	for (const directory of ["tests", "test"]) {
		try {
			if (readdirSync(path.join(workspaceRoot, directory)).some((name) => /^test.*\.py$|_test\.py$/u.test(name))) {
				return directory;
			}
		} catch {
			// A missing directory is simply not a test directory.
		}
	}
	return null;
}

export function pythonProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const proposals: RawProposal[] = [];
	const launcher = pythonLauncher(workspaceRoot);
	let pytestDependency = false;
	const pyprojectPath = "pyproject.toml";
	const pyproject = regularFileText(path.join(workspaceRoot, pyprojectPath), workspaceRoot);
	if (pyproject instanceof Error) diagnostics.push(`${pyprojectPath}: ${pyproject.message}; Python discovery skipped.`);
	if (typeof pyproject === "string") {
		const document = parseTomlDocument(pyproject);
		if (document === null) {
			diagnostics.push(`${pyprojectPath}: invalid TOML; Python discovery skipped.`);
		} else {
			for (const [path, section, module, id, description, tags] of [
				[
					["tool", "pytest", "ini_options"],
					"tool.pytest.ini_options",
					"pytest",
					"python-pytest",
					"Run the declared pytest suite",
					["python", "test"],
				],
				[["tool", "tox"], "tool.tox", "tox", "python-tox", "Run the declared tox environments", ["python", "test"]],
				[["tool", "nox"], "tool.nox", "nox", "python-nox", "Run the declared nox sessions", ["python", "test"]],
			] as const) {
				if (tomlTableAt(document, path) === null) continue;
				proposals.push({
					preferredId: id,
					description,
					command: [...launcher, "python", "-m", module],
					cwd: ".",
					timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
					tags: [...tags],
					provenance: {
						kind: "python-runner",
						path: pyprojectPath,
						detail: `[${section}]`,
						authority: "toolchain-defined",
					},
				});
			}
			for (const [path, section] of [
				[["project", "scripts"], "project.scripts"],
				[["tool", "poetry", "scripts"], "tool.poetry.scripts"],
			] as const) {
				const scripts = tomlTableAt(document, path);
				if (scripts === null) continue;
				for (const [name, target] of Object.entries(scripts)) {
					if (typeof target !== "string" || !isVerificationScriptName(name)) continue;
					proposals.push({
						preferredId: `python-${slug(name, "check")}`,
						description: `Run declared Python entry point '${name}'`,
						command: [...launcher, name],
						cwd: ".",
						timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
						tags: [slug(name.split(/[:.-]/u)[0] ?? "python", "python"), "python"],
						provenance: {
							kind: "python-runner",
							path: pyprojectPath,
							detail: `[${section}] entry '${name}'`,
							authority: "project-declared",
						},
					});
				}
			}
			pytestDependency = declaresPytestDependency(document);
		}
	}

	for (const [relative, marker, module, id, description] of [
		["pytest.ini", null, "pytest", "python-pytest", "Run the declared pytest suite"],
		["tox.ini", null, "tox", "python-tox", "Run the declared tox environments"],
		["noxfile.py", null, "nox", "python-nox", "Run the declared nox sessions"],
		["setup.cfg", /^\s*\[tool:pytest\]/mu, "pytest", "python-pytest", "Run the declared pytest suite"],
	] as const) {
		const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
		if (text === null) continue;
		if (text instanceof Error) {
			diagnostics.push(`${relative}: ${text.message}; Python discovery skipped.`);
			continue;
		}
		if (marker !== null && !marker.test(text)) continue;
		proposals.push({
			preferredId: id,
			description,
			command: [...launcher, "python", "-m", module],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["python", "test"],
			provenance: {
				kind: "python-runner",
				path: relative,
				detail: `${module} configuration file`,
				authority: "toolchain-defined",
			},
		});
	}
	if (proposals.some((proposal) => proposal.preferredId === "python-pytest")) return proposals;
	const conftest = ["conftest.py", "tests/conftest.py", "test/conftest.py"].find((relative) =>
		existsSync(path.join(workspaceRoot, relative)),
	);
	if (pytestDependency || conftest !== undefined) {
		proposals.push({
			preferredId: "python-pytest",
			description: "Run the pytest suite the project depends on",
			command: [...launcher, "python", "-m", "pytest"],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["python", "test"],
			provenance: {
				kind: "python-runner",
				path: conftest ?? pyprojectPath,
				detail: conftest !== undefined ? "pytest conftest.py" : "pytest dependency",
				authority: "toolchain-defined",
			},
		});
		return proposals;
	}
	const start = unittestStartDirectory(workspaceRoot);
	if (start !== null) {
		proposals.push({
			preferredId: "python-unittest",
			description: `Run the standard-library unittest suite under ${start}/`,
			command: [...launcher, "python", "-m", "unittest", "discover", "-s", start],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["python", "test"],
			provenance: {
				kind: "python-runner",
				path: start,
				detail: "test modules with no pytest configuration or dependency",
				authority: "toolchain-defined",
			},
		});
	}
	return proposals;
}

export function goProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "go.mod";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; Go discovery skipped.`);
		return [];
	}
	if (!/^\s*module\s+\S+/mu.test(text)) {
		diagnostics.push(`${relative}: no module directive was found; Go discovery skipped.`);
		return [];
	}
	return [
		{
			preferredId: "go-test",
			description: "Run all Go module tests",
			command: ["go", "test", "./..."],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["go", "test"],
			provenance: {
				kind: "go-module",
				path: relative,
				detail: "Go module directive",
				authority: "toolchain-defined",
			},
		},
	];
}

export function shellLikeArgv(command: string): string[] | Error {
	const argv: string[] = [];
	let token = "";
	let quote: "single" | "double" | null = null;
	let tokenStarted = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (quote === "single") {
			if (character === "'") quote = null;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = null;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === undefined) return new Error("trailing escape");
				token += next;
				index += 1;
			} else if (character === "$" || character === "`") {
				return new Error(`shell expansion '${character}' is ambiguous`);
			} else {
				token += character;
			}
			tokenStarted = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (tokenStarted) {
				argv.push(token);
				token = "";
				tokenStarted = false;
			}
			continue;
		}
		if (character === "'") {
			quote = "single";
			tokenStarted = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			tokenStarted = true;
			continue;
		}
		if (character === "\\") {
			const next = command[index + 1];
			if (next === undefined) return new Error("trailing escape");
			token += next;
			tokenStarted = true;
			index += 1;
			continue;
		}
		if ("|&;<>()`$\n\r".includes(character)) {
			return new Error(`shell operator or expansion '${character}' is ambiguous`);
		}
		token += character;
		tokenStarted = true;
	}
	if (quote !== null) return new Error(`unterminated ${quote}-quoted argument`);
	if (tokenStarted) argv.push(token);
	if (argv.length === 0) return new Error("empty command");
	if ((argv[0] ?? "").includes("=")) return new Error("environment assignments are not argv executables");
	return argv;
}

export interface DeclaredProjectEntry {
	id: string;
	command: string[];
	path: string;
	detail: string;
	kind: "package-script" | "just-recipe" | "make-target";
}

/** Discover every exact project-declared entry without promoting it to a verifier check. */
export function discoverDeclaredProjectEntriesAtRoot(workspaceRoot: string): DeclaredProjectEntry[] {
	const entries: DeclaredProjectEntry[] = [];
	const packagePath = path.join(workspaceRoot, "package.json");
	if (existsSync(packagePath)) {
		const pkg = parsePackageJson(packagePath);
		if (pkg.ok) {
			for (const name of Object.keys(pkg.scripts).sort()) {
				if (typeof pkg.scripts[name] !== "string") continue;
				entries.push({
					id: name,
					command: ["npm", "run", name],
					path: "package.json",
					detail: `package.json script '${name}'`,
					kind: "package-script",
				});
			}
		}
	}
	for (const relative of ["justfile", "Justfile"] as const) {
		const filePath = path.join(workspaceRoot, relative);
		if (!existsSync(filePath)) continue;
		const text = readFileSync(filePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:[^:=\n]*)?:\s*(?:#.*)?$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith("_")) continue;
			entries.push({
				id: name,
				command: ["just", name],
				path: relative,
				detail: `just recipe '${name}'`,
				kind: "just-recipe",
			});
		}
		break;
	}
	const makePath = path.join(workspaceRoot, "Makefile");
	if (existsSync(makePath)) {
		const text = readFileSync(makePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=])[^\n]*$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith(".")) continue;
			entries.push({
				id: name,
				command: ["make", name],
				path: "Makefile",
				detail: `Makefile target '${name}'`,
				kind: "make-target",
			});
		}
	}
	return entries;
}

export function parsePackageJson(
	packagePath: string,
): { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string } {
	try {
		const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: "package.json root must be an object" };
		}
		const scripts = (parsed as Record<string, unknown>).scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
			return { ok: false, reason: "package.json has no scripts object" };
		}
		return { ok: true, scripts: scripts as Record<string, unknown> };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
