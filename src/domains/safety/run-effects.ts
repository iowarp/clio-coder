import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { typedValidationSummary } from "./finish-contract.js";
import {
	detectValidationCommand,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	tokenizeShellLike,
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
 */
export interface RunEffects {
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
	/** Canonical validation commands the run ran to a clean exit. */
	validationCommands: ReadonlySet<string>;
	/**
	 * The same commands read under the wider `grounding` vocabulary, which adds
	 * read verification (`git diff`), ad-hoc checks (`node -e`) and the runners
	 * the strict set omits (`npx vitest`, `tsc --noEmit`). Always a superset of
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
	 * wider set.
	 */
	verificationCommands: ReadonlySet<string>;
}

export interface RunEffectsRecorder {
	/** Record a tool call's mutation targets and validation identity. */
	start(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void;
	/** Commit a call's effects, or drop them when the call did not succeed. */
	finish(toolCallId: string, failed: boolean): void;
	snapshot(): RunEffects;
}

interface PendingEffects {
	paths: ReadonlyArray<string>;
	validationCommand: string | null;
	verificationCommand: string | null;
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
	for (const segment of splitCommandSegments(command)) {
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

/**
 * Split the shared tokenizer's output on command separators. Only the
 * git-operand scan above needs segments, and it needs them after tokenization
 * rather than off the raw string.
 */
function splitCommandSegments(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of tokenizeShellLike(command)) {
		if (token === ";" || token === "&&" || token === "||" || token === "|") {
			if (current.length > 0) segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

function commandOf(args: Record<string, unknown> | undefined): string | null {
	const command = args?.command;
	return typeof command === "string" && command.length > 0 ? command : null;
}

function mutationTargets(toolName: string, args: Record<string, unknown> | undefined): string[] {
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
function validationCommandOf(
	toolName: string,
	args: Record<string, unknown> | undefined,
	scope: ValidationCommandScope,
): string | null {
	if (toolName === ToolNames.Bash) {
		const command = commandOf(args);
		if (command === null) return null;
		const detected = detectValidationCommand(command, scope);
		return detected.kind === "validation" ? detected.matched : null;
	}
	return typedValidationSummary(toolName, { args: args ?? {} });
}

/**
 * Fold a run's tool calls into its observed effects. A call's effects land only
 * when its result comes back clean: a blocked write and a red command are not
 * evidence that the workspace changed or that a check passed.
 */
export function createRunEffectsRecorder(cwd: string): RunEffectsRecorder {
	const pending = new Map<string, PendingEffects>();
	const mutatedPaths = new Set<string>();
	const failedMutationPaths = new Set<string>();
	const validationCommands = new Set<string>();
	const verificationCommands = new Set<string>();
	return {
		start(toolCallId, toolName, args) {
			const paths = mutationTargets(toolName, args);
			const validationCommand = validationCommandOf(toolName, args, "finish-contract");
			const verificationCommand = validationCommandOf(toolName, args, "grounding");
			if (paths.length === 0 && validationCommand === null && verificationCommand === null) return;
			// A bash call may re-base its relative paths with its own cwd argument.
			const base = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(cwd, args.cwd) : cwd;
			pending.set(toolCallId, {
				paths: paths.map((target) => path.resolve(base, target)),
				validationCommand,
				verificationCommand,
			});
		},
		finish(toolCallId, failed) {
			const effects = pending.get(toolCallId);
			pending.delete(toolCallId);
			if (effects === undefined) return;
			if (failed) {
				for (const target of effects.paths) failedMutationPaths.add(target);
				return;
			}
			for (const target of effects.paths) mutatedPaths.add(target);
			if (effects.validationCommand !== null) validationCommands.add(effects.validationCommand);
			if (effects.verificationCommand !== null) verificationCommands.add(effects.verificationCommand);
		},
		snapshot() {
			// A path written after an earlier attempt was refused is written, so
			// the successful set always wins the overlap.
			return {
				mutatedPaths: new Set(mutatedPaths),
				failedMutationPaths: new Set([...failedMutationPaths].filter((target) => !mutatedPaths.has(target))),
				validationCommands: new Set(validationCommands),
				verificationCommands: new Set(verificationCommands),
			};
		},
	};
}
