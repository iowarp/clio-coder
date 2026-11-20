import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNonSourcePath, isProsePath } from "../../core/test-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import { isProjectVerifierCheckId, isVerificationScriptName } from "../../core/verification-scripts.js";
import { effectiveToolCall, expandChainMessages } from "../../tools/surface.js";
import {
	type DeclaredCheckSourceRef,
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	resolveProjectVerifierExecutionCwd,
} from "../../tools/verify/catalog.js";
import { assessQualityPolicy, loadQualityPolicy, type QualityFinding } from "../../tools/verify/quality-policy.js";
import { validateTrustStatus } from "../evidence/trust-status.js";
import type { ObservedCheck } from "../session/task-board.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import { callVerdict } from "./check-classifier.js";
import { type RunCheckFacts, runCheckFacts } from "./observed-checks.js";
import {
	type CommandStep,
	commandSteps,
	detectValidationCommand,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	heredocDataWriteTargets,
	scanShellLike,
	shellCommandWords,
	splitSegments,
	toolMutationPaths,
} from "./protected-artifacts.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_ADVISORY_MESSAGE =
	"[CLIO Coder] finish-contract advisory: you changed files this turn without recording validation evidence or a limitation receipt. Report the change as unverified. Run checks only within the operator's authorized scope; this advisory does not authorize tests, scripts, or additional tools.";

/**
 * Appended to the advisory when the workspace declares checks the turn did not
 * run in a form the contract can credit; the footer turns it into a `verify` hint.
 */
export const FINISH_CONTRACT_DECLARED_CHECKS_PREFIX = " Declared checks: ";

/** Appended for checks the caller declared for this run only (`run --verify`), which `verify` does not know. */
export const FINISH_CONTRACT_RUN_CHECKS_PREFIX = " Run checks: ";

/**
 * Appended for changed files a successful command ran after their last edit,
 * such as `python3 src/clean.py`. Running a file is not a check, so the change
 * stays unverified, but the footer must not say nothing ran.
 */
export const FINISH_CONTRACT_RAN_CHANGED_PREFIX = " Ran after the edit: ";

export const FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE =
	"[CLIO Coder] finish-contract advisory: checks passed; behavior coverage unverified. Passing receipts establish the recorded checks, not every changed behavior. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

/** Checks passed, but a check's last outcome since the last change is red, as the receipt seals it (bt-44). */
export const FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE =
	"[CLIO Coder] finish-contract advisory: a check failed after the last change; behavior coverage unverified. Its red outcome stands in the receipt beside any passing check. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

export const FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE =
	"[CLIO Coder] finish-contract advisory: validation evidence recorded; behavior coverage unverified. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

/**
 * The recent-window cap (entries since the last user message). Exported so a
 * tail-scoped reader can size its read as a multiple of this and stay in lockstep
 * with the window the contract actually inspects.
 */
export const DEFAULT_RECENT_ENTRY_LIMIT = 80;

export type FinishContractEvidenceKind =
	| "validation_command"
	| "protected_artifact"
	| "dispatch_run_record"
	| "limitation";

interface ValidationExecutionEvidence {
	source?: DeclaredCheckSourceRef;
	cwd?: string;
	argv?: ReadonlyArray<string>;
	durationMs?: number;
}

export interface FinishContractEvidence extends ValidationExecutionEvidence {
	kind: FinishContractEvidenceKind;
	summary: string;
	check?: string;
	paths?: ReadonlyArray<string>;
	turnId?: string;
}

/** CLB-3: declared checks and freshness are useful evidence, but neither records runtime behavior coverage. */
export interface FinishContractVerificationScope {
	behaviorCoverage: "unknown";
	passedChecks: ReadonlyArray<string>;
	acceptance: ReadonlyArray<{ check: string; state: "passed" | "limited" | "unverified" }>;
	limitations: ReadonlyArray<FinishContractEvidence>;
}

/** Why the contract settled. Every branch is auditable from the ledger alone. */
export type FinishContractReason =
	| "no_mutation"
	| "no_net_mutation"
	| "deletion_only"
	| "prose_only"
	| "validation_evidence"
	| "explicit_limitation"
	| "no_checks_declared"
	| "unvalidated_mutation";

export type FinishContractAssessment =
	| {
			kind: "ok";
			reason:
				| "no_mutation"
				| "no_net_mutation"
				| "deletion_only"
				| "prose_only"
				| "validation_evidence"
				| "explicit_limitation"
				| "no_checks_declared";
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
			advisory?: string;
	  }
	| {
			kind: "engage";
			reason: "unvalidated_mutation";
			message: string;
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
	  };

/** A check declared for this session that has no project catalog entry, such as `run --verify`. */
export interface SessionVerifier {
	id: string;
	/** A shell command string, run through the platform shell. */
	command: string;
}

export interface FinishContractInput {
	sessionEntries?: ReadonlyArray<unknown>;
	/** Checks declared for this session only (`run --verify`); they join the project catalog's. */
	sessionVerifiers?: ReadonlyArray<SessionVerifier>;
	assistantTurnId?: string | null;
	recentEntryLimit?: number;
	/**
	 * The user row a step pipeline began at (bt-12 #4): the window runs from it to the assistant turn, past the
	 * continuation rows in between and past `recentEntryLimit`, so the turn that ends the pipeline sees every step.
	 */
	windowStartTurnId?: string;
	rigor?: Rigor;
	activeAcceptance?: UserTaskAcceptance;
	/** Owning session workspace, supplied by the finish registration. */
	workspaceRoot?: string;
	/**
	 * Mutation targets whose state at turn end matches what it was before the
	 * turn first touched them: a create-then-delete probe changed nothing.
	 */
	unchangedPaths?: ReadonlySet<string>;
}

interface ToolCallEvidenceCandidate {
	turnId?: string;
	toolCallId: string;
	command: string;
	check?: string;
	paths?: string[];
	execution?: ValidationExecutionEvidence;
}

interface MutationCandidate {
	toolCallId: string;
	paths: string[];
	/** Targets the call wrote or created, as opposed to only removed. */
	writes: string[];
	/** Writes that stand even when the call exits nonzero ({@link heredocDataWriteTargets}). */
	settledWrites: string[];
	/** The targets are a shell command's, read from its text rather than named by a tool. */
	shell: boolean;
}

/**
 * Action-scoped completion contract. The engine keys off what the turn actually
 * DID, not how the prompt was phrased: it engages only when the recent window
 * mutated workspace state and then settled (turn_end) without recording
 * validation evidence or a limitation receipt. The turn settling is itself
 * the completion signal, so the model never has to type "done" to be gated, and
 * a work request phrased as a question cannot bypass the gate.
 *
 * Decision order (pure function of ledger receipts):
 *   1. no mutating receipt in the window        -> ok/no_mutation
 *   2. validation evidence present              -> ok/validation_evidence, with bounded scope advisory
 *   3. successful `limitation` receipt present  -> ok/explicit_limitation
 *      or verify reported no declared check     -> ok/no_checks_declared
 *   4. only prose written, or only non-source removed -> ok/prose_only or ok/deletion_only
 *   5. otherwise                                -> engage/unvalidated_mutation
 *
 * The assistant's prose never enters the decision. A limitation counts only
 * as a `limitation` tool_call paired with a non-error tool_result inside the
 * same window the mutation scan uses, so a run cannot satisfy the contract by
 * wording alone and a real limitation is never missed for its phrasing.
 */
export function assessFinishContract(input: FinishContractInput): FinishContractAssessment {
	const scope = assessmentScope(input);
	const assessment = assessMutationFinishContract(input, scope);
	if (
		assessment.mutatedPaths.length === 0 ||
		assessment.reason === "deletion_only" ||
		assessment.reason === "prose_only"
	)
		return assessment;
	const limitations = assessment.evidence.filter((item) => item.kind === "limitation");
	const passedChecks = [
		...assessment.evidence.filter((item) => item.kind === "validation_command").map((item) => item.check ?? item.summary),
		...(assessment.quality?.filter((finding) => finding.state === "passed").map((finding) => finding.check) ?? []),
	];
	const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
	const verificationScope: FinishContractVerificationScope = {
		behaviorCoverage: "unknown",
		passedChecks: [...new Set(passedChecks)],
		acceptance: (input.activeAcceptance?.verification ?? []).map((required) => ({
			check: required.check,
			state: assessment.evidence.some((item) => acceptanceCheckPassed(item, required, input.workspaceRoot))
				? "passed"
				: limited.has(required.check)
					? "limited"
					: "unverified",
		})),
		limitations,
	};
	// CLB-3: an OK decision permits completion; it is not a correctness verdict.
	// No current receipt describes runtime behavior coverage, including a fresh
	// quality snapshot or a pass for an explicitly requested acceptance check.
	const hasPassedChecks = passedChecks.length > 0;
	const hasEvidence = hasPassedChecks || assessment.evidence.some((item) => item.kind !== "limitation");
	return {
		...assessment,
		verificationScope,
		...(assessment.kind === "ok" && hasEvidence
			? {
					advisory: !hasPassedChecks
						? FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE
						: checkFailedSinceLastChange(input, scope)
							? FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE
							: FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE,
				}
			: {}),
	};
}

