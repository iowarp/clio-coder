/**
 * Refuses a `.git` marker at the system temp root or at the run's scratch root.
 *
 * `src/tools/ignore-policy.ts` decides whether fd and ripgrep get
 * `--no-require-git` by walking up from the search path until it finds a `.git`
 * entry. Contract tests that assert the outside-a-repo half of that policy build
 * their scratch with `mkdtemp(join(tmpdir(), ...))`, so the walk climbs through
 * the run's scratch root and then through the real system temp directory. A
 * `.git` at either of those two levels silently flips the answer for every such
 * test, and the failure surfaces somewhere else entirely: the file that created
 * the marker passes, and `tests/contracts/tool-hardening.test.ts` fails minutes
 * later in a different lane. Issue #205 is that failure.
 *
 * Nothing in this repository has any business writing a `.git` at either level.
 * Every legitimate creator writes inside its own `mkdtemp` directory, which is a
 * level below the run root and therefore untouched by this guard. So the guard
 * can be absolute: the first write that targets one of the two guarded paths
 * throws, and the throw's stack names the test file and line that made it.
 *
 * Two vectors are covered, because a `.git` can appear without this process
 * calling `fs` at all:
 *
 *   - In-process writes. The `node:fs` creators are wrapped and throw before the
 *     entry exists. `syncBuiltinESMExports()` republishes the wrappers through
 *     the builtin ES module facades, so a test using `import { mkdirSync } from
 *     "node:fs"` sees the wrapper rather than the original binding.
 *   - Child processes. A spawned `git` or shell cannot be stopped mid-flight, so
 *     each `node:child_process` entry point records whether a guarded path
 *     existed before the spawn and checks again after. A synchronous spawn that
 *     created one throws with the argv and cwd attached; an asynchronous one is
 *     recorded and reported when the process exits.
 *
 * The guard never deletes anything. A `.git` under the system temp root could
 * belong to somebody else on the machine, and a harness that removes it would
 * trade a loud, attributable failure for silent data loss.
 */
import { existsSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);

/** Paths this guard refuses, plus whether each already existed when it was installed. */
interface GuardedPath {
	path: string;
	preexisting: boolean;
}

let guarded: GuardedPath[] = [];

/** Guarded paths a child process created, which cannot be refused before the fact. */
const childOffenders: string[] = [];

let installed = false;

function guardMessage(path: string, cause: string): string {
	return [
		`tests/harness/tmp-git-guard: refused a .git at ${path}`,
		`  created by: ${cause}`,
		"  A .git at the system temp root or at the test run's scratch root makes",
		"  isInsideGitRepo() report every mkdtemp scratch as inside a repository, which",
		"  breaks the ignore-policy contracts in tests/contracts/tool-hardening.test.ts",
		"  from an unrelated test file. Write the marker inside this test's own mkdtemp",
		"  directory instead. See issue #205.",
	].join("\n");
}

/** The guarded path `candidate` falls on, or null. Never throws on odd input. */
function guardedHit(candidate: unknown): string | null {
	let text: string;
	try {
		if (typeof candidate === "string") text = candidate;
		else if (candidate instanceof URL) text = candidate.pathname;
		else if (Buffer.isBuffer(candidate)) text = candidate.toString("utf8");
		else return null;
		if (text.length === 0) return null;
		// Fast path first. Every guarded path ends in `.git`, so a candidate
		// without that substring cannot be one, and this check runs on every
		// filesystem write the suite makes.
		if (!text.includes(".git")) return null;
		const full = resolve(text);
		for (const entry of guarded) {
			if (full === entry.path || full.startsWith(`${entry.path}${sep}`)) return entry.path;
		}
		return null;
	} catch {
		return null;
	}
}

/** Every `node:fs` export that can bring a path into existence. */
const FS_CREATORS = [
	"appendFile",
	"appendFileSync",
	"copyFile",
	"copyFileSync",
	"cp",
	"cpSync",
	"createWriteStream",
	"link",
	"linkSync",
	"mkdir",
	"mkdirSync",
	"open",
	"openSync",
	"rename",
	"renameSync",
	"symlink",
	"symlinkSync",
	"writeFile",
	"writeFileSync",
] as const;

/** The promise-flavored subset, shared by `fs.promises` and `node:fs/promises`. */
const FS_PROMISE_CREATORS = [
	"appendFile",
	"copyFile",
	"cp",
	"link",
	"mkdir",
	"open",
	"rename",
	"symlink",
	"writeFile",
] as const;

