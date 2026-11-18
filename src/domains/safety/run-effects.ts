import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ObservedProof } from "../../core/hoare.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import { shellExitSpeaksForCommand } from "../../tools/shell-exit-scope.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { captureProofSnapshot, readObservedProof } from "../../tools/verify/proof.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../../tools/verify/resolve.js";
import { isVerifyListing } from "../../tools/verify/surface.js";
import { classify } from "./action-classifier.js";
import { typedValidationSummary } from "./finish-contract.js";
import {
	type CheckCommandShape,
	checkCommandShape,
	commandArgumentSegments,
	detectValidationCommand,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	isReadOnlyInspectionCommand,
	observedValidationCommand,
	toolMutationPaths,
	type ValidationCommandScope,
} from "./protected-artifacts.js";

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
	 * Canonical validation commands the run ran to a clean exit since its last workspace mutation. A mutation clears
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
	 * The same commands read under the wider `grounding` vocabulary, which adds
	 * read verification (`git diff`), ad-hoc checks (`node -e`) and the runners
	 * the strict set omits (`npx vitest`, `tsc --noEmit`). A verify call adds the
	 * command its check resolved to, read the same way. Always a superset of
	 * `validationCommands`, because the grounding scope falls back to the strict
	 * matcher first.
	 *
	 * The two sets exist because their readers pay different prices for a match.
	 * `validationCommands` opens a gate: `result-contract.ts` reads
	 * `validationCommands.size > 0` as the difference between a mutation report
	 * sealing `pass` and sealing `unmeasured`, and a run whose only command was
	 * `git diff` has asserted nothing about correctness. `verificationCommands`
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
}

export interface RunEffectsRecorder {
	started(toolCallId: string): boolean;
	/** Record a tool call's mutation targets and validation identity. */
	start(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void;
	/** Commit a call's effects, or drop them when the call did not succeed. */
	finish(toolCallId: string, failed: boolean, result?: unknown): void;
	checkOutcome(toolCallId: string, outcome: "ok" | "error" | "blocked"): void;
	snapshot(): RunEffects;
	checkFreshness(): CheckFreshness;
}

interface PendingEffects {
	proofCheck: string | null;
	tool: string;
	toolCallId: string;
	paths: ReadonlyArray<string>;
	validationCommand: string | null;
	validationName: string | null;
	/** False when a bash call's exit status is only its last command's, so it settles nothing about the check. */
	checkStatusAttributable: boolean;
	mutationRevision: number;
	verificationCommand: string | null;
	opaque: boolean;
	/** A bash call made only of read-only inspection ({@link isReadOnlyInspectionCommand}), so it changed no tree. */
	inspection: boolean;
	/** Where the call's check stands against its own changes ({@link checkCommandShape}); null when it runs none. */
	checkShape: CheckCommandShape | null;
	/** The bash command text, or a verify call's resolved argv joined by spaces; null otherwise. */
	shellCommand: string | null;
	/** The tool's own outcome, when the call reached it. Stays null when the engine answered instead. */
	outcome: "ok" | "error" | "blocked" | null;
}

/**
 * Action classes whose successful calls write only paths their own arguments
 * name. `read` covers the observe, retrieve, interact, and orchestrate-bookkeeping
 * tools, none of which touch a source-workspace file: `git` is a closed
 * status/diff/log surface, and `tasks`, `ledger`, and `context` write Clio's own
 * state. `write` covers `write`, `edit`, and `artifact`, whose target
 * `toolMutationPaths` resolves from the call itself, including the artifact
 * tool's default path.
 */
const ENUMERABLE_ACTION_CLASSES: ReadonlySet<string> = new Set(["read", "write"]);

/**
 * Whether a successful call to this tool can mutate a path its own recorded
 * arguments do not name.
 *
 * Asked of the classifier rather than of a hand-written list, because
 * `src/tools/policy.ts` asserts at bootstrap that every registered tool's
 * `baseActionClass` equals what this classifier returns and what the plane
 * table declares. A tool added to the execute or orchestrate-dispatch plane is
 * therefore opaque the day it is registered, with no list to remember to update.
 *
 * The classifier is asked about the tool name alone. Bash's argument scan can
 * escalate a single call to `system_modify` or `git_destructive`, and those are
 * still bash; the question here is what the tool can do, not what one call was
 * caught doing. An unregistered name (a dynamic or MCP tool) classifies as
 * `unknown` and is opaque, which is the fail-closed answer for a tool whose
 * arguments this process has no schema for.
 */
function toolWritesOpaquely(toolName: string): boolean {
	return !ENUMERABLE_ACTION_CLASSES.has(classify({ tool: toolName }).actionClass);
}

/**
 * Git subcommands that move or remove named path operands. The shared
 * write-target extractor classifies bare `mv`/`rm`, not their git spellings,
 * and it stays that way: widening it would change what the finish-contract gate
 * treats as a mutating turn. Grounding wants the wider set, because a path this
 * misses can only produce a false conformance failure.
 */
const GIT_PATH_MUTATIONS: ReadonlySet<string> = new Set(["mv", "rm"]);

function gitPathOperands(command: string): string[] {
	const targets: string[] = [];
	for (const segment of commandArgumentSegments(command)) {
		if (segment[0] !== "git") continue;
		const subcommand = segment[1];
		if (subcommand === undefined || !GIT_PATH_MUTATIONS.has(subcommand)) continue;
		for (const token of segment.slice(2)) {
			if (token.startsWith("-")) continue;
			targets.push(token);
		}
	}
	return targets;
}

/** The command a verify call runs, resolved as the tool resolves it (task gates included); null when it runs none. */
function verifyCommandOf(toolName: string, args: Record<string, unknown> | undefined, base: string): string | null {
	if (toolName !== ToolNames.Verify || args === undefined) return null;
	try {
		return verifyResolutionArgv(resolveVerifyCall(base, args), args, base)?.join(" ") ?? null;
	} catch {
		return null;
	}
}

function commandOf(args: Record<string, unknown> | undefined): string | null {
	const command = args?.command;
	return typeof command === "string" && command.length > 0 ? command : null;
}

export function mutationTargets(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName !== ToolNames.Bash) return toolMutationPaths(toolName, args);
	const command = commandOf(args);
	if (command === null) return [];
	return [...extractCommandWriteTargets(command), ...extractCommandDeleteTargets(command), ...gitPathOperands(command)];
}