/** The window one assessment reads, with its declared checks and the shared fold over it, each read at most once. */
interface AssessmentScope {
	window: ReadonlyArray<unknown>;
	declared(): ReadonlyArray<DeclaredVerifierCommand>;
	/** The shared classifier's replay of the window, run once per assessment for every consumer (x8-6). */
	facts(): RunCheckFacts;
}

function assessmentScope(input: FinishContractInput): AssessmentScope {
	const window = recentEntries(
		input.sessionEntries ?? [],
		input.assistantTurnId ?? null,
		input.recentEntryLimit ?? DEFAULT_RECENT_ENTRY_LIMIT,
		input.windowStartTurnId,
	);
	let declared: DeclaredVerifierCommand[] | undefined;
	let facts: RunCheckFacts | undefined;
	const scope: AssessmentScope = {
		window,
		declared: () => {
			declared ??= declaredVerifierCommands(input.workspaceRoot, input.sessionVerifiers);
			return declared;
		},
		facts: () => {
			const root = resolve(input.workspaceRoot ?? ".");
			facts ??= runCheckFacts(window, root, [...scope.declared(), ...acceptanceScriptChecks(input, root)]);
			return facts;
		},
	};
	return scope;
}

/**
 * The package scripts only the operator's acceptance admits as checks (`npm run custom`), declared to the fold so
 * their freshness is read with every other check's.
 */
function acceptanceScriptChecks(input: FinishContractInput, root: string): DeclaredVerifierCommand[] {
	return (input.activeAcceptance?.verification ?? []).flatMap(({ check }) => {
		const words = ["npm", "run", check];
		if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(check) || callVerdict(ToolNames.Bash, { command: words.join(" ") }) === "check")
			return [];
		return [{ id: check, segments: [words], cwd: root, session: true }];
	});
}

/**
 * Whether a check's last outcome since the run's last change is red, read by the shared classifier's replay as the
 * run-effects recorder seals it, so the notice never says checks passed beside a red the receipt keeps (bt-44).
 */
function checkFailedSinceLastChange(input: FinishContractInput, scope: AssessmentScope): boolean {
	if (input.workspaceRoot === undefined) return false;
	// Only a failed result can seal a red, so an all-green window skips the replay's reads.
	if (!capabilityEntries(scope.window).some(failedResult)) return false;
	return scope.facts().failing.length > 0;
}

function failedResult(entry: unknown): boolean {
	const record = asRecord(entry);
	if (record?.kind === "bashExecution") return typeof record.exitCode === "number" && record.exitCode !== 0;
	if (record?.kind !== "message" || record.role !== "tool_result") return false;
	const payload = asRecord(record.payload);
	const result = asRecord(payload?.result);
	const details = asRecord(result?.details);
	return (
		payload?.isError === true ||
		payload?.error === true ||
		result?.kind === "error" ||
		details?.kind === "error" ||
		(typeof details?.exitCode === "number" && details.exitCode !== 0) ||
		asRecord(details?.chainAdmission)?.outcome === "error" ||
		payload?.outcome === "error"
	);
}

function assessMutationFinishContract(input: FinishContractInput, scope: AssessmentScope): FinishContractAssessment {
	const sessionEntries = input.sessionEntries ?? [];
	const assistantTurnId = input.assistantTurnId ?? null;
	const { window } = scope;

	const { paths: touchedPaths, written } = mutatingReceipts(
		window,
		input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : undefined,
	);
	if (touchedPaths.length === 0) {
		return { kind: "ok", reason: "no_mutation", evidence: [], mutatedPaths: touchedPaths };
	}
	const unchanged = input.unchangedPaths;
	// The contract guards workspace state. A note written outside the workspace
	// is not a code change that needs validation evidence.
	const inWorkspace = input.workspaceRoot
		? touchedPaths.filter((path) => isWithinWorkspace(path, input.workspaceRoot as string))
		: touchedPaths;
	const mutatedPaths = inWorkspace.filter(
		(path) => !unchanged?.has(path) && !isClioConfigurationPath(path, input.workspaceRoot),
	);
	if (mutatedPaths.length === 0) {
		return { kind: "ok", reason: "no_net_mutation", evidence: [], mutatedPaths };
	}

	const acceptanceChecks = new Set(input.activeAcceptance?.verification.map((item) => item.check) ?? []);
	const declared = scope.declared();
	const evidence = collectValidationEvidence(
		window,
		acceptanceChecks,
		input.workspaceRoot,
		declared,
		scope.facts().passCalls,
	);
	const limitations = collectLimitationEvidence(window);
	let quality: QualityFinding[] = [];
	if (input.workspaceRoot) {
		const loaded = loadQualityPolicy(input.workspaceRoot);
		if (!loaded.ok)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[CLIO Coder] quality policy cannot be assessed: ${loaded.reason}. Report the change as unverified; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
			};
		if (loaded.policy)
			quality = assessQualityPolicy(input.workspaceRoot, loaded.policy, mutatedPaths, capabilityEntries(window));
		const outstanding = quality.filter((finding) => finding.state !== "passed" && finding.state !== "limited");
		if (outstanding.length)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[CLIO Coder] project quality policy has outstanding checks: ${outstanding.map((finding) => `${finding.rule}/${finding.check}: ${finding.state} (${finding.message})`).join("; ")}. Run checks only within the operator's authorized scope; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				quality,
			};
	}
	const required = input.rigor === "high" ? (input.activeAcceptance?.verification ?? []) : [];
	if (required.length > 0) {
		const passes = new Set(
			required.filter((check) => evidence.some((item) => acceptanceCheckPassed(item, check, input.workspaceRoot))),
		);
		const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
		const missing = [
			...new Set(required.filter((check) => !passes.has(check) && !limited.has(check.check)).map((item) => item.check)),
		];
		if (missing.length > 0)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[CLIO Coder] High-rigor finish gate: operator acceptance still requires passing validation for: ${missing.join(", ")}. Run each named check or include its exact id in limitation.paths.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				...(quality.length ? { quality } : {}),
			};
		return {
			kind: "ok",
			reason: passes.size === required.length ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			...(quality.length ? { quality } : {}),
		};
	}
	if (quality.length > 0)
		return {
			kind: "ok",
			reason: quality.every((finding) => finding.state === "passed") ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			quality,
		};
	if (evidence.length > 0) {
		return { kind: "ok", reason: "validation_evidence", evidence: [...evidence, ...limitations], mutatedPaths };
	}

	if (limitations.length > 0) {
		return { kind: "ok", reason: "explicit_limitation", evidence: limitations, mutatedPaths };
	}
	// A workspace with no check to run is a fact the verify receipt states, not a gap the turn left open.
	if (declared.length === 0 && verifyFoundNoChecks(window)) {
		return { kind: "ok", reason: "no_checks_declared", evidence: [], mutatedPaths };
	}
	// A handoff note, a spec or a Mermaid diagram has no check to run, so
	// writing only prose is not an unverified change.
	if (mutatedPaths.every((path) => isProsePath(path))) {
		return { kind: "ok", reason: "prose_only", evidence: [], mutatedPaths };
	}
	// Removing tests or docs leaves nothing to check (D2-t2-b). Removing source
	// can break imports or the build, so it still earns the advisory unless the
	// operator's own message asked for that removal (F-Y1); quality and
	// acceptance gates above applied either way.
	const request = latestUserText(sessionEntries, assistantTurnId);
	if (
		mutatedPaths.every(
			(path) => !written.has(path) && (isNonSourcePath(path) || operatorRequestedDeletion(path, request)),
		)
	) {
		return { kind: "ok", reason: "deletion_only", evidence: [], mutatedPaths };
	}

	const named = (prefix: string, session: boolean) => {
		const ids = [...new Set(declared.filter((check) => check.session === session).map((check) => check.id))];
		return ids.length > 0 ? `${prefix}${ids.join(", ")}.` : "";
	};
	const ran = changedFilesRunAfterEdit(window, mutatedPaths, input.workspaceRoot);
	return {
		kind: "engage",
		reason: "unvalidated_mutation",
		message: `${FINISH_CONTRACT_ADVISORY_MESSAGE}${named(FINISH_CONTRACT_DECLARED_CHECKS_PREFIX, false)}${named(FINISH_CONTRACT_RUN_CHECKS_PREFIX, true)}${ran.length > 0 ? `${FINISH_CONTRACT_RAN_CHANGED_PREFIX}${ran.join(", ")}.` : ""}`,
		evidence: [],
		mutatedPaths,
	};
}

