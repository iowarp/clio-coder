import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { buildSafeToolEnv, resolveSafeCwd, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
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
	interpreter?: string;
}

export interface VerifierAvailability {
	state: "needs-provisioning" | "unavailable";
	reason: string;
	provisionCommand?: string[];
}

export interface RawProposal {
	preferredId: string;
	description: string;
	command: string[];
	cwd: string;
	timeoutMs: number;
	tags: string[];
	provenance: VerifierProvenance;
	availability?: VerifierAvailability;
}

export const DECLARED_FILE_CAP_BYTES = 1024 * 1024;

export type RegularFileRead =
	| { ok: true; text: string }
	| { ok: false; reason: "not-regular" }
	| { ok: false; reason: "too-large"; size: number };

/**
 * Read a file only if it is a regular file under the cap. The open is
 * nonblocking and the type check runs on the open descriptor, so a FIFO named
 * Makefile is refused at once instead of blocking the event loop in a read
 * that no writer will ever end, past any timeout_ms the caller gave. Throws
 * only for an operating-system error; the caller words a refusal.
 */
export function readRegularFileText(filePath: string, capBytes: number): RegularFileRead {
	const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) return { ok: false, reason: "not-regular" };
		if (stats.size > capBytes) return { ok: false, reason: "too-large", size: stats.size };
		return { ok: true, text: readFileSync(fd, "utf8") };
	} finally {
		closeSync(fd);
	}
}

function declaredFileText(filePath: string): string {
	const read = readRegularFileText(filePath, DECLARED_FILE_CAP_BYTES);
	if (read.ok) return read.text;
	if (read.reason === "not-regular") throw new Error("path is not a regular file");
	throw new Error(`file exceeds the ${DECLARED_FILE_CAP_BYTES}-byte discovery cap`);
}

