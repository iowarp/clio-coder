import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { readClioVersion } from "../../core/package-root.js";
import { resolveSafeCwd, runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { clioStateDir } from "../../core/xdg.js";
import { currentProcessLease, ownerIsAlive, type ProcessLease, validProcessLease } from "../process-lease.js";
import { extractNumericPayloadText, type NumericReferenceProvenance } from "./numeric.js";
import {
	type DeclaredReproduce,
	judgeReproduce,
	parseReproducePayload,
	type ReproduceConditions,
	type ReproduceInputRecord,
	type ReproducePayload,
	type ReproducePlatform,
	type ReproduceReport,
	type ReproduceRunRecord,
	reproduceEnvironment,
} from "./reproduce.js";
import { readRegularFileText, resolveCleanRunArgv } from "./toolchain.js";

/**
 * Runs a `kind: reproduce` check. Every declared input is hashed in the
 * operator's checkout and the check refuses before anything runs when a
 * digest differs. Each run then gets a fresh clean environment under Clio's
 * state directory, never inside the operator's tree: a detached worktree of
 * HEAD, or a directory holding only the declared inputs. Inputs are copied in
 * at their relative paths and hashed again there, so the bytes the command
 * reads are the bytes the catalog pinned, tracked or not. The environment is
 * removed when the run ends, on failure and abort included. One a crash or
 * kill left behind is swept by the next reproduce run once its owner process
 * is gone.
 *
 * `twice` uses two separate clean environments rather than one reused twice,
 * so a first run that leaves caches or intermediate files behind cannot make
 * the second run agree with it.
 *
 * A pass is evidence. It grants no permission and changes no budget or clock.
 */

/** Output ceiling for one reproduce run; the same bound a judged check has. */
const REPRODUCE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const PYTHON_VERSION_TIMEOUT_MS = 10_000;
/** Names the process that owns a clean environment and the repository its worktree is registered in. */
const ENVIRONMENT_OWNER_FILE = "owner.json";
/**
 * An environment with no readable owner is swept only once it is this old: one made before owners were recorded, or
 * one whose owner file a crash kept from being written.
 */
const UNOWNED_ENVIRONMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ENVIRONMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ReproduceRefusalReason =
	| "interpreter-unavailable"
	| "input-unreadable"
	| "input-digest-mismatch"
	| "reference-unreadable"
	| "not-a-repository"
	| "environment-setup-failed";

export interface ReproduceDigestMismatch {
	path: string;
	expected: string;
	actual: string;
}

export interface ReproduceRefusal {
	reason: ReproduceRefusalReason;
	message: string;
	mismatches?: ReproduceDigestMismatch[];
	provisionCommand?: string[];
}

export interface ReproduceRunFacts {
	argv: string[];
	cwd: string;
	/** Whether this run's process was created; false when spawn failed or the sandbox refused, so nothing ran. */
	launched: boolean;
	exitCode: number | null;
	durationMs: number;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
}

export type ReproduceOutcome =
	| { kind: "refused"; refusal: ReproduceRefusal }
	/**
	 * A run did not complete cleanly, so nothing was judged. `run` is 1 or 2; `facts.launched` says whether it started,
	 * and `completed` holds the runs before it, each launched and completed cleanly: the check ran when either holds.
	 */
	| { kind: "run-failed"; run: number; facts: ReproduceRunFacts; completed: ReproduceRunFacts[]; message: string }
	/** The command completed but its output or the reference could not be judged. */
	| { kind: "unjudgeable"; message: string; facts: ReproduceRunFacts[] }
	| { kind: "judged"; report: ReproduceReport; facts: ReproduceRunFacts[] };

export interface ReproduceRunInput {
	command: ReadonlyArray<string>;
	/** Repository-relative directory, as declared. */
	cwd: string;
	timeoutMs: number;
	spec: DeclaredReproduce;
	/** The directory catalog paths are relative to. */
	workspaceRoot: string;
	signal?: AbortSignal;
	/** Parent for clean environments; defaults to `<state>/scratch/reproduce`. */
	scratchRoot?: string;
}

async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
	const hash = createHash("sha256");
	let sizeBytes = 0;
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk as Buffer);
		sizeBytes += (chunk as Buffer).byteLength;
	}
	return { sha256: hash.digest("hex"), sizeBytes };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			internalGitArgv(["-C", cwd, ...args]),
			{ encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`git ${args[0] ?? ""} failed: ${(stderr || error.message).trim()}`));
				else resolve(stdout);
			},
		);
	});
}