/** A declared check as the `&&` segments a shell run must contain, in the cwd it must run from. */
export interface DeclaredVerifierCommand {
	id: string;
	segments: string[][];
	cwd: string;
	/** Declared for this session only, so `verify` cannot run it by id. */
	session: boolean;
}

/**
 * Plain `command` checks of the project catalog plus the session's own. A
 * numeric, perf or reproduce check judges more than an exit code, and a sweep
 * check never runs bare, so running their command through the shell proves
 * nothing and they are left out. The shared classifier reads a shell run of one
 * as a check (x7-5).
 */
export function declaredVerifierCommands(
	workspaceRoot: string | undefined,
	sessionVerifiers: ReadonlyArray<SessionVerifier> | undefined,
): DeclaredVerifierCommand[] {
	if (workspaceRoot === undefined) return [];
	const root = resolve(workspaceRoot);
	const declared: DeclaredVerifierCommand[] = [];
	for (const verifier of sessionVerifiers ?? []) {
		const segments = shellAndSegments(verifier.command);
		if (segments !== null) declared.push({ id: verifier.id, segments, cwd: root, session: true });
	}
	try {
		const loaded = loadProjectVerifierCatalog(root);
		for (const check of loaded.ok ? (loaded.source?.checks ?? []) : []) {
			if (check.kind !== "command" || check.runs !== undefined) continue;
			const cwd = resolveProjectVerifierExecutionCwd(check.cwd, root);
			if (cwd instanceof Error) continue;
			declared.push({ id: check.id, segments: [check.command], cwd: resolve(cwd), session: false });
		}
	} catch {
		// An unreadable catalog declares nothing the shell could be credited for.
	}
	return declared;
}

/**
 * The literal words of each segment of a pure `&&` chain, or null when the
 * command is anything else. Exit 0 of such a chain means every segment exited
 * 0, which `;`, `||`, pipes, redirections and background jobs do not promise.
 * Any word the shell would expand ($, backticks, substitutions, `~`, globs) is
 * refused too, since its literal text is not what ran.
 */