/**
 * The canonical identity of a call's check under one scope. A typed
 * verification tool carries the same identity under both scopes: the scope only
 * widens which bash spellings are recognized as a check at all.
 */
export function validationCommandOf(
	toolName: string,
	args: Record<string, unknown> | undefined,
	scope: ValidationCommandScope,
): string | null {
	if (toolName === ToolNames.Bash) {
		const command = commandOf(args);
		if (command === null) return null;
		const detected = detectValidationCommand(command, scope);
		if (detected.kind !== "validation") return null;
		// A scoped unittest run must not stand in for the full suite, so the first positional target names the check.
		if (detected.matched === "python -m unittest") {
			const target = /\s-m\s+unittest((?:\s+\S+)*)/u
				.exec(command)?.[1]
				?.trim()
				.split(/\s+/u)
				.find((token) => token.length > 0 && !token.startsWith("-") && !/^[0-9]*[<>|&]/u.test(token));
			return target ? `${detected.matched} ${target}` : detected.matched;
		}
		return detected.matched;
	}
	return typedValidationSummary(toolName, { args: args ?? {} });
}

/**
 * The command a receipt names for a validation call. The canonical identity reads a script-family verify id such as
 * `test` as `npm run test`, but verify runs the project catalog's or the toolchain's check of that id first, so where
 * the workspace resolves it to anything but a package script the receipt names the argv that really ran. Grounding a
 * worker's claims keeps the canonical identity, which matches claims by check id.
 */