export function regularFileText(filePath: string, workspaceRoot: string): string | null | Error {
	if (!existsSync(filePath)) return null;
	try {
		const realRoot = realpathSync(workspaceRoot);
		const realFilePath = realpathSync(filePath);
		try {
			resolveSafeCwd(realFilePath, realRoot);
		} catch {
			return new Error(`resolves outside the workspace root to ${realFilePath}`);
		}
		return declaredFileText(realFilePath);
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
 * suite against the wrong interpreter or gave up on it. Once the environment
 * exists the runner adds `--no-sync`: a bare `uv run` may provision
 * dependencies first, so #377 admits uv-launched pytest only with that flag,
 * and without it every non-interactive worker was denied its own test check.
 */
function pythonLauncher(workspaceRoot: string): string[] {
	if (!existsSync(path.join(workspaceRoot, "uv.lock"))) return [];
	return existsSync(path.join(workspaceRoot, ".venv")) ? ["uv", "run", "--no-sync"] : ["uv", "run"];
}

/** DF-11: safe-exec preserves this PATH inside the worker sandbox; resolve once, without executing a probe. */
function pythonInterpreter(workspaceRoot: string, launcher: string[]): string | null {
	if (launcher.length > 0) return "python";
	if (existsSync(path.join(workspaceRoot, ".venv"))) {
		return process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
	}
	if (process.env.VIRTUAL_ENV) {
		return path.join(process.env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	}
	const env = buildSafeToolEnv();
	for (const name of ["python", "python3"]) {
		for (const directory of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
			const candidate = path.resolve(workspaceRoot, directory, process.platform === "win32" ? `${name}.exe` : name);
			try {
				if (!statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return name;
			} catch {
				// Missing or non-executable candidates do not resolve this interpreter.
			}
		}
	}
	return null;
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
	const resolvedInterpreter = pythonInterpreter(workspaceRoot, launcher);
	const interpreter = resolvedInterpreter ?? "python";
	const availability: VerifierAvailability | undefined =
		launcher.length === 2
			? {
					state: "needs-provisioning",
					reason: "uv.lock exists but .venv is missing; bare uv run would sync dependencies under a no-install policy",
					provisionCommand: ["uv", "sync"],
				}
			: resolvedInterpreter === null
				? { state: "unavailable", reason: "neither python nor python3 is executable on the worker PATH" }
				: undefined;
	const finish = (): RawProposal[] =>
		proposals.map((proposal) => ({
			...proposal,
			provenance: { ...proposal.provenance, ...(resolvedInterpreter ? { interpreter: resolvedInterpreter } : {}) },
			...(availability ? { availability } : {}),
		}));
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
					command: [...launcher, interpreter, "-m", module],
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
			command: [...launcher, interpreter, "-m", module],
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
	if (proposals.some((proposal) => proposal.preferredId === "python-pytest")) return finish();
	const conftest = ["conftest.py", "tests/conftest.py", "test/conftest.py"].find((relative) =>
		existsSync(path.join(workspaceRoot, relative)),
	);
	if (pytestDependency || conftest !== undefined) {
		proposals.push({
			preferredId: "python-pytest",
			description: "Run the pytest suite the project depends on",
			command: [...launcher, interpreter, "-m", "pytest"],
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
		return finish();
	}
	const start = unittestStartDirectory(workspaceRoot);
	if (start !== null) {
		proposals.push({
			preferredId: "python-unittest",
			description: `Run the standard-library unittest suite under ${start}/`,
			command: [...launcher, interpreter, "-m", "unittest", "discover", "-s", start],
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
	return finish();
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

export { shellLikeArgv } from "../../core/shell-argv.js";

export interface DeclaredProjectEntry {
	id: string;
	command: string[];
	path: string;
	detail: string;
	kind: "package-script" | "just-recipe" | "make-target";
}

/**
 * Discover every exact project-declared entry without promoting it to a
 * verifier check. A declaration file that exists but cannot be used (outside
 * the workspace through a link, not a regular file, over the cap, malformed)
 * goes to diagnostics as '<file>: <reason>' instead of vanishing.
 */
export function discoverDeclaredProjectEntriesAtRoot(
	workspaceRoot: string,
	diagnostics: string[] = [],
): DeclaredProjectEntry[] {
	const entries: DeclaredProjectEntry[] = [];
	const packageText = regularFileText(path.join(workspaceRoot, "package.json"), workspaceRoot);
	if (packageText instanceof Error) {
		diagnostics.push(`package.json: ${packageText.message}; package script discovery skipped.`);
	} else if (packageText !== null) {
		const pkg = parsePackageJsonText(packageText);
		if (!pkg.ok && pkg.reason !== PACKAGE_JSON_NO_SCRIPTS) {
			diagnostics.push(`package.json: ${pkg.reason}; package script discovery skipped.`);
		}
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
	entries.push(...discoverTaskRunnerEntriesAtRoot(workspaceRoot, diagnostics));
	return entries;
}

/** The justfile recipes and Makefile targets of discoverDeclaredProjectEntriesAtRoot alone. */
export function discoverTaskRunnerEntriesAtRoot(workspaceRoot: string, diagnostics: string[]): DeclaredProjectEntry[] {
	const entries: DeclaredProjectEntry[] = [];
	for (const relative of ["justfile", "Justfile"] as const) {
		const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
		if (text === null) continue;
		// just reads the first of these it finds, so an unusable one ends the search.
		if (text instanceof Error) {
			diagnostics.push(`${relative}: ${text.message}; just recipe discovery skipped.`);
			break;
		}
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
	const text = regularFileText(path.join(workspaceRoot, "Makefile"), workspaceRoot);
	if (text instanceof Error) diagnostics.push(`Makefile: ${text.message}; make target discovery skipped.`);
	if (typeof text === "string") {
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

type PackageJsonParse = { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string };

/** A package.json without scripts is ordinary, not a defect worth a diagnostic. */
export const PACKAGE_JSON_NO_SCRIPTS = "package.json has no scripts object";

function parsePackageJsonText(text: string): PackageJsonParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "package.json root must be an object" };
	}
	const scripts = (parsed as Record<string, unknown>).scripts;
	if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
		return { ok: false, reason: PACKAGE_JSON_NO_SCRIPTS };
	}
	return { ok: true, scripts: scripts as Record<string, unknown> };
}

/** Contained like every other declaration read, so a package.json symlinked outside the workspace is never parsed. */
export function parsePackageJson(packagePath: string, workspaceRoot: string): PackageJsonParse {
	const text = regularFileText(packagePath, workspaceRoot);
	if (text === null) return { ok: false, reason: "file not found" };
	if (text instanceof Error) return { ok: false, reason: text.message };
	return parsePackageJsonText(text);
}