function shellAndSegments(command: string): string[][] | null {
	const segments: string[][] = [[]];
	for (const token of scanShellLike(command)) {
		const current = segments[segments.length - 1] as string[];
		if (token.operator) {
			if (token.value !== "&&" || current.length === 0) return null;
			segments.push([]);
			continue;
		}
		if (token.substitutions?.length || token.hiddenContent || token.ansiCQuoted || token.homeRelative) return null;
		const raw = command.slice(token.start, token.end);
		if (/[$`]/u.test(raw) && !/^'[^']*'$/u.test(raw)) return null;
		if (!token.quoted && /[*?[]/u.test(token.value)) return null;
		current.push(token.value);
	}
	return segments.every((segment) => segment.length > 0) ? segments : null;
}

/**
 * Words that, leading an earlier `&&` segment, can end the shell, replace it,
 * or change its cwd or what a later word runs, so a later segment that reads
 * like a check may never have run, or ran somewhere or as something else.
 */
const SHELL_STATE_WORDS = new Set([
	".",
	"alias",
	"builtin",
	"cd",
	"command",
	"declare",
	"enable",
	"eval",
	"exec",
	"exit",
	"export",
	"function",
	"hash",
	"kill",
	"local",
	"logout",
	"popd",
	"pushd",
	"readonly",
	"return",
	"set",
	"shopt",
	"source",
	"suspend",
	"trap",
	"typeset",
	"unalias",
	"unset",
]);

/**
 * Words that run the rest of their segment as a command, such as `/usr/bin/time exit 0`
 * or `env cd /`. The guard does not model what they run, so a segment they
 * lead ends the part of the chain that can be credited, as a state change does.
 * A leading `time`, `timeout`, `nice` or `xvfb-run` is read through to the
 * command it runs, as every check reader reads it (x10-1).
 */
const COMMAND_PREFIX_WORDS = new Set([
	"!",
	"busybox",
	"chroot",
	"coproc",
	"doas",
	"env",
	"ionice",
	"nice",
	"nohup",
	"setsid",
	"stdbuf",
	"sudo",
	"taskset",
	"time",
	"timeout",
	"unbuffer",
	"xargs",
]);

const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;

function changesShellState(step: CommandStep): boolean {
	if (!step.literal) return true;
	// A bare assignment persists for the rest of the chain; one before a command applies to that command only.
	const word = step.argv.slice(step.command).find((candidate) => !SHELL_ASSIGNMENT.test(candidate));
	if (word === undefined || SHELL_STATE_WORDS.has(word)) return true;
	const name = word.slice(word.lastIndexOf("/") + 1);
	return COMMAND_PREFIX_WORDS.has(name) || SHELL_STATE_WORDS.has(name);
}

/** A declared check a shell command ran whole, and the indices of the steps that ran it. */
export interface DeclaredCheckRun {
	check: DeclaredVerifierCommand;
	steps: number[];
}

/**
 * Every declared check a shell command runs whole, each as a contiguous `&&` run
 * of the classifier's own steps ({@link commandSteps}) that no earlier step could
 * have skipped, redirected or moved to another cwd. A step runs a declared
 * segment when its words, or the command a leading `time`, `timeout`, `nice` or
 * `xvfb-run` runs, are exactly that segment's, so `make ci FOO=1` runs no `make
 * ci`. A leading `cd <dir> &&` moves where the rest ran. This only names the
 * steps; whether the call settles them (pipes, logs, `2>&1`) and stands after
 * the run's changes is the shared classifier's answer, as for any check (x7-5,
 * x10-1).
 */
export function declaredCheckRuns(
	command: string,
	base: string,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): DeclaredCheckRun[] {
	if (declared.length === 0) return [];
	let steps = commandSteps(command);
	if (steps.length === 0 || steps.some((step) => step.grouped)) return [];
	let ranIn = resolve(base);
	let offset = 0;
	const [first] = steps;
	if (
		first?.argv[0] === "cd" &&
		first.argv.length === 2 &&
		first.literal &&
		first.joinedBy === "&&" &&
		steps.length > 1 &&
		!first.argv[1]?.startsWith("-")
	) {
		ranIn = resolve(base, first.argv[1] as string);
		offset = 1;
		steps = steps.slice(1);
	}
	const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
		left.length === right.length && left.every((word, index) => word === right[index]);
	const runs = (segment: ReadonlyArray<string>, step: CommandStep | undefined) =>
		step !== undefined && step.literal && (same(segment, step.argv) || same(segment, step.argv.slice(step.command)));
	const firstStateChange = steps.findIndex(changesShellState);
	const reachable = firstStateChange === -1 ? steps.length : firstStateChange + 1;
	const matches: DeclaredCheckRun[] = [];
	for (const check of declared) {
		if (check.cwd !== ranIn) continue;
		// The last run of a check is the one the fewest later steps can undo.
		let end = -1;
		for (let start = 0; start < reachable && start + check.segments.length <= steps.length; start += 1) {
			const ran = check.segments.every(
				(segment, index) =>
					runs(segment, steps[start + index]) &&
					(index === check.segments.length - 1 || steps[start + index]?.joinedBy === "&&"),
			);
			if (ran) end = start + check.segments.length;
		}
		if (end === -1) continue;
		const indices = check.segments.map((_, index) => end - check.segments.length + index + offset);
		matches.push({ check, steps: indices });
	}
	return matches;
}

function isClioConfigurationPath(path: string, workspaceRoot: string | undefined): boolean {
	const root = resolve(workspaceRoot ?? ".");
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	const local = relative(root, target).split(sep).join("/");
	return /^\.clio-coder\/(?:settings(?:\.local)?\.yaml|playbooks\/[^/]+\.md)$/u.test(local);
}

/** Relative targets resolve against the workspace; `~` and absolute paths are judged where they land. */
function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
	const root = resolve(workspaceRoot);
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function acceptanceCheckPassed(
	evidence: FinishContractEvidence,
	required: UserTaskAcceptance["verification"][number],
	workspaceRoot: string | undefined,
): boolean {
	if (evidence.kind !== "validation_command" || evidence.check !== required.check || !workspaceRoot || !evidence.source)
		return false;
	if (evidence.durationMs !== undefined && evidence.durationMs > required.timeoutMs) return false;
	const root = resolve(workspaceRoot);
	if (evidence.source.kind === "project-catalog")
		return evidence.source.path === resolve(root, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH);
	return (
		evidence.source.path === resolve(root, "package.json") &&
		evidence.cwd === root &&
		validationCheckId(evidence.argv?.join(" ") ?? "") === required.check
	);
}

/**
 * Recent entries as the capabilities that ran. The coordinator reaches verify,
 * bash and limitation only through gateway op=call or op=chain, so a scan keyed
 * on the recorded name would never see that evidence and would keep demanding
 * validation the model already ran. Result entries keep their own ids.
 */
export function capabilityEntries(recent: ReadonlyArray<unknown>): unknown[] {
	return expandChainMessages(recent).map((entry) => {
		const record = asRecord(entry);
		if (record?.kind !== "message" || record.role !== "tool_call") return entry;
		const payload = asRecord(record.payload);
		const recorded = payload === null ? null : stringFromFirst(payload, ["name", "toolName", "tool"]);
		if (payload === null || recorded === null) return entry;
		const call = effectiveToolCall(recorded, payload.args ?? payload.arguments ?? payload.input);
		if (!call.viaGateway) return entry;
		return { ...record, payload: { ...payload, name: call.toolName, args: call.args ?? {} } };
	});
}

/**
 * Successful `limitation` receipts over the recent window. A receipt is a
 * `limitation` tool_call whose tool_result in the same window is not an
 * error, judged by the same `successfulToolResultId` rule the mutation and
 * validation scans use. A call the tool rejected (bad reason, empty scope)
 * leaves no receipt, so it cannot settle the contract.
 */
function collectLimitationEvidence(recent: ReadonlyArray<unknown>): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const calls = new Map<string, ToolCallEvidenceCandidate>();
	const seen = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		const call = limitationToolCall(entry);
		if (call !== null) {
			calls.set(call.toolCallId, call);
			continue;
		}
		const resultId = successfulToolResultId(entry);
		if (resultId === null) continue;
		const candidate = calls.get(resultId);
		if (candidate === undefined) continue;
		const item: FinishContractEvidence = {
			kind: "limitation",
			summary: candidate.command,
			...(candidate.paths ? { paths: candidate.paths } : {}),
		};
		if (candidate.turnId !== undefined) item.turnId = candidate.turnId;
		pushEvidence(evidence, seen, item);
	}

	return evidence;
}

/**
 * A verify result in the window whose typed details say the workspace declares and derives no check: the list, or a
 * named check that resolved to nothing and so stays an error that credits no pass.
 */
export function verifyFoundNoChecks(recent: ReadonlyArray<unknown>): boolean {
	const calls = new Set<string>();
	for (const entry of capabilityEntries(recent)) {
		const record = asRecord(entry);
		const payload = asRecord(record?.payload);
		if (payload === null) continue;
		if (record?.role === "tool_call") {
			const id = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
			if (id !== null && stringFromFirst(payload, ["name", "toolName", "tool"]) === ToolNames.Verify) calls.add(id);
			continue;
		}
		if (record?.role !== "tool_result" || payload.outcome === "blocked" || typeof payload.blockReason === "string")
			continue;
		const resultId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
		if (
			resultId !== null &&
			calls.has(resultId) &&
			asRecord(asRecord(payload.result)?.details)?.noChecksDeclared === true
		)
			return true;
	}
	return false;
}

function limitationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== ToolNames.Limitation) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
	const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		paths: Array.isArray(args?.paths)
			? args.paths.filter((item): item is string => typeof item === "string").map((item) => item.trim())
			: [],
		command: `limitation recorded: ${scope.length > 0 ? scope : "unspecified"} (reason=${reason.length > 0 ? reason : "unspecified"})`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * Paths the turn actually mutated, drawn only from successful (non-error)
 * receipts inside the window:
 *   - write / edit / artifact, via `toolMutationPaths`.
 *   - bash whose command carries a workspace write or delete target, via
 *     `extractCommandWriteTargets` / `extractCommandDeleteTargets`.
 * Read-only git and pure read/grep/find/ls/exec/web_fetch receipts contribute
 * nothing, so the contract can never fire on a retrieval or execution-only
 * turn. Grounded in the same mutation notion the action classifier records, so
 * the audit ledger and this gate stay consistent about what counts as a change.
 */
export function mutatingReceipts(
	recent: ReadonlyArray<unknown>,
	/** Where shell targets land: relative ones resolve against `cwd`, which defaults to the workspace root. */
	place?: { workspaceRoot: string; cwd?: string },
): { paths: string[]; written: Set<string> } {
	const mutationCalls = new Map<string, MutationCandidate>();
	const paths: string[] = [];
	const seen = new Set<string>();
	const written = new Set<string>();
	const shellPaths = new Set<string>();
	const toolPaths = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		// A user-run `!` bash execution is self-contained: it carries its own
		// success signal, so any mutation targets count without a paired result.
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			for (const path of bashMutation.paths) {
				pushPath(paths, seen, path);
				shellPaths.add(path);
			}
			for (const path of bashMutation.writes) written.add(path);
			continue;
		}

		const call = mutatingToolCall(entry);
		if (call !== null) {
			mutationCalls.set(call.toolCallId, call);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const candidate = mutationCalls.get(resultId);
			if (candidate !== undefined) {
				for (const path of candidate.paths) {
					pushPath(paths, seen, path);
					(candidate.shell ? shellPaths : toolPaths).add(path);
				}
				for (const path of candidate.writes) written.add(path);
			}
			continue;
		}
		// A here-document written ahead of a failing suite run is still on disk (SF-5).
		const failedId = ranToNonzeroExitResultId(entry);
		const failed = failedId === null ? undefined : mutationCalls.get(failedId);
		for (const path of failed?.settledWrites ?? []) {
			pushPath(paths, seen, path);
			shellPaths.add(path);
			written.add(path);
		}
	}

	if (shellPaths.size === 0) return { paths, written };
	const kept = workspaceShellTargets([...shellPaths], place);
	const changes = (path: string): boolean => toolPaths.has(path) || !shellPaths.has(path) || kept.has(path);
	return { paths: paths.filter(changes), written: new Set([...written].filter(changes)) };
}

/** A shell target with `~`, `$TMPDIR` and `$HOME` expanded, or null while it still names a variable or substitution. */
function expandShellTarget(target: string): string | null {
	const expanded = target
		.replace(/^~(?=\/|$)/u, "$HOME")
		.replace(
			/\$\{(TMPDIR|HOME)\}|\$(TMPDIR|HOME)(?![A-Za-z0-9_])/gu,
			(_match, braced?: string, bare?: string) => process.env[braced ?? bare ?? ""] || "\0",
		);
	return /[$`\0]/u.test(expanded) ? null : expanded;
}

/**
 * The shell write targets that change the workspace. One that still names a variable or substitution (`$OUT/x`,
 * `$(mktemp)`) names no workspace path, and once `~`, `$TMPDIR` and `$HOME` expand, one outside the workspace or one git
 * ignores there leaves the tree as it was: a check's log or a scratch patch is no changed file (FX-1). Without a place
 * only the unexpanded ones drop.
 */
function workspaceShellTargets(
	targets: ReadonlyArray<string>,
	place: { workspaceRoot: string; cwd?: string } | undefined,
): Set<string> {
	const inside = new Map<string, string>();
	for (const target of targets) {
		const expanded = expandShellTarget(target);
		if (expanded === null) continue;
		if (place === undefined) {
			inside.set(target, "");
			continue;
		}
		const absolute = resolve(place.cwd ?? place.workspaceRoot, expanded);
		if (isWithinWorkspace(absolute, place.workspaceRoot))
			inside.set(target, relative(resolve(place.workspaceRoot), absolute) || ".");
	}
	const ignored = place === undefined ? new Set<string>() : gitIgnoredPaths([...inside.values()], place.workspaceRoot);
	return new Set([...inside].filter(([, local]) => !ignored.has(local)).map(([target]) => target));
}

/** The workspace-relative paths git ignores; none when there is no repository or no git, which proves nothing. */
function gitIgnoredPaths(paths: ReadonlyArray<string>, workspaceRoot: string): Set<string> {
	const asked = paths.filter((path) => path !== "" && path !== ".");
	if (asked.length === 0) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
			cwd: workspaceRoot,
			input: asked.join("\0"),
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: 5000,
		});
		return new Set(out.split("\0").filter((path) => path.length > 0));
	} catch {
		// Exit 1 means none is ignored.
		return new Set();
	}
}