/**
 * Creators whose destination is the SECOND argument. Everywhere else the second
 * argument is data, flags, or options, and running the check over it would mean
 * stringifying whole file payloads for nothing.
 */
const DESTINATION_IS_SECOND_ARG = new Set([
	"copyFile",
	"copyFileSync",
	"cp",
	"cpSync",
	"link",
	"linkSync",
	"rename",
	"renameSync",
	"symlink",
	"symlinkSync",
]);

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Move everything hanging off `original` onto `replacement`, then restore the
 * name.
 *
 * `child_process.exec` and `child_process.execFile` carry a
 * `util.promisify.custom` implementation as an own symbol, and `promisify()`
 * prefers it over callback promisification. A wrapper that does not carry the
 * symbol forward silently changes what `promisify(execFile)()` resolves to,
 * which is a whole class of breakage a guard has no business introducing.
 */
function adoptFunctionIdentity(original: AnyFn, replacement: AnyFn, name: string): AnyFn {
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype") continue;
		const descriptor = Object.getOwnPropertyDescriptor(original, key);
		// Forced configurable so wrapPromisified can redefine the one it needs.
		// The builtins ship these non-writable and non-configurable.
		if (descriptor !== undefined) Object.defineProperty(replacement, key, { ...descriptor, configurable: true });
	}
	Object.defineProperty(replacement, "name", { value: name, configurable: true });
	return replacement;
}

function wrapCreators(host: Record<string, unknown>, names: ReadonlyArray<string>, label: string): void {
	for (const name of names) {
		const original = host[name];
		if (typeof original !== "function") continue;
		const destinationIndex = DESTINATION_IS_SECOND_ARG.has(name) ? 1 : 0;
		const guardedCreator = function (this: unknown, ...args: unknown[]): unknown {
			const hit = guardedHit(args[destinationIndex]);
			if (hit !== null) throw new Error(guardMessage(hit, `${label}.${name}()`));
			return (original as AnyFn).apply(this, args);
		};
		host[name] = adoptFunctionIdentity(original as AnyFn, guardedCreator, name);
	}
}

function snapshot(): boolean[] {
	return guarded.map((entry) => existsSync(entry.path));
}

/** Guarded paths that appeared between `before` and now. */
function appearedSince(before: ReadonlyArray<boolean>): string[] {
	const created: string[] = [];
	for (const [index, entry] of guarded.entries()) {
		if (before[index] === false && existsSync(entry.path)) created.push(entry.path);
	}
	return created;
}

function describeSpawn(name: string, args: ReadonlyArray<unknown>): string {
	const command = typeof args[0] === "string" ? args[0] : String(args[0]);
	const argv = Array.isArray(args[1]) ? args[1].map(String).join(" ") : "";
	const options = args.find((value) => typeof value === "object" && value !== null && !Array.isArray(value));
	const cwd = (options as { cwd?: unknown } | undefined)?.cwd;
	return `child_process.${name}(${command} ${argv})${cwd === undefined ? "" : ` cwd=${String(cwd)}`}`;
}

const CP_SYNC = ["execFileSync", "execSync", "spawnSync"] as const;
const CP_ASYNC = ["exec", "execFile", "fork", "spawn"] as const;

function wrapChildProcess(host: Record<string, unknown>): void {
	for (const name of CP_SYNC) {
		const original = host[name];
		if (typeof original !== "function") continue;
		const guardedSpawnSync = function (this: unknown, ...args: unknown[]): unknown {
			const before = snapshot();
			let result: unknown;
			let failure: unknown;
			let failed = false;
			try {
				result = (original as AnyFn).apply(this, args);
			} catch (error) {
				failure = error;
				failed = true;
			}
			const [created] = appearedSince(before);
			// The guarded path wins over the child's own failure: a stray .git
			// poisons every later test in this process, and the child's exit status
			// is recoverable information the message below does not need.
			if (created !== undefined) throw new Error(guardMessage(created, describeSpawn(name, args)));
			if (failed) throw failure;
			return result;
		};
		host[name] = adoptFunctionIdentity(original as AnyFn, guardedSpawnSync, name);
	}
	for (const name of CP_ASYNC) {
		const original = host[name];
		if (typeof original !== "function") continue;
		const guardedSpawn = function (this: unknown, ...args: unknown[]): unknown {
			const before = snapshot();
			const child = (original as AnyFn).apply(this, args);
			const emitter = child as { on?: (event: string, listener: () => void) => unknown };
			if (typeof emitter?.on === "function") {
				emitter.on("close", () => {
					for (const path of appearedSince(before)) {
						childOffenders.push(guardMessage(path, describeSpawn(name, args)));
					}
				});
			}
			return child;
		};
		const wrapped = adoptFunctionIdentity(original as AnyFn, guardedSpawn, name);
		wrapPromisified(name, wrapped);
		host[name] = wrapped;
	}
}

