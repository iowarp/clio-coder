import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ClioSettings } from "../../core/config.js";
import { internalGitArgv } from "../../core/internal-git.js";
import { PATH_BOUNDARY_MAX_ENTRIES, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { sandboxEnvPolicy } from "../../core/sandbox/env-scrub.js";
import { buildSandboxInvocation } from "../../core/sandbox/invocation.js";
import { type MainSandboxPolicy, mainSandboxPolicy, mainShellContained } from "../../core/sandbox/main-session.js";
import { withMountAliases } from "../../core/sandbox/mount-aliases.js";
import { discoverSecretMasks } from "../../core/sandbox/secret-files.js";
import type { SandboxMode } from "../../core/sandbox/types.js";
import { unixSocketLaunch } from "../../core/sandbox/unix-sockets.js";
import { settingsFileMasks, workerSandboxMasks } from "../../core/sandbox/worker-process.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { taskWorktreeManifestsChanged } from "../../tools/task-worktree.js";
import { renderReproduceReport } from "../../tools/verify/reproduce.js";
import { runReproduce } from "../../tools/verify/reproduce-run.js";
import { JUDGED_CHECK_MAX_OUTPUT_BYTES, judgeNumericTexts, judgePerfTexts } from "../../tools/verify/scripts.js";
import { PLAYBOOK_COMMAND_BASE_ENV, type PlaybookCommand } from "../agents/playbook-commands.js";
import { redactCommandOutputSecrets } from "../evidence/redact.js";
import { effectiveScratchRoots } from "../safety/scratch-roots.js";
import { CODE_STEP_CAPTURE_MAX_BYTES, runCodeStep } from "./code-step.js";
import type { DispatchRequest } from "./contract.js";
import { BASE_PREFLIGHT_EXIT, BASE_PREFLIGHT_SCRIPT, baseModulesLinks } from "./host-verification-base.js";
import { hostCheckBaseNote } from "./host-verification-note.js";
import type { RunHostVerification, RunHostVerificationAttribution, RunHostVerificationCheck } from "./types.js";
import { type VerificationSlotEvents, withVerificationSlot } from "./verification-slot.js";
import { captureWorkspaceSnapshot } from "./write-boundary.js";

const OUTPUT_TAIL_BYTES = 2_048;
const MEMO_VERSION = 3;

type ResolvedCheck = NonNullable<DispatchRequest["resolvedVerification"]>[number];

const HTTP_URL_RE = /\bhttps?:\/\/\S+/gu;
/**
 * Path-like tokens a failing check named. A separator and a source or document
 * extension are both required, which is the grammar `path-scope.ts:302` already
 * uses to decide which prose tokens read as repository paths; without the
 * extension list `10/20 passing` and `v1.2.3` become implicated files. Probed
 * against node:test, tsc, and stack-trace output: relative, absolute, and
 * `./`-prefixed forms all match and stop at a trailing `:line:col`.
 */
const CHECK_OUTPUT_PATH_RE =
	/\/?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]*\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|py|go|rs|c|h|cc|cpp|hpp|java|rb|sh|toml|css|html|sql)\b/gu;
/** Implicated paths recorded on a receipt, matching the intent path-list cap. */
const IMPLICATED_PATH_CAP = PATH_BOUNDARY_MAX_ENTRIES;

interface MemoEntry {
	key: string;
	runId: string;
	check: RunHostVerificationCheck;
}

interface MemoFile {
	version: typeof MEMO_VERSION;
	entries: MemoEntry[];
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function outputTail(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= OUTPUT_TAIL_BYTES) return value;
	let text = bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
	while (Buffer.byteLength(text, "utf8") > OUTPUT_TAIL_BYTES) text = text.slice(1);
	return text;
}