/** Mutation targets for a tool call, empty for read-only/execute-only tools. */
export function mutationPathsForTool(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === ToolNames.Bash) {
		const command = typeof args?.command === "string" ? args.command : null;
		if (command === null) return [];
		return [...extractCommandWriteTargets(command), ...extractCommandDeleteTargets(command)];
	}
	return toolMutationPaths(toolName, args);
}

function mutatingToolCall(entry: unknown): MutationCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const recordedTool = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (recordedTool === null) return null;
	// An artifact written through the gateway mutates the same path a direct
	// artifact call would, so the call unwraps to the capability first.
	const { toolName, args } = effectiveToolCall(
		recordedTool,
		asRecord(payload.args ?? payload.arguments ?? payload.input) ?? undefined,
	);
	const paths = mutationPathsForTool(toolName, args);
	if (paths.length === 0) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const command = toolName === ToolNames.Bash && typeof args?.command === "string" ? args.command : null;
	return {
		toolCallId,
		paths,
		writes: command === null ? paths : extractCommandWriteTargets(command),
		settledWrites: command === null ? [] : heredocDataWriteTargets(command),
		shell: command !== null,
	};
}

/**
 * Mutation targets of a settled `!` bash execution entry. Returns null when the
 * entry is not a successful bash execution so the caller falls through to the
 * tool_call/tool_result pairing path; returns `[]` for a successful command
 * with no write/delete target (a read-only `!` command is not a mutation).
 */
function bashExecutionMutationPaths(entry: unknown): { paths: string[]; writes: string[] } | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true || record.exitCode !== 0) return null;
	const writes = extractCommandWriteTargets(record.command);
	return { paths: [...writes, ...extractCommandDeleteTargets(record.command)], writes };
}

function pushPath(paths: string[], seen: Set<string>, path: string): void {
	if (path.length === 0 || seen.has(path)) return;
	seen.add(path);
	paths.push(path);
}

/**
 * Receipt-based validation evidence over the recent window: shell and operator
 * `!` checks the shared fold settled, verify check runs, passed dispatch
 * receipts, and protected-artifact records. The finish vocabulary
 * (`detectValidationCommand`) only labels a shell check and admits its package
 * execution; it never decides whether one is credited.
 * Inspection was removed because inspecting the repo is never a mutation, so it
 * can no longer be on the path to engaging the contract.
 */
function collectValidationEvidence(
	recent: ReadonlyArray<unknown>,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
	standing: ReadonlyMap<string, ObservedCheck>,
): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const toolCalls = new Map<string, ToolCallEvidenceCandidate>();
	const declaredRuns = new Map<string, ToolCallEvidenceCandidate[]>();
	const dispatchCalls = new Map<string, ToolCallEvidenceCandidate>();
	const shellCalls = new Map<string, string | null>();
	const seen = new Set<string>();
	const entries = capabilityEntries(recent);
	// A check run through the shell, `verify`, an operator's `!` or a dispatch run record counts only where the shared
	// fold settled its pass and no later change retired it, the same fold the task board and the recorder's change
	// sequence use (x7-5, x8-1). `standing` keys a call by its id and a `!` run by `#<index>` into these same entries.

	for (const [index, entry] of entries.entries()) {
		const protectedArtifact = protectedArtifactEvidence(entry);
		if (protectedArtifact !== null) {
			pushEvidence(evidence, seen, protectedArtifact);
			continue;
		}

		// A declared check credits on its own terms even when the command is also a generic validation command.
		const declaredCalls = bashDeclaredVerifierCalls(entry, workspaceRoot, declared);
		const declaredCallId = declaredCalls[0]?.toolCallId;
		if (declaredCallId !== undefined) declaredRuns.set(declaredCallId, declaredCalls);

		const call = bashValidationCall(entry, acceptanceChecks, workspaceRoot);
		if (call !== null) {
			toolCalls.set(call.toolCallId, call);
			continue;
		}
		if (declaredCallId !== undefined) continue;
		const shellCallId = bashCallId(entry);
		if (shellCallId !== null) {
			shellCalls.set(shellCallId, turnIdOf(entry));
			continue;
		}

		const typedValidationCall = validationToolCall(entry);
		if (typedValidationCall !== null) {
			toolCalls.set(typedValidationCall.toolCallId, typedValidationCall);
			continue;
		}

		const dispatchCall = dispatchEvidenceCall(entry);
		if (dispatchCall !== null) {
			dispatchCalls.set(dispatchCall.toolCallId, dispatchCall);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const pass = standing.get(resultId);
			if (pass === undefined) continue;
			const dispatchRunRecord = dispatchRunRecordEvidence(entry, dispatchCalls.get(resultId));
			if (dispatchRunRecord !== null) {
				pushEvidence(evidence, seen, dispatchRunRecord);
				continue;
			}
			const candidate = toolCalls.get(resultId);
			if (candidate !== undefined) pushEvidence(evidence, seen, validationEvidence(candidate, entry));
			for (const declaredCandidate of declaredRuns.get(resultId) ?? [])
				pushEvidence(evidence, seen, validationEvidence(declaredCandidate, entry));
			if (shellCalls.has(resultId))
				pushEvidence(evidence, seen, observedCheckEvidence(pass, shellCalls.get(resultId) ?? null));
			continue;
		}

		const pass = standing.get(`#${index}`);
		if (pass === undefined) continue;
		const bashExecution = bashExecutionEvidence(entry, acceptanceChecks, workspaceRoot);
		const declaredExecutions = bashExecutionDeclaredEvidence(entry, workspaceRoot, declared);
		if (bashExecution !== null) pushEvidence(evidence, seen, bashExecution);
		for (const declaredExecution of declaredExecutions) pushEvidence(evidence, seen, declaredExecution);
		if (bashExecution === null && declaredExecutions.length === 0) {
			const marker = asRecord(entry)?.excludeFromContext === true ? " [not sent to model]" : "";
			pushEvidence(evidence, seen, observedCheckEvidence(pass, turnIdOf(entry), marker));
		}
	}

	return evidence;
}

export function recentEntries(
	entries: ReadonlyArray<unknown>,
	assistantTurnId: string | null,
	recentEntryLimit: number,
	startTurnId?: string,
): ReadonlyArray<unknown> {
	const boundedLimit =
		Number.isFinite(recentEntryLimit) && recentEntryLimit > 0 ? Math.floor(recentEntryLimit) : DEFAULT_RECENT_ENTRY_LIMIT;
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	const endExclusive = assistantIndex >= 0 ? assistantIndex : entries.length;
	const startIndex =
		startTurnId === undefined
			? -1
			: entries.findIndex((entry, index) => index < endExclusive && turnIdOf(entry) === startTurnId);
	if (startIndex >= 0 && isUserMessageEntry(entries[startIndex])) return entries.slice(startIndex + 1, endExclusive);
	let startInclusive = Math.max(0, endExclusive - boundedLimit);
	for (let index = endExclusive - 1; index >= startInclusive; index -= 1) {
		if (isUserMessageEntry(entries[index])) {
			startInclusive = index + 1;
			break;
		}
	}
	return entries.slice(startInclusive, endExclusive);
}