/**
 * Wrap the `util.promisify.custom` implementation `adoptFunctionIdentity` just
 * carried across.
 *
 * `promisify(execFile)` calls that implementation, not the callback form, and it
 * reaches the module-internal spawn without passing through the wrapper above.
 * Left alone it would be the one child-process route the guard cannot see.
 */
function wrapPromisified(name: string, wrapped: AnyFn): void {
	const host = wrapped as unknown as Record<symbol, unknown>;
	const custom = host[promisify.custom];
	if (typeof custom !== "function") return;
	const original = custom as AnyFn;
	// The descriptor carried over from the builtin is non-writable, so this has
	// to be redefined rather than assigned.
	Object.defineProperty(host, promisify.custom, {
		configurable: true,
		enumerable: false,
		writable: false,
		value: function guardedPromisified(this: unknown, ...args: unknown[]): unknown {
			const before = snapshot();
			const refuse = (): void => {
				const [created] = appearedSince(before);
				if (created !== undefined) throw new Error(guardMessage(created, describeSpawn(name, args)));
			};
			return Promise.resolve(original.apply(this, args)).then(
				(value) => {
					refuse();
					return value;
				},
				(error: unknown) => {
					refuse();
					throw error;
				},
			);
		},
	});
}

export interface TmpGitGuardOptions {
	/** The real system temp directory, read before TMPDIR is repointed at the run root. */
	systemTmp: string;
	/** This run's scratch root, if one was established. */
	runRoot?: string | undefined;
}

/**
 * Wrap the filesystem and child-process creators and report at exit.
 *
 * Idempotent: the preload that calls this runs once per process, but a stray
 * second call must not stack a second layer of wrappers on the first.
 */
export function installTmpGitGuard(options: TmpGitGuardOptions): void {
	if (installed) return;
	installed = true;

	const paths = [join(resolve(options.systemTmp), ".git")];
	if (options.runRoot !== undefined && options.runRoot.length > 0) {
		paths.push(join(resolve(options.runRoot), ".git"));
	}
	guarded = paths.map((path) => ({ path, preexisting: existsSync(path) }));

	for (const entry of guarded) {
		if (!entry.preexisting) continue;
		// Not this run's doing, so not this run's failure. It still breaks the
		// ignore-policy contracts, and saying so here turns a baffling assertion
		// message in tool-hardening into a one-line explanation.
		process.stderr.write(
			`tests/harness/tmp-git-guard: ${entry.path} already exists. It was not created by this run, ` +
				"but it makes every mkdtemp scratch look like it sits inside a git repository and will fail " +
				"the ignore-policy contracts in tests/contracts/tool-hardening.test.ts. Remove it. See issue #205.\n",
		);
	}

	const fs = require("node:fs") as Record<string, unknown>;
	wrapCreators(fs, FS_CREATORS, "fs");
	wrapCreators(fs.promises as Record<string, unknown>, FS_PROMISE_CREATORS, "fs.promises");
	wrapChildProcess(require("node:child_process") as Record<string, unknown>);
	// Builtin ES module facades snapshot their named exports when they are first
	// linked, so `import { mkdirSync } from "node:fs"` would otherwise keep the
	// original binding. This republishes the wrappers through every facade.
	syncBuiltinESMExports();

	process.on("exit", () => {
		const messages = [...childOffenders];
		for (const entry of guarded) {
			if (entry.preexisting || existsSync(entry.path) === false) continue;
			if (messages.some((message) => message.includes(entry.path))) continue;
			messages.push(guardMessage(entry.path, "an unattributed writer outside this process"));
		}
		if (messages.length === 0) return;
		process.stderr.write(`${messages.join("\n")}\n`);
		process.exitCode = process.exitCode === 0 || process.exitCode === undefined ? 1 : process.exitCode;
	});
}