interface RepositoryState {
	toplevel: string;
	commit: string;
	trackedTreeClean: boolean;
	tracked: Set<string>;
}

/**
 * HEAD and whether tracked files match it, for a judged check that runs in the live checkout; null outside a
 * repository. A numeric-compare result carries it so the claim it becomes names the commit it held at (#406).
 */
export async function checkoutState(
	workspaceRoot: string,
): Promise<{ commit: string; trackedTreeClean: boolean } | null> {
	const state = await repositoryState(workspaceRoot, []);
	return state === null ? null : { commit: state.commit, trackedTreeClean: state.trackedTreeClean };
}

async function repositoryState(workspaceRoot: string, inputs: ReadonlyArray<string>): Promise<RepositoryState | null> {
	let toplevel: string;
	let commit: string;
	try {
		toplevel = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
		commit = (await git(workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	} catch {
		return null;
	}
	const status = await git(toplevel, ["status", "--porcelain", "--untracked-files=no"]).catch(() => null);
	const tracked = new Set<string>();
	if (inputs.length > 0) {
		const listed = await git(workspaceRoot, ["ls-files", "-z", "--", ...inputs]).catch(() => "");
		for (const entry of listed.split("\0")) if (entry.length > 0) tracked.add(entry);
	}
	return { toplevel, commit, trackedTreeClean: status !== null && status.trim().length === 0, tracked };
}

async function pythonVersion(interpreter: string, workspaceRoot: string): Promise<string | undefined> {
	try {
		const result = await runCommandVector(interpreter, ["--version"], {
			cwd: workspaceRoot,
			workspaceRoot,
			timeoutMs: PYTHON_VERSION_TIMEOUT_MS,
		});
		const text = `${result.stdout}${result.stderr}`.trim();
		return result.exitCode === 0 && text.length > 0 ? text.split("\n")[0] : undefined;
	} catch {
		return undefined;
	}
}

/** Hash every pin in the operator's checkout; refuse on the first unreadable path, report every mismatch. */
async function verifyInputs(
	spec: DeclaredReproduce,
	workspaceRoot: string,
): Promise<{ records: Array<Omit<ReproduceInputRecord, "tracked"> & { source: string }> } | ReproduceRefusal> {
	const realRoot = await realpath(workspaceRoot);
	const records: Array<Omit<ReproduceInputRecord, "tracked"> & { source: string }> = [];
	const mismatches: ReproduceDigestMismatch[] = [];
	for (const pin of spec.inputs) {
		let source: string;
		try {
			source = await realpath(resolveSafeCwd(pin.path, workspaceRoot));
			resolveSafeCwd(source, realRoot);
			if (!(await stat(source)).isFile()) throw new Error("not a regular file");
		} catch (error) {
			return {
				reason: "input-unreadable",
				message: `input '${pin.path}' cannot be read as a regular file inside the workspace (${errorText(error)}); nothing ran`,
			};
		}
		const digest = await sha256File(source);
		if (digest.sha256 !== pin.sha256) {
			mismatches.push({ path: pin.path, expected: pin.sha256, actual: digest.sha256 });
			continue;
		}
		records.push({ path: pin.path, sha256: digest.sha256, sizeBytes: digest.sizeBytes, source });
	}
	if (mismatches.length > 0) {
		return {
			reason: "input-digest-mismatch",
			message: `input digest mismatch; nothing ran: ${mismatches
				.map((mismatch) => `'${mismatch.path}' expected sha256 ${mismatch.expected}, actual ${mismatch.actual}`)
				.join("; ")}`,
			mismatches,
		};
	}
	return { records };
}

interface EnvironmentOwner {
	owner: ProcessLease;
	/** Toplevel of the repository a `worktree` environment is registered in; null for `copy`. */
	repository: string | null;
}

async function readEnvironmentOwner(base: string): Promise<EnvironmentOwner | null> {
	try {
		const value = JSON.parse(await readFile(path.join(base, ENVIRONMENT_OWNER_FILE), "utf8")) as Record<string, unknown>;
		if (!validProcessLease(value.owner)) return null;
		if (value.repository !== null && typeof value.repository !== "string") return null;
		return { owner: value.owner, repository: value.repository };
	} catch {
		return null;
	}
}

/** The main checkout of the repository an unowned environment's worktree is registered in, or null when it is none. */
async function registeredRepository(tree: string): Promise<string | null> {
	try {
		// A linked worktree's `.git` is a file; without one, git would answer for whatever repository encloses the state dir.
		if (!(await lstat(path.join(tree, ".git"))).isFile()) return null;
		const listed = await git(tree, ["worktree", "list", "--porcelain"]);
		const main = /^worktree (.+)$/mu.exec(listed)?.[1];
		return main === undefined || main.length === 0 ? null : main;
	} catch {
		return null;
	}
}

/**
 * Remove the clean environments a crashed or killed reproduce run left under `scratchRoot`: the checkout, and
 * the worktree entry it registered in the operator's repository. Only an environment whose owner process is gone, or
 * an unowned one past UNOWNED_ENVIRONMENT_MAX_AGE_MS, is touched; a live run's, or one owned on another host, is kept.
 */
async function sweepAbandonedEnvironments(scratchRoot: string): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(scratchRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !ENVIRONMENT_NAME.test(entry.name)) continue;
		const base = path.join(scratchRoot, entry.name);
		const tree = path.join(base, "tree");
		const owner = await readEnvironmentOwner(base);
		if (owner !== null) {
			if (ownerIsAlive(owner.owner)) continue;
		} else {
			const modified = await stat(base).then(
				(info) => info.mtimeMs,
				() => now,
			);
			if (now - modified < UNOWNED_ENVIRONMENT_MAX_AGE_MS) continue;
		}
		const repository = owner !== null ? owner.repository : await registeredRepository(tree);
		if (repository !== null) await git(repository, ["worktree", "remove", "--force", tree]).catch(() => undefined);
		await rm(base, { recursive: true, force: true }).catch(() => undefined);
		if (repository !== null) await git(repository, ["worktree", "prune"]).catch(() => undefined);
	}
}