function bashValidationCall(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "bash") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const command = typeof args?.command === "string" ? args.command : null;
	if (command === null) return null;
	const execution = workspaceValidationCommand(command, args?.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: detected.matched,
		...validationCheckFields(detected.matched),
		execution: packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/** A model `bash` call's id, for a check the shared fold settles that the finish vocabulary does not name. */
function bashCallId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null || stringFromFirst(payload, ["name", "toolName", "tool"]) !== "bash") return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
}

/**
 * A pass the shared classifier settled and no later change retired, credited under the name the fold filed it by
 * (`cargo clippy`, `mypy .`) when the finish vocabulary has no label for it, so the gate and the receipt agree (x8-1).
 */
function observedCheckEvidence(pass: ObservedCheck, turnId: string | null, marker = ""): FinishContractEvidence {
	return {
		kind: "validation_command",
		summary: `validation command passed: ${pass.name}${marker}`,
		...(pass.check ? { check: pass.check } : {}),
		...(turnId !== null ? { turnId } : {}),
	};
}

/** A model `bash` call's runs of declared checks, each credited when the call's result succeeds. */
function bashDeclaredVerifierCalls(
	entry: unknown,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): ToolCallEvidenceCandidate[] {
	if (declared.length === 0 || workspaceRoot === undefined) return [];
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return [];
	const payload = asRecord(record.payload);
	if (payload === null || stringFromFirst(payload, ["name", "toolName", "tool"]) !== "bash") return [];
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (typeof args?.command !== "string") return [];
	const execution = workspaceValidationCommand(args.command, args.cwd, workspaceRoot);
	if (execution === null) return [];
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return [];
	const turnId = turnIdOf(entry);
	return declaredCheckRuns(args.command, shellBase(workspaceRoot, args.cwd), declared).map(({ check }) => {
		const catalog = catalogCheckExecution(check, workspaceRoot);
		return {
			toolCallId,
			command: `${execution.command.trim()} (declared check ${check.id})`,
			check: check.id,
			...(catalog !== undefined ? { execution: catalog } : {}),
			...(turnId !== null ? { turnId } : {}),
		};
	});
}

/** A catalog check run through the shell keeps its declaration's source, cwd and argv, as a package script run does. */
function catalogCheckExecution(
	check: DeclaredVerifierCommand,
	workspaceRoot: string,
): ValidationExecutionEvidence | undefined {
	if (check.session || check.segments.length !== 1) return undefined;
	return {
		source: { kind: "project-catalog", path: resolve(workspaceRoot, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH) },
		cwd: check.cwd,
		argv: [...(check.segments[0] ?? [])],
	};
}

function shellBase(workspaceRoot: string, cwd: unknown): string {
	return resolve(workspaceRoot, typeof cwd === "string" && cwd.length > 0 ? cwd : ".");
}

/** An operator `!` run's declared checks; the run carries its own exit code. */
function bashExecutionDeclaredEvidence(
	entry: unknown,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): FinishContractEvidence[] {
	if (declared.length === 0 || workspaceRoot === undefined) return [];
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution" || typeof record.command !== "string") return [];
	if (record.cancelled === true || record.exitCode !== 0) return [];
	const execution = workspaceValidationCommand(record.command, record.cwd, workspaceRoot);
	if (execution === null) return [];
	const turnId = turnIdOf(entry);
	return declaredCheckRuns(record.command, shellBase(workspaceRoot, record.cwd), declared).map(({ check }) => ({
		kind: "validation_command",
		summary: `validation command passed: ${execution.command.trim()} (declared check ${check.id})`,
		check: check.id,
		...(catalogCheckExecution(check, workspaceRoot) ?? {}),
		...(turnId !== null ? { turnId } : {}),
	}));
}

/**
 * The changed files a successful command ran after their last edit: the
 * script of an interpreter (`python3 -B src/clean.py`, also under `uv run`), a
 * command word with a path (`./run.sh`), or the manifest a project runner
 * reads (`make`'s makefile, `npm run`'s `package.json`). A call that both edits and runs a file does not count, so
 * the run is known to postdate the edit.
 */
function changedFilesRunAfterEdit(
	window: ReadonlyArray<unknown>,
	mutatedPaths: ReadonlyArray<string>,
	workspaceRoot: string | undefined,
): string[] {
	const root = resolve(workspaceRoot ?? ".");
	const lastEdit = new Map<string, number>();
	const lastRun = new Map<string, number>();
	const edits = new Map<string, string[]>();
	const runs = new Map<string, string[]>();
	const mark = (marks: Map<string, number>, paths: ReadonlyArray<string>, index: number) => {
		for (const path of paths) marks.set(resolve(root, path), index);
	};
	for (const [index, entry] of capabilityEntries(window).entries()) {
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			const record = asRecord(entry);
			mark(lastEdit, bashMutation.paths, index);
			mark(lastRun, executedFiles(String(record?.command), record?.cwd, root), index);
			continue;
		}
		const call = mutatingToolCall(entry);
		if (call !== null) edits.set(call.toolCallId, call.paths);
		const record = asRecord(entry);
		const payload = record?.kind === "message" && record.role === "tool_call" ? asRecord(record.payload) : null;
		if (payload !== null && stringFromFirst(payload, ["name", "toolName", "tool"]) === ToolNames.Bash) {
			const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
			const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
			if (typeof args?.command === "string" && toolCallId !== null)
				runs.set(toolCallId, executedFiles(args.command, args.cwd, root));
			continue;
		}
		const resultId = successfulToolResultId(entry);
		if (resultId === null) continue;
		mark(lastEdit, edits.get(resultId) ?? [], index);
		mark(lastRun, runs.get(resultId) ?? [], index);
	}
	return mutatedPaths.filter((path) => {
		const key = resolve(root, path);
		return (lastRun.get(key) ?? -1) > (lastEdit.get(key) ?? Number.POSITIVE_INFINITY);
	});
}

const SCRIPT_INTERPRETERS =
	/^(?:python[0-9.]*|pypy[0-9.]*|node|bash|sh|zsh|dash|ruby|perl|php|Rscript|deno|bun|tsx|ts-node|lua|julia)$/u;
