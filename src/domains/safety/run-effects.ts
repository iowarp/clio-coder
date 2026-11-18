import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ObservedProof } from "../../core/hoare.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { captureProofSnapshot, readObservedProof } from "../../tools/verify/proof.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../../tools/verify/resolve.js";
import {
	type CallClassification,
	type CheckOutputReader,
	classifyCall,
	settleCheckCall,
	validationCommandOf,
} from "./check-classifier.js";
import { declaredVerifierCommands, type SessionVerifier } from "./finish-contract.js";
import { isSameOrDescendant } from "./path-policy.js";
import { observedValidationCommand } from "./protected-artifacts.js";
import { effectiveScratchRoots } from "./scratch-roots.js";

/**
 * What a run's own tool calls show it did to the workspace.
 *
 * A mutation report claims paths and validations. Neither claim means anything
 * on its own: the run's tool calls are the only record of what it actually
 * touched and what it actually ran. This is the write-side counterpart of the
 * observed read spans that ground a Scout citation, recorded from the same tool
 * event stream so the worker's bounded repair round and the orchestrator's
 * sealed validation judge one set of facts.
 *
 * `mutatedPaths` is deliberately generous. Its only job is to answer "could
 * this run have produced this path", so a write channel it cannot enumerate (a
 * bash command that writes through a script) leaves the path absent from the
 * set and the validator falls back to the filesystem rather than to a failed
 * conformance.
 *
 * `writeRecordComplete` is the other half of that sentence, and it exists for
 * the reader that cannot fall back to the filesystem. The write boundary uses
 * this record the other way round, to decide that a path the run did *not*
 * write is somebody else's and must survive. Reading an under-reporting set as
 * a closed list would clear a step of a write it really made, so the recorder
 * says outright whether the set is closed.
 */
export interface RunEffects {
	/** Latest paired native proof results, rechecked against current declared inputs. */
	proofs: ReadonlyMap<string, ObservedProof>;
	/** Absolute paths the run's successful tool calls aimed a mutation at. */
	mutatedPaths: ReadonlySet<string>;
	/**
	 * Absolute paths whose only mutation attempt came back blocked or errored.
	 * Observed live (receipt 182h2ai478p5): a coder's edit was refused by the
	 * worker permission policy and the report still claimed the file as mutated.
	 * The file existed, so presence could not tell the claim from the truth; the
	 * run's own failed tool result can.
	 */
	failedMutationPaths: ReadonlySet<string>;
	/**
	 * The checks the run ran to a clean exit since its last workspace mutation, each named as the receipt files it: a
	 * declared check under its id, else its vocabulary label, else the classifier's name (S1). A mutation clears
	 * them like `validationOutcomes`: a pass on the pre-change tree cannot verify the final one (bt-27b). The run's
	 * earlier checks stay visible as execution evidence in `verificationCommands` and `executedShellCommands`.
	 */
	validationCommands: ReadonlySet<string>;
	/**
	 * Outcomes observed since the run's last workspace mutation, keyed by `observedValidationCommand`; observed
	 * finishes, never report order. A mutation clears them all: a check run on the pre-change tree says nothing
	 * about the final one (bt-27).
	 */
	validationOutcomes: ReadonlyMap<string, boolean>;
	/**
	 * `validationOutcomes` joined, in finish order, by each `verify` call's outcome under its check id and under the
	 * command it resolved to. Only the result contract's claim judgement reads it, so a green claim against a red
	 * latest verify seals fail; typed facts keep reading `validationOutcomes`, since verify calls seal their own (bt-27).
	 */
	checkOutcomes: ReadonlyMap<string, boolean>;
	/** True once a call counted as a workspace mutation ran, so no standing outcome predates every change. */
	mutationObserved: boolean;
	/** True only when every observed checking call has an authoritative blocked outcome. */
	checksAllBlocked?: boolean;
	/**
	 * The run's commands read under the wider `grounding` vocabulary, which adds
	 * read verification (`git diff`), ad-hoc checks (`node -e`) and the runners
	 * the strict set omits (`npx vitest`, `tsc --noEmit`). A verify call adds the
	 * command its check resolved to, read the same way.
	 *
	 * The two sets exist because their readers pay different prices for a match.
	 * `validationCommands` opens a gate: `result-contract.ts` reads
	 * `validationCommands.size > 0` as the difference between a mutation report
	 * sealing `pass` and sealing `unmeasured`, so only a call the classifier reads as a check enters it, and a run
	 * whose only command was `git diff` has asserted nothing about correctness. `verificationCommands`
	 * only decides whether a receipt prints `unmatched validation: ...`, where a
	 * miss and a false match both cost one line of noise, so it can afford the
	 * wider set. A bash check whose exit status is a later command's (`make test; echo EXIT=$?`) lands in
	 * `unattributableVerificationCommands` instead: it ran, but nothing observed says it passed (bt-9).
	 */
	verificationCommands: ReadonlySet<string>;
	/** Checks read as `verificationCommands` reads them, from bash calls whose exit status was not the check's. */
	unattributableVerificationCommands: ReadonlySet<string>;
	/**
	 * False once the run made a successful call to a tool that can mutate a path
	 * its own arguments do not name. After such a call `mutatedPaths` is a lower
	 * bound rather than the whole list, so a reader that would treat an absent
	 * path as proof the run did not write it has to stop treating it that way.
	 *
	 * The downgrade covers the whole run rather than the one call, because an
	 * opaque call's effect is unbounded. A shell command, a project script, or a
	 * spawned worker can write anywhere the process can reach, so once one has
	 * run there is no path left in the checkout that the record can clear.
	 */
	writeRecordComplete: boolean;
	/**
	 * Successful opaque calls that made the write record incomplete. The call id
	 * and tool name are retained so a later write-boundary verdict can explain
	 * exactly why attribution was downgraded instead of exposing only a boolean.
	 */
	writeRecordDowngrades: ReadonlyArray<WriteRecordDowngrade>;
	/**
	 * Commands that ran to a clean exit, through bash (verbatim) or a verify check (its resolved argv joined by
	 * spaces), in run order. A verify call that resolves to no argv, such as a bare listing, records nothing.
	 */
	executedShellCommands?: ReadonlyArray<string>;
	/**
	 * Calls the check classifier could not read (`check-classifier.ts`, verdict `unknown`) that ran after the oldest
	 * check outcome still standing, in run order: a bash call's command, any other call's tool name. They neither
	 * settled nor cleared an outcome, so a receipt discloses them beside its verdict without changing it. A later
	 * outcome leaves them listed while an earlier one stands (x6-3). Empty while no outcome stands.
	 */
	unclassifiedAfterLastCheck?: ReadonlyArray<string>;
}

