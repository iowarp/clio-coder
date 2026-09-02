import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PATH_BOUNDARY_MAX_ENTRIES, pathBoundaryCovers, resolvePathBoundary } from "../../core/path-boundary.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { FLEET_COMMAND_BASE_ENV, type FleetCommand } from "../agents/fleet-commands.js";
import { runCodeStep } from "./code-step.js";
import type { DispatchRequest } from "./contract.js";
import type { RunHostVerification, RunHostVerificationAttribution, RunHostVerificationCheck } from "./types.js";
import { captureWorkspaceSnapshot } from "./write-boundary.js";

const OUTPUT_TAIL_BYTES = 2_048;
const MEMO_VERSION = 1;

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
	version: 1;
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
	return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

export function workspaceFingerprint(cwd: string): string | null {
	try {
		const snapshot = captureWorkspaceSnapshot(repositoryRoot(cwd));
		return sha256(
			JSON.stringify({
				head: snapshot.head,
				entries: [...snapshot.entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			}),
		);
	} catch {
		return null;
	}
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

function memoKey(command: FleetCommand, fingerprint: string, env: NodeJS.ProcessEnv): string {
	const names = [...FLEET_COMMAND_BASE_ENV, ...command.env];
	const values = Object.fromEntries(names.map((name) => [name, env[name] ?? null]));
	return sha256(JSON.stringify({ fingerprint, argv: command.argv, cwd: command.cwd, env: values }));
}

export function hostVerificationRejection(
	verification: RunHostVerification | undefined,
): { outcomeCode: "host_verification_rejected"; detail: string } | null {
	if (verification?.status !== "rejected") return null;
	const failedCheck = verification.checks.find((check) => check.exitCode !== 0);
	return {
		outcomeCode: "host_verification_rejected",
		detail:
			failedCheck === undefined
				? "host verification rejected"
				: `host verification check '${failedCheck.check}' rejected with exit code ${failedCheck.exitCode}`,
	};
}

async function runResolvedCheck(input: {
	runId: string;
	index: number;
	resolvedCheck: ResolvedCheck;
	stateDir: string;
	env: NodeJS.ProcessEnv;
	onDiagnostic?: (error: unknown) => void;
}): Promise<{ check: RunHostVerificationCheck; outputExcerpt: string }> {
	const resolvedCheck = input.resolvedCheck;
	const command: FleetCommand = {
		id: resolvedCheck.check,
		argv: [...resolvedCheck.argv],
		cwd: "",
		timeoutMs: resolvedCheck.timeoutMs,
		env: [],
		description: `Host verification check ${resolvedCheck.check}.`,
	};
	const fingerprint = workspaceFingerprint(resolvedCheck.cwd);
	const key =
		fingerprint === null ? null : memoKey({ ...command, cwd: resolve(resolvedCheck.cwd) }, fingerprint, input.env);
	const hit =
		key === null
			? undefined
			: readMemo(input.stateDir).entries.find((entry) => entry.key === key && entry.check.exitCode === 0);
	// A memo hit is always a pass, so no caller ever needs its output for
	// attribution; the empty excerpt says the fresh output does not exist.
	if (hit !== undefined) {
		return {
			check: { ...hit.check, argv: [...hit.check.argv], memo: true, evidenceRunId: hit.runId },
			outputExcerpt: "",
		};
	}
	const outcome = await runCodeStep({
		stepId: `verification-${input.index + 1}-${resolvedCheck.check.replace(/[^a-z0-9._-]/giu, "_")}`,
		command,
		workspaceRoot: resolvedCheck.cwd,
		artifactDir: join(input.stateDir, "artifacts", input.runId, "verification"),
		env: input.env,
	});
	const artifactPath = outcome.record.artifactPaths[0];
	const check: RunHostVerificationCheck = {
		check: resolvedCheck.check,
		argv: [...outcome.record.argv],
		cwd: outcome.record.cwd,
		exitCode: outcome.record.exitCode,
		durationMs: outcome.record.durationMs,
		memo: false,
		outputTail: outputTail(outcome.report.outputExcerpt),
		...(artifactPath !== undefined ? { artifactPath } : {}),
	};
	if (check.exitCode === 0 && key !== null) {
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

export async function runHostVerification(input: {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification">;
	workerSuccessful: boolean;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	onDiagnostic?: (error: unknown) => void;
}): Promise<RunHostVerification | undefined> {
	const checks = input.request.resolvedVerification;
	if (checks === undefined || checks.length === 0) return undefined;
	if (!input.workerSuccessful) return { status: "skipped", reason: "worker_not_successful", checks: [] };
	const stateDir = input.stateDir ?? clioStateDir();
	const env = input.env ?? process.env;
	const results: RunHostVerificationCheck[] = [];
	for (const [index, resolvedCheck] of checks.entries()) {
		const outcome = await runResolvedCheck({
			runId: input.runId,
			index,
			resolvedCheck,
			stateDir,
			env,
			...(input.onDiagnostic !== undefined ? { onDiagnostic: input.onDiagnostic } : {}),
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

/** Identity of a resolved check across batch members: same command, same cwd, same bound. */
function checkDedupeKey(resolvedCheck: ResolvedCheck): string {
	return sha256(
		JSON.stringify({
			check: resolvedCheck.check,
			argv: [...resolvedCheck.argv],
			cwd: resolve(resolvedCheck.cwd),
			timeoutMs: resolvedCheck.timeoutMs,
		}),
	);
}

export interface BatchVerificationParticipant {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification" | "intent" | "cwd">;
	workerSuccessful: boolean;
	onDiagnostic?: (error: unknown) => void;
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
		const hits = input.implicated.filter((path) => pathBoundaryCovers(boundary, path));
		if (hits.length === 0) continue;
		implicatedDeclarers.add(member.runId);
		for (const hit of hits) decisive.add(hit);
	}
	const others = input.wave.filter((member) => !declared.has(member.runId));
	const ownedElsewhere =
		input.implicated.length > 0 &&
		input.implicated.every((path) => others.some((member) => pathBoundaryCovers(memberBoundary(member), path)));
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
 * until dispatch finalization ends (`extension.ts:5720`), so the queued member's
 * `admit` would time out (`admission.ts:244-291`) and take the whole batch down
 * with it. Live-only membership still costs a queued member the difference
 * between the first live member finishing and the last, charged against the same
 * 60 s admission deadline (`extension.ts:2669`). That wait is not free: a batch
 * whose first member finishes inside the deadline and whose last does not now
 * expires the queued member's `admit`, and `dispatchBatch` aborts every already
 * dispatched run when one member's admission throws (`extension.ts:6197-6205`).
 * Releasing the lease before parking would let a fresh writer into the checkout
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
			...(participant.onDiagnostic !== undefined ? { onDiagnostic: participant.onDiagnostic } : {}),
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
		const distinct = new Map<
			string,
			{ resolvedCheck: ResolvedCheck; owner: BatchVerificationParticipant; index: number }
		>();
		for (const member of contributors) {
			for (const resolvedCheck of member.request.resolvedVerification ?? []) {
				const key = checkDedupeKey(resolvedCheck);
				if (!distinct.has(key)) distinct.set(key, { resolvedCheck, owner: member, index: distinct.size });
			}
		}
		const ran = new Map<string, { check: RunHostVerificationCheck; owner: string; outputExcerpt: string }>();
		for (const [key, entry] of distinct) {
			const outcome = await runResolvedCheck({
				runId: entry.owner.runId,
				index: entry.index,
				resolvedCheck: entry.resolvedCheck,
				stateDir,
				env,
				// The owning member's callback, because the artifact directory is
				// named for that same run and the diagnostic text is closed over the
				// run id it was built for (`extension.ts:5534`); any other member's
				// callback would name a run whose artifacts the failure is not under.
				...(entry.owner.onDiagnostic !== undefined ? { onDiagnostic: entry.owner.onDiagnostic } : {}),
			});
			ran.set(key, { check: outcome.check, owner: entry.owner.runId, outputExcerpt: outcome.outputExcerpt });
		}
		const attribution: RunHostVerificationAttribution[] = [];
		const chargedByKey = new Map<string, Set<string>>();
		for (const [key, entry] of ran) {
			if (entry.check.exitCode === 0) continue;
			const declarers = contributors.filter((member) =>
				(member.request.resolvedVerification ?? []).some((candidate) => checkDedupeKey(candidate) === key),
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
			for (const resolvedCheck of member.request.resolvedVerification ?? []) {
				const key = checkDedupeKey(resolvedCheck);
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