/** Interpreter options that run inline code or a module rather than a script file. */
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-m", "-p", "--eval", "--print"]);
const RUN_PREFIX_WORDS = new Set(["command", "env", "exec", "nice", "nohup", "time"]);
/** Environment runners whose `run` executes the command after it: `uv run src/clean.py`, `poetry run python x.py`. */
const ENV_RUNNERS = new Set(["uv", "poetry", "pipenv", "pdm"]);
/** Runner options that take the next word as their value. */
const RUNNER_VALUE_OPTIONS = new Set([
	"--with",
	"-w",
	"--with-requirements",
	"--with-editable",
	"--python",
	"-p",
	"--project",
	"--directory",
	"--package",
	"--env-file",
	"--extra",
	"--group",
	"--only-group",
	"--index",
	"--from",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** Package-manager subcommands that run a script `package.json` declares. */
const PACKAGE_SCRIPT_COMMANDS = new Set(["run", "run-script", "test", "t", "start"]);
const PACKAGE_DIRECTORY_OPTIONS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];

/** The makefiles a `make` invocation reads: `-f` names them, otherwise the default names in its `-C` directory. */
function makefilesRead(words: ReadonlyArray<string>, from: number, directory: string): string[] {
	let dir = directory;
	const named: string[] = [];
	for (let index = from; index < words.length; index += 1) {
		const word = words[index] as string;
		const value = (long: string, short: string): string | undefined => {
			if (word === short || word === long) {
				index += 1;
				return words[index];
			}
			if (word.startsWith(`${long}=`)) return word.slice(long.length + 1);
			if (word.startsWith(short) && word.length > short.length) return word.slice(short.length);
			return undefined;
		};
		const cd = value("--directory", "-C");
		if (cd !== undefined) {
			dir = resolve(dir, cd);
			continue;
		}
		const file = value("--file", "-f") ?? (word.startsWith("--makefile=") ? word.slice(11) : undefined);
		if (file !== undefined) named.push(file);
	}
	return (named.length > 0 ? named : MAKEFILE_NAMES).map((name) => resolve(dir, name));
}

/** The `package.json` a package manager reads to run one of its scripts, or null when the command runs none. */
function packageScriptManifest(words: ReadonlyArray<string>, from: number, directory: string): string | null {
	let dir = directory;
	for (let index = from; index < words.length; index += 1) {
		const word = words[index] as string;
		if (PACKAGE_DIRECTORY_OPTIONS.has(word)) {
			const value = words[index + 1];
			if (value !== undefined) dir = resolve(dir, value);
			index += 1;
			continue;
		}
		if (word.startsWith("-")) continue;
		return PACKAGE_SCRIPT_COMMANDS.has(word) ? resolve(dir, "package.json") : null;
	}
	return null;
}

/** The files a shell command executes by name, resolved against its cwd and any literal `cd` before them. */
function executedFiles(command: string, cwd: unknown, root: string): string[] {
	let directory = resolve(root, typeof cwd === "string" ? cwd : ".");
	const files: string[] = [];
	for (const segment of splitSegments(scanShellLike(command))) {
		const words = shellCommandWords(segment)
			.filter((token) => !token.substitutions?.length && !token.homeRelative && !/[$`]/u.test(token.value))
			.map((token) => token.value);
		let at = 0;
		while (at < words.length) {
			const word = words[at] as string;
			if (SHELL_ASSIGNMENT.test(word) || RUN_PREFIX_WORDS.has(word)) at += 1;
			else if (word === "timeout") at += 2;
			else break;
		}
		let head = words[at];
		if (head === undefined) continue;
		if (head === "cd") {
			if (words[at + 1] !== undefined) directory = resolve(directory, words[at + 1] as string);
			continue;
		}
		const program = head.slice(head.lastIndexOf("/") + 1);
		if (program === "make" || program === "gmake") {
			files.push(...makefilesRead(words, at + 1, directory));
			continue;
		}
		if (PACKAGE_MANAGERS.has(program)) {
			const manifest = packageScriptManifest(words, at + 1, directory);
			if (manifest !== null) files.push(manifest);
			continue;
		}
		let underRunner = false;
		if (ENV_RUNNERS.has(program) && words[at + 1] === "run") {
			at += 2;
			while (at < words.length && (words[at] as string).startsWith("-")) {
				const option = words[at] as string;
				at += RUNNER_VALUE_OPTIONS.has(option) ? 2 : 1;
			}
			head = words[at];
			if (head === undefined) continue;
			underRunner = true;
		}
		let script: string | undefined;
		if (SCRIPT_INTERPRETERS.test(head.slice(head.lastIndexOf("/") + 1))) {
			for (let index = at + 1; index < words.length; index += 1) {
				const word = words[index] as string;
				if (INLINE_CODE_FLAGS.has(word)) break;
				if (word.startsWith("-") || (index === at + 1 && word === "run")) continue;
				script = word;
				break;
			}
		} else if (head.includes("/") || (underRunner && /\.[A-Za-z]+$/u.test(head))) script = head;
		if (script !== undefined) files.push(resolve(directory, script));
	}
	return files;
}

function dispatchEvidenceCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "dispatch") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const { agentId, task } = dispatchCallDescriptor(args);
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: `agent=${agentId}${task.length > 0 ? ` task=${task}` : ""}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * Agent id and lead task text for a dispatch call, tolerant of both the toolkit
 * v2 `tasks` array (task strings or {agent, task} objects, with an optional
 * shared default agent) and the legacy single `task` argument. Only the first
 * task seeds the summary; it feeds the receipt evidence's agent fallback and the
 * audit line, never the gate decision itself.
 */
function dispatchCallDescriptor(args: Record<string, unknown> | null): { agentId: string; task: string } {
	const defaultAgent = stringFromFirst(args ?? {}, ["agent", "agent_id", "agentId"]);
	const tasks = Array.isArray(args?.tasks) ? args.tasks : null;
	if (tasks !== null && tasks.length > 0) {
		const first = tasks[0];
		if (typeof first === "string") {
			return { agentId: defaultAgent ?? "coder", task: first.trim() };
		}
		const firstRecord = asRecord(first);
		const itemAgent = firstRecord === null ? null : stringFromFirst(firstRecord, ["agent", "agent_id", "agentId"]);
		const itemTask = typeof firstRecord?.task === "string" ? firstRecord.task.trim() : "";
		return { agentId: itemAgent ?? defaultAgent ?? "coder", task: itemTask };
	}
	const singleTask = typeof args?.task === "string" ? args.task.trim() : "";
	return { agentId: defaultAgent ?? "coder", task: singleTask };
}

function validationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName === null) return null;
	const summary = typedValidationSummary(toolName, payload);
	if (summary === null) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: summary,
		...validationCheckFields(summary),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * The canonical command a typed validation tool call stands for, or null when
 * the call is not a validation. Exported because run-effects grounds a mutation
 * report's claimed validations against the same notion this gate uses.
 */
export function typedValidationSummary(toolName: string, payload: Record<string, unknown>): string | null {
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (toolName === "verify") {
		const check = typeof args?.check === "string" ? args.check.trim() : "";
		if (check === "frontend") {
			const path = typeof args?.path === "string" && args.path.trim().length > 0 ? args.path.trim() : "artifact";
			return `verify frontend ${path}`;
		}
		if (isVerificationScriptName(check)) return `npm run ${check}`;
		if (isProjectVerifierCheckId(check)) return `verify ${check}`;
		return null;
	}
	return null;
}

function successfulToolResultId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	if (payload.isError === true || payload.error === true) return null;
	// A call the safety rails refused or the registry settled as an error ran
	// nothing. The persisted verdict says so even when `isError` is false: a
	// denied write is not a change, and a denied test run is not validation.
	if (payload.outcome === "blocked" || payload.outcome === "error" || typeof payload.blockReason === "string")
		return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (result?.kind === "error" || details?.kind === "error") return null;
	const chainAdmission = asRecord(details?.chainAdmission);
	if (chainAdmission?.outcome === "blocked" || chainAdmission?.outcome === "error") return null;
	if (typeof details?.exitCode === "number" && details.exitCode !== 0) return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
}

/** The id of a command that ran and exited nonzero; a refused or blocked call has no exit code. */
function ranToNonzeroExitResultId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null || payload.outcome === "blocked" || typeof payload.blockReason === "string") return null;
	const details = asRecord(asRecord(payload.result)?.details);
	if (asRecord(details?.chainAdmission)?.outcome === "blocked") return null;
	if (typeof details?.exitCode !== "number" || details.exitCode === 0) return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
}

export function dispatchRunRecordEvidence(
	entry: unknown,
	candidate: ToolCallEvidenceCandidate | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["toolName", "name", "tool"]);
	if (toolName !== null && toolName !== "dispatch") return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (details === null) return null;
	const summary = passedDispatchRunRecordSummary(details, candidate);
	if (summary === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "dispatch_run_record",
		summary,
	};
	const turnId = candidate?.turnId ?? turnIdOf(entry);
	if (turnId !== null && turnId !== undefined) evidence.turnId = turnId;
	return evidence;
}

/**
 * Summarizes a dispatch result as passed-run evidence, or null when it is
 * not a passing dispatch. Handles the toolkit v2 batch shape
 * (`{mode, runIds, runCount, failedCount, runs:[{runId, agentId, exitCode}]}`
 * where exit codes live per-run) as well as the legacy single-run shape
 * (`{exitCode, runId, agentId}`). A batch counts only when it has at least one
 * run and every run exited cleanly. Current results must also carry verified
 * integrity and validated evidence on their canonical trust axes, so failed or
 * ungrounded checks never become validation evidence through process success.
 */
function passedDispatchRunRecordSummary(
	details: Record<string, unknown>,
	candidate: ToolCallEvidenceCandidate | undefined,
): string | null {
	if (Array.isArray(details.runs)) {
		const runs = details.runs.map(asRecord);
		if (runs.length === 0 || runs.some((run) => run === null || !passedDispatchRun(run))) return null;
		if (typeof details.failedCount === "number" && details.failedCount !== 0) return null;
		const first = runs[0];
		const runId = typeof first?.runId === "string" && first.runId.length > 0 ? first.runId : "unknown";
		const agentId = dispatchRunRecordAgentId(typeof first?.agentId === "string" ? first.agentId : undefined, candidate);
		const extra = runs.length > 1 ? ` (+${runs.length - 1} more)` : "";
		return `dispatch run record passed: run ${runId} agent ${agentId}${extra}`;
	}
	if (passedDispatchRun(details)) {
		const runId = typeof details.runId === "string" && details.runId.length > 0 ? details.runId : "unknown";
		const agentId = dispatchRunRecordAgentId(
			typeof details.agentId === "string" ? details.agentId : undefined,
			candidate,
		);
		return `dispatch run record passed: run ${runId} agent ${agentId}`;
	}
	return null;
}