export interface WriteRecordDowngrade {
	reason: "opaque_tool_succeeded";
	tool: string;
	toolCallId: string;
}

/**
 * Which checking calls judged the run's final tree: a call counts when it ran and no workspace mutation but its own
 * landed after it started (bt-27c). A check that ran before a later edit says nothing about the tree the run left.
 */
export interface CheckFreshness {
	/** False while no call counted as a workspace mutation, so every call ran on the final tree. */
	mutationObserved: boolean;
	/** `verify` call ids, a chain step as `<call id>:<step id>`, that ran on the final tree. */
	verifyCalls: ReadonlySet<string>;
	/** Tools whose latest executed call ran on the final tree. */
	tools: ReadonlySet<string>;
	/** Passing `verify` calls that ran on the final tree: the check id and the command it resolved to (bt-9). */
	verifyRuns: ReadonlyArray<{ check: string; command: string }>;
}

export interface RunEffectsRecorderOptions {
	/** Fires once, when the first successful opaque call opens the record. */
	onWriteRecordDowngraded?(downgrade: WriteRecordDowngrade): void;
	/** The environment the run's commands inherit, whose `GIT_CONFIG_*` entries join the git config read. */
	env?: NodeJS.ProcessEnv;
	/** `safety.scratchRoots` from the operator's settings: a check logged under one changes no tree (x5-4). */
	scratchRoots?: ReadonlyArray<string>;
	/**
	 * Checks declared for this run only (`run --verify`). With the project catalog's, read when the recorder is made, a
	 * shell run of one is a check, as the finish contract credits it (x7-5).
	 */
	sessionVerifiers?: ReadonlyArray<SessionVerifier>;
}