function repositoryRoot(cwd: string): string {
	return execFileSync("git", internalGitArgv(["-C", cwd, "rev-parse", "--show-toplevel"]), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

/** The checkout a check judged: its root, HEAD, and a digest of HEAD plus working-tree content. */
function checkedTree(cwd: string): { root: string; head: string; fingerprint: string } | null {
	try {
		const snapshot = captureWorkspaceSnapshot(repositoryRoot(cwd));
		const fingerprint = sha256(
			JSON.stringify({
				head: snapshot.head,
				entries: [...snapshot.entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			}),
		);
		return { root: snapshot.root, head: snapshot.head, fingerprint };
	} catch {
		return null;
	}
}

export function workspaceFingerprint(cwd: string): string | null {
	return checkedTree(cwd)?.fingerprint ?? null;
}

function memoPath(stateDir: string): string {
	return join(stateDir, "dispatch-verification-memo.json");
}

function readMemo(stateDir: string): MemoFile {
	const target = memoPath(stateDir);
	if (!existsSync(target)) return { version: MEMO_VERSION, entries: [] };
	try {
		const parsed = JSON.parse(readFileSync(target, "utf8")) as MemoFile;
		if (parsed.version === MEMO_VERSION && Array.isArray(parsed.entries)) return parsed;
	} catch {
		// A damaged cache is a miss. Receipts remain the authoritative evidence.
	}
	return { version: MEMO_VERSION, entries: [] };
}

function writeMemo(stateDir: string, memo: MemoFile): void {
	const target = memoPath(stateDir);
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(memo, null, 2), "utf8");
	renameSync(temporary, target);
}

function storeMemoEntry(stateDir: string, entry: MemoEntry): void {
	const target = memoPath(stateDir);
	withStateFileLockSync(target, () => {
		const memo = readMemo(stateDir);
		memo.entries = [entry, ...memo.entries.filter((candidate) => candidate.key !== entry.key)].slice(0, 512);
		writeMemo(stateDir, memo);
	});
}

function memoKey(command: PlaybookCommand, judgment: string, fingerprint: string, env: NodeJS.ProcessEnv): string {
	const names = [...PLAYBOOK_COMMAND_BASE_ENV, ...command.env];
	const values = Object.fromEntries(names.map((name) => [name, env[name] ?? null]));
	return sha256(JSON.stringify({ fingerprint, judgment, env: values }));
}

/**
 * Per-task scoping of lint and format checks.
 *
 * A declared command check is a lint or format check when its command runs a
 * known file-taking linter or formatter (biome, eslint, prettier, ruff, black,
 * stylelint) directly, through `npx`/`bunx`, or through `pnpm|npm|yarn exec`;
 * or when it is exactly `pnpm run <script>` or `npm run <script>` and the
 * package.json script is a single such command with no shell operators,
 * quoting or globs (`biome check .`, not `biome check . && tsc`). The declared
 * id is not used: a name says nothing about how the command takes paths.
 *
 * For a task with a task worktree, such a check runs on the files the task
 * changed relative to its base commit (`git diff <base>` plus untracked files),
 * limited to those under the check's cwd: bare `.` path arguments are dropped
 * and each changed file is appended as `./<path>` (biome also gets
 * `--no-errors-on-unmatched`). A task that changed no such file passes the check
 * without running it. Every other check, typecheck included, runs whole-repo as
 * declared, and a whole-repo check takes the machine's verification slot (see
 * src/domains/dispatch/verification-slot.ts) while a scoped one does not.
 */
const LINT_FORMAT_TOOLS = new Set(["biome", "eslint", "prettier", "ruff", "black", "stylelint"]);
const SCRIPT_UNSAFE_RE = /[&|;<>`$()'"\\\n*?{}]/u;
const SCOPED_PATHS_MAX = 1_000;
/** Scoped checks whose task changed no file under them; they pass without running. */
const nothingChanged = new WeakSet<ResolvedCheck>();
/** Checks narrowed to a task's changed files; they run without the verification slot. */
const scopedToTask = new WeakSet<ResolvedCheck>();

/** Index of the linter or formatter in `argv`, or -1. */
function lintFormatToolIndex(argv: ReadonlyArray<string>): number {
	const head = basename(argv[0] ?? "");
	let index = 0;
	if (head === "npx" || head === "bunx") index = 1;
	else if ((head === "pnpm" || head === "npm" || head === "yarn") && argv[1] === "exec") index = 2;
	while (index > 0 && argv[index]?.startsWith("-") === true) index += 1;
	const tool = argv[index];
	return tool !== undefined && LINT_FORMAT_TOOLS.has(basename(tool)) ? index : -1;
}

/** The command a lint or format check runs when it can take paths, or null when it is not one. */
export function lintFormatScopeArgv(check: Pick<ResolvedCheck, "argv" | "cwd" | "kind">): string[] | null {
	if (check.kind !== undefined && check.kind !== "command") return null;
	if (lintFormatToolIndex(check.argv) >= 0) return [...check.argv];
	const [runner, verb, name, ...rest] = check.argv;
	const runnerName = basename(runner ?? "");
	if (runner === undefined || (runnerName !== "pnpm" && runnerName !== "npm") || verb !== "run") return null;
	if (name === undefined || rest.length > 0) return null;
	const segments = lintScriptSegments(check.cwd, name);
	if (segments === null) return null;
	return [runner, "exec", ...(runnerName === "npm" ? ["--"] : []), ...(segments[0] ?? [])];
}

/**
 * A package script's `&&`-joined commands as token lists when its first command
 * runs a known linter or formatter, else null. `biome check . && node --import
 * tsx scripts/check-hygiene.ts` yields the Biome run and the hygiene check.
 */
function lintScriptSegments(cwd: string, name: string): string[][] | null {
	let script: unknown;
	try {
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		script = manifest.scripts?.[name];
	} catch {
		return null;
	}
	if (typeof script !== "string") return null;
	const parts = script.split("&&").map((part) => part.trim());
	if (parts.some((part) => part === "" || SCRIPT_UNSAFE_RE.test(part))) return null;
	const segments = parts.map((part) => part.split(/\s+/u));
	if (!LINT_FORMAT_TOOLS.has(segments[0]?.[0] ?? "")) return null;
	return segments;
}

/**
 * The whole-repo commands a package lint script runs after its linter, such
 * as the repository hygiene check, as checks of their own. Scoping narrows the
 * linter to the task's files; these still run on the whole task worktree and
 * are compared with the base like any whole-repo check.
 */
export function lintScriptFollowUpChecks(check: ResolvedCheck): ResolvedCheck[] {
	if (check.kind !== undefined && check.kind !== "command") return [];
	const [runner, verb, name, ...rest] = check.argv;
	const runnerName = basename(runner ?? "");
	if ((runnerName !== "pnpm" && runnerName !== "npm") || verb !== "run" || name === undefined || rest.length > 0)
		return [];
	const segments = lintScriptSegments(check.cwd, name);
	return (segments ?? []).slice(1).map((argv) => ({ ...check, check: `${check.check}: ${argv.join(" ")}`, argv }));
}

/** Absolute paths of the files a task worktree changed against its base, or null when Git cannot say. */
function taskChangedPaths(worktree: { path: string; base: string }): string[] | null {
	const git = (args: string[]) =>
		execFileSync("git", internalGitArgv(["-C", worktree.path, ...args]), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	try {
		const names = [
			...git(["diff", "--name-only", "--no-renames", "-z", worktree.base, "--"]).split("\0"),
			...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
		];
		const paths = new Set<string>();
		for (const name of names) {
			if (name === "") continue;
			const path = resolve(worktree.path, name);
			// A deleted file has nothing left to lint.
			if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) paths.add(path);
		}
		return [...paths].sort();
	} catch {
		return null;
	}
}

/** The check to run for this task: a lint or format check narrowed to `changed`, else the check as declared. */
function scopeCheckToTask(check: ResolvedCheck, changed: ReadonlyArray<string> | null): ResolvedCheck {
	if (changed === null) return check;
	const argv = lintFormatScopeArgv(check);
	if (argv === null) return check;
	const inside = changed.flatMap((path) => {
		const rel = relative(check.cwd, path);
		return rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? [] : [`./${rel}`];
	});
	if (inside.length > SCOPED_PATHS_MAX) return check;
	if (inside.length === 0) {
		const scoped = { ...check, argv: [...check.argv] };
		nothingChanged.add(scoped);
		return scoped;
	}
	const toolIndex = lintFormatToolIndex(argv);
	const scopedArgv = argv.filter((arg, index) => index <= toolIndex || (arg !== "." && arg !== "./"));
	if (basename(argv[toolIndex] ?? "") === "biome" && !scopedArgv.includes("--no-errors-on-unmatched"))
		scopedArgv.push("--no-errors-on-unmatched");
	const scoped = { ...check, argv: [...scopedArgv, ...inside] };
	scopedToTask.add(scoped);
	return scoped;
}

/** A request's declared checks as this task runs them; see {@link scopeCheckToTask}. */
function taskChecks(request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree">): ResolvedCheck[] {
	const checks = request.resolvedVerification ?? [];
	const worktree = request.taskWorktree;
	if (worktree === undefined || !checks.some((check) => lintFormatScopeArgv(check) !== null)) return [...checks];
	// Scoping and the follow-up steps come from the worktree's package scripts, which the
	// worker can edit; once a manifest or package-manager config differs from the base,
	// every check runs exactly as declared.
	if (taskWorktreeManifestsChanged(worktree)) return [...checks];
	const changed = taskChangedPaths(worktree);
	return checks.flatMap((check) => {
		const scoped = scopeCheckToTask(check, changed);
		return scoped === check ? [check] : [scoped, ...lintScriptFollowUpChecks(check)];
	});
}

/** Lockfiles whose agreement lets the base replay borrow the task's installed dependencies. */
const DEPENDENCY_MANIFESTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
];

/** Each manifest is absent on both sides or has the same blob id; hashes avoid reading lockfiles into memory. */
async function manifestsMatchBase(root: string, base: string): Promise<boolean> {
	const git = (args: string[]) =>
		runCommandVector("git", internalGitArgv(["-C", root, ...args]), { timeoutMs: 5_000, maxOutputBytes: 1_024 });
	try {
		return await manifestsMatch(root, base, git);
	} catch {
		// Clio refused its own hash-object after config drift: unproven manifests do not match.
		return false;
	}
}

async function manifestsMatch(
	root: string,
	base: string,
	git: (args: string[]) => ReturnType<typeof runCommandVector>,
): Promise<boolean> {
	for (const name of DEPENDENCY_MANIFESTS) {
		const atBase = await git(["rev-parse", "--verify", "-q", `${base}:${name}`]);
		const baseId = atBase.exitCode === 0 ? atBase.stdout.trim() : null;
		if (!existsSync(join(root, name))) {
			if (baseId !== null) return false;
			continue;
		}
		if (baseId === null) return false;
		const inTask = await git(["hash-object", "--", name]);
		if (inTask.exitCode !== 0 || inTask.stdout.trim() !== baseId) return false;
	}
	return true;
}

/**
 * Base replays of whole-repo checks, one per base commit, check command, cwd
 * and environment, so every task cut from one base pays for each failing
 * check's base run once. In flight they are shared in memory; once complete
 * they are kept under the state root, so another session on the machine reuses
 * them too. Both are bounded.
 */
interface BaseReplay {
	exitCode: number | null;
	incomplete: boolean;
	/** The base tree could not resolve the check's toolchain; never cached, never compared. */
	startFailed?: boolean;
	/** The base run's output as {@link outputLines}. */
	lines: string[];
}
// Version 3 drops replays recorded before the base check ran under the secret masks.
const BASE_REPLAY_VERSION = 3;
const BASE_REPLAY_CACHE_MAX = 64;
const BASE_REPLAY_LINES_MAX = 20_000;
const baseReplayCache = new Map<string, Promise<BaseReplay>>();

function baseReplayPath(stateDir: string, key: string): string {
	return join(stateDir, "dispatch-verification-base", `${key}.json`);
}

function readBaseReplay(stateDir: string, key: string): BaseReplay | undefined {
	try {
		const parsed = JSON.parse(readFileSync(baseReplayPath(stateDir, key), "utf8")) as {
			version?: unknown;
			exitCode?: unknown;
			lines?: unknown;
		};
		if (
			parsed.version !== BASE_REPLAY_VERSION ||
			typeof parsed.exitCode !== "number" ||
			!Array.isArray(parsed.lines) ||
			!parsed.lines.every((line) => typeof line === "string")
		)
			return undefined;
		return { exitCode: parsed.exitCode, incomplete: false, lines: parsed.lines as string[] };
	} catch {
		// A missing or damaged entry is a miss; the base runs again.
		return undefined;
	}
}

function storeBaseReplay(stateDir: string, key: string, replay: BaseReplay): void {
	const target = baseReplayPath(stateDir, key);
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(
		temporary,
		JSON.stringify({ version: BASE_REPLAY_VERSION, exitCode: replay.exitCode, lines: replay.lines }),
		"utf8",
	);
	renameSync(temporary, target);
	const stale = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => ({ name, mtimeMs: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(BASE_REPLAY_CACHE_MAX);
	for (const entry of stale) rmSync(join(dir, entry.name), { force: true });
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");
const PASSING_LINE_RE = /^(?:✔|✓|√|ok\b|PASS\b)/u;

/**
 * A check's output as lines comparable across two checkouts: escape codes
 * stripped, each checkout root replaced, every digit run (line and column
 * numbers, counts, durations) replaced, whitespace collapsed, and blank or
 * passing-test lines dropped.
 */
function outputLines(output: string, roots: ReadonlyArray<string>): string[] {
	const ordered = [...new Set(roots)].sort((left, right) => right.length - left.length);
	const lines = new Set<string>();
	for (const raw of redactCommandOutputSecrets(output).split(/\r?\n/u)) {
		let line = raw.replace(ANSI_ESCAPE_RE, "");
		for (const root of ordered) line = line.split(root).join("<root>");
		line = line.replace(/\d+/gu, "N").replace(/\s+/gu, " ").trim();
		if (line !== "" && !PASSING_LINE_RE.test(line)) lines.add(line);
	}
	return [...lines];
}

/** What the failing check printed on the task: its full artifact log when there is one, else the receipt tail. */
function taskCheckOutput(check: RunHostVerificationCheck): string {
	if (check.artifactPath !== undefined) {
		try {
			const log = readFileSync(check.artifactPath, "utf8");
			// The code-step log is a header, a blank line, then the captured output.
			const body = log.indexOf("\n\n");
			if (body >= 0) return log.slice(body + 2);
		} catch {
			// Fall back to the tail sealed on the receipt.
		}
	}
	// A full tail starts mid-line; that partial line is not output the base could match.
	return Buffer.byteLength(check.outputTail, "utf8") >= OUTPUT_TAIL_BYTES - 4
		? check.outputTail.slice(check.outputTail.indexOf("\n") + 1)
		: check.outputTail;
}

function taskRoots(path: string): string[] {
	try {
		return [path, realpathSync(path)];
	} catch {
		return [path];
	}
}

/** A failure line short enough for a receipt reason. */
function boundedLine(line: string): string {
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** A failing check the base fails the same way: it predates the task and does not reject it. */
function failsTheSameOnBase(check: RunHostVerificationCheck): boolean {
	return check.baseComparison?.status === "failed" && check.baseComparison.reason === undefined;
}

function resolvedBaseSha(root: string, base: string): string | null {
	try {
		return execFileSync("git", internalGitArgv(["-C", root, "rev-parse", "--verify", "-q", `${base}^{commit}`]), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Compare each failing whole-repo check against the task's base commit.
 *
 * The check runs once on an isolated archive of the base, cached per base sha
 * (see {@link BaseReplay}), under the check's own declared timeout however long
 * it took on the task. A failing check fails the same way on the base when the
 * base run fails too and the task's output, compared line by line through
 * {@link outputLines}, adds nothing the base's lacks. When every failing check
 * fails the same way on the base, the failures predate the task: the
 * verification is sealed `not_implicated` with reason `failures_present_on_base`
 * and the run is not rejected. A lint or format check scoped to the task's
 * changed files (see {@link scopeCheckToTask}) judges only the task's own files
 * and is never excused by the base.
 */
export async function compareHostVerificationBase(input: {
	verification: RunHostVerification | undefined;
	request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree">;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Reports the wait for the verification slot each base replay takes; see {@link withVerificationSlot}. */
	slot?: VerificationSlotEvents;
}): Promise<void> {
	const failures = input.verification?.checks.filter((check) => check.exitCode !== 0) ?? [];
	if (failures.length === 0) return;
	const worktree = input.request.taskWorktree;
	for (const check of failures)
		check.baseComparison = { status: "not_compared", reason: "no isolated task base available" };
	if (worktree === undefined) return;
	const candidates = failures.flatMap((check) => {
		const declared = (input.request.resolvedVerification ?? [])
			.flatMap((entry) => [entry, ...lintScriptFollowUpChecks(entry)])
			.find((entry) => entry.check === check.check);
		const reason =
			declared === undefined
				? "declared check unavailable"
				: declared.kind !== undefined && declared.kind !== "command"
					? "judged check cannot be replayed as a command"
					: lintFormatScopeArgv(declared) !== null &&
							(check.argv.length !== declared.argv.length || check.argv.some((arg, index) => arg !== declared.argv[index]))
						? "check was scoped to the task's changed files"
						: declared.argv.some((arg) => arg.includes(worktree.path))
							? "command refers to the worker checkout"
							: null;
		check.baseComparison = { status: "not_compared", base: worktree.base, ...(reason ? { reason } : {}) };
		return reason === null && declared !== undefined ? [{ check, declared }] : [];
	});
	if (candidates.length === 0) return;
	// The seatbelt backend permits shared temporary writes; only bubblewrap
	// contains an arbitrary comparison command to this checkout (flywheel p9/C1).
	const sandbox = sandboxAvailability();
	if (!sandbox.available || sandbox.backend !== "bwrap" || sandbox.executable === null) {
		for (const { check } of candidates)
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "isolated base comparison sandbox unavailable",
			};
		return;
	}
	const backend = sandbox.backend;
	const executable = sandbox.executable;
	// The archived base has no installed dependencies. When the manifests match,
	// the base borrows the task's dependency view: the nearest node_modules from
	// the check cwd upward (a nested task worktree's is its enclosing checkout's)
	// and each workspace package's own, linked inside the private tmpfs.
	const linksByCwd = new Map(
		candidates.map(({ declared }) => [declared.cwd, baseModulesLinks(worktree.path, declared.cwd)] as const),
	);
	const linkModules = [...linksByCwd.values()].some((links) => links.length > 0);
	if (linkModules && !(await manifestsMatchBase(worktree.path, worktree.base))) {
		for (const { check } of candidates)
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "base dependencies were not provisioned: package.json or the lockfile differs from the base",
			};
		return;
	}
	for (const { check, declared } of candidates) {
		const relativeCwd = relative(worktree.path, declared.cwd);
		if (
			relativeCwd === ".." ||
			relativeCwd.startsWith("../") ||
			resolve(worktree.path, relativeCwd) !== resolve(declared.cwd)
		) {
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "check cwd is outside the task worktree",
			};
			continue;
		}
		const env = Object.fromEntries(
			PLAYBOOK_COMMAND_BASE_ENV.flatMap((name) => {
				const value = (input.env ?? process.env)[name];
				return value === undefined ? [] : [[name, value]];
			}),
		);
		const baseSha = resolvedBaseSha(worktree.path, worktree.base);
		const links = linksByCwd.get(declared.cwd) ?? [];
		const cacheKey =
			baseSha === null
				? null
				: sha256(
						JSON.stringify({
							baseSha,
							argv: declared.argv,
							relativeCwd,
							links,
							timeout: declared.timeoutMs,
							env,
						}),
					);
		const replay = async (): Promise<BaseReplay> => {
			// The archive lives only in bubblewrap's private tmpfs. Even SIGKILL
			// cannot leave a checkout or shared Git registration behind (flywheel p9/C1).
			const basePath = `/tmp/verification-base-${randomUUID()}`;
			const script = [
				'base_dir="$1"; source_dir="$2"; base_ref="$3"; relative_cwd="$4"; node_bin="$5"; preflight="$6"; link_count="$7"; shift 7',
				'mkdir -p "$base_dir" || exit 125',
				'git -C "$source_dir" archive "$base_ref" | tar -x -C "$base_dir" || exit 125',
				'while [ "$link_count" -gt 0 ]; do',
				'  link_path="$base_dir/$2"; mkdir -p "$(dirname "$link_path")" || exit 125',
				'  rm -rf "$link_path"; ln -s "$1" "$link_path" || exit 125',
				"  shift 2; link_count=$((link_count - 1))",
				"done",
				'cd "$base_dir/$relative_cwd" || exit 125',
				'case "$(pwd -P)/" in "$base_dir/"*) ;; *) exit 125 ;; esac',
				'export TMPDIR="$base_dir" TMP="$base_dir" TEMP="$base_dir"',
				'"$node_bin" -e "$preflight" "$base_dir" "$1" || exit $?',
				'exec "$@"',
			].join("\n");
			// The base check runs repository code, so it gets a worker command's
			// credential, settings, escape-socket and workspace secret masks too.
			const baseMasks = [...workerSandboxMasks(), ...settingsFileMasks()];
			const secretMasks = discoverSecretMasks(
				{ workspaceRoots: [worktree.path, ...links.map((link) => dirname(link.target))] },
				baseMasks,
			).masks;
			const sockets = unixSocketLaunch("block", sandbox, { workspaceRoots: [worktree.path], privateTmp: true }, [
				...baseMasks,
				...secretMasks,
			]);
			const masks = withMountAliases([...baseMasks, ...secretMasks, ...sockets.masks]);
			// A sandbox that cannot see the mount aliases would leave secrets readable.
			if (masks instanceof Error) return { exitCode: null, incomplete: true, lines: [] };
			const invocation = buildSandboxInvocation(
				{
					command: {
						argv: [
							"/bin/bash",
							"-o",
							"pipefail",
							"-c",
							script,
							"base-check",
							basePath,
							worktree.path,
							worktree.base,
							relativeCwd,
							process.execPath,
							BASE_PREFLIGHT_SCRIPT,
							String(links.length),
							...links.flatMap((link) => [link.target, link.relativePath]),
							...declared.argv,
						],
					},
					cwd: worktree.path,
					writableRoots: [],
					network: false,
					maskedPaths: masks,
					...sockets.fields,
				},
				backend,
				executable,
			);
			const outcome = await runCommandVector(invocation.file, invocation.args, {
				cwd: worktree.path,
				workspaceRoot: worktree.path,
				env,
				timeoutMs: declared.timeoutMs,
				killGraceMs: 0,
				maxOutputBytes: CODE_STEP_CAPTURE_MAX_BYTES,
			});
			// The preflight, not the check's exit code, decides whether the check could start on the base.
			const startFailed =
				outcome.exitCode === BASE_PREFLIGHT_EXIT && /^base preflight: .* does not resolve$/mu.test(outcome.stderr);
			return {
				exitCode: outcome.exitCode,
				...(startFailed ? { startFailed } : {}),
				incomplete:
					startFailed ||
					outcome.timedOut ||
					outcome.signal !== null ||
					outcome.outputCapped ||
					outcome.failure !== null ||
					outcome.exitCode === null ||
					outcome.exitCode === 125,
				lines: outputLines(`${outcome.stdout}\n${outcome.stderr}`, [basePath]).slice(0, BASE_REPLAY_LINES_MAX),
			};
		};
		const stateDir = input.stateDir ?? clioStateDir();
		const slotted = (): Promise<BaseReplay> =>
			withVerificationSlot(`base replay of ${declared.check}`, replay, input.slot);
		const cachedReplay = async (key: string): Promise<BaseReplay> => {
			const stored = readBaseReplay(stateDir, key);
			if (stored !== undefined) return stored;
			// Another process may have replayed this base while this one waited for the slot.
			const result = await withVerificationSlot(
				`base replay of ${declared.check}`,
				async () => readBaseReplay(stateDir, key) ?? (await replay()),
				input.slot,
			);
			if (!result.incomplete) {
				try {
					storeBaseReplay(stateDir, key, result);
				} catch {
					// The cache saves a rerun; failing to write it changes no verdict.
				}
			}
			return result;
		};
		try {
			let pending = cacheKey === null ? undefined : baseReplayCache.get(cacheKey);
			if (pending === undefined) {
				pending = cacheKey === null ? slotted() : cachedReplay(cacheKey);
				if (cacheKey !== null) {
					baseReplayCache.set(cacheKey, pending);
					while (baseReplayCache.size > BASE_REPLAY_CACHE_MAX) {
						const oldest = baseReplayCache.keys().next().value;
						if (oldest === undefined) break;
						baseReplayCache.delete(oldest);
					}
					// Only a completed replay is a fact about the base; a timeout or setup failure is retried next time.
					pending.then(
						(result) => {
							if (result.incomplete) baseReplayCache.delete(cacheKey);
						},
						() => baseReplayCache.delete(cacheKey),
					);
				}
			}
			const { exitCode, incomplete, startFailed, lines } = await pending;
			if (startFailed === true) {
				check.baseComparison = {
					status: "not_compared",
					base: worktree.base,
					reason: "the check could not start on the base",
				};
				continue;
			}
			// A failure the base has too excuses the task only when the task's output
			// adds nothing to the base's: a new error in an already red check rejects.
			const known = new Set(lines);
			const added =
				incomplete || exitCode === 0
					? []
					: outputLines(taskCheckOutput(check), taskRoots(worktree.path)).filter((line) => !known.has(line));
			check.baseComparison = {
				status: incomplete ? "not_compared" : exitCode === 0 ? "passed" : "failed",
				base: worktree.base,
				...(exitCode !== null ? { exitCode } : {}),
				...(incomplete
					? { reason: "base check could not complete in the isolated comparison" }
					: added.length > 0
						? {
								reason: `the task's output has ${added.length} line${added.length === 1 ? "" : "s"} the base's does not, first: ${JSON.stringify(boundedLine(added[0] ?? ""))}`,
							}
						: {}),
			};
		} catch {
			// Comparison is explanatory evidence; setup failure retains the host rejection.
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "isolated base comparison could not run",
			};
		}
	}
	const verification = input.verification;
	if (verification?.status === "rejected" && failures.every(failsTheSameOnBase)) {
		// Every failure is already present on the base: the task did not cause it.
		verification.status = "not_implicated";
		verification.reason = "failures_present_on_base";
	}
}

export function hostVerificationRejection(
	verification: RunHostVerification | undefined,
): { outcomeCode: "host_verification_rejected"; detail: string } | null {
	if (verification?.status !== "rejected") return null;
	// Name a failure the run is rejected for, not one its base already has.
	const failedCheck =
		verification.checks.find((check) => check.exitCode !== 0 && !failsTheSameOnBase(check)) ??
		verification.checks.find((check) => check.exitCode !== 0);
	return {
		outcomeCode: "host_verification_rejected",
		detail:
			(failedCheck === undefined
				? "host verification rejected"
				: failedCheck.report !== undefined
					? `host verification check '${failedCheck.check}' rejected: ${failedCheck.report.summary}`
					: `host verification check '${failedCheck.check}' rejected with exit code ${failedCheck.exitCode}`) +
			(failedCheck === undefined
				? "; the base was not compared"
				: `; ${hostCheckBaseNote(failedCheck)}. The host ran this check; rejection is not evidence that the worker skipped validation.`),
	};
}

function readSealedFile(absolutePath: string): string | undefined {
	try {
		return readFileSync(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * The kind-specific verdict for a resolved check that already ran. A command
 * check keeps its exit code. A numeric-compare check judges captured stdout
 * against the sealed reference; a perf-budget check judges the measured
 * duration against the sealed budget or baseline. Either judgement turns a
 * clean exit into exit 1 when it fails, and a judgement that cannot be made
 * (missing reference, unparseable output) fails with the reason in the tail.
 */
function judgeResolvedCheck(
	resolvedCheck: ResolvedCheck,
	exitCode: number,
	durationMs: number,
	stdout: string,
): { exitCode: number; report?: RunHostVerificationCheck["report"]; outputTail?: string } {
	if (resolvedCheck.kind === undefined || resolvedCheck.kind === "command" || exitCode !== 0) return { exitCode };
	if (resolvedCheck.kind === "numeric-compare" && resolvedCheck.numeric !== undefined) {
		const referenceText = readSealedFile(resolvedCheck.numeric.reference);
		if (referenceText === undefined) {
			return { exitCode: 1, outputTail: `numeric-compare: reference '${resolvedCheck.numeric.reference}' cannot be read` };
		}
		const report = judgeNumericTexts(
			stdout,
			referenceText,
			resolvedCheck.numeric.tolerance,
			`reference '${resolvedCheck.numeric.reference}'`,
			resolvedCheck.numeric.reference,
		);
		if (report instanceof Error) return { exitCode: 1, outputTail: `numeric-compare: ${report.message}` };
		return { exitCode: report.passed ? 0 : 1, report, outputTail: outputTail(report.summary) };
	}
	if (resolvedCheck.kind === "perf-budget" && resolvedCheck.perf !== undefined) {
		const baselinePath = resolvedCheck.perf.baseline;
		const report = judgePerfTexts(
			durationMs,
			resolvedCheck.perf,
			baselinePath === undefined ? undefined : readSealedFile(baselinePath),
			`baseline '${baselinePath ?? ""}'`,
		);
		if (report instanceof Error) return { exitCode: 1, outputTail: `perf-budget: ${report.message}` };
		return { exitCode: report.passed ? 0 : 1, report, outputTail: outputTail(report.summary) };
	}
	return { exitCode: 1, outputTail: `${resolvedCheck.kind}: sealed check carries no parameters` };
}

/**
 * A sealed reproduce check runs through the same runner as the verify tool,
 * from the root its declared cwd implies. It is never memoized: its inputs
 * may be untracked files the tree fingerprint does not cover, so a stored
 * pass could outlive the bytes it judged.
 */
async function runSealedReproduce(
	resolvedCheck: ResolvedCheck,
	shellSandbox: MainSandboxPolicy | undefined,
): Promise<RunHostVerificationCheck> {
	const sealed = resolvedCheck.reproduce;
	const argv = [...resolvedCheck.argv];
	if (sealed === undefined) {
		return {
			check: resolvedCheck.check,
			argv,
			cwd: resolvedCheck.cwd,
			exitCode: 1,
			durationMs: 0,
			memo: false,
			notRun: "unconfigured",
			outputTail: "reproduce: sealed check carries no parameters",
		};
	}
	const depth = sealed.declaredCwd === "." ? 0 : sealed.declaredCwd.split("/").length;
	const root = resolve(resolvedCheck.cwd, ...Array.from({ length: depth }, () => ".."));
	const outcome = await runReproduce({
		command: argv,
		cwd: sealed.declaredCwd,
		timeoutMs: resolvedCheck.timeoutMs,
		spec: sealed.spec,
		workspaceRoot: root,
		...(shellSandbox !== undefined ? { shellSandbox } : {}),
	});
	const base = { check: resolvedCheck.check, argv, cwd: resolvedCheck.cwd, memo: false };
	switch (outcome.kind) {
		case "refused":
			return {
				...base,
				exitCode: 1,
				durationMs: 0,
				notRun: "refused",
				outputTail: outputTail(`reproduce refused: ${outcome.refusal.message}`),
			};
		case "run-failed":
			return {
				...base,
				argv: outcome.facts.argv,
				exitCode: outcome.facts.exitCode === 0 || outcome.facts.exitCode === null ? 1 : outcome.facts.exitCode,
				durationMs: outcome.facts.durationMs,
				// A check whose first run's process could not be created stopped on its environment, not on what it
				// judges. Once a run launched the check ran, so a later run that could not start leaves it unjudged.
				...(outcome.facts.launched || outcome.completed.length > 0 ? {} : { notRun: "spawn-failed" as const }),
				outputTail: outputTail(`reproduce ${outcome.message}`),
			};
		case "unjudgeable":
			return {
				...base,
				exitCode: 1,
				durationMs: outcome.facts.reduce((sum, fact) => sum + fact.durationMs, 0),
				outputTail: outputTail(`reproduce: ${outcome.message}`),
			};
		case "judged":
			return {
				...base,
				argv: outcome.report.conditions.argv,
				exitCode: outcome.report.passed ? 0 : 1,
				durationMs: outcome.facts.reduce((sum, fact) => sum + fact.durationMs, 0),
				outputTail: outputTail(renderReproduceReport(outcome.report)),
				report: outcome.report,
			};
	}
}

interface ResolvedCheckRun {
	runId: string;
	index: number;
	resolvedCheck: ResolvedCheck;
	stateDir: string;
	env: NodeJS.ProcessEnv;
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	slot?: VerificationSlotEvents;
}

async function runResolvedCheck(
	input: ResolvedCheckRun,
): Promise<{ check: RunHostVerificationCheck; outputExcerpt: string }> {
	const resolvedCheck = input.resolvedCheck;
	const note = `host verification ${resolvedCheck.check} for run ${input.runId}`;
	if (resolvedCheck.kind === "reproduce") {
		const check = await withVerificationSlot(
			note,
			() => runSealedReproduce(resolvedCheck, input.shellSandbox),
			input.slot,
		);
		return { check, outputExcerpt: check.outputTail };
	}
	if (nothingChanged.has(resolvedCheck)) {
		return {
			check: {
				check: resolvedCheck.check,
				argv: [...resolvedCheck.argv],
				cwd: resolvedCheck.cwd,
				exitCode: 0,
				durationMs: 0,
				memo: false,
				outputTail: "host verification: the task changed no file under this lint or format check; nothing to check",
			},
			outputExcerpt: "",
		};
	}
	const command: PlaybookCommand = {
		id: resolvedCheck.check,
		argv: [...resolvedCheck.argv],
		cwd: "",
		timeoutMs: resolvedCheck.timeoutMs,
		env: [],
		description: `Host verification check ${resolvedCheck.check}.`,
	};
	const judgmentKey = checkDedupeKey(resolvedCheck);
	const tree = checkedTree(resolvedCheck.cwd) ?? undefined;
	const fingerprint = tree?.fingerprint ?? null;
	const key = fingerprint === null ? null : memoKey(command, judgmentKey, fingerprint, input.env);
	const memoHit = (): { check: RunHostVerificationCheck; outputExcerpt: string } | undefined => {
		const hit =
			key === null
				? undefined
				: readMemo(input.stateDir).entries.find((entry) => entry.key === key && entry.check.exitCode === 0);
		if (hit === undefined) return undefined;
		// A memo hit is always a pass, so no caller ever needs its output for
		// attribution; the empty excerpt says the fresh output does not exist.
		// The tree is stamped fresh on a hit: the memo matched this tree's content,
		// but its stored entry names whichever checkout first produced the pass (F6).
		return {
			check: {
				...hit.check,
				argv: [...hit.check.argv],
				memo: true,
				evidenceRunId: hit.runId,
				...(tree !== undefined ? { tree } : {}),
			},
			outputExcerpt: "",
		};
	};
	const hit = memoHit();
	if (hit !== undefined) return hit;
	// A check scoped to the task's own files is small; every other one takes the slot, and a pass another
	// process stored for this tree while this one waited answers it.
	if (scopedToTask.has(resolvedCheck)) return spawnResolvedCheck(input, command, judgmentKey, key, tree);
	return withVerificationSlot(
		note,
		async () => memoHit() ?? (await spawnResolvedCheck(input, command, judgmentKey, key, tree)),
		input.slot,
	);
}

async function spawnResolvedCheck(
	input: ResolvedCheckRun,
	command: PlaybookCommand,
	judgmentKey: string,
	key: string | null,
	tree: RunHostVerificationCheck["tree"],
): Promise<{ check: RunHostVerificationCheck; outputExcerpt: string }> {
	const resolvedCheck = input.resolvedCheck;
	const judged = resolvedCheck.kind === "numeric-compare" || resolvedCheck.kind === "perf-budget";
	const captureMaxBytes = judged ? JUDGED_CHECK_MAX_OUTPUT_BYTES : CODE_STEP_CAPTURE_MAX_BYTES;
	const outcome = await runCodeStep({
		stepId: `verification-${input.index + 1}-${resolvedCheck.check.replace(/[^a-z0-9._-]/giu, "_")}`,
		command,
		workspaceRoot: resolvedCheck.cwd,
		artifactDir: join(input.stateDir, "artifacts", input.runId, "verification"),
		env: input.env,
		maxOutputBytes: captureMaxBytes,
		...(input.shellSandbox !== undefined ? { shellSandbox: input.shellSandbox } : {}),
	});
	const artifactPath = outcome.record.artifactPaths[0];
	// outputTruncated also covers the report excerpt; only capture loss prevents judgement.
	const judgement =
		judged && outcome.record.outputTruncated && outcome.record.outputBytes > captureMaxBytes
			? {
					exitCode: 1,
					outputTail: `verify: ${resolvedCheck.kind} command output exceeded ${captureMaxBytes} bytes before judgement; captured output was truncated`,
				}
			: judgeResolvedCheck(resolvedCheck, outcome.record.exitCode, outcome.record.durationMs, outcome.stdout);
	const check: RunHostVerificationCheck = {
		check: resolvedCheck.check,
		argv: [...outcome.record.argv],
		cwd: outcome.record.cwd,
		exitCode: judgement.exitCode,
		durationMs: outcome.record.durationMs,
		memo: false,
		...(outcome.launched ? {} : { notRun: "spawn-failed" as const }),
		outputTail: judgement.outputTail ?? outputTail(outcome.report.outputExcerpt),
		...(artifactPath !== undefined ? { artifactPath } : {}),
		...(judgement.report !== undefined ? { report: judgement.report } : {}),
		...(tree !== undefined ? { tree } : {}),
	};
	if (check.exitCode === 0 && key !== null && checkDedupeKey(resolvedCheck) === judgmentKey) {
		try {
			storeMemoEntry(input.stateDir, { key, runId: input.runId, check });
		} catch (error) {
			input.onDiagnostic?.(error);
		}
	}
	// The 8KB code-step excerpt (code-step.ts:37), not the 2KB receipt tail:
	// attribution reads the runner's own failure summary and a 2KB window loses
	// it on a large suite.
	return { check, outputExcerpt: outcome.report.outputExcerpt };
}

/**
 * The sandbox host verification runs a run's declared checks in. A worker
 * may have written the test files and helpers a check executes, so the host
 * runs them where the main session's own bash would: the main-session
 * sandbox rooted at the run's workspace. `off` runs them bare, as does `auto`
 * on a host with no backend, where the worker itself ran unsandboxed; under
 * `required` a missing backend refuses each check rather than running it bare.
 */
export function hostVerificationSandbox(
	settings: Readonly<Pick<ClioSettings, "safety" | "targets">> | undefined,
	workspace: string,
	availability = sandboxAvailability(),
): MainSandboxPolicy | undefined {
	const mode: SandboxMode = settings?.safety.sandbox ?? "auto";
	if (mode === "off" || (mode === "auto" && !mainShellContained(mode, availability))) return undefined;
	return mainSandboxPolicy({
		workspace,
		scratchRoots: effectiveScratchRoots(settings?.safety.scratchRoots ?? [], workspace),
		...(settings !== undefined
			? { env: sandboxEnvPolicy(settings), unixSockets: settings.safety.sandboxUnixSockets }
			: {}),
	});
}

export async function runHostVerification(input: {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree">;
	workerSuccessful: boolean;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	/** The sandbox every check runs in; see {@link hostVerificationSandbox}. Absent runs them bare. */
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	/** Reports each check waiting for and taking the verification slot; see {@link withVerificationSlot}. */
	slot?: VerificationSlotEvents;
}): Promise<RunHostVerification | undefined> {
	const checks = input.request.resolvedVerification;
	if (checks === undefined || checks.length === 0) return undefined;
	if (!input.workerSuccessful) return { status: "skipped", reason: "worker_not_successful", checks: [] };
	const stateDir = input.stateDir ?? clioStateDir();
	const env = input.env ?? process.env;
	const results: RunHostVerificationCheck[] = [];
	for (const [index, resolvedCheck] of taskChecks(input.request).entries()) {
		const outcome = await runResolvedCheck({
			runId: input.runId,
			index,
			resolvedCheck,
			stateDir,
			env,
			...(input.shellSandbox !== undefined ? { shellSandbox: input.shellSandbox } : {}),
			...(input.onDiagnostic !== undefined ? { onDiagnostic: input.onDiagnostic } : {}),
			...(input.slot !== undefined ? { slot: input.slot } : {}),
		});
		results.push(outcome.check);
	}
	return {
		status: results.every((check) => check.exitCode === 0) ? "verified" : "rejected",
		checks: results,
	};
}

function implicatedPaths(outputExcerpt: string, checkCwd: string): string[] {
	const withoutUrls = outputExcerpt.replace(HTTP_URL_RE, (url) => " ".repeat(url.length));
	const paths = new Set<string>();
	for (const match of withoutUrls.matchAll(CHECK_OUTPUT_PATH_RE)) paths.add(resolve(checkCwd, match[0]));
	return [...paths].sort();
}

/** Identity shared by memo reuse and batch deduplication, including the declared judgment and its input files. */
function checkDedupeKey(resolvedCheck: ResolvedCheck): string {
	const numeric = resolvedCheck.numeric;
	const perf = resolvedCheck.perf;
	return sha256(
		JSON.stringify({
			check: resolvedCheck.check,
			...(nothingChanged.has(resolvedCheck) ? { nothingChanged: true } : {}),
			argv: [...resolvedCheck.argv],
			cwd: resolve(resolvedCheck.cwd),
			timeoutMs: resolvedCheck.timeoutMs,
			kind: resolvedCheck.kind ?? "command",
			reproduce: resolvedCheck.reproduce,
			numeric:
				numeric === undefined
					? undefined
					: {
							reference: numeric.reference,
							referenceDigest: sha256(JSON.stringify(readSealedFile(numeric.reference) ?? null)),
							tolerance: numeric.tolerance,
						},
			perf:
				perf === undefined
					? undefined
					: {
							budget:
								perf.budget === undefined
									? undefined
									: {
											wallTimeMs: perf.budget.wallTimeMs,
											tolerance: perf.budget.tolerance,
										},
							baseline: perf.baseline,
							baselineDigest:
								perf.baseline === undefined ? undefined : sha256(JSON.stringify(readSealedFile(perf.baseline) ?? null)),
							tolerance: perf.tolerance,
						},
		}),
	);
}

export interface BatchVerificationParticipant {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification" | "intent" | "cwd" | "taskWorktree">;
	workerSuccessful: boolean;
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	/** Reports this run's checks waiting for and taking the verification slot. */
	slot?: VerificationSlotEvents;
}

export interface BatchVerificationGate {
	/** This run holds a capacity lease and its worker is spawned, so it may be writing. */
	live(runId: string): void;
	/** Park until every live member has arrived or left, then return this run's verdict. */
	arrive(input: BatchVerificationParticipant): Promise<RunHostVerification | undefined>;
	/** Release a member that will never arrive. Idempotent, and a no-op for one already parked. */
	abandon(runId: string): void;
}

interface ParkedMember {
	participant: BatchVerificationParticipant;
	settle: (value: RunHostVerification | undefined) => void;
	/**
	 * Reject the parked promise so the member's finalization takes the identical
	 * path a single-task dispatch takes when its declared check cannot run at all
	 * (`extension.ts:5544` throws into the finalization catch at 5669 and the run
	 * is marked failed). Silently dropping a declared check must never look like
	 * never having declared one.
	 */
	fail: (error: unknown) => void;
}

/**
 * The member's declared write roots resolved in the frame its own request ran in.
 *
 * An empty result means UNCONFINED, never "writes nothing": `intent.ts:139`
 * normalizes a `"."` scope entry to an empty list, a request may omit
 * `write_roots` entirely, and `extension.ts:1949` only builds a write boundary
 * for a non-empty list, so such a run executed with no write confinement at all.
 */
function memberBoundary(participant: BatchVerificationParticipant): string[] {
	const writeRoots = participant.request.intent?.writeRoots ?? [];
	return writeRoots.map((root) => resolvePathBoundary(participant.request.cwd ?? process.cwd(), root));
}

/**
 * Charge one failing batch check to the members that own it.
 *
 * The charge follows write-root coverage across the whole wave, not just across
 * the members that declared the check: a live sibling that declared no check, or
 * whose own worker failed, still edited the shared checkout, so a named path
 * inside its boundary and inside no declarer's is positive evidence that the
 * declarers are innocent. That exculpation demands every named path be owned
 * elsewhere; one path nobody claims leaves the failure unowned and every
 * declarer is charged. When the owner is a member that declared no check the
 * charge set comes out empty, because a run has nothing to reject on for a check
 * it never asked for; that is the attribution rule applied faithfully, and the
 * alternative is rejecting a worker the evidence points away from, which is the
 * defect this gate exists to remove.
 *
 * Exculpation always requires positive evidence, so a declarer that ran
 * unconfined is charged unconditionally: with no boundary there is nothing to
 * test the failing paths against, and it is the member most able to have broken
 * the tree. `basis` is the weakest evidence behind the charge set, never the
 * strongest, so `write_roots` on a receipt means every charged run has a named
 * path inside its own declared boundary.
 *
 * A `worktree: true` member's checks run inside its own task worktree (F6),
 * so their batch identity differs from every sibling's and a failure there is
 * judged against that member's own checkout and write roots.
 */
function attributeFailure(input: {
	implicated: ReadonlyArray<string>;
	declarers: ReadonlyArray<BatchVerificationParticipant>;
	wave: ReadonlyArray<BatchVerificationParticipant>;
}): { charged: Set<string>; basis: RunHostVerificationAttribution["basis"]; decisive: string[] } {
	const declared = new Set(input.declarers.map((member) => member.runId));
	const implicatedDeclarers = new Set<string>();
	const unconfined = new Set<string>();
	const decisive = new Set<string>();
	for (const member of input.declarers) {
		const boundary = memberBoundary(member);
		if (boundary.length === 0) {
			unconfined.add(member.runId);
			continue;
		}
		const hits = input.implicated.filter((path) => writeRootsCover(boundary, path));
		if (hits.length === 0) continue;
		implicatedDeclarers.add(member.runId);
		for (const hit of hits) decisive.add(hit);
	}
	const others = input.wave.filter((member) => !declared.has(member.runId));
	const ownedElsewhere =
		input.implicated.length > 0 &&
		input.implicated.every((path) => others.some((member) => writeRootsCover(memberBoundary(member), path)));
	const localized = implicatedDeclarers.size > 0 || ownedElsewhere;
	const charged = localized ? new Set(implicatedDeclarers) : new Set(declared);
	for (const runId of unconfined) charged.add(runId);
	return {
		charged,
		basis:
			!localized || unconfined.size > 0
				? "unattributable"
				: implicatedDeclarers.size > 0
					? "write_roots"
					: "attributed_elsewhere",
		decisive: [...decisive].sort(),
	};
}

/**
 * One settlement barrier per wave of a parallel dispatch batch.
 *
 * A check run while a sibling is still editing the shared checkout judges a tree
 * neither worker authored: three coders on one kvlog batch (round 5, 2026-09-02)
 * all sealed `host_verification_rejected` for one worker's broken test. Every
 * live member parks at the verification step, each distinct resolved check runs
 * once for the whole wave on the settled tree, and a failure is charged by
 * write-root coverage across the wave.
 *
 * Membership is what is LIVE, never what was requested. A run still queued for
 * capacity holds no lease and cannot write, and waiting on it would deadlock
 * every batch larger than `fleet.concurrency`: parked members keep their lease
 * until dispatch finalization ends, so the queued member's `admit` would never be
 * granted and the batch would hang. Live-only membership still costs a queued
 * member the difference between the first live member finishing and the last.
 * Admission waits are advisory (c7670370e), so that wait has no deadline of its
 * own. Only a caller deadline, such as the dispatch call's `timeout_ms`, can
 * expire the queued member's `admit`, and `dispatchBatch` aborts every already
 * dispatched run when one member's admission throws. Releasing the lease before parking would let a fresh writer into the checkout
 * the settlement is about to judge, which is the defect itself, so the wait
 * stands until the lease lifecycle is restructured.
 *
 * The gate is multi-shot: a batch larger than the effective capacity admits in
 * waves, and each wave forms its own barrier from the members live at that
 * moment. Latching after the first settlement would drop every later member onto
 * the per-run path and reproduce the original defect verbatim, since those
 * members are admitted together and would run the shared check concurrently on
 * the checkout their siblings are still editing.
 *
 * One narrow window survives, and it is the reason `live()` registers as early
 * as the worker spawn: a member that goes live WHILE a wave's checks are
 * executing joins the next wave, so its edits can land in the tree the running
 * check is judging. Reaching it takes either a lease freed mid-settlement, which
 * means a sibling whose finalization failed before the barrier, or a member of
 * `dispatchBatch`'s sequential loop (`extension.ts:6194`) whose worker had not
 * spawned yet when every earlier member had already finished. The next wave
 * re-runs the check on the settled tree, so a stale verdict is bounded to the
 * one wave that raced.
 */
export function createBatchVerificationGate(
	options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): BatchVerificationGate {
	const stateDir = options.stateDir ?? clioStateDir();
	const env = options.env ?? process.env;
	const liveMembers = new Set<string>();
	const parked = new Map<string, ParkedMember>();
	let settling = false;

	const perRun = (participant: BatchVerificationParticipant): Promise<RunHostVerification | undefined> =>
		runHostVerification({
			runId: participant.runId,
			request: participant.request,
			workerSuccessful: participant.workerSuccessful,
			stateDir,
			env,
			...(participant.shellSandbox !== undefined ? { shellSandbox: participant.shellSandbox } : {}),
			...(participant.onDiagnostic !== undefined ? { onDiagnostic: participant.onDiagnostic } : {}),
			...(participant.slot !== undefined ? { slot: participant.slot } : {}),
		});

	/** Today's value for a member that contributes no check; runs no command. */
	const nothingToRun = (participant: BatchVerificationParticipant): RunHostVerification | undefined => {
		const checks = participant.request.resolvedVerification;
		if (checks === undefined || checks.length === 0) return undefined;
		return { status: "skipped", reason: "worker_not_successful", checks: [] };
	};

	async function settleBatch(wave: ReadonlyArray<ParkedMember>): Promise<void> {
		const members = wave.map((entry) => entry.participant);
		const contributors = members.filter(
			(member) => member.workerSuccessful && (member.request.resolvedVerification?.length ?? 0) > 0,
		);
		const memberChecks = new Map(contributors.map((member) => [member, taskChecks(member.request)]));
		const distinct = new Map<
			string,
			{ resolvedCheck: ResolvedCheck; owner: BatchVerificationParticipant; index: number }
		>();
		const checkKeys = new Map<ResolvedCheck, string>();
		for (const member of contributors) {
			for (const resolvedCheck of memberChecks.get(member) ?? []) {
				const key = checkDedupeKey(resolvedCheck);
				checkKeys.set(resolvedCheck, key);
				if (!distinct.has(key)) distinct.set(key, { resolvedCheck, owner: member, index: distinct.size });
			}
		}
		const ran = new Map<string, { check: RunHostVerificationCheck; owner: string; outputExcerpt: string }>();
		// Every member of the wave is parked on these checks, so each card says when they wait for the slot.
		const waveSlot: VerificationSlotEvents = {
			onWaiting: () => {
				for (const member of members) member.slot?.onWaiting?.();
			},
			onTaken: () => {
				for (const member of members) member.slot?.onTaken?.();
			},
		};
		for (const [key, entry] of distinct) {
			const outcome = await runResolvedCheck({
				runId: entry.owner.runId,
				index: entry.index,
				resolvedCheck: entry.resolvedCheck,
				stateDir,
				env,
				...(entry.owner.shellSandbox !== undefined ? { shellSandbox: entry.owner.shellSandbox } : {}),
				// The owning member's callback, because the artifact directory is
				// named for that same run and the diagnostic text is closed over the
				// run id it was built for (`extension.ts:5534`); any other member's
				// callback would name a run whose artifacts the failure is not under.
				...(entry.owner.onDiagnostic !== undefined ? { onDiagnostic: entry.owner.onDiagnostic } : {}),
				slot: { ...waveSlot, onUnavailable: (error) => entry.owner.slot?.onUnavailable?.(error) },
			});
			ran.set(key, { check: outcome.check, owner: entry.owner.runId, outputExcerpt: outcome.outputExcerpt });
		}
		const attribution: RunHostVerificationAttribution[] = [];
		const chargedByKey = new Map<string, Set<string>>();
		for (const [key, entry] of ran) {
			if (entry.check.exitCode === 0) continue;
			const declarers = contributors.filter((member) =>
				(memberChecks.get(member) ?? []).some((candidate) => checkKeys.get(candidate) === key),
			);
			const implicated = implicatedPaths(entry.outputExcerpt, entry.check.cwd);
			const verdict = attributeFailure({ implicated, declarers, wave: members });
			chargedByKey.set(key, verdict.charged);
			const decisive = new Set(verdict.decisive);
			attribution.push({
				check: entry.check.check,
				// The paths that decided the charge lead the capped list. A large
				// suite names more than 32 files and the sealed evidence has to
				// contain the path a receipt was charged on, or it documents nothing.
				implicated: [...verdict.decisive, ...implicated.filter((path) => !decisive.has(path))].slice(
					0,
					IMPLICATED_PATH_CAP,
				),
				charged: [...verdict.charged].sort(),
				basis: verdict.basis,
			});
		}
		attribution.sort((first, second) => (first.check < second.check ? -1 : first.check > second.check ? 1 : 0));
		for (const entry of wave) {
			const member = entry.participant;
			if (!contributors.includes(member)) {
				entry.settle(nothingToRun(member));
				continue;
			}
			const own: RunHostVerificationCheck[] = [];
			let rejected = false;
			let unimplicated = false;
			for (const resolvedCheck of memberChecks.get(member) ?? []) {
				const key = checkKeys.get(resolvedCheck);
				if (key === undefined) throw new Error("host verification: declared check has no batch identity");
				const shared = ran.get(key);
				if (shared === undefined) continue;
				own.push(
					shared.owner === member.runId || shared.check.evidenceRunId !== undefined
						? { ...shared.check, argv: [...shared.check.argv] }
						: { ...shared.check, argv: [...shared.check.argv], evidenceRunId: shared.owner },
				);
				if (shared.check.exitCode === 0) continue;
				if (chargedByKey.get(key)?.has(member.runId) === true) rejected = true;
				else unimplicated = true;
			}
			entry.settle({
				// `verified` states that every declared check passed, which is what
				// `trust-status.ts:619` certifies and what the board and
				// `worker-evidence.ts:161` print. An exculpated member's checks array
				// still carries a non-zero exit code, so it seals its own status
				// instead of borrowing that claim.
				status: rejected ? "rejected" : unimplicated ? "not_implicated" : "verified",
				...(!rejected && unimplicated ? { reason: "batch_settled_not_implicated" } : {}),
				checks: own,
				strategy: "batch-settled",
				// Copied per receipt so no two members of the batch share a mutable array.
				...(attribution.length > 0
					? {
							attribution: attribution.map((record) => ({
								...record,
								implicated: [...record.implicated],
								charged: [...record.charged],
							})),
						}
					: {}),
			});
		}
	}

	function maybeSettle(): void {
		if (settling || parked.size === 0) return;
		for (const runId of liveMembers) {
			if (!parked.has(runId)) return;
		}
		settling = true;
		// The wave closes here. Its members leave `liveMembers` so a member that
		// arrives during the settlement forms the next barrier instead of joining
		// one whose checks are already executing.
		const wave = [...parked.values()];
		for (const runId of parked.keys()) liveMembers.delete(runId);
		parked.clear();
		void settleBatch(wave)
			.catch(async (error) => {
				// The barrier must never be the reason a receipt cannot seal, so a
				// member whose own checks still run gets today's per-run result. A
				// member whose per-run attempt throws the same way takes the throw:
				// swallowing it would seal a run that declared a check it never
				// executed as `host_verification=not_requested` and succeeded, while
				// the identical single-task dispatch fails the run.
				for (const entry of wave) {
					entry.participant.onDiagnostic?.(error);
					try {
						entry.settle(await perRun(entry.participant));
					} catch (fallbackError) {
						entry.fail(fallbackError);
					}
				}
			})
			.finally(() => {
				settling = false;
				maybeSettle();
			});
	}

	return {
		live(runId) {
			liveMembers.add(runId);
		},
		abandon(runId) {
			// Dropping the id out of `liveMembers` rather than remembering it in a
			// second set keeps the membership of a later wave exact: the same run
			// abandons again when its finalPromise settles, long after its own wave.
			if (parked.has(runId) || !liveMembers.delete(runId)) return;
			maybeSettle();
		},
		arrive(input) {
			liveMembers.add(input.runId);
			// The executor runs synchronously, so the member is registered before
			// arrive() yields and two concurrent arrivals cannot miss each other.
			const parkedPromise = new Promise<RunHostVerification | undefined>((settle, fail) => {
				parked.set(input.runId, { participant: input, settle, fail });
			});
			maybeSettle();
			return parkedPromise;
		},
	};
}