function passedDispatchRun(run: Record<string, unknown>): boolean {
	if (run.exitCode !== 0) return false;
	// Historical results predate canonical trust status. For current results,
	// a clean process exit cannot overrule failed, absent, or ungrounded validation.
	if (!("trustStatus" in run)) return true;
	const trust = validateTrustStatus(run.trustStatus);
	return (
		trust.ok &&
		trust.status.artifactIntegrity.state === "verified" &&
		trust.status.validationGrounding.state === "validated"
	);
}

/** Prefer the receipt's own agent id, then the dispatch call's, then unknown. */
function dispatchRunRecordAgentId(
	runAgentId: string | undefined,
	candidate: ToolCallEvidenceCandidate | undefined,
): string {
	if (runAgentId !== undefined && runAgentId.length > 0) return runAgentId;
	return candidate?.command.match(/^agent=([^\s]+)/)?.[1] ?? "unknown";
}

function bashExecutionEvidence(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true) return null;
	if (record.exitCode !== 0) return null;
	const execution = workspaceValidationCommand(record.command, record.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const contextMarker = record.excludeFromContext === true ? " [not sent to model]" : "";
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${detected.matched}${contextMarker}`,
		...validationCheckFields(detected.matched),
		...packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function protectedArtifactEvidence(entry: unknown): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "protectedArtifact" || record.action !== "protect") return null;
	const artifact = asRecord(record.artifact);
	const path = typeof artifact?.path === "string" && artifact.path.trim().length > 0 ? artifact.path.trim() : null;
	if (path === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "protected_artifact",
		summary: `protected artifact recorded: ${path}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function validationEvidence(candidate: ToolCallEvidenceCandidate, entry: unknown): FinishContractEvidence {
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${candidate.command}`,
		...(candidate.check ? { check: candidate.check } : {}),
		...(candidate.execution ?? declaredCheckExecution(entry, candidate.check)),
	};
	if (candidate.turnId !== undefined) evidence.turnId = candidate.turnId;
	return evidence;
}

/** Preserve the verifier's execution facts only when they identify the declared check. */
function declaredCheckExecution(entry: unknown, check: string | undefined): ValidationExecutionEvidence {
	const payload = asRecord(asRecord(entry)?.payload);
	const details = asRecord(asRecord(payload?.result)?.details);
	const source = asRecord(details?.source);
	if (
		!details ||
		details.check !== check ||
		details.exitCode !== 0 ||
		details.aborted === true ||
		details.timedOut === true ||
		details.outputCapped === true ||
		(source?.kind !== "package.json" && source?.kind !== "project-catalog") ||
		typeof source.path !== "string" ||
		typeof details.cwd !== "string" ||
		!Array.isArray(details.argv) ||
		!details.argv.every((arg): arg is string => typeof arg === "string")
	)
		return {};
	if (source.kind === "project-catalog") {
		const argv = details.argv;
		if (
			!Array.isArray(details.declaredCommand) ||
			details.declaredCommand.length !== details.argv.length ||
			!details.declaredCommand.every((arg, index) => arg === argv[index]) ||
			typeof details.declaredCwd !== "string" ||
			typeof details.declaredTimeoutMs !== "number" ||
			typeof details.durationMs !== "number" ||
			details.durationMs > details.declaredTimeoutMs ||
			resolve(source.path, "../..", details.declaredCwd) !== details.cwd
		)
			return {};
	}
	return {
		source: { kind: source.kind, path: source.path },
		cwd: details.cwd,
		argv: details.argv,
		...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
	};
}

/** Resolve a literal leading cd without crediting checks from a different workspace. */
function workspaceValidationCommand(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): { command: string; cwd: unknown } | null {
	const tokens = scanShellLike(command);
	if (tokens[0]?.value !== "cd") return { command, cwd };
	const directory = tokens[1];
	const separator = tokens[2];
	if (
		!workspaceRoot ||
		!directory ||
		directory.operator ||
		directory.substitutions?.length ||
		directory.homeRelative ||
		/[$`]/u.test(directory.value) ||
		separator?.operator !== true ||
		separator.value !== "&&"
	)
		return null;
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".", directory.value);
	if (!isWithinWorkspace(executionCwd, workspaceRoot)) return null;
	return { command: command.slice(separator.end).trim(), cwd: executionCwd };
}

/** Exact package commands retain their execution cwd; a matched substring proves no project identity. */
function packageCommandExecution(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): ValidationExecutionEvidence {
	if (
		!workspaceRoot ||
		!/^(?:npm|pnpm|yarn|bun) /u.test(command.trim()) ||
		validationCheckId(command.trim()) === undefined
	)
		return {};
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".");
	return {
		source: { kind: "package.json", path: resolve(executionCwd, "package.json") },
		cwd: executionCwd,
		argv: command.trim().split(/\s+/u),
	};
}

function pushEvidence(evidence: FinishContractEvidence[], seen: Set<string>, item: FinishContractEvidence): void {
	const key = JSON.stringify(item);
	if (seen.has(key)) return;
	seen.add(key);
	evidence.push(item);
}

const DELETION_CLAUSE_SPLIT = /[.;\n]|\b(?:then|but)\b/iu;
const DELETION_VERB = /\b(?:delete|remove|rm|drop|get\s+rid\s+of)\b/iu;
const DELETION_NEGATION = /\b(?:do\s+not|don['’]t|never|without)\s+(?:delete|remove|drop)\b/iu;

/** A clause of the operator's message that asks to delete and names this path or its last segment. */
function operatorRequestedDeletion(path: string, request: string | null): boolean {
	if (request === null) return false;
	const trimmed = path.replace(/^\.\//u, "").replace(/\/+$/u, "");
	const leaf = trimmed.split("/").pop() ?? "";
	if (leaf.length === 0) return false;
	const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const names = new RegExp(`(?:^|[\\s\`'"(/])(?:${literal(trimmed)}|${literal(leaf)})(?:$|[\\s\`'",;:)/])`, "u");
	return request
		.split(DELETION_CLAUSE_SPLIT)
		.some((clause) => DELETION_VERB.test(clause) && !DELETION_NEGATION.test(clause) && names.test(clause));
}

/** Text of the last real user message before the assessed turn. */
function latestUserText(entries: ReadonlyArray<unknown>, assistantTurnId: string | null): string | null {
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	for (let index = (assistantIndex >= 0 ? assistantIndex : entries.length) - 1; index >= 0; index -= 1) {
		if (!isUserMessageEntry(entries[index])) continue;
		const payload = asRecord(asRecord(entries[index])?.payload);
		const content = payload?.text ?? payload?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((part) => {
					const text = asRecord(part)?.text;
					return typeof text === "string" ? text : "";
				})
				.join("\n");
		return null;
	}
	return null;
}

function isUserMessageEntry(entry: unknown): boolean {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "user") return false;
	const payload = asRecord(record.payload);
	return payload?.synthetic !== true;
}

function turnIdOf(entry: unknown): string | null {
	const record = asRecord(entry);
	return typeof record?.turnId === "string" ? record.turnId : null;
}

function stringFromFirst(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Exact check ids, never substring matches against rendered evidence summaries. */
export function validationCheckId(command: string): string | undefined {
	return (
		/^(?:npm|pnpm|yarn|bun) (?:run )?([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1] ??
		/^verify ([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1]
	);
}

function validationCheckFields(command: string): { check?: string } {
	const check = validationCheckId(command);
	return check ? { check } : {};
}

/** Additional package scripts are admitted only by the operator's typed acceptance. */
function acceptanceValidationCommand(
	command: string,
	checks: ReadonlySet<string>,
): ReturnType<typeof detectValidationCommand> {
	const exact = command.trim();
	const check = /^npm run ([a-z0-9][a-z0-9._:-]*)$/.exec(exact)?.[1];
	if (check && checks.has(check)) return { kind: "validation", matched: exact };
	// The call classifier alone says whether the command ran a check; the finish vocabulary only names it.
	if (callVerdict(ToolNames.Bash, { command }) !== "check") return { kind: "none" };
	return detectValidationCommand(command);
}