interface CleanEnvironment {
	/** The clean equivalent of the workspace root. */
	root: string;
	dispose(): Promise<void>;
}

async function createCleanEnvironment(input: {
	spec: DeclaredReproduce;
	scratchRoot: string;
	workspaceRoot: string;
	repository: RepositoryState | null;
	inputs: ReadonlyArray<{ path: string; sha256: string; source: string }>;
	cwd: string;
}): Promise<CleanEnvironment> {
	await mkdir(input.scratchRoot, { recursive: true });
	const base = path.join(input.scratchRoot, randomUUID());
	const tree = path.join(base, "tree");
	let registered = false;
	const dispose = async () => {
		if (registered && input.repository !== null) {
			await git(input.repository.toplevel, ["worktree", "remove", "--force", tree]).catch(() => undefined);
		}
		await rm(base, { recursive: true, force: true });
		if (registered && input.repository !== null) {
			await git(input.repository.toplevel, ["worktree", "prune"]).catch(() => undefined);
		}
	};
	try {
		await mkdir(base, { recursive: true });
		const owner: EnvironmentOwner = {
			owner: currentProcessLease(),
			repository: reproduceEnvironment(input.spec) === "worktree" ? (input.repository?.toplevel ?? null) : null,
		};
		await writeFile(path.join(base, ENVIRONMENT_OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });
		let root: string;
		if (reproduceEnvironment(input.spec) === "worktree") {
			if (input.repository === null) throw new Error("worktree environment needs a git repository with a commit");
			// Hooks stay off: a verification checkout must not run the repository's post-checkout program.
			registered = true;
			await git(input.repository.toplevel, [
				"-c",
				"core.hooksPath=/dev/null",
				"worktree",
				"add",
				"--detach",
				"--quiet",
				tree,
				input.repository.commit,
			]);
			const relative = path.relative(await realpath(input.repository.toplevel), await realpath(input.workspaceRoot));
			root = path.join(tree, relative);
		} else {
			root = tree;
		}
		await mkdir(root, { recursive: true });
		for (const pin of input.inputs) {
			const destination = resolveSafeCwd(pin.path, root);
			await mkdir(path.dirname(destination), { recursive: true });
			await copyFile(pin.source, destination);
			const copied = await sha256File(destination);
			if (copied.sha256 !== pin.sha256) {
				throw new Error(`input '${pin.path}' changed while it was copied (sha256 ${copied.sha256})`);
			}
		}
		await mkdir(resolveSafeCwd(input.cwd, root), { recursive: true });
		return { root, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

function runFacts(result: SafeCommandResult, argv: string[], cwd: string): ReproduceRunFacts {
	return {
		argv,
		cwd,
		launched: result.launched === true,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		aborted: result.aborted,
		timedOut: result.timedOut,
		outputCapped: result.outputCapped,
	};
}

function notLaunchedFacts(argv: ReadonlyArray<string>, cwd: string): ReproduceRunFacts {
	return {
		argv: [...argv],
		cwd,
		launched: false,
		exitCode: null,
		durationMs: 0,
		aborted: false,
		timedOut: false,
		outputCapped: false,
	};
}

function runFailure(result: SafeCommandResult, timeoutMs: number): string | null {
	if (result.launched !== true)
		return `could not start: ${(result.stderr || result.failure || "no process was created").trim()}`;
	if (result.aborted) return "aborted";
	if (result.timedOut) return `timed out after ${timeoutMs}ms`;
	if (result.outputCapped) return `output exceeded ${REPRODUCE_MAX_OUTPUT_BYTES} bytes before judgement`;
	if (result.exitCode !== 0) {
		const tail = `${result.stdout}${result.stderr}`.trim().slice(-2_000);
		return `exited with code ${result.exitCode ?? "?"} before judgement${tail.length > 0 ? `: ${tail}` : ""}`;
	}
	return null;
}

export async function runReproduce(input: ReproduceRunInput): Promise<ReproduceOutcome> {
	const { spec, workspaceRoot } = input;
	const argvResolution = resolveCleanRunArgv(input.command, workspaceRoot);
	if (!argvResolution.ok) {
		return {
			kind: "refused",
			refusal: {
				reason: "interpreter-unavailable",
				message: `${argvResolution.reason}; nothing ran`,
				...(argvResolution.provisionCommand !== undefined ? { provisionCommand: argvResolution.provisionCommand } : {}),
			},
		};
	}
	const argv = argvResolution.argv;
	const verified = await verifyInputs(spec, workspaceRoot).catch(
		(error): ReproduceRefusal => ({
			reason: "input-unreadable",
			message: `inputs cannot be hashed (${errorText(error)}); nothing ran`,
		}),
	);
	if (!("records" in verified)) return { kind: "refused", refusal: verified };

	let referenceText: string | undefined;
	let referenceProvenance: NumericReferenceProvenance | undefined;
	if (spec.compare.mode === "reference") {
		const reference = spec.compare.reference;
		try {
			const read = readRegularFileText(resolveSafeCwd(reference, workspaceRoot), REPRODUCE_MAX_OUTPUT_BYTES);
			if (!read.ok)
				throw new Error(read.reason === "not-regular" ? "not a regular file" : `${read.size} bytes exceeds the cap`);
			referenceText = read.text;
		} catch (error) {
			return {
				kind: "refused",
				refusal: {
					reason: "reference-unreadable",
					message: `reference '${reference}' cannot be read (${errorText(error)}); nothing ran`,
				},
			};
		}
		referenceProvenance = {
			source: `reference '${reference}'`,
			path: reference,
			sha256: createHash("sha256").update(referenceText).digest("hex"),
			bytes: Buffer.byteLength(referenceText, "utf8"),
		};
	}

	const repository = await repositoryState(
		workspaceRoot,
		spec.inputs.map((pin) => pin.path),
	);
	if (reproduceEnvironment(spec) === "worktree" && repository === null) {
		return {
			kind: "refused",
			refusal: {
				reason: "not-a-repository",
				message: "environment worktree needs a git repository with at least one commit; nothing ran",
			},
		};
	}

	const platform: ReproducePlatform = {
		os: process.platform,
		arch: process.arch,
		release: release(),
		nodeVersion: process.versions.node,
		clioVersion: readClioVersion(),
	};
	if (argvResolution.interpreter !== undefined) {
		platform.interpreter = argvResolution.interpreter;
		const version = await pythonVersion(argvResolution.interpreter, workspaceRoot);
		if (version !== undefined) platform.pythonVersion = version;
	}
	const conditions: ReproduceConditions = {
		inputs: verified.records.map((record) => ({
			path: record.path,
			sha256: record.sha256,
			sizeBytes: record.sizeBytes,
			tracked: repository === null ? null : repository.tracked.has(record.path),
		})),
		environment: reproduceEnvironment(spec),
		commit: repository?.commit ?? null,
		trackedTreeClean: repository?.trackedTreeClean ?? null,
		seed: spec.seed !== undefined ? { ...spec.seed } : null,
		platform,
		argv: [...argv],
		cwd: input.cwd,
	};

	const scratchRoot = input.scratchRoot ?? path.join(clioStateDir(), "scratch", "reproduce");
	await sweepAbandonedEnvironments(scratchRoot);
	const runCount = spec.compare.mode === "twice" ? 2 : 1;
	const facts: ReproduceRunFacts[] = [];
	const records: ReproduceRunRecord[] = [];
	const payloads: ReproducePayload[] = [];
	for (let run = 1; run <= runCount; run += 1) {
		let environment: CleanEnvironment;
		try {
			environment = await createCleanEnvironment({
				spec,
				scratchRoot,
				workspaceRoot,
				repository,
				inputs: verified.records,
				cwd: input.cwd,
			});
		} catch (error) {
			const message = `clean ${reproduceEnvironment(spec)} environment for run ${run} could not be prepared (${errorText(error)})`;
			// Before the first run nothing ran; after it the check ran, and this run is the one that could not start.
			if (facts.length === 0) return { kind: "refused", refusal: { reason: "environment-setup-failed", message } };
			return {
				kind: "run-failed",
				run,
				facts: notLaunchedFacts(argv, input.cwd),
				completed: [...facts],
				message: `run ${run} could not start: ${message}`,
			};
		}
		let result: SafeCommandResult;
		const [file, ...rest] = argv;
		try {
			const cwd = resolveSafeCwd(input.cwd, environment.root);
			result = await runCommandVector(file as string, rest, {
				cwd,
				workspaceRoot: environment.root,
				timeoutMs: input.timeoutMs,
				maxOutputBytes: REPRODUCE_MAX_OUTPUT_BYTES,
				...(spec.seed !== undefined ? { env: { [spec.seed.env]: spec.seed.value } } : {}),
				...(input.signal !== undefined ? { signal: input.signal } : {}),
			});
		} catch (error) {
			return {
				kind: "run-failed",
				run,
				facts: notLaunchedFacts(argv, input.cwd),
				completed: [...facts],
				message: `run ${run} could not start: ${errorText(error)}`,
			};
		} finally {
			await environment.dispose();
		}
		const fact = runFacts(result, [...argv], input.cwd);
		const failure = runFailure(result, input.timeoutMs);
		if (failure !== null)
			return { kind: "run-failed", run, facts: fact, completed: [...facts], message: `run ${run} ${failure}` };
		facts.push(fact);
		const payloadText = extractNumericPayloadText(result.stdout);
		const payload = parseReproducePayload(payloadText, `run ${run} output`);
		if (payload instanceof Error) return { kind: "unjudgeable", message: payload.message, facts };
		payloads.push(payload);
		records.push({
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			payload: {
				sha256: createHash("sha256").update(payloadText).digest("hex"),
				bytes: Buffer.byteLength(payloadText, "utf8"),
			},
		});
	}

	let expected: ReproducePayload;
	if (referenceText !== undefined) {
		const parsed = parseReproducePayload(referenceText, `reference '${referenceProvenance?.path ?? ""}'`);
		if (parsed instanceof Error) return { kind: "unjudgeable", message: parsed.message, facts };
		expected = parsed;
	} else {
		expected = payloads[1] as ReproducePayload;
	}
	const report = judgeReproduce({
		spec,
		actual: payloads[0] as ReproducePayload,
		expected,
		expectedIsReference: referenceText !== undefined,
		conditions,
		runs: records,
		...(referenceProvenance !== undefined ? { reference: referenceProvenance } : {}),
	});
	return { kind: "judged", report, facts };
}