function receiptValidationCommand(
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
function gitRunsConfiguredHelpers(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
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

/**
 * Fold a run's tool calls into its observed effects. A call's effects land only
 * when its result comes back clean: a blocked write and a red command are not
 * evidence that the workspace changed or that a check passed.
 */
export function createRunEffectsRecorder(cwd: string, options: RunEffectsRecorderOptions = {}): RunEffectsRecorder {
	const pending = new Map<string, PendingEffects>();
	const gitHelpers = gitRunsConfiguredHelpers(cwd, options.env);
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
			const paths = mutationTargets(toolName, args);
			// A bash call may re-base its relative paths with its own cwd argument.
			const base = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(cwd, args.cwd) : cwd;
			const validationCommand = receiptValidationCommand(toolName, args, base);
			const verificationCommand = validationCommandOf(toolName, args, "grounding");
			const opaque = toolWritesOpaquely(toolName);
			const command = toolName === ToolNames.Bash ? commandOf(args) : null;
			// A listing names no check and runs none, so it is not a checking call (bt-19).
			if ((toolName === ToolNames.Verify && !isVerifyListing(args)) || verificationCommand !== null)
				checkingCalls.set(toolCallId, null);
			// An opaque call is tracked even when it exposed no path and no
			// command, because the fact that it ran at all is the finding.
			const chain = toolName === "gateway" && args?.op === "chain";
			if (!chain && !opaque && paths.length === 0 && validationCommand === null && verificationCommand === null) return;
			pending.set(toolCallId, {
				proofCheck,
				tool: toolName,
				toolCallId,
				paths: paths.map((target) => path.resolve(base, target)),
				validationCommand,
				validationName:
					toolName === ToolNames.Bash && validationCommand !== null
						? `${base === cwd ? "" : `cwd=${base}: `}${observedValidationCommand(commandOf(args) ?? "")}`
						: null,
				checkStatusAttributable: toolName !== ToolNames.Bash || shellExitSpeaksForCommand(commandOf(args) ?? ""),
				mutationRevision,
				verificationCommand,
				opaque,
				inspection: command !== null && isReadOnlyInspectionCommand(command, gitHelpers),
				checkShape: command === null ? null : checkCommandShape(command, gitHelpers),
				shellCommand: command ?? verifyCommandOf(toolName, args, base),
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
			// A refused call never reached its tool, so it changed nothing and leaves
			// outcomes standing. A failed call that really ran may have partly written.
			const refused = failed && effects.outcome !== "error" && effects.outcome !== "ok";
			// A verify call is a check, as a recognized validation command is: even a bare listing changes no tree. Its
			// argv is one simple command (a catalog refuses shell executables, a task gate takes bare words). A bash
			// check that shares its call with steps that may change the tree is still a mutation, and it judged the
			// final tree only when every such step ran first (x1-1).
			const checkChangedTree = effects.checkShape === "after-change" || effects.checkShape === "mixed";
			const opaqueMutation =
				effects.opaque &&
				!effects.inspection &&
				(checkChangedTree || (effects.tool !== ToolNames.Verify && effects.validationCommand === null));
			const mutation = !refused && (effects.paths.length > 0 || opaqueMutation);
			if (mutation) {
				mutationRevision += 1;
				validationOutcomes.clear();
				checkOutcomes.clear();
				validationCommands.clear();
			}
			const checkedAfterOwnMutation = mutation && effects.checkShape !== "mixed" && effects.checkShape !== "pure";
			const checkedRevision = effects.mutationRevision + (checkedAfterOwnMutation ? 1 : 0);
			settleRan(checkedAfterOwnMutation);
			// Only a check that ran can fail. A call the engine answered without
			// reaching its tool settles with no outcome, so it records nothing.
			// `pytest; echo done` ran the check, but its status is echo's, so the outcome stays unknown either way.
			const settled = failed
				? effects.outcome === "error"
				: effects.outcome !== "blocked" && checkedRevision === mutationRevision;
			if (effects.validationName !== null && effects.checkStatusAttributable && settled) {
				validationOutcomes.set(effects.validationName, !failed);
				checkOutcomes.set(effects.validationName, !failed);
			}
			if (effects.proofCheck !== null && effects.proofCheck.length > 0 && settled) {
				checkOutcomes.set(effects.proofCheck, !failed);
				if (effects.shellCommand !== null) checkOutcomes.set(observedValidationCommand(effects.shellCommand), !failed);
			}
			if (failed) {
				for (const target of effects.paths) failedMutationPaths.add(target);
				return;
			}
			// Success-gated on purpose. A shell command the safety policy blocked,
			// or one that came back an error, never reached the filesystem, so it
			// leaves the record closed.
			if (effects.opaque) {
				const downgrade: WriteRecordDowngrade = {
					reason: "opaque_tool_succeeded",
					tool: effects.tool,
					toolCallId: effects.toolCallId,
				};
				const recordWasComplete = writeRecordDowngrades.size === 0;
				writeRecordDowngrades.set(effects.toolCallId, downgrade);
				if (recordWasComplete) options.onWriteRecordDowngraded?.({ ...downgrade });
			}
			for (const target of effects.paths) mutatedPaths.add(target);
			if (effects.validationCommand !== null && effects.checkStatusAttributable && checkedRevision === mutationRevision)
				validationCommands.add(effects.validationCommand);
			if (effects.verificationCommand !== null)
				(effects.checkStatusAttributable ? verificationCommands : unattributableVerificationCommands).add(
					effects.verificationCommand,
				);
			if (effects.tool === ToolNames.Verify) {
				verificationCommands.add("tool:verify");
				// The check ran its resolved command, so that command grounds as the same text run through bash would.
				const ran =
					effects.shellCommand === null || effects.outcome === "blocked" || effects.outcome === "error"
						? null
						: validationCommandOf(ToolNames.Bash, { command: effects.shellCommand }, "grounding");
				if (ran !== null) verificationCommands.add(ran);
				if (
					effects.proofCheck !== null &&
					effects.proofCheck.length > 0 &&
					effects.shellCommand !== null &&
					effects.outcome !== "blocked" &&
					effects.outcome !== "error" &&
					call !== undefined
				)
					passedVerifyRuns.set(toolCallId, {
						check: effects.proofCheck,
						command: effects.shellCommand,
						revision: call.revision,
					});
			}
			if (effects.shellCommand !== null && effects.outcome !== "blocked" && effects.outcome !== "error")
				executedShellCommands.push(effects.shellCommand);
		},
		checkOutcome(toolCallId, outcome) {
			const effects = pending.get(toolCallId);
			if (effects !== undefined) effects.outcome = outcome;
			const call = inFlight.get(toolCallId);
			if (call !== undefined) call.outcome = outcome;
			if (checkingCalls.has(toolCallId)) checkingCalls.set(toolCallId, outcome);
		},
		snapshot() {
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
		recorder.checkOutcome(id, child.admission.outcome);
		recorder.finish(id, child.admission.outcome !== "ok", child.result);
	}
	// A structured refusal comes back as an error result with an "error" outcome,
	// such as a gateway capability off the run's surface, but nothing ran.
	if (isRefusalToolResultError(event.result)) recorder.checkOutcome(toolCallId, "blocked");
	recorder.finish(toolCallId, event.isError === true, event.result);
}
