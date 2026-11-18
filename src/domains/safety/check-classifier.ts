import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { shellExitSpeaksForCommand } from "../../tools/shell-exit-scope.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../../tools/verify/resolve.js";
import { isVerifyListing } from "../../tools/verify/surface.js";
import { classify } from "./action-classifier.js";
import { type DeclaredVerifierCommand, declaredCheckRuns, typedValidationSummary } from "./finish-contract.js";
import {
	type CheckCommandShape,
	type CommandVerdict,
	checkCommandShape,
	checkFailureAttributable,
	checkLogTargets,
	checkRunsOutside,
	checkWritesTree,
	commandArgumentSegments,
	detectValidationCommand,
	extractCommandCdTargets,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	observedValidationCommand,
	shellCommandVerdict,
	shellWritesOnlyNamedTargets,
	toolMutationPaths,
	type ValidationCommandScope,
} from "./protected-artifacts.js";

/**
 * The one reader of what a tool call does to the tree, shared by every consumer that decides whether a call ran a
 * check, cleared one, or neither: the run-effects recorder, the task board's replay over session entries, and through
 * them the sealed receipt, its typed evidence and the headless `observed:` line (x5-1, x5-2).
 *
 * - `check`: a recognized check, bash (the validation vocabulary, the closed read-only check set, or a check the
 *   project catalog or the session declares, run whole in its cwd (x7-5)), `verify`, or a typed validation tool. It settles its outcome when fresh, inside the workspace and attributable; one whose own
 *   shape writes the tree (after-change, mixed, `-u`, `--fix`) is also a change.
 * - `inspection`: only reads. Settles nothing and clears nothing.
 * - `mutation`: provably or plausibly writes: an edit, write or artifact path, a redirect or `tee` to a tree path, a
 *   known writer (`node -e`, an emitting `tsc`, `jest -u`, `sed -i`, git beyond inspection, an install), or a
 *   registered tool that writes paths its arguments do not name (`dispatch`, `run_script`). It clears standing passes,
 *   unless every write is a target it names outside the workspace (x7-1), and settles no pass of its own.
 * - `unknown`: cannot be told apart (an unrecognized command, a package check refused for a runtime loader after
 *   `--`, a tool this process has no registration for). It neither settles nor clears a recorded outcome; the
 *   recorder lists it so a receipt can say it ran after a standing check.
 */
export type CallVerdict = CommandVerdict;

/** Where a check's output may land without changing the tree it judged (x4-2, x5-4); see `checkOutputReader`. */
export interface CheckOutputReader {
	(base: string, logs?: ReadonlySet<string>): (target: string) => boolean;
	/** Paths a call changed: a later check log written there overwrites the run's own work, so it stays a change. */
	changed(paths: Iterable<string>): void;
	/** Whether a write target lands outside the workspace: out of `cwd`, under the temp dir or a scratch root (x7-1). */
	outside(base: string): (target: string) => boolean;
}

export interface ClassifierContext {
	/** The run's workspace. */
	cwd: string;
	/**
	 * The repository's git config names a helper program, which narrows the git steps that only read (x1-3). Absent
	 * reads as none; a check's verdict never depends on it.
	 */
	gitHelpers?: boolean;
	/** Where a check's log may land; absent, no target is one, so every write in a check call is a change. */
	outputTarget?: CheckOutputReader;
	/** Checks the project catalog or the session declares (`declaredVerifierCommands`); a bash run of one is a check. */
	declaredChecks?: ReadonlyArray<DeclaredVerifierCommand>;
}

const NO_OUTPUT_TARGET: CheckOutputReader = Object.assign(() => () => false, {
	changed() {},
	outside: () => () => false,
});

/** What a bash command's own text says about the check it runs. */
export interface ShellCheckReading {
	/** False when the call's exit status is only a later command's ({@link shellExitSpeaksForCommand}). */
	statusAttributable: boolean;
	/** False when a stage piped after the check can fail a green check ({@link checkFailureAttributable}). */
	failureAttributable: boolean;
	/** The check ran outside `cwd` ({@link checkRunsOutside}), so its pass is not this workspace's. */
	outsideCwd: boolean;
}