export interface RunEffectsRecorder {
	started(toolCallId: string): boolean;
	/** Record a tool call's mutation targets and validation identity. */
	start(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void;
	/** Commit a call's effects, or drop them when the call did not succeed. */
	finish(toolCallId: string, failed: boolean, result?: unknown): void;
	/** A check name that resolved to no check ran nothing, so `unresolved` settles and clears nothing, as a refusal (c16-C). */
	checkOutcome(toolCallId: string, outcome: "ok" | "error" | "blocked", unresolved?: boolean): void;
	snapshot(): RunEffects;
	checkFreshness(): CheckFreshness;
}

interface PendingEffects {
	proofCheck: string | null;
	tool: string;
	toolCallId: string;
	reading: CallClassification;
	validationCommands: string[];
	validationName: string | null;
	mutationRevision: number;
	verificationCommand: string | null;
	/** The tool's own outcome, when the call reached it. Stays null when the engine answered instead. */
	outcome: "ok" | "error" | "blocked" | null;
}

/**
 * The names a receipt files a check call's pass under. The classifier's verdict alone says the call ran a check, as the
 * gate and the board read it, so every check names at least one (S1): each declared check it ran whole under its id,
 * then the vocabulary's label, else the classifier's own name for it.
 */
function receiptValidationCommands(
	toolName: string,
	args: Record<string, unknown> | undefined,
	reading: CallClassification,
): string[] {
	if (reading.verdict !== "check") return [];
	const label = receiptValidationLabel(toolName, args, reading.base);
	const names = [...reading.declared, ...(label === null ? [] : [label])];
	return names.length > 0 || reading.name === null ? names : [reading.name];
}

/**
 * The vocabulary's label for a validation call. The canonical identity reads a script-family verify id such as
 * `test` as `npm run test`, but verify runs the project catalog's or the toolchain's check of that id first, so where
 * the workspace resolves it to anything but a package script the receipt names the argv that really ran. Grounding a
 * worker's claims keeps the canonical identity, which matches claims by check id.
 */
function receiptValidationLabel(
	toolName: string,
	args: Record<string, unknown> | undefined,
	base: string,
): string | null {
	const canonical = validationCommandOf(toolName, args, "finish-contract");
	if (canonical === null || toolName !== ToolNames.Verify || !canonical.startsWith("npm run ")) return canonical;
	try {
		const resolution = resolveVerifyCall(base, args ?? {});
		if (resolution.kind === "package" || resolution.kind === "unresolved") return canonical;
		return verifyResolutionArgv(resolution, args ?? {}, base)?.join(" ") ?? canonical;
	} catch {
		return canonical;
	}
}

const GIT_HELPER_KEYS = "^(core\\.fsmonitor|diff\\.external|diff\\..+\\.(command|textconv))$";

/** `core.fsmonitor` set to a boolean names git's own daemon or nothing, never a program of the repository's. */
const GIT_CONFIG_BOOLEAN = /^(?:true|false|yes|no|on|off|1|0|)$/iu;

/**
 * Whether the effective git config at `cwd` names a program that `git status`, `git diff`, `git log` or
 * `git show` would run: a `core.fsmonitor` hook, `diff.external`, or a diff driver's `command` or `textconv`
 * (x1-3). Read once per run; planting such config later is a mutation of its own. No match, no git and no `cwd`
 * all answer false, because then no git command can run a helper there. Any other failure answers true.
 */
export function gitRunsConfiguredHelpers(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	let listing: string;
	try {
		listing = execFileSync("git", ["config", "--get-regexp", GIT_HELPER_KEYS], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
	} catch (error) {
		const failure = error as { code?: unknown; status?: unknown };
		return !(failure.code === "ENOENT" || failure.status === 1);
	}
	const effective = new Map<string, string>();
	for (const line of listing.split("\n")) {
		if (line.length === 0) continue;
		const space = line.indexOf(" ");
		effective.set(space === -1 ? line : line.slice(0, space), space === -1 ? "true" : line.slice(space + 1));
	}
	return [...effective].some(([key, value]) =>
		key === "core.fsmonitor" ? !GIT_CONFIG_BOOLEAN.test(value) : value.length > 0,
	);
}

/** Reads where a check's output lands; `logs` are the call's check log targets ({@link checkLogTargets}). */
export type { CheckOutputReader };

/**
 * Where a check's output lands (x4-2): a `*.log`, outside the workspace, under the temp dir or a scratch root, or
 * git-ignored. `outside` asks only of any write whether it leaves `cwd` (x7-1): a temp dir or scratch root inside the
 * workspace holds output but is not outside it (x8-4). `$TMPDIR`, `$HOME` and `~` expand from the run's env first
 * (x5-4). A check log the call's check pipeline writes (`npm test > out.txt`) to a path git does not track and the run did not change is output too.
 * A tracked source path stays a change, and a target this cannot resolve is one too. Shared by the recorder and the
 * task board's replay, so a check logged through `tee` keeps its outcome on both (x4-1).
 */
export function checkOutputReader(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	configuredScratchRoots: ReadonlyArray<string> = [],
	/** Git's ignore and tracking answers, shared by every reader of one run and never kept past it (x6-7). */
	gitAnswers = new Map<string, boolean>(),
): CheckOutputReader {
	const git = (args: string[], target: string, answer: (status: number | null) => boolean): boolean => {
		const key = `${args[0]}\0${target}`;
		let known = gitAnswers.get(key);
		if (known === undefined) {
			try {
				execFileSync("git", [...args, "--", target], { cwd, env, stdio: "ignore", timeout: 5000 });
				known = answer(0);
			} catch (error) {
				const status = (error as { status?: unknown }).status;
				known = answer(typeof status === "number" ? status : null);
			}
			gitAnswers.set(key, known);
		}
		return known;
	};
	const gitIgnores = (target: string) => git(["check-ignore", "-q"], target, (status) => status === 0);
	// Exit 1 names a path git does not track; anything else (no repository, no git) proves nothing.
	const untracked = (target: string) => git(["ls-files", "--error-unmatch"], target, (status) => status === 1);
	let scratch: string[] | undefined;
	const changedByRun = new Set<string>();
	const expand = (target: string): string | null => {
		const expanded = target
			.replace(/^~(?=\/|$)/u, "$HOME")
			.replace(/\$\{(TMPDIR|HOME)\}|\$(TMPDIR|HOME)(?![A-Za-z0-9_])/gu, (_, braced, bare) => env[braced ?? bare] || "\0");
		return /^~|[$`\0]/u.test(expanded) ? null : expanded;
	};
	const landsOutside = (resolved: string, inTreeScratch: boolean): boolean => {
		if (!isSameOrDescendant(resolved, cwd)) return true;
		// A temp dir or scratch root inside the workspace holds a check's logs, but a write there changes the tree (x8-4).
		if (!inTreeScratch) return false;
		if (isSameOrDescendant(resolved, tmpdir()) && !isSameOrDescendant(cwd, tmpdir())) return true;
		scratch ??= effectiveScratchRoots(configuredScratchRoots, cwd);
		return scratch.some((root) => isSameOrDescendant(resolved, root) && !isSameOrDescendant(cwd, root));
	};
	const reader = (base: string, logs?: ReadonlySet<string>) => (target: string) => {
		if (/\.log$/u.test(target)) return true;
		const expanded = expand(target);
		if (expanded === null) return false;
		const resolved = path.resolve(base, expanded);
		if (landsOutside(resolved, true)) return true;
		if (gitIgnores(resolved)) return true;
		return logs?.has(target) === true && !changedByRun.has(resolved) && untracked(resolved);
	};
	return Object.assign(reader, {
		changed(paths: Iterable<string>) {
			for (const target of paths) changedByRun.add(target);
		},
		outside(base: string) {
			return (target: string) => {
				const expanded = expand(target);
				return expanded !== null && landsOutside(path.resolve(base, expanded), false);
			};
		},
	});
}

/**
 * Fold a run's tool calls into its observed effects. A call's effects land only
 * when its result comes back clean: a blocked write and a red command are not
 * evidence that the workspace changed or that a check passed.
 */
export function createRunEffectsRecorder(cwd: string, options: RunEffectsRecorderOptions = {}): RunEffectsRecorder {
	const pending = new Map<string, PendingEffects>();
	const gitHelpers = gitRunsConfiguredHelpers(cwd, options.env);
	const outputTarget = checkOutputReader(cwd, options.env, options.scratchRoots);
	const declaredChecks = declaredVerifierCommands(cwd, options.sessionVerifiers);
	const mutatedPaths = new Set<string>();
	const failedMutationPaths = new Set<string>();
	const validationCommands = new Set<string>();
	const validationOutcomes = new Map<string, boolean>();
	const checkOutcomes = new Map<string, boolean>();
	let mutationRevision = 0;
	// Every call in flight, with the revision it started on, so finish can tell whether it ran on the final tree.
	const inFlight = new Map<string, { tool: string; revision: number; outcome: "ok" | "error" | "blocked" | null }>();
	const toolsRanAt = new Map<string, number>();
	const verifyCallsRanAt = new Map<string, number>();
	const passedVerifyRuns = new Map<string, { check: string; command: string; revision: number }>();
	const verificationCommands = new Set<string>();
	const unattributableVerificationCommands = new Set<string>();
	const checkingCalls = new Map<string, "ok" | "error" | "blocked" | null>();
	const writeRecordDowngrades = new Map<string, WriteRecordDowngrade>();
	const executedShellCommands: string[] = [];
	// Each finished call's place in run order, so an unknown call is disclosed while any outcome older than it stands (x6-3).
	let sequence = 0;
	const outcomeSequence = new Map<string, number>();
	const unclassifiedCalls: Array<{ sequence: number; label: string }> = [];
	const proofs = new Map<string, ObservedProof>();
	const latestProofCalls = new Map<string, string>();
	return {
		started(toolCallId) {
			return pending.has(toolCallId);
		},
		start(toolCallId, toolName, args) {
			const proofCheck = toolName === ToolNames.Verify && typeof args?.check === "string" ? args.check.trim() : null;
			if (proofCheck !== null) {
				proofs.delete(proofCheck);
				latestProofCalls.set(proofCheck, toolCallId);
			}
			inFlight.set(toolCallId, { tool: toolName, revision: mutationRevision, outcome: null });
			const reading = classifyCall(toolName, args, { cwd, gitHelpers, outputTarget, declaredChecks });
			const { shell } = reading;
			// The classifier alone says whether the call ran a check; the vocabularies only name it.
			const validationCommands = receiptValidationCommands(toolName, args, reading);
			const verificationCommand = validationCommandOf(toolName, args, "grounding");
			// Every bash check settles under the classifier's name, named by a vocabulary or not, as the board files it (x6-1).
			const validationName = shell === null ? null : reading.name;
			// A listing names no check and runs none, so it is not a checking call (bt-19).
			if (reading.verdict === "check") checkingCalls.set(toolCallId, null);
			// An opaque call is tracked even when it exposed no path and no
			// command, because the fact that it ran at all is the finding.
			const chain = toolName === "gateway" && args?.op === "chain";
			if (
				!chain &&
				!reading.opaque &&
				reading.paths.length === 0 &&
				validationCommands.length === 0 &&
				validationName === null &&
				verificationCommand === null
			)
				return;
			pending.set(toolCallId, {
				proofCheck,
				tool: toolName,
				toolCallId,
				reading,
				validationCommands,
				validationName,
				mutationRevision,
				verificationCommand,
				outcome: null,
			});
		},
		finish(toolCallId, failed, result) {
			const effects = pending.get(toolCallId);
			pending.delete(toolCallId);
			const call = inFlight.get(toolCallId);
			inFlight.delete(toolCallId);
			// A call that ran with no mutation but its own landing since it started judged the tree as it now stands.
			const settleRan = (ownMutation: boolean) => {
				if (call === undefined || (failed ? call.outcome !== "error" : call.outcome === "blocked")) return;
				if (call.revision + (ownMutation ? 1 : 0) !== mutationRevision) return;
				toolsRanAt.set(call.tool, mutationRevision);
				if (call.tool === ToolNames.Verify) verifyCallsRanAt.set(toolCallId, mutationRevision);
			};
			if (effects === undefined) {
				settleRan(false);
				return;
			}
			if (
				!failed &&
				effects.proofCheck !== null &&
				effects.outcome === "ok" &&
				latestProofCalls.get(effects.proofCheck) === toolCallId
			) {
				const details = result !== null && typeof result === "object" && "details" in result ? result.details : undefined;
				const value = details !== null && typeof details === "object" && "proof" in details ? details.proof : undefined;
				const proof = readObservedProof(value, effects.proofCheck, toolCallId);
				if (proof !== null) proofs.set(effects.proofCheck, proof);
			}
			// An outcome before a later mutation judged a tree that is gone: a pass
			// cannot settle the final tree and a red baseline cannot fail it (bt-27).
			const { reading } = effects;
			// False when a bash call's exit status is only its last command's, so it settles nothing about the check.
			const statusAttributable = () => reading.shell?.statusAttributable !== false;
			const { mutation, checkedAfterOwnMutation, fresh, settled } = settleCheckCall(
				reading,
				failed,
				effects.outcome,
				effects.mutationRevision === mutationRevision,
			);
			if (mutation) {
				outputTarget.changed(reading.changedPaths);
				mutationRevision += 1;
				validationOutcomes.clear();
				checkOutcomes.clear();
				outcomeSequence.clear();
				// The calls were disclosed against outcomes the change just retired, so none is left to disclose (x6-6).
				unclassifiedCalls.length = 0;
				validationCommands.clear();
			}
			settleRan(checkedAfterOwnMutation);
			sequence += 1;
			const settleOutcome = (key: string) => {
				checkOutcomes.set(key, !failed);
				outcomeSequence.set(key, sequence);
			};
			// `pytest; echo done` ran the check, but its status is echo's, so the outcome stays unknown either way.
			if (effects.validationName !== null && settled && statusAttributable()) {
				validationOutcomes.set(effects.validationName, !failed);
				settleOutcome(effects.validationName);
			}
			if (effects.proofCheck !== null && effects.proofCheck.length > 0 && settled) {
				settleOutcome(effects.proofCheck);
				if (reading.shellCommand !== null) settleOutcome(observedValidationCommand(reading.shellCommand));
			}
			// An unknown call that ran neither settles nor clears, so a receipt can only say a standing outcome predates it.
			if (
				reading.verdict === "unknown" &&
				outcomeSequence.size > 0 &&
				(failed ? effects.outcome === "error" : effects.outcome !== "blocked")
			)
				unclassifiedCalls.push({
					sequence,
					label: reading.shell === null ? effects.tool : (reading.shellCommand ?? effects.tool),
				});
			if (failed) {
				for (const target of reading.paths) failedMutationPaths.add(target);
				return;
			}
			// Success-gated on purpose. A shell command the safety policy blocked,
			// or one that came back an error, never reached the filesystem, so it
			// leaves the record closed.
			if (reading.opaque) {
				const downgrade: WriteRecordDowngrade = {
					reason: "opaque_tool_succeeded",
					tool: effects.tool,
					toolCallId: effects.toolCallId,
				};
				const recordWasComplete = writeRecordDowngrades.size === 0;
				writeRecordDowngrades.set(effects.toolCallId, downgrade);
				if (recordWasComplete) options.onWriteRecordDowngraded?.({ ...downgrade });
			}
			for (const target of reading.paths) mutatedPaths.add(target);
			if (fresh && statusAttributable() && reading.shell?.outsideCwd !== true)
				for (const command of effects.validationCommands) validationCommands.add(command);
			if (effects.verificationCommand !== null)
				(statusAttributable() ? verificationCommands : unattributableVerificationCommands).add(effects.verificationCommand);
			if (effects.tool === ToolNames.Verify) {
				verificationCommands.add("tool:verify");
				// The check ran its resolved command, so that command grounds as the same text run through bash would.
				const ran =
					reading.shellCommand === null || effects.outcome === "blocked" || effects.outcome === "error"
						? null
						: validationCommandOf(ToolNames.Bash, { command: reading.shellCommand }, "grounding");
				if (ran !== null) verificationCommands.add(ran);
				if (
					effects.proofCheck !== null &&
					effects.proofCheck.length > 0 &&
					reading.shellCommand !== null &&
					effects.outcome !== "blocked" &&
					effects.outcome !== "error" &&
					call !== undefined
				)
					passedVerifyRuns.set(toolCallId, {
						check: effects.proofCheck,
						command: reading.shellCommand,
						revision: call.revision,
					});
			}
			if (reading.shellCommand !== null && effects.outcome !== "blocked" && effects.outcome !== "error")
				executedShellCommands.push(reading.shellCommand);
		},
		checkOutcome(toolCallId, reported, unresolved) {
			const outcome = reported === "error" && unresolved === true ? "blocked" : reported;
			const effects = pending.get(toolCallId);
			if (effects !== undefined) effects.outcome = outcome;
			const call = inFlight.get(toolCallId);
			if (call !== undefined) call.outcome = outcome;
			if (checkingCalls.has(toolCallId)) checkingCalls.set(toolCallId, outcome);
		},
		snapshot() {
			const oldestStanding = Math.min(...outcomeSequence.values());
			const currentProofs = new Map<string, ObservedProof>();
			for (const [check, proof] of proofs) {
				try {
					if (captureProofSnapshot(cwd, proof.proof.inputs) === proof.snapshot) currentProofs.set(check, proof);
				} catch {
					// Missing or unreadable inputs cannot ground a claim; the result validator names the missing evidence.
				}
			}
			// A path written after an earlier attempt was refused is written, so
			// the successful set always wins the overlap.
			return {
				proofs: currentProofs,
				mutatedPaths: new Set(mutatedPaths),
				failedMutationPaths: new Set([...failedMutationPaths].filter((target) => !mutatedPaths.has(target))),
				validationCommands: new Set(validationCommands),
				validationOutcomes: new Map(validationOutcomes),
				checkOutcomes: new Map(checkOutcomes),
				mutationObserved: mutationRevision > 0,
				checksAllBlocked: checkingCalls.size > 0 && [...checkingCalls.values()].every((outcome) => outcome === "blocked"),
				verificationCommands: new Set(verificationCommands),
				unattributableVerificationCommands: new Set(unattributableVerificationCommands),
				writeRecordComplete: writeRecordDowngrades.size === 0,
				writeRecordDowngrades: [...writeRecordDowngrades.values()].map((entry) => ({ ...entry })),
				executedShellCommands: [...executedShellCommands],
				unclassifiedAfterLastCheck: unclassifiedCalls
					.filter((call) => call.sequence > oldestStanding)
					.map((call) => call.label),
			};
		},
		checkFreshness() {
			const current = (ranAt: ReadonlyMap<string, number>) =>
				new Set([...ranAt].filter(([, revision]) => revision === mutationRevision).map(([key]) => key));
			return {
				mutationObserved: mutationRevision > 0,
				verifyCalls: current(verifyCallsRanAt),
				tools: current(toolsRanAt),
				verifyRuns: [...passedVerifyRuns.values()]
					.filter((run) => run.revision === mutationRevision)
					.map(({ check, command }) => ({ check, command })),
			};
		},
	};
}

/** The engine tool events a run's effects are folded from, as either process sees them. */
export interface ToolExecutionEffectEvent {
	type: string;
	toolCallId?: unknown;
	toolName?: unknown;
	tool?: unknown;
	args?: unknown;
	result?: unknown;
	isError?: unknown;
}

/**
 * Fold one engine tool event into a run's effects, identically in the worker
 * and in the orchestrator's copy of the worker stream. A gateway op=call counts
 * as the capability it ran. A chain counts as each settled, admitted child under
 * `<call id>:<step id>`, judged by that child's own admission outcome; planned,
 * pending and unresolved steps never ran and count for nothing.
 */
export function recordToolExecutionEffects(recorder: RunEffectsRecorder, event: ToolExecutionEffectEvent): void {
	if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
	const toolCallId = event.toolCallId;
	if (event.type === "tool_execution_start") {
		const toolName =
			typeof event.toolName === "string" ? event.toolName : typeof event.tool === "string" ? event.tool : null;
		if (toolName === null) return;
		const call = effectiveToolCall(toolName, event.args);
		recorder.start(toolCallId, call.toolName, call.args);
		return;
	}
	if (event.type !== "tool_execution_end") return;
	for (const child of recorder.started(toolCallId) ? gatewayChainReceipts(String(event.toolName), event.result) : []) {
		const id = `${toolCallId}:${child.id}`;
		recorder.start(id, child.capability, child.args);
		recorder.checkOutcome(id, child.admission.outcome, child.admission.unresolved);
		recorder.finish(id, child.admission.outcome !== "ok", child.result);
	}
	// A structured refusal comes back as an error result with an "error" outcome,
	// such as a gateway capability off the run's surface, but nothing ran.
	if (isRefusalToolResultError(event.result)) recorder.checkOutcome(toolCallId, "blocked");
	recorder.finish(toolCallId, event.isError === true, event.result);
}