export interface CallClassification {
	verdict: CallVerdict;
	/** The call changes the tree: a mutation that writes the workspace, or a check whose own shape or targets write it. */
	changesTree: boolean;
	/** Where the call ran: the run's cwd, re-based by a bash call's own cwd argument. */
	base: string;
	/** Absolute paths the call's arguments aim a mutation at. */
	paths: string[];
	/** `paths` less the logs a check's output was written to, which change no tree the check judged (x4-2). */
	changedPaths: string[];
	/** The bash command text, or a verify call's resolved argv joined by spaces; null otherwise. */
	shellCommand: string | null;
	/** A bash command read for its check; null for any other call. */
	shell: ShellCheckReading | null;
	/** The tool can write paths its own arguments do not name, so the write record is open once it succeeds. */
	opaque: boolean;
	/** Where its check stands against its own changes ({@link checkCommandShape}); null when it runs none. */
	shape: CheckCommandShape | null;
	/** A check's canonical identity in the `grounding` vocabulary; null for anything but a named check. */
	check: string | null;
	/**
	 * The name a check's outcome is filed under: a bash check's full observed command, named or not by a vocabulary,
	 * else {@link check}. The recorder and the task board both key on it, so neither drops a check the other keeps (x6-1).
	 */
	name: string | null;
}

/** The name a bash check's outcome is filed under: its full observed command, prefixed with its directory off `cwd`. */
function observedCheckName(command: string, base: string, cwd: string): string {
	return `${base === cwd ? "" : `cwd=${base}: `}${observedValidationCommand(command)}`;
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
 * widens which bash spellings are recognized as a check at all. It names a check; whether a call ran one is
 * {@link classifyCall}'s answer alone.
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
 * The verdict alone, for a consumer that needs no other facet of the reading (the registry, the finish contract). It
 * is {@link classifyCall}'s verdict, computed without the facets only a recorder or replay reads (x6-7), and without
 * the declared checks, so a declared run that the vocabulary does not name reads here as it would undeclared.
 */
export function callVerdict(
	toolName: string,
	args: Record<string, unknown> | undefined,
	gitHelpers = false,
): CallVerdict {
	if (toolName !== ToolNames.Bash) return toolVerdict(toolName, args, toolMutationPaths(toolName, args).length);
	const command = commandOf(args);
	return command === null ? "unknown" : shellCommandVerdict(command, gitHelpers);
}

/**
 * A bash command's {@link ShellCheckReading}, each facet read from the command on first use: only a check, or a call a
 * vocabulary names, ever asks, so a large write never pays for them (x6-7).
 */
function shellCheckReading(command: string, base: string, cwd: string): ShellCheckReading {
	let statusAttributable: boolean | undefined;
	let failureAttributable: boolean | undefined;
	let outsideCwd: boolean | undefined;
	return {
		get statusAttributable() {
			statusAttributable ??= shellExitSpeaksForCommand(command);
			return statusAttributable;
		},
		get failureAttributable() {
			failureAttributable ??= checkFailureAttributable(command);
			return failureAttributable;
		},
		get outsideCwd() {
			outsideCwd ??= checkRunsOutside(command, base, cwd);
			return outsideCwd;
		},
	};
}

/** A tool other than bash: verify and typed validation check, named paths change, an unregistered tool is unknown. */
function toolVerdict(toolName: string, args: Record<string, unknown> | undefined, paths: number): CallVerdict {
	if (toolName === ToolNames.Verify) return isVerifyListing(args) ? "inspection" : "check";
	if (typedValidationSummary(toolName, { args: args ?? {} }) !== null) return "check";
	if (paths > 0) return "mutation";
	if (!toolWritesOpaquely(toolName)) return "inspection";
	return classify({ tool: toolName }).actionClass === "unknown" ? "unknown" : "mutation";
}

/**
 * Whether a mutation changes the workspace tree (x7-1). One whose every write is a target it names, all landing outside
 * the workspace (out of `cwd`, under the temp dir or a scratch root, never a git-ignored path inside it), leaves the
 * tree as it was, as the finish contract's in-workspace filter already reads it. An opaque writer (git, an interpreter,
 * an install, a tool that writes paths its arguments do not name) stays a change. After a `cd` only an absolute target
 * is placed.
 */
function writesTree(
	toolName: string,
	command: string | null,
	targets: ReadonlyArray<string>,
	base: string,
	gitHelpers: boolean,
	outputTarget: CheckOutputReader,
): boolean {
	const named = command !== null ? shellWritesOnlyNamedTargets(command, gitHelpers) : !toolWritesOpaquely(toolName);
	if (!named) return true;
	const rebased = command !== null && extractCommandCdTargets(command).length > 0;
	const outside = outputTarget.outside(base);
	return targets.some((target) => (rebased && !/^[/~$]/u.test(target)) || !outside(target));
}

/**
 * Read one call at its start, for the recorder and the task board's replay alike (x4-1). `context.cwd` is the run's
 * workspace; a bash call's own `cwd` argument re-bases it.
 */
export function classifyCall(
	toolName: string,
	args: Record<string, unknown> | undefined,
	context: ClassifierContext,
): CallClassification {
	const { cwd, gitHelpers = false, outputTarget = NO_OUTPUT_TARGET, declaredChecks = [] } = context;
	const base = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(cwd, args.cwd) : cwd;
	const command = toolName === ToolNames.Bash ? commandOf(args) : null;
	const shellCommand = command ?? verifyCommandOf(toolName, args, base);
	const targets = mutationTargets(toolName, args);
	const paths = targets.map((target) => path.resolve(base, target));
	// The steps that run a declared check are check steps, so the call is a check whose shape places them (x7-5).
	const declaredSteps = new Set(
		command === null ? [] : declaredCheckRuns(command, base, declaredChecks).flatMap((run) => run.steps),
	);
	const verdict = declaredSteps.size > 0 ? "check" : callVerdict(toolName, args, gitHelpers);
	// A bash command has a shape exactly when it runs a check, so only a check reads where its output lands.
	const isOutput = command !== null && verdict === "check" ? outputTarget(base, checkLogTargets(command)) : () => false;
	const shape =
		command !== null
			? verdict === "check"
				? checkCommandShape(command, gitHelpers, isOutput, declaredSteps)
				: null
			: // A verify check whose argv rewrites the tree (`npm run format`) is a change, as in bash (x3-3).
				verdict === "check" && shellCommand !== null && checkWritesTree(shellCommand.split(" "))
				? "mixed"
				: null;
	const outputs =
		command !== null && shape !== null
			? new Set(
					extractCommandWriteTargets(command)
						.filter(isOutput)
						.map((target) => path.resolve(base, target)),
				)
			: new Set<string>();
	const changedPaths = paths.filter((target) => !outputs.has(target));
	const check = verdict === "check" ? validationCommandOf(toolName, args, "grounding") : null;
	return {
		verdict,
		changesTree:
			(verdict === "mutation" && writesTree(toolName, command, targets, base, gitHelpers, outputTarget)) ||
			(verdict === "check" && (changedPaths.length > 0 || shape === "after-change" || shape === "mixed")),
		base,
		paths,
		changedPaths,
		shellCommand,
		shell: command === null ? null : shellCheckReading(command, base, cwd),
		opaque: toolWritesOpaquely(toolName),
		shape,
		check,
		name: verdict === "check" && command !== null ? observedCheckName(command, base, cwd) : check,
	};
}

export interface CheckCallSettlement {
	/** The call counts as a workspace change, so no earlier pass stands on the tree it left. */
	mutation: boolean;
	/** Its check ran after its own change, so it judged the tree that change left. */
	checkedAfterOwnMutation: boolean;
	/** Its check judged the tree as it now stands. */
	fresh: boolean;
	/** Its outcome settles its check: a red that is the check's own, or a fresh green in this workspace. */
	settled: boolean;
}

/**
 * How one finished call bears on the outcomes standing before it, shared by the recorder and the task board's replay
 * (x4-1). `startedOnCurrentTree` says no other call's change landed while it ran. A refused call never reached its
 * tool, so it changed nothing and settles nothing. A failed call that really ran may have partly written. Only a
 * check settles; inspection and unknown calls neither settle nor clear.
 */
export function settleCheckCall(
	call: CallClassification,
	failed: boolean,
	outcome: "ok" | "error" | "blocked" | null,
	startedOnCurrentTree: boolean,
): CheckCallSettlement {
	const refused = failed && outcome !== "error" && outcome !== "ok";
	// A bash check that shares its call with steps that may change the tree is still a mutation, and it judged the
	// final tree only when every such step ran first (x1-1). A check that rewrites the tree, bash or verify, is a
	// change too, so no earlier pass stands on code it reformatted (x3-3).
	const mutation = !refused && call.changesTree;
	const checkedAfterOwnMutation = mutation && call.shape !== "mixed" && call.shape !== "pure";
	const fresh = startedOnCurrentTree && (!mutation || checkedAfterOwnMutation);
	// Only a check that ran can fail. A call the engine answered without
	// reaching its tool settles with no outcome, so it records nothing.
	// `pytest | head` exits 0 only when pytest did, but its red may be head's SIGPIPE (x3-2). A pass in another
	// directory judged another tree, so it settles nothing here and a standing red stays (x3-5). A change that runs no
	// check (`node -e`, a `tsc` that emits, `npx jest -u`) lands no outcome of its own (x5-1), and an unknown call
	// such as a loader-refused `npm test -- --import x` settles nothing (x5-2).
	const settled =
		call.verdict === "check" &&
		(failed
			? outcome === "error" && call.shell?.failureAttributable !== false
			: outcome !== "blocked" && fresh && call.shell?.outsideCwd !== true);
	return { mutation, checkedAfterOwnMutation, fresh, settled };
}
