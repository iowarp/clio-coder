import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { probeToolEnv } from "../../core/bash-exec.js";
import { asDirectoryPathBoundary, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import {
	canonicalizeExistingPath,
	canonicalizePath,
	canonicalizeRawPath,
	createPathWalkMemo,
	type PathWalkMemo,
} from "../../core/path-canonical.js";
import { mainSandboxGitControlPaths, type YoloScriptSandboxState } from "../../core/sandbox/main-session.js";
import { isSessionAuthoredFile } from "../../core/session-authored-files.js";
import { ToolNames } from "../../core/tool-names.js";
import { clioConfigDir, resolveClioDirs } from "../../core/xdg.js";
import { expandPath } from "../../tools/path-utils.js";
import type { RunScriptInterpreter } from "../../tools/run-script.js";
import { resolveProjectVerifierExecutionCwd } from "../../tools/verify/catalog.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../../tools/verify/resolve.js";
import { prepareVerifyArguments } from "../../tools/verify/surface.js";
import {
	type ActionClass,
	bashDeleteReasons,
	type Classification,
	type ClassifierCall,
	classify,
	normalizeCallPaths,
} from "./action-classifier.js";
import { downloadedFiles, findDeletesNotFollowing, removedAbsolutePaths, unpackedTargets } from "./command-readings.js";
import {
	cleansIgnoredFiles,
	outwardShellReason,
	SNAPSHOT_RECOVERABLE_GIT_PATTERNS,
	SNAPSHOT_RECOVERABLE_GIT_RULE_IDS,
	SNAPSHOT_RECOVERABLE_REASON_CODE,
} from "./containment.js";
import { CONFIRMED_POSTURE } from "./contract.js";
import type { DamageControlMatch, DamageControlRule } from "./damage-control.js";
import {
	BUILD_OUTPUT_PATHS,
	DEFAULT_DAMAGE_CONTROL_PATH_POLICY,
	mergePathPolicyInputs,
	OPERATOR_PATH_POLICY,
} from "./default-path-policy.js";
import type { ApprovedFlowPolicy } from "./flow-policy-snapshot.js";
import {
	forgetApprovedFlowPolicy,
	recallApprovedFlowPolicy,
	rememberApprovedFlowPolicy,
} from "./flow-policy-snapshot.js";
import { normalizedGitCommands } from "./git-command-normalization.js";
import { classifyBashGit, splitGitChdir } from "./git-policy.js";
import type { FlowRestrictionSet, FlowSourceCall, InformationFlowPolicy } from "./information-flow.js";
import { compileInformationFlowPolicy, flowRestrictionsForCall } from "./information-flow.js";
import { inertQuotedMatch } from "./literal-exemption.js";
import {
	type CompiledPathPolicy,
	compilePathPolicy,
	evaluatePathPolicy,
	isSameOrDescendant,
	type PathPolicyDecision,
	type PathPolicyInput,
	type PathPolicyOperation,
} from "./path-policy.js";
import {
	type LoadedProjectSafetyPolicy,
	loadProjectSafetyPolicy,
	type ProjectCommandPolicy,
} from "./project-policy.js";
import {
	commandArgumentSegments,
	decodedLocaleQuoting,
	extractCommandDeleteTargets,
	extractCommandPathWalks,
	extractCommandWriteTargets,
	extractFilteredFindDeleteRoots,
	hasUnparsedShellScript,
	inlineShellScript,
	invokesClioSkillMutation,
	type ScriptSource,
	type ShellToken,
	scanShellLike,
	scanShellLikeDeep,
	scriptLineSources,
	shellCommandSteps,
	shellScriptSources,
} from "./protected-artifacts.js";
import {
	isReadScopeTool,
	type ReadScopeExemptRoot,
	readScopeEscape,
	readScopeExemptRoots,
	readScopeSpellings,
} from "./read-scope.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { ROUTING_PIN_HINT } from "./routing-settings.js";
import { getCachedDefaultRulePacks, type PackId, type RulePacks } from "./rule-pack-loader.js";
import { effectiveScratchRoots } from "./scratch-roots.js";
import {
	advanceScriptShell,
	childScriptShell,
	commandMoveBases,
	newScriptReader,
	newScriptShell,
	readScriptLine,
	type ScriptLine,
	type ScriptNames,
	type ScriptReader,
	type ScriptShell,
} from "./script-shell.js";
import { clioCredentialStorePaths } from "./secret-paths.js";
import type { MutationCandidate } from "./skill-authority.js";
import {
	activeClioSkillRoots,
	foreignDevRootReason,
	mutationCandidates,
	skillMutationReason,
} from "./skill-authority.js";
import { gateProjectSafetyPolicy, workspaceTrustDirectory } from "./workspace-trust.js";
import {
	YOLO_FLOOR_PACK_RULE_IDS,
	YOLO_FLOOR_REASON_PREFIX,
	YOLO_FLOOR_RULE_IDS,
	YOLO_FLOOR_TEXT_RULES,
	type YoloFloorHit,
	yoloFloorDeleteHit,
	yoloFloorExecutableHit,
} from "./yolo-floor.js";

export type SafetyPolicySource =
	| "damage-control:base"
	| "project-policy"
	| "project-policy-invalid"
	| "builtin-command-allowlist"
	| "builtin-classifier"
	| "none";

export interface SafetyPolicyDecision {
	/**
	 * Net verdict (sd-01 §2.2): `block` is final, and `ask` is a net rail
	 * demanding operator confirmation at the current level. Under the
	 * operator's yolo scope only the floor, operator-authored rules and the
	 * run's ceilings block and nothing asks (#407). Under the operator's
	 * default scope only the floor, path and authority rails and the run's
	 * ceilings block, and former damage-control blocks ask. An `allow` means
	 * the net passed; the autonomy mapping decides what happens next at the
	 * admission seam (tools/registry.ts, acp/tool-mediator.ts).
	 */
	kind: "allow" | "ask" | "block";
	classification: Classification;
	tool: string;
	actionClass: ActionClass;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
	reasonCode: string;
	command?: string;
	cwd: string;
	posture?: string;
	policySource: SafetyPolicySource;
	policyHash?: string;
	projectPolicyPath?: string;
	match?: DamageControlMatch;
	rejection?: RejectionMessage;
	/**
	 * Execute-class passes only: whether the command is in the no-prompt set
	 * (built-in allowlist, project policy command, typed execution tool). The
	 * autonomy mapping asks for unrecognized execution in default mode.
	 */
	execRecognition?: "recognized" | "unrecognized";
	/**
	 * Set when a built-in test runner is recognized, alone, behind a workspace
	 * PYTHONPATH, or as one step of a recognized chain. The runner executes
	 * repository code whoever wrote it, so an attended main session at default
	 * asks once per session before its first test runner, and a headless run
	 * keeps #377's allow (#377 follow-up).
	 */
	runsWorkspaceCode?: true;
	/**
	 * Set on an allowed read, ls, grep, or find whose path resolves outside the
	 * workspace and outside Clio's own readable roots. The net passed; the
	 * autonomy mapping asks for it in default mode. The operator's default
	 * scope never sets it: its reads of non-secret paths run anywhere.
	 */
	readScope?: "outside-workspace";
	/**
	 * Set on a decision whose call runs in the main-session sandbox
	 * (`src/core/sandbox/main-session.ts`), which may write only the canonical
	 * workspace, these scratch roots, the package caches and the repository's
	 * git dirs: a contained bash or run_script call of the operator's session
	 * at default, or a script under the operator's yolo with
	 * `safety.sandbox: required` (#419).
	 */
	shellSandbox?: { workspace: string; scratchRoots: ReadonlyArray<string> };
	/**
	 * Set when the operator's default admits a destructive call because the
	 * workspace snapshot taken right before it can undo it: a worktree discard,
	 * a stash drop, or a delete inside the workspace or a scratch root. The
	 * registry snapshots before the body and refuses the call when that
	 * snapshot cannot be taken.
	 */
	recoverable?: true;
}

export interface SafetyPolicyMetadata {
	version: 1;
	rulePackHash: string;
	rulePackVersion: number;
	activeRuleIds: ReadonlyArray<string>;
	projectPolicyPath: string | null;
	projectPolicyHash: string | null;
	projectPolicyValid: boolean;
	projectPolicyErrors: ReadonlyArray<string>;
	disableDefaultPathPolicy?: boolean;
	workspaceTrustVerdict?: "trusted" | "untrusted" | "changed";
	cwd: string;
}

/**
 * The operator's yolo (#407, #419). With a scope the engine judges a call the
 * skip-permissions way: only the yolo floor, operator-authored rules and the
 * run's ceilings (write roots, a required sandbox the host lacks) block, and
 * nothing asks. Admission passes it for a call the operator's session
 * registry makes at yolo, which includes the turns that scheduled `main` jobs
 * and `main_turn` deliveries run in that session, and for a worker whose
 * permit inherited the operator's yolo. A worker grant and a scheduled
 * command job never get it; `posture` still says "yolo" for them and keeps
 * the rails.
 */
export interface OperatorYoloScope {
	level?: "yolo";
	/** `safety.scratchRoots` from the operator's own settings, unvalidated here. */
	scratchRoots: ReadonlyArray<string>;
	/** How a script runs on this host; absent reads as `unsandboxed`. */
	scriptSandbox?: YoloScriptSandboxState;
}

/**
 * The operator's own session at autonomy default: containment first,
 * judgment second, asking last. Only the main session's registry passes it,
 * so workers, grants and scheduled command jobs keep today's rails. Under it
 * the yolo floor blocks first, then the path, authority and ceiling rails
 * still block; a contained bash or run_script call needs no ask for what its
 * command text hides; a damage-control hit a workspace snapshot can undo
 * runs; every other former damage-control block asks, so the safety judge
 * decides it with the operator's intent; a typed write or edit inside a
 * scratch root runs like one inside the workspace; and reads outside the
 * workspace run.
 */
export interface OperatorDefaultScope {
	level: "default";
	/** `safety.scratchRoots` from the operator's own settings, unvalidated here. */
	scratchRoots: ReadonlyArray<string>;
	/** True when this session's bash and run_script calls run in the main-session sandbox on this host. */
	sandbox: boolean;
	/** True when a workspace snapshot is taken before a destructive call runs (a git work tree, `safety.snapshots` on). */
	snapshots: boolean;
}

/** The scope the operator's own session hands the engine at its autonomy level. */
export type OperatorScope = OperatorYoloScope | OperatorDefaultScope;

export interface SafetyPolicyEngine {
	evaluate(call: ClassifierCall, posture?: string, scope?: OperatorScope): SafetyPolicyDecision;
	/**
	 * False when a zero-access entry covers the path. The per-entry filter of a
	 * listing or a search asks this about every result, so it runs the path
	 * policy alone instead of a whole admission.
	 */
	readablePath(target: string): boolean;
	/**
	 * Block reason when a write would land outside this run's write roots, or
	 * null. The typed mutation seam asks again right before it publishes, so a
	 * link swapped in after admission is still caught (F3).
	 */
	writeTargetViolation(target: string): string | null;
	metadata(posture?: string): SafetyPolicyMetadata;
	/** Compiled, trust-gated information-flow rules of the project policy. */
	informationFlow(): InformationFlowPolicy;
	/**
	 * Restrictions the result of this call will carry, judged by the path or
	 * tool name before the call runs. Null for an unrestricted source.
	 */
	flowRestrictionsFor(call: ClassifierCall): FlowRestrictionSet | null;
}

export interface SafetyPolicyEngineOptions {
	cwd?: string;
	rulePacks?: RulePacks;
	projectPolicy?: LoadedProjectSafetyPolicy;
	/**
	 * Absolute path boundaries a write-class tool call is confined to for this run.
	 * Exact files omit a trailing slash and subtrees retain one.
	 * When present and non-empty, a write/edit target outside every root is a
	 * final BLOCK (reason code "write-root"). Empty or absent disables the check.
	 * Enforced at the worker safety seam so both the native worker registry and
	 * the Claude SDK hook path inherit it.
	 */
	writeRoots?: ReadonlyArray<string>;
	/**
	 * True when the OS sandbox confines every command this run spawns to the
	 * same write roots (a dispatched worker under bubblewrap). Execute-class
	 * tools then stay admissible under write roots; dispatch still escapes.
	 */
	writeRootsOsConfined?: boolean;
	/**
	 * Extra trees read-class tools may read outside the workspace, judged by
	 * real path like the built-in exempt roots. A sandboxed worker passes its
	 * sandbox's readable roots, which its own shell can already read.
	 */
	readExemptRoots?: ReadonlyArray<string>;
}

/** What {@link OperatorDefaultScope} resolves to for one evaluation. */
interface DefaultResort {
	/** Canonical: the built-in temp roots plus the operator's valid scratch roots. */
	scratchRoots: ReadonlyArray<string>;
	/** The call runs in the main-session sandbox. */
	contained: boolean;
	/** A workspace snapshot precedes a destructive call. */
	snapshots: boolean;
}

/** A former hard block the operator's default turns into an ask, kept until the other rails have spoken. */
type DeferredAsk = Omit<
	SafetyPolicyDecision,
	"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
>;

/** A hard block from the authority and protected-path rails. */
interface AuthorityBlock {
	reasonCode: string;
	reasons: string[];
	policySource: SafetyPolicySource;
}

interface SourcedRule {
	rule: DamageControlRule;
	source: SafetyPolicySource;
}

const BUILTIN_ALLOWLIST: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "builtin:pwd", re: /^pwd$/ },
	// ls is not here: its operands must pass the workspace scope check (`ls /etc`,
	// `ls ..`, `ls link/` through a symlink) and -R walks without bound, so it is
	// recognized only through readOnlyInspectionRule.
	{ id: "builtin:git-status", re: /^git\s+status(?:\s+--short|\s+--branch|\s+-sb)*$/ },
	{ id: "builtin:git-diff", re: /^git\s+diff(?:\s+--cached|\s+--stat|\s+--name-only|\s+--\s+[\w./-]+)*$/ },
	{ id: "builtin:git-log", re: /^git\s+log\s+--oneline(?:\s+-n\s+[1-9]\d{0,2})?(?:\s+--\s+[\w./-]+)?$/ },
];

/**
 * A deny-mode fleet worker ran `node --version`, the call fell to
 * bash-unrecognized, and the refusal counted toward WORKER_REFUSAL_LIMIT until
 * the worker ended at three (0.6.3 dogfood). Each tool lists only the spellings
 * that print a version and exit: `node version`, `python version` and
 * `make version` run a workspace file or Makefile target, `python -v` starts a
 * verbose interpreter on stdin, and `yarn version` bumps the package. The
 * bare tool name is required, so `./node` or `/tmp/node` never matches. The
 * probe is recognized only standalone, like `git diff --check`: a
 * BUILTIN_ALLOWLIST entry would also recognize `node --version | cat` and
 * `node --version && git status` as chain steps.
 */
const VERSION_PROBE = versionProbePattern();

function versionProbePattern(): RegExp {
	const probes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
		["node", ["--version", "-v"]],
		["npm", ["--version", "-v"]],
		["pnpm", ["--version", "-v"]],
		["yarn", ["--version", "-v"]],
		["bun", ["--version", "-v"]],
		["deno", ["--version", "-V"]],
		["python", ["--version", "-V"]],
		["python3", ["--version", "-V"]],
		["pip", ["--version", "-V"]],
		["pip3", ["--version", "-V"]],
		["uv", ["--version", "-V"]],
		["go", ["version"]],
		["cargo", ["--version", "-V", "version"]],
		["rustc", ["--version", "-V"]],
		["ruby", ["--version", "-v"]],
		["java", ["--version"]],
		["javac", ["--version"]],
		["gcc", ["--version"]],
		["g\\+\\+", ["--version"]],
		["clang", ["--version"]],
		["make", ["--version"]],
		["cmake", ["--version"]],
		["git", ["--version", "version"]],
		["tsc", ["--version", "-v"]],
	];
	const alternatives = probes.map(([tool, flags]) => `${tool}[ \\t]+(?:${flags.join("|")})`);
	return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/**
 * Test runners run without an ask in default and yolo modes (#377). They
 * execute repository-authored code, which the maintainer accepted so a
 * headless run can verify its own work by the project's own command. Every id
 * here maps to a `detectValidationCommand` label, and
 * `tests/contracts/test-runner-vocabulary.test.ts` fails when the two drift.
 * Arguments stay bare words: quoting, substitution, and operators fall through
 * to the rails below.
 */
export const TEST_RUNNER_COMMANDS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "builtin:npm-test", re: /^npm\s+(?:test|run\s+test)(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:pnpm-test", re: /^pnpm\s+(?:test|run\s+test)(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:yarn-test", re: /^yarn\s+(?:test|run\s+test)(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:bun-test", re: /^bun\s+(?:test|run\s+test)(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{
		id: "builtin:npm-test-script",
		re: /^npm\s+run\s+test:[\w=./:-]+(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/,
	},
	{
		id: "builtin:pnpm-test-script",
		re: /^pnpm\s+run\s+test:[\w=./:-]+(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/,
	},
	{
		id: "builtin:yarn-test-script",
		re: /^yarn\s+run\s+test:[\w=./:-]+(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/,
	},
	{
		id: "builtin:bun-test-script",
		re: /^bun\s+run\s+test:[\w=./:-]+(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/,
	},
	// uv can provision dependencies before pytest; --no-sync keeps #377's
	// unattended allowance from authorizing environment synchronization.
	{
		id: "builtin:uv-pytest",
		re: /^uv\s+run(?:\s+--(?:frozen|locked))*\s+--no-sync(?:\s+--(?:no-sync|frozen|locked))*\s+pytest(?:\s+[\w=./:-]+)*$/,
	},
	{
		id: "builtin:uv-python-pytest",
		re: /^uv\s+run(?:\s+--(?:frozen|locked))*\s+--no-sync(?:\s+--(?:no-sync|frozen|locked))*\s+python\s+-m\s+pytest(?:\s+[\w=./:-]+)*$/,
	},
	{ id: "builtin:node-test", re: /^node\s+--test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:pytest", re: /^pytest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:python-pytest", re: /^python(?:3(?:\.\d+)?)?\s+-m\s+pytest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:python-unittest", re: /^python(?:3(?:\.\d+)?)?\s+-m\s+unittest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:cargo-test", re: /^cargo\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:go-test", re: /^go\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:ctest", re: /^ctest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:make-test", re: /^make\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:make-check", re: /^make\s+check(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:ninja-test", re: /^ninja\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:meson-test", re: /^meson\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:mvn-test", re: /^mvn\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:gradle-test", re: /^(?:gradle|(?:\.\/)?gradlew)\s+test(?:\s+[\w=./:-]+)*$/ },
];

/** Test runners that resolve imports through PYTHONPATH. */
const PYTHON_TEST_RUNNER_IDS: ReadonlySet<string> = new Set([
	"builtin:uv-pytest",
	"builtin:uv-python-pytest",
	"builtin:pytest",
	"builtin:python-pytest",
	"builtin:python-unittest",
]);

/**
 * A src-layout Python project is tested as `PYTHONPATH=src python3 -m pytest`.
 * The bare runner was recognized, but the prefixed form fell to
 * bash-unrecognized, so a non-interactive worker was refused the exact check
 * its task named and finished with a test that contradicted its own fix
 * (DF-16). The prefix is read only when every entry is a relative path with no
 * `..`, which keeps the import roots inside the call's workspace cwd: the
 * runner already executes that repository's code, so the prefix adds no reach.
 */
function pythonRunnerBehindWorkspacePythonPath(command: string): { id: string; re: RegExp } | undefined {
	const match = /^PYTHONPATH=([\w./:-]+)[ \t]+(\S.*)$/.exec(command);
	if (match === null) return undefined;
	const entries = (match[1] ?? "").split(":");
	const inWorkspace = entries.every(
		(entry) => entry.length > 0 && !entry.startsWith("/") && !entry.split("/").includes(".."),
	);
	if (!inWorkspace) return undefined;
	const runner = match[2] ?? "";
	return TEST_RUNNER_COMMANDS.find((entry) => PYTHON_TEST_RUNNER_IDS.has(entry.id) && entry.re.test(runner));
}

/**
 * Repository scripts that are not test runners. They still count as validation
 * evidence (`npm run <verification script>`). Their net verdict passes after
 * safety checks, while autonomy asks in default unless project policy
 * explicitly declares the command safe.
 */
export const PROJECT_SCRIPT_COMMANDS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "builtin:npm-lint", re: /^npm\s+run\s+lint(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-build", re: /^npm\s+run\s+build(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-typecheck", re: /^npm\s+run\s+typecheck(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-ci-script", re: /^npm\s+run\s+ci(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
];

function matchesRepositoryCommand(command: string): boolean {
	return [...TEST_RUNNER_COMMANDS, ...PROJECT_SCRIPT_COMMANDS].some((entry) => entry.re.test(command));
}

/**
 * What the recognized spelling looks like, carried on every unrecognized-bash
 * decision. It rides the decision's reasons so the approval overlay, the audit
 * record, and any surface that renders them all say the same thing: an agent
 * that hits this rail should learn the form that passes instead of retrying the
 * same shape. A headless denial carries only the first reason after the
 * cause, cut at 240 characters, so the note naming the refused step goes
 * ahead of this hint and the hint stays under that cut.
 */
const BASH_RECOGNIZED_FORM_HINT =
	"Runs without asking: cat, head, tail, grep, rg, find, ls, wc, sed -n and git inspection on workspace paths, joined by &&, ||, ; or |, redirected only to /dev/null, with cwd as the cwd argument.";

/**
 * A step quoted for a refusal note. Headless guidance keeps 240 characters,
 * and a long step would leave no room for the reason that follows it.
 */
function quotedStep(step: string): string {
	return `\`${step.length > 80 ? `${step.slice(0, 77)}...` : step}\``;
}

/**
 * ripgrep reads extra options from the file `RIPGREP_CONFIG_PATH` names, and
 * that file can add `--follow`, `--pre` and `-z`, which {@link parseRgArgs}
 * refuses on the command line. Admission judges from the command text alone,
 * so an rg that would run with a config is never recognized. The variable is
 * left in the tool environment so the operator's rg keeps working. Until the
 * login profile has been captured the tool environment is unknown, and that
 * asks the same way.
 */
const RG_CONFIG_ENV = "RIPGREP_CONFIG_PATH";

const RG_CONFIG_REASONS = {
	set: `ripgrep reads options from the file ${RG_CONFIG_ENV} names, which can add --follow, --pre or -z behind the command text; with it set rg is not recognized as read-only`,
	pending: `the login environment has not been captured yet, so whether ${RG_CONFIG_ENV} names a ripgrep config that can add --follow, --pre or -z is unknown; rg is not recognized as read-only until it is`,
} as const;

/** Why rg cannot be recognized under the tool environment it would run with, or null when it can. */
function rgConfigRefusal(): string | null {
	const probe = probeToolEnv(RG_CONFIG_ENV);
	return probe === "unset" ? null : RG_CONFIG_REASONS[probe];
}

/** The reason a command with an `rg` step is not recognized because of the ripgrep config variable, or none. */
function rgConfigReasons(command: string): string[] {
	if (!commandArgumentSegments(command).some((args) => args[0] === "rg")) return [];
	const refusal = rgConfigRefusal();
	return refusal === null ? [] : [refusal];
}

const EXECUTION_TOOLS = new Set<string>([ToolNames.Bash, ToolNames.Verify]);

/**
 * Tools write-root confinement refuses by name, whatever their arguments: they
 * run a project script, a shell, or an unconfined child, so no lexical check
 * can bound where they write. Exported because a run that declares write roots
 * must not be *offered* them: a tool that is guaranteed to be refused is a
 * budget the model spends learning it cannot use it, and the refusal reads to
 * the model as a mistake it should retry. The class-based check below still
 * catches anything that classifies as execute or dispatch at call time.
 */
export const WRITE_ROOT_REFUSED_TOOLS: ReadonlySet<string> = new Set<string>([
	ToolNames.Bash,
	ToolNames.Verify,
	ToolNames.RunScript,
	ToolNames.Dispatch,
]);

// Write-class tools (action class "write"). bash is execute class and runs its
// own loop, so it is not covered by the lexical write-root containment below.
const WRITE_ROOT_TOOLS = new Set<string>([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

function writeRootTargetPath(call: ClassifierCall): string | null {
	if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
	const target = pathArg(call.args);
	if (target !== null) return target;
	if (call.tool === ToolNames.Artifact) return artifactDefaultPath(call.args?.kind);
	return null;
}

/**
 * Under active write-root confinement, a tool that can write outside the roots
 * without a path argument the lexical check can inspect. Execute-class tools run
 * project scripts or a shell; dispatch spawns a worker not bound to these roots.
 */
function isWriteConfinementEscape(call: ClassifierCall, actionClass: string, osConfined: boolean): boolean {
	// The typed git tool's add or commit runs a fixed argv that writes only Git
	// metadata, and the task-worktree allowance and hooks guard decide it later.
	// Blocking it as arbitrary bash made typed task commits impossible in any
	// run that also declared write roots.
	if (call.projection === "typed-git") return false;
	// Under the OS sandbox a command's writes land only in the bound roots, so
	// running one is no escape. A dispatched child is not bound by them.
	if (osConfined && call.tool !== ToolNames.Dispatch && actionClass !== "dispatch") return false;
	if (WRITE_ROOT_REFUSED_TOOLS.has(call.tool)) return true;
	return actionClass === "execute" || actionClass === "dispatch";
}

/**
 * The roots where a write through them lands, walked at the moment of the
 * check. A root that cannot be resolved covers nothing.
 */
function physicalWriteRoots(roots: ReadonlyArray<string>, memo: PathWalkMemo): string[] {
	return roots.flatMap((root) => {
		const directory = root.endsWith("/");
		const resolved = canonicalizePath(directory ? root.slice(0, -1) : root, memo);
		if (resolved === null) return [];
		return [directory ? asDirectoryPathBoundary(resolved) : resolved];
	});
}

/** Block reason when a physical write target sits outside every physical root. */
function writeRootViolation(
	roots: ReadonlyArray<string>,
	label: string,
	physical: string | null,
	memo: PathWalkMemo,
): string | null {
	if (physical === null) {
		return `write target '${label}' cannot be resolved (a symbolic link loop or more than 40 links), so it cannot be shown inside the permitted write roots for this run: ${roots.join(", ")}`;
	}
	if (writeRootsCover(physicalWriteRoots(roots, memo), physical)) return null;
	return `write target '${label}' resolves to '${physical}', which is outside the permitted write roots for this run: ${roots.join(", ")}`;
}

/**
 * Write-root containment judges where the typed tool actually writes: the
 * target goes through the same walk as resolveMutationTarget (realpath of the
 * deepest existing ancestor plus the remaining components) and is compared
 * with roots resolved the same way. The former lexical check let
 * `allowed/link/x` through while the write landed wherever `link` pointed (F3).
 * Returns the block reason, or null when allowed.
 */
function evaluateWriteRoots(roots: ReadonlyArray<string>, writeRootCwd: string, call: ClassifierCall): string | null {
	if (roots.length === 0) return null;
	const target = writeRootTargetPath(call);
	if (target === null) return null;
	const memo = createPathWalkMemo();
	return writeRootViolation(roots, target, canonicalizeRawPath(expandPath(target), writeRootCwd, memo), memo);
}

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = canonicalizeExistingPath(path.resolve(options.cwd ?? process.cwd()));
	// Write targets resolve relative to the cwd the tools use, un-canonicalized,
	// and both targets and roots are walked physically at each check (F3).
	const writeRootCwd = path.resolve(options.cwd ?? process.cwd());
	const writeRoots = (options.writeRoots ?? []).map((root) => resolvePathBoundary(writeRootCwd, root));
	const writeRootsOsConfined = options.writeRootsOsConfined === true;
	const skillRoots = activeClioSkillRoots(cwd);
	const readExemptRoots = [
		...readScopeExemptRoots(),
		...(options.readExemptRoots ?? []).map((root) => ({ path: root, operatorOwned: false })),
	];
	const packs = options.rulePacks ?? getCachedDefaultRulePacks();
	const projectPolicy = options.projectPolicy ?? gateProjectSafetyPolicy(cwd, loadProjectSafetyPolicy(cwd));
	const projectPolicyRoot =
		projectPolicy.path === null ? cwd : path.dirname(path.dirname(path.resolve(projectPolicy.path)));
	const compileEnginePathPolicy = (defaults: PathPolicyInput): CompiledPathPolicy => {
		const pathPolicyInput = projectPolicy.disableDefaultPathPolicy
			? projectPolicy.pathPolicy
			: mergePathPolicyInputs(defaults, projectPolicy.pathPolicy);
		// Clio's own secret store and user skills, by absolute path.
		// Config directory expansion has to happen here because
		// the list cannot call config helpers at module scope.
		const expandedDefaults = mergePathPolicyInputs(mergePathPolicyInputs(pathPolicyInput, OPERATOR_PATH_POLICY), {
			zeroAccessPaths: clioCredentialStorePaths(),
			readOnlyPaths: [...clioSkillsRootPaths(), path.join(clioConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
		});
		return compilePathPolicy(expandedDefaults, projectPolicyRoot);
	};
	const pathPolicy = compileEnginePathPolicy(DEFAULT_DAMAGE_CONTROL_PATH_POLICY);
	// The operator's own session deletes build outputs and never hand-edits them
	// (#419), so its deletes are judged without the default build-output
	// entries, at default and at yolo alike. A project's own entries still
	// apply. Compiled on first use: most engines never judge such a delete.
	let operatorDeletePathPolicy: CompiledPathPolicy | null = null;
	const operatorDeletePolicy = (): CompiledPathPolicy => {
		operatorDeletePathPolicy ??= compileEnginePathPolicy({
			...DEFAULT_DAMAGE_CONTROL_PATH_POLICY,
			readOnlyPaths: (DEFAULT_DAMAGE_CONTROL_PATH_POLICY.readOnlyPaths ?? []).filter(
				(entry) => !BUILD_OUTPUT_PATHS.includes(entry),
			),
		});
		return operatorDeletePathPolicy;
	};
	const flowTrusted = projectPolicy.trustVerdict === "trusted" && projectPolicy.valid;
	// The approved flow section is remembered while trusted and consulted while
	// not, so an unapproved edit cannot unlabel files an approved rule named.
	// A snapshot that cannot be written or read is a refusal, not a fallback.
	let flowRefusal: string | null = null;
	let approvedFlow: ApprovedFlowPolicy | null = null;
	if (projectPolicy.path === null && projectPolicy.valid) {
		// Deleting the policy disables future source labeling; carried labels stay in the session ledger.
		flowRefusal = forgetApprovedFlowPolicy(cwd);
	} else if (flowTrusted && projectPolicy.hash !== null && projectPolicy.path !== null) {
		flowRefusal =
			projectPolicy.informationFlow.sources.length > 0
				? rememberApprovedFlowPolicy(cwd, projectPolicy.path, projectPolicy.hash, projectPolicy.informationFlow)
				: forgetApprovedFlowPolicy(cwd);
	} else {
		const recalled = recallApprovedFlowPolicy(cwd);
		if (recalled.kind === "approved") approvedFlow = recalled.approved;
		else if (recalled.kind === "unavailable") flowRefusal = recalled.reason;
	}
	const informationFlow = compileInformationFlowPolicy(
		projectPolicy.informationFlow,
		projectPolicyRoot,
		projectPolicy.hash,
		flowTrusted,
		approvedFlow,
		flowRefusal,
	);
	// Bash-read scanning tests argument tokens against zero-access entries only:
	// read-only paths stay readable from bash by design, secrets do not.
	const zeroAccessPolicy: CompiledPathPolicy = {
		root: pathPolicy.root,
		entries: pathPolicy.entries.filter((entry) => entry.kind === "zeroAccessPaths"),
		diagnostics: [],
	};

	// Base pack rules apply at every posture, so they are sourced once at
	// construction. Building the array inside evaluate() re-allocated it on
	// every admission for no behavioral gain.
	const sourcedRules: SourcedRule[] = packs.base.rules.map((rule) => ({ rule, source: "damage-control:base" }));
	/**
	 * The trust, settings, skill, dev-root, protected-path and zero-access rails,
	 * in the order a top-level call meets them.
	 */
	const authorityBlock = (
		call: ClassifierCall,
		callCwd: string,
		mutationCommand: string | null,
		scannedCommand: string | null,
		candidates: ReturnType<typeof mutationCandidates>,
		walkMemo: ReturnType<typeof createPathWalkMemo>,
		deletes: CompiledPathPolicy,
	): AuthorityBlock | null => {
		if (mutationCommand !== null && invokesTrustMutation(mutationCommand)) {
			return {
				reasonCode: "trust-authority",
				reasons: ["workspace trust grants require the operator CLI"],
				policySource: "builtin-classifier",
			};
		}
		if (
			skillMutationReason(
				[path.join(clioConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
				candidates,
				walkMemo,
			) !== null
		) {
			return {
				reasonCode: "path-policy:readOnlyPaths",
				reasons: ["Clio settings and workspace trust records are operator-owned and cannot be mutated by tools"],
				policySource: "builtin-classifier",
			};
		}
		const skillReason =
			mutationCommand !== null && invokesClioSkillMutation(mutationCommand, true)
				? "resource installation and lifecycle changes require the operator CLI or an explicit operator install choice; draft outside installed resource roots"
				: skillMutationReason(skillRoots, candidates, walkMemo);
		if (skillReason !== null) {
			return { reasonCode: "skill-authority", reasons: [skillReason], policySource: "builtin-classifier" };
		}
		const devRootReason = foreignDevRootReason(candidates, walkMemo);
		if (devRootReason !== null) {
			return { reasonCode: "dev-root-owned", reasons: [devRootReason], policySource: "builtin-classifier" };
		}
		// The path policy runs regardless of project policy validity. When
		// `.clio-coder/safety.yaml` is invalid, the loader has already dropped every
		// project-authored path entry and forced `disableDefaultPathPolicy`
		// off, so the compiled policy here carries exactly the built-in
		// defaults. Evaluating it unconditionally keeps default credential
		// protection (`.env`, `~/.ssh/`, `credentials.yaml`, ...) active on a
		// broken config, which is the fail-closed intent; project-authored
		// additions and exemptions stay gated on validity inside the loader.
		const pathBlock = evaluateProjectPathPolicy(pathPolicy, deletes, call, callCwd, walkMemo);
		if (pathBlock !== null) {
			return { reasonCode: pathBlock.reasonCode, reasons: [pathBlock.reason], policySource: "project-policy" };
		}
		// Bash reads of zero-access paths. pathPolicyTargets extracts only
		// write/delete targets from bash, so `cat .env` used to run and its
		// output persisted into the transcript and evidence previews. Any
		// path-like argument token matching a zero-access entry blocks the
		// command; the one carve-out is the exit-code-only presence check
		// (`grep -q`/`grep -sq` with a ^NAME= pattern), which is the safe
		// protocol the credentials skill teaches.
		if (scannedCommand !== null) {
			const secretRead = evaluateBashZeroAccessRead(zeroAccessPolicy, scannedCommand, callCwd);
			if (secretRead !== null) {
				return {
					reasonCode: "secret_path_bash",
					reasons: [
						`bash read of zero-access path blocked: '${secretRead.token}' matches ${secretRead.entrySource}. Check presence with exit codes only (grep -sq "^NAME=" <file>); have the user supply values through their own terminal (read -s), never through chat or command output.`,
					],
					policySource: "project-policy",
				};
			}
		}
		return null;
	};
	// The yolo floor's text rules: the pack rules it keeps by id, then its own.
	const floorRules: SourcedRule[] = [
		...sourcedRules.filter((entry) => YOLO_FLOOR_PACK_RULE_IDS.has(entry.rule.id)),
		...YOLO_FLOOR_TEXT_RULES.map((rule) => ({ rule, source: "damage-control:base" as const })),
	];
	/**
	 * Operator-authored path rules (#407): the entries of a trusted
	 * `.clio-coder/safety.yaml`, kept apart from the built-in defaults they are
	 * merged with everywhere else. The loader drops an untrusted file's entries,
	 * so what is here is what the operator approved. While it carries any, the
	 * file itself is read-only too: an edit would drop its trust, and with it
	 * every rule it holds.
	 */
	let operatorPathPolicy: CompiledPathPolicy | null = null;
	const operatorPolicy = (): CompiledPathPolicy => {
		if (operatorPathPolicy !== null) return operatorPathPolicy;
		const own = projectPolicy.pathPolicy;
		const authored = [own.zeroAccessPaths, own.readOnlyPaths, own.noWritePaths, own.noDeletePaths].some(
			(entries) => (entries?.length ?? 0) > 0,
		);
		operatorPathPolicy = compilePathPolicy(
			authored && projectPolicy.path !== null ? mergePathPolicyInputs(own, { readOnlyPaths: [projectPolicy.path] }) : own,
			projectPolicyRoot,
		);
		return operatorPathPolicy;
	};
	/** A write or delete into one of Clio's own trees, however the command spells or reaches it. */
	const clioOwnedMutation = (call: ClassifierCall, callCwd: string, command: string | null, trees: ClioOwnedTrees) => {
		const targets = pathPolicyTargets(call, callCwd).filter((target) => target.operation !== "read");
		if (targets.length === 0) return false;
		const spelled = targets.some(
			(target) =>
				CLIO_OWNED_VARIABLE.test(target.path) ||
				trees.spellings.some((spelling) => target.path === spelling || target.path.startsWith(`${spelling}/`)),
		);
		if (spelled) return true;
		const memo = createPathWalkMemo();
		return skillMutationReason(trees.roots, mutationCandidates(targets, callCwd, command, memo), memo) !== null;
	};
	const floorMatch = (hit: YoloFloorHit, actionClass = "system_modify") => ({
		match: { ruleId: hit.ruleId, reason: hit.reason, actionClass, block: true } satisfies DamageControlMatch,
		source: "builtin-classifier" as const,
	});
	/**
	 * The floor a command meets: the text rules over every scan, then mkfs and
	 * wipefs, deletes by target, trust grants and Clio's trees over the whole
	 * command. The parsers follow its cds, substitutions and `sh -c` scripts
	 * themselves, so a segment read alone would lose a cd and misplace a delete.
	 */
	const commandFloorHit = (
		texts: ReadonlyArray<string>,
		commands: ReadonlyArray<string>,
		callCwd: string,
		trees: ClioOwnedTrees,
	): { match: DamageControlMatch; source: SafetyPolicySource } | null => {
		const text = matchSourcedRule(texts, floorRules);
		if (text !== null) return text;
		const command = commands[0] ?? "";
		for (const candidate of commands) {
			const executable = yoloFloorExecutableHit(candidate);
			if (executable !== null) return floorMatch(executable);
			const deleted = yoloFloorDeleteHit(candidate, callCwd, cwd);
			if (deleted !== null) return floorMatch(deleted);
		}
		if (invokesTrustMutation(command)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.trustAuthority,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.trustAuthority}: workspace trust grants require the operator CLI`,
			});
		}
		if (clioOwnedMutation({ tool: ToolNames.Bash, args: { command } }, callCwd, command, trees)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.clioOwned,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.clioOwned}: writes into or deletes Clio's own config, data, state or trust records, which only the operator changes`,
			});
		}
		return null;
	};
	/** One script line against the floor, from every directory the scan places it in. */
	const floorLine = (trees: ClioOwnedTrees) => (raw: string, read: ScriptLine, callCwd: string) => {
		// A here-document body or a comment is data the script carries, not a command.
		if (read.data) return null;
		const texts = read.expanded === raw ? [raw] : [read.expanded, raw];
		for (const base of read.bases ?? [callCwd]) {
			const hit = commandFloorHit(texts, texts, base, trees);
			if (hit !== null) return hit;
		}
		return null;
	};
	/**
	 * Reads of Clio's own credential store are floor at both autonomy levels:
	 * no task needs Clio's provider tokens, and yolo used to read them. Typed
	 * reads of the store or its lock, and a shell word naming either one or the
	 * config directory that holds them, are refused; a typed listing or search
	 * of that directory already drops the store from its results.
	 */
	const credentialReadHit = (call: ClassifierCall, callCwd: string, command: string | null): YoloFloorHit | null => {
		const stores = clioCredentialStorePaths();
		if (stores.length === 0) return null;
		const forms = (entry: string): string[] => {
			const lexical = path.resolve(entry);
			const real = canonicalizePath(lexical);
			return real === null || real === lexical ? [lexical] : [lexical, real];
		};
		const files = new Set(stores.flatMap((store) => [store, `${store}.lock`]).flatMap(forms));
		const dirs = new Set(stores.map((store) => path.dirname(store)).flatMap(forms));
		const hit = (spelled: string): YoloFloorHit => ({
			ruleId: YOLO_FLOOR_RULE_IDS.clioCredentials,
			reason: `matched ${YOLO_FLOOR_RULE_IDS.clioCredentials}: reads Clio's own credential store (${spelled}), which no task needs`,
		});
		const lands = (raw: string, wholeDirectory: boolean): boolean => {
			const home = homedir();
			let target = raw.replace(/^(?:~(?=\/|$)|\$\{HOME\}|\$HOME(?!\w))/u, home);
			if (/[$`]/u.test(target)) {
				return (
					CLIO_CONFIG_VARIABLE.test(target) &&
					(target.includes("credentials.yaml") || /^\$\{?CLIO_CODER_CONFIG_DIR\}?\/?\*?$/u.test(target))
				);
			}
			const wildcard = target.search(/[*?[{]/u);
			if (wildcard >= 0) {
				const slash = target.lastIndexOf("/", wildcard);
				target = slash < 0 ? "." : slash === 0 ? "/" : target.slice(0, slash);
			}
			const lexical = path.resolve(callCwd, target);
			const real = canonicalizeRawPath(target, callCwd);
			return [lexical, ...(real === null ? [] : [real])].some(
				(landing) => files.has(landing) || (wholeDirectory && dirs.has(landing)),
			);
		};
		for (const target of pathPolicyTargets(call, callCwd)) {
			if (target.operation === "read" && lands(target.path, false)) return hit(target.path);
		}
		if (command === null) return null;
		// Naming the directory reads the store unless every step only lists names.
		const listsOnly = shellCommandSteps(command).every((step) => NAME_LISTERS.has(step.executable));
		for (const token of bashPathTokenCandidates(command)) {
			if (lands(token, !listsOnly)) return hit(token);
		}
		return null;
	};
	/**
	 * The floor for one call (#407), at yolo and at the operator's default: the
	 * command's own text and targets, reads of Clio's credential store, then
	 * each shell script the call runs by literal path, read line by line. A
	 * script the scan cannot read through runs.
	 */
	const floorBlock = (
		call: ClassifierCall,
		callCwd: string,
		command: string | null,
	): Omit<
		SafetyPolicyDecision,
		"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
	> | null => {
		const trees = clioOwnedTrees();
		const held = (hit: { match: DamageControlMatch; source: SafetyPolicySource }, reasons: string[] = []) => ({
			ruleId: hit.match.ruleId,
			reasonCode: `${YOLO_FLOOR_REASON_PREFIX}${hit.match.ruleId}`,
			reasons: [...reasons, hit.match.reason, "the yolo floor holds at every autonomy level"],
			match: hit.match,
			policySource: hit.source,
		});
		if (command !== null) {
			const decoded = [decodedAnsiCCommand(command), decodedLocaleQuoting(command)].filter(
				(text): text is string => text !== null,
			);
			const commands = [...new Set([command, ...decoded])];
			const hit = commandFloorHit([...new Set([...commands, ...shellCommandSegments(command)])], commands, callCwd, trees);
			if (hit !== null) return held(hit);
		} else if (clioOwnedMutation(call, callCwd, null, trees)) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.clioOwned,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.clioOwned}: writes into Clio's own config, data, state or trust records, which only the operator changes`,
				}),
			);
		}
		const credentials = credentialReadHit(call, callCwd, command);
		if (credentials !== null) return held(floorMatch(credentials, "read"));
		const line = floorLine(trees);
		const scriptHit = (scan: ScriptHit | null) =>
			scan === null ? null : held(scan, [`script ${scan.file} line ${scan.line}: ${scan.text.slice(0, 200)}`]);
		if (call.tool === ToolNames.RunScript && runsUnderShell(call.args)) {
			const script = typeof call.args?.script === "string" ? call.args.script.trim() : "";
			const file = script === "" ? null : scriptPath(script, cwd);
			const hit = scriptHit(
				file === null
					? null
					: scanNamedScript(file, line, callCwd, [callCwd], newScriptBudget(), { zero: file, source: file }),
			);
			if (hit !== null) return hit;
		}
		if (call.tool === ToolNames.Bash && command !== null && hasUnparsedShellScript(command)) {
			const cwds = commandMoveBases(command, callCwd);
			const written = commandWrittenPaths(command, cwds ?? [callCwd], newWrittenPaths());
			const budget = newScriptBudget();
			for (const script of shellScriptSources(command) ?? []) {
				const hit = scriptHit(scanCommandScript(script, line, callCwd, cwds, written, budget));
				if (hit !== null) return hit;
			}
		}
		return null;
	};
	/** An operator-authored path rule this call breaks, judged without the built-in defaults (#407). */
	const operatorRuleBlock = (
		call: ClassifierCall,
		callCwd: string,
		command: string | null,
	): Omit<
		SafetyPolicyDecision,
		"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
	> | null => {
		const policy = operatorPolicy();
		if (policy.entries.length === 0) return null;
		const provenance = {
			policySource: "project-policy" as const,
			...(projectPolicy.hash !== null ? { policyHash: projectPolicy.hash } : {}),
			...(projectPolicy.path !== null ? { projectPolicyPath: projectPolicy.path } : {}),
		};
		const held = "an operator-authored rule in .clio-coder/safety.yaml holds at yolo";
		const judged = command !== null && call.tool !== ToolNames.Bash ? { tool: ToolNames.Bash, args: { command } } : call;
		const pathBlock = evaluateProjectPathPolicy(policy, policy, judged, callCwd, createPathWalkMemo());
		if (pathBlock !== null) {
			return {
				ruleId: pathBlock.reasonCode,
				reasonCode: `operator-rule:${pathBlock.reasonCode}`,
				reasons: [pathBlock.reason, held],
				...provenance,
			};
		}
		if (command === null) return null;
		const zeroAccess: CompiledPathPolicy = {
			root: policy.root,
			entries: policy.entries.filter((entry) => entry.kind === "zeroAccessPaths"),
			diagnostics: [],
		};
		const secretRead = evaluateBashZeroAccessRead(zeroAccess, command, callCwd);
		if (secretRead === null) return null;
		return {
			ruleId: "secret_path_bash",
			reasonCode: "operator-rule:secret_path_bash",
			reasons: [`bash read of zero-access path blocked: '${secretRead.token}' matches ${secretRead.entrySource}`, held],
			...provenance,
		};
	};

	/**
	 * What the operator's default makes of the damage-control rules a call
	 * matched (Phase 2c). A hit the workspace snapshot taken right before the
	 * call can undo yields; every other former hard block is deferred as an ask
	 * for the safety judge; an authored ask rule no snapshot undoes keeps its
	 * ask rail.
	 */
	const resortDamageControl = (
		scans: ReadonlyArray<string>,
		raw: Classification,
		command: string | null,
		resort: DefaultResort,
	): ResortedDamageControl => {
		const hits = scans.length > 0 ? matchingSourcedRules(scans, sourcedRules) : [];
		const undoes = (entry: { match: DamageControlMatch; pattern: RegExp }): boolean =>
			resort.snapshots &&
			snapshotRecoverableRule(entry.match.ruleId, entry.pattern, scans, command, resort.scratchRoots, cwd);
		const yielded = hits.filter(undoes);
		const hard = hits.filter((entry) => isHardMatch(entry.match) && !undoes(entry));
		const soft = hits.filter((entry) => !isHardMatch(entry.match) && !undoes(entry));
		const patternDestructive = raw.actionClass === "git_destructive";
		const patternUndone =
			patternDestructive &&
			resort.snapshots &&
			raw.reasons.every((reason) => SNAPSHOT_RECOVERABLE_GIT_PATTERNS.has(reason)) &&
			!cleansIgnoredFiles(command ?? "");
		const first = hard[0];
		let ask: DeferredAsk | null = null;
		if (first !== undefined) {
			ask = {
				ruleId: first.match.ruleId,
				reasonCode: `damage-control:${first.match.ruleId}`,
				reasons: [...raw.reasons, ...hard.map((entry) => entry.match.reason), DEFAULT_RESORTED_REASON],
				match: first.match,
				policySource: first.source,
			};
		} else if (patternDestructive && !patternUndone && soft.length === 0) {
			ask = {
				reasonCode: "classification:git_destructive",
				reasons: [...raw.reasons, DEFAULT_RESORTED_REASON],
				policySource: "damage-control:base",
			};
		}
		const askRule = soft[0] === undefined ? null : { match: soft[0].match, source: soft[0].source };
		const ruling = first ?? askRule;
		// A hit the snapshot undoes does not lend the call its class, and a
		// recoverable discard runs as the command it is.
		const classification =
			ruling !== null
				? effectiveClassification(raw, ruling.match)
				: patternUndone
					? { actionClass: "execute" as const, reasons: [...raw.reasons, "snapshot-recoverable"] }
					: raw;
		const recoverable = yielded[0];
		return {
			classification,
			ask,
			askRule,
			recoverable: recoverable !== undefined ? { match: recoverable.match } : patternUndone ? { match: null } : null,
		};
	};

	/**
	 * Settles a decision of the operator's default (Phase 2c): a hard block
	 * stands; a deferred former block asks unless an operator-only ask already
	 * holds the call; a contained call carries the sandbox it runs in; a call
	 * whose discards or deletes only the snapshot taken before it undoes says
	 * so, and the registry refuses it when that snapshot cannot be taken.
	 */
	const settleDefault = (
		decision: SafetyPolicyDecision,
		base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
		deferred: DeferredAsk | null,
		resort: DefaultResort,
		recoverable: boolean,
	): SafetyPolicyDecision => {
		if (decision.kind === "block") return decision;
		let out = decision;
		const operatorOnly = out.kind === "ask" && out.ruleId !== undefined && OPERATOR_ONLY_ASKS.has(out.ruleId);
		// An operator's approval of this exact call already answered the deferred ask.
		if (deferred !== null && base.posture !== CONFIRMED_POSTURE && !operatorOnly) {
			out = askDecision(base, deferred);
		} else if (deferred !== null) {
			out = { ...out, reasons: [...out.reasons, ...deferred.reasons] };
		}
		if (resort.contained) {
			out = { ...out, shellSandbox: { workspace: canonicalizePath(cwd) ?? cwd, scratchRoots: resort.scratchRoots } };
		}
		if (recoverable && resort.snapshots) out = { ...out, recoverable: true };
		return out;
	};

	/**
	 * The net for one call. `resort` is the operator's own default (Phase 2c):
	 * damage control a snapshot can undo yields, a former hard block waits as
	 * an ask until the hard rails after it have spoken, and a contained call
	 * meets no ask for what its command text hides.
	 */
	const evaluateCall = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		resort?: DefaultResort,
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const rawClassification = scratchRootWrite(classify(call), call, resort?.scratchRoots);
		const command = commandArg(call.args);
		// Resolve verify exactly as the tool does: the check id alone is not the
		// command when the model also supplied argv. Scan and admit that full argv.
		const verifyArgs = call.tool === ToolNames.Verify ? prepareVerifyArguments(call.args ?? {}) : null;
		const verifyResolution = verifyArgs === null ? null : resolveVerifyCall(cwd, verifyArgs);
		const resolvedCheckCwd =
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		const callCwd = typeof resolvedCheckCwd === "string" ? resolvedCheckCwd : cwdArg(call.args, cwd);
		const verifyArgv =
			verifyResolution === null || verifyArgs === null ? null : verifyResolutionArgv(verifyResolution, verifyArgs);
		const verifyCommand = verifyArgv?.join(" ") ?? null;
		const scans = (verifyCommand !== null ? [verifyCommand] : damageControlScans(call, rawClassification)).filter(
			(scan) => scan !== "",
		);
		const hit = scans.length > 0 ? matchSourcedRule(scans, sourcedRules) : null;
		const sorted = resort === undefined ? null : resortDamageControl(scans, rawClassification, command, resort);
		const classification = sorted?.classification ?? effectiveClassification(rawClassification, hit?.match);

		// Verify carries no command argument; the resolved argv is what runs, and
		// a refusal or audit row names it.
		const base = baseDecision(call, classification, callCwd, posture, command ?? verifyCommand);

		// Worker write-root containment (Slice C). A write-class tool whose
		// target escapes every permitted root is a final block, ranked ahead of
		// the git/system-modify/path-policy rails so an out-of-root write reports
		// "write-root" even when the classifier escalated it to system_modify
		// (e.g. a write outside cwd). No-op unless the run carries writeRoots.
		const writeRootReason = evaluateWriteRoots(writeRoots, writeRootCwd, call);
		if (writeRootReason !== null) {
			return blockDecision(base, {
				ruleId: "write-root",
				reasonCode: "write-root",
				reasons: [writeRootReason],
				policySource: "builtin-classifier",
			});
		}

		// Write-confinement is only honest if the run cannot escape the roots by
		// running an arbitrary command or spawning an unconfined child. Under
		// active writeRoots, execute-class tools (bash, verify, which run project
		// scripts) and dispatch (which spawns a worker not bound to these roots)
		// are blocked outright: they can mutate the filesystem outside the roots.
		if (writeRoots.length > 0 && isWriteConfinementEscape(call, classification.actionClass, writeRootsOsConfined)) {
			return blockDecision(base, {
				ruleId: "write-root",
				reasonCode: "write-root",
				reasons: [
					`tool '${call.tool}' (${classification.actionClass}) can mutate the filesystem outside the permitted write roots and is blocked under write-root confinement`,
				],
				policySource: "builtin-classifier",
			});
		}
		if (resolvedCheckCwd instanceof Error) {
			return blockDecision(base, {
				ruleId: "verify-cwd-invalid",
				reasonCode: "verify-cwd-invalid",
				reasons: [resolvedCheckCwd.message],
				policySource: "builtin-classifier",
			});
		}

		// An explicit `ask: true` damage-control rule is an authored
		// confirm rail and takes precedence over classifier escalation for
		// the same command (sd-01 M3). Without this, the unconditional
		// git_destructive block made every authored git ask rule dead
		// config. Commands matched only by classifier patterns, and rules
		// with `block: true`, stay hard blocks. The ask rail itself runs
		// only after the fail-closed and path-policy blocks below: hard
		// blocks always win, and the ask rail decides among survivors.
		// The operator's default judged every rule in resortDamageControl.
		const askHit = sorted === null ? (hit?.match.ask === true && hit.match.block !== true ? hit : null) : sorted.askRule;
		let deferred: DeferredAsk | null = sorted?.ask ?? null;
		if (
			sorted === null &&
			askHit === null &&
			(classification.actionClass === "git_destructive" ||
				hit?.match.actionClass === "git_destructive" ||
				hit?.match.block === true)
		) {
			const blockInput: DeferredAsk = {
				reasonCode: hit ? `damage-control:${hit.match.ruleId}` : "classification:git_destructive",
				reasons: [...classification.reasons, ...(hit ? [hit.match.reason] : [])],
				policySource: hit?.source ?? "damage-control:base",
			};
			if (hit?.match.ruleId !== undefined) blockInput.ruleId = hit.match.ruleId;
			if (hit?.match !== undefined) blockInput.match = hit.match;
			return blockDecision(base, blockInput);
		}

		// A delete is judged by where it lands, at every autonomy level, after the
		// authored rules so a named catastrophic rule reports itself. The
		// flag rules this replaces let `rm -v -r /` through, blocked scratch
		// cleanup, and taught the model that dropping `-f` got around a block.
		// The operator's default places deletes inside the scratch roots like
		// ones inside the workspace, and asks for any other instead of refusing.
		const deleteReasons = command === null ? [] : bashDeleteReasons(command, bashCwdArg(call.args), resort?.scratchRoots);
		if (deleteReasons.length > 0) {
			const match: DamageControlMatch = {
				ruleId: DELETE_TARGET_RULE_ID,
				reason: `matched ${DELETE_TARGET_RULE_ID}: ${DELETE_TARGET_RULE_DESCRIPTION}`,
				actionClass: "system_modify",
				block: true,
			};
			const input: DeferredAsk = {
				ruleId: DELETE_TARGET_RULE_ID,
				reasonCode: `damage-control:${DELETE_TARGET_RULE_ID}`,
				reasons: [...deleteReasons, match.reason],
				match,
				policySource: "damage-control:base",
			};
			if (resort === undefined) return blockDecision(base, input);
			deferred =
				deferred === null
					? { ...input, reasons: [...input.reasons, DEFAULT_RESORTED_REASON] }
					: { ...deferred, reasons: [...deleteReasons, ...deferred.reasons] };
		}
		// A delete inside the workspace is undone only by the workspace snapshot
		// taken before it: without one the operator's default asks for it even
		// when contained, and with one the call is refused if that snapshot fails.
		const workspaceDeletes = resort === undefined || command === null ? [] : deletesNeedingSnapshot(command, cwd);
		if (resort !== undefined && !resort.snapshots && workspaceDeletes.length > 0) {
			const reason = `deletes ${workspaceDeletes.slice(0, 3).join(", ")} with no workspace snapshot to undo it: the workspace is not a git work tree or safety.snapshots is off`;
			deferred =
				deferred === null
					? {
							ruleId: DELETE_WITHOUT_SNAPSHOT_RULE_ID,
							reasonCode: DELETE_WITHOUT_SNAPSHOT_RULE_ID,
							reasons: [reason],
							policySource: "builtin-classifier",
						}
					: { ...deferred, reasons: [...deferred.reasons, reason] };
		}
		// Every decision below settles the operator's default when it applies.
		const settle = (decision: SafetyPolicyDecision): SafetyPolicyDecision =>
			resort === undefined
				? decision
				: settleDefault(
						decision,
						base,
						deferred,
						resort,
						(sorted?.recoverable ?? null) !== null || workspaceDeletes.length > 0,
					);

		if (!projectPolicy.valid && EXECUTION_TOOLS.has(call.tool)) {
			const blockInput: DeferredAsk = {
				ruleId: "project-policy-invalid",
				reasonCode: "project-policy-invalid",
				reasons: [`project safety policy is invalid and execution fails closed: ${projectPolicy.errors.join("; ")}`],
				policySource: "project-policy-invalid",
			};
			if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
			if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
			return blockDecision(base, blockInput);
		}

		// Editing active instructions is an operator privilege at every autonomy
		// level, in both the coordinator and the shared worker safety contract.
		const mutationCommand = call.tool === ToolNames.Bash ? command : verifyCommand;
		const scannedCommand = mutationCommand;
		// Reuse the canonical authority boundary scan for parent deletions,
		// shell cwd changes and aliases that a literal path-policy lookup misses.
		// Every authority check judges the same targets, so they share one
		// resolution and one walk memo, both dropped when this call is decided.
		const walkMemo = createPathWalkMemo();
		const targets = pathPolicyTargets(
			verifyCommand === null ? call : { tool: ToolNames.Bash, args: { command: verifyCommand } },
			callCwd,
		);
		const candidates = mutationCandidates(
			resort === undefined || mutationCommand === null ? targets : operatorAuthorityTargets(targets, mutationCommand),
			callCwd,
			mutationCommand,
			walkMemo,
		);
		const authority = authorityBlock(
			call,
			callCwd,
			mutationCommand,
			scannedCommand,
			candidates,
			walkMemo,
			resort === undefined ? pathPolicy : operatorDeletePolicy(),
		);
		if (authority !== null) {
			const blockInput: DeferredAsk = { ruleId: authority.reasonCode, ...authority };
			if (authority.policySource === "project-policy") {
				if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
				if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
			}
			return blockDecision(base, blockInput);
		}
		// The contained shell cannot write the repository's hooks, config or git
		// dir pointers, so under the operator's default a typed write asks for
		// them too and the safety judge weighs it against the operator's intent.
		const gitControl = resort === undefined ? null : gitControlTarget(call, cwd);
		if (gitControl !== null) {
			const input = {
				ruleId: GIT_CONTROL_FILE_RULE_ID,
				reasonCode: GIT_CONTROL_FILE_RULE_ID,
				reasons: [
					`'${gitControl}' is a git hook, config or git dir pointer of the workspace repository; writing it would run code outside the sandbox on the next git command, so it requires approval`,
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : askDecision(base, input));
		}
		const outsideReplacement = outsideExistingTypedMutationTarget(call, cwd, classification, posture);
		if (outsideReplacement !== null) {
			const input = {
				ruleId: "outside-file-replacement",
				reasonCode: "outside-file-replacement",
				reasons: [
					`Existing file '${outsideReplacement}' lies outside the workspace; replacing its contents requires operator approval`,
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : askDecision(base, input));
		}
		// Project settings carry persistent fleet routing. A model edit is file
		// level, so it cannot be told apart from a routing change: every mutation
		// asks at every autonomy level, and a headless denial repeats reasons[0].
		if (mutatesProjectSettings(cwd, candidates)) {
			const input = {
				ruleId: "project-settings-confirm",
				reasonCode: "project-settings-confirm",
				reasons: [
					`Project settings under .clio-coder/ hold persistent fleet routing and are operator-owned; changing them requires operator approval. ${ROUTING_PIN_HINT}`,
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : askDecision(base, input));
		}

		// A contained call runs in the main-session sandbox, which bounds what
		// hidden quoting could reach, so only an uncontained one asks for it.
		if (
			scannedCommand !== null &&
			posture !== "confirmed" &&
			resort?.contained !== true &&
			scanShellLikeDeep(scannedCommand).some((token) => token.hiddenContent)
		) {
			return settle(
				askDecision(base, {
					ruleId: "bash-hidden-quoting",
					reasonCode: "bash-hidden-quoting",
					reasons: ["ambiguous ANSI-C escapes or locale quoting require one-shot operator confirmation"],
					policySource: "builtin-command-allowlist",
					execRecognition: "unrecognized",
				}),
			);
		}

		// Managed library changes can be authorized by the operator. Direct
		// mutations and all hard path/trust blocks above remain non-overridable.
		if (
			mutationCommand !== null &&
			invokesClioSkillMutation(mutationCommand) &&
			!(posture === "yolo" && askHit !== null)
		) {
			const input = {
				ruleId: "library-confirm",
				reasonCode: "library-confirm",
				reasons: [
					posture === "confirmed"
						? "library change confirmed by operator"
						: posture === "yolo"
							? "library change admitted by yolo"
							: "library changes require one-shot operator confirmation in default",
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" || posture === "yolo" ? allowDecision(base, input) : askDecision(base, input));
		}

		// The authored ask rail (sd-01 M3) decides only among calls that
		// survived every hard block above. A confirmed posture admits the
		// matched command; an unconfirmed one parks it for confirmation.
		if (askHit !== null && posture !== "confirmed") {
			return settle(
				askDecision(base, {
					ruleId: askHit.match.ruleId,
					reasonCode: `damage-control:${askHit.match.ruleId}`,
					reasons: [...classification.reasons, askHit.match.reason, "damage-control rule requires confirmation"],
					policySource: askHit.source,
					match: askHit.match,
				}),
			);
		}
		if (askHit !== null && posture === "confirmed") {
			return settle(
				allowDecision(base, {
					ruleId: askHit.match.ruleId,
					reasonCode: `damage-control:${askHit.match.ruleId}`,
					reasons: [...classification.reasons, askHit.match.reason, "damage-control rule confirmed by operator"],
					policySource: askHit.source,
					match: askHit.match,
				}),
			);
		}

		// A lone worktree discard, or a lone delete the judge placed inside the
		// workspace or a scratch root, runs under the operator's default as soon
		// as the snapshot that undoes it is taken; it runs nothing else.
		const undone = sorted?.recoverable ?? null;
		const lone = command !== null && !hasShellOperators(command) && !/[$`]/u.test(command);
		const loneDiscard = lone && undone !== null && LONE_GIT_DISCARD.test(command?.trim() ?? "");
		const loneDelete = lone && resort?.snapshots === true && deferred === null && LONE_DELETE.test(command?.trim() ?? "");
		if (loneDiscard || loneDelete) {
			return settle(
				allowDecision(base, {
					ruleId: undone?.match?.ruleId ?? SNAPSHOT_RECOVERABLE_REASON_CODE,
					reasonCode: SNAPSHOT_RECOVERABLE_REASON_CODE,
					reasons: [...classification.reasons, SNAPSHOT_RECOVERABLE_REASON],
					policySource: "damage-control:base",
					execRecognition: "recognized",
					recoverable: true,
					...(undone?.match !== null && undone?.match !== undefined ? { match: undone.match } : {}),
				}),
			);
		}

		if (classification.actionClass === "system_modify") {
			const input: DeferredAsk = {
				ruleId: "system-modify-confirm",
				reasonCode: resort?.contained === true ? "contained:system-modify-confirm" : "system-modify-confirm",
				reasons: [
					...classification.reasons,
					posture === "confirmed"
						? "system-level change confirmed by operator"
						: posture === "yolo"
							? "system-level change admitted by yolo"
							: resort?.contained === true
								? CONTAINED_REASON
								: "system-level changes require one-shot confirmation in default",
				],
				policySource: "builtin-classifier",
			};
			return settle(
				posture === "confirmed" || posture === "yolo" || resort?.contained === true
					? allowDecision(base, input)
					: askDecision(base, input),
			);
		}

		// A verify call that resolves to no argv lists the checks or names the
		// ids it accepts and runs nothing. Scanning it as `npm run <check>` made
		// an unknown id a permission ask, which a non-interactive worker turns
		// into a terminal denial instead of reading the id list it would get.
		if ((call.tool === ToolNames.Bash || verifyArgv !== null) && classification.actionClass === "execute") {
			const bash = evaluateBashPolicy(
				verifyArgv ?? command ?? "",
				callCwd,
				cwd,
				posture,
				projectPolicy,
				{
					exemptRoots: readExemptRoots,
					memo: walkMemo,
					readable: (target) => evaluatePathPolicy(zeroAccessPolicy, "read", target, callCwd, walkMemo).kind === "allow",
					walkBudget: { remaining: RG_WALK_BUDGET },
					notes: [],
				},
				resort?.contained === true,
			);
			// A typed verifier still runs through the same command safety scan.
			// Unrecognized checks are left to the autonomy mapping: default asks,
			// while yolo admits them headlessly.
			if (bash.kind === "block") return blockDecision(base, bash);
			if (bash.kind === "ask") return settle(askDecision(base, bash));
			return settle(allowDecision(base, bash));
		}

		const allowInput: DeferredAsk = {
			reasonCode: "allowed",
			reasons: classification.reasons,
			policySource: hit?.source ?? "none",
		};
		if (hit?.match.ruleId !== undefined) allowInput.ruleId = hit.match.ruleId;
		if (hit?.match !== undefined) allowInput.match = hit.match;
		// Catalog argv already went through canonical command recognition above.
		// Package scripts and the frontend validator retain their fixed typed surface.
		if (classification.actionClass === "execute") allowInput.execRecognition = "recognized";
		// Search scope: the zero-access list above is the only path rail a
		// read-class tool meets, so a path through a link or a plain `..` used
		// to be read, listed, and searched at every level. The net still passes
		// it; the flag lets the autonomy mapping ask in default mode. The
		// operator's own default reads anywhere a secret is not.
		if (isReadScopeTool(call.tool) && posture !== "confirmed" && resort === undefined) {
			const escaped = readScopeEscape(pathArg(call.args) ?? ".", callCwd, cwd, readExemptRoots, walkMemo);
			if (escaped !== null) {
				allowInput.readScope = "outside-workspace";
				allowInput.reasons = [...allowInput.reasons, `read-path-outside-workspace: ${escaped}`];
			}
		}
		return settle(allowDecision(base, allowInput));
	};

	/** The command a call runs and the directory it runs from, as the floor and the net judge them. */
	const commandUnderJudgment = (call: ClassifierCall): { callCwd: string; judgedCommand: string | null } => {
		const command = commandArg(call.args);
		const verifyArgs = call.tool === ToolNames.Verify ? prepareVerifyArguments(call.args ?? {}) : null;
		const verifyResolution = verifyArgs === null ? null : resolveVerifyCall(cwd, verifyArgs);
		const verifyCommand =
			verifyResolution === null || verifyArgs === null
				? null
				: (verifyResolutionArgv(verifyResolution, verifyArgs)?.join(" ") ?? null);
		const checkCwd =
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		return {
			callCwd: typeof checkCwd === "string" ? checkCwd : cwdArg(call.args, cwd),
			judgedCommand: call.tool === ToolNames.Bash ? command : verifyCommand,
		};
	};

	/**
	 * A call under the operator's yolo, judged the skip-permissions way (#407).
	 * What holds: the run's ceilings (write roots, an invalid approved policy,
	 * a required sandbox the host lacks), the yolo floor and operator-authored
	 * rules. Every other ask and block the net would raise is admitted, and the
	 * allow keeps the rail it passed over in its reasons for the audit.
	 */
	const evaluateTrueYolo = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorYoloScope,
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const base = baseDecision(call, classify(call), callCwd, posture, judgedCommand);
		const floor = floorBlock(call, callCwd, judgedCommand);
		if (floor !== null) return blockDecision(base, floor);
		if (scope.scriptSandbox === "refused" && runsScriptFile(rawCall)) {
			return blockDecision(base, {
				ruleId: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasonCode: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasons: [YOLO_SCRIPT_SANDBOX_REFUSED],
				policySource: "builtin-classifier",
			});
		}
		const normal = evaluateCall(rawCall, posture);
		if (normal.kind === "allow" || holdsAtYolo(normal)) return normal;
		const operator = operatorRuleBlock(call, callCwd, judgedCommand);
		if (operator !== null)
			return blockDecision({ ...base, classification: normal.classification, actionClass: normal.actionClass }, operator);
		const { rejection: _rejection, match: _match, ...rest } = normal;
		return {
			...rest,
			kind: "allow",
			reasonCode: `${YOLO_ADMITTED_REASON_PREFIX}${normal.reasonCode}`,
			reasons: [
				...normal.reasons,
				`yolo admits this call: ${normal.ruleId ?? normal.reasonCode} would ${normal.kind} at default and does not hold at yolo`,
			],
			// What the net could not read through is what System One's yolo gate records.
			...(normal.actionClass === "execute" ? { execRecognition: "unrecognized" as const } : {}),
		};
	};

	/**
	 * A call of the operator's own session at autonomy default (Phase 2c): the
	 * yolo floor first, then the net with damage control re-sorted and, for a
	 * contained call, the rails that exist only because Clio cannot see what a
	 * command does left to the sandbox.
	 */
	const evaluateOperatorDefault = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorDefaultScope,
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const classification = classify(call);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const floor = floorBlock(call, callCwd, judgedCommand);
		if (floor !== null) return blockDecision(baseDecision(call, classification, callCwd, posture, judgedCommand), floor);
		return evaluateCall(rawCall, posture, {
			scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
			contained: scope.sandbox && containedShellCall(call, classification),
			snapshots: scope.snapshots,
		});
	};

	const engine: SafetyPolicyEngine = {
		evaluate(rawCall, posture, scope) {
			if (scope?.level === "default") return evaluateOperatorDefault(rawCall, posture, scope);
			const decision = scope === undefined ? evaluateCall(rawCall, posture) : evaluateTrueYolo(rawCall, posture, scope);
			// A script the operator's yolo admitted under `safety.sandbox: required`
			// runs in the main-session sandbox, whatever stage allowed it (#419, #407).
			if (decision.kind !== "allow" || scope?.scriptSandbox !== "sandboxed" || !runsScriptFile(rawCall)) return decision;
			const shellSandbox = {
				workspace: canonicalizePath(cwd) ?? cwd,
				scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
			};
			return { ...decision, shellSandbox };
		},
		writeTargetViolation(target) {
			if (writeRoots.length === 0) return null;
			const memo = createPathWalkMemo();
			return writeRootViolation(writeRoots, target, canonicalizeRawPath(target, writeRootCwd, memo), memo);
		},
		readablePath(target) {
			return evaluatePathPolicy(zeroAccessPolicy, "read", target, cwd).kind === "allow";
		},
		informationFlow: () => informationFlow,
		flowRestrictionsFor(rawCall) {
			// Runs on every tool call. With no rules there is nothing to label, and the
			// cwd canonicalization below is a filesystem walk the call must not pay for.
			if (informationFlow.rules.length === 0) return null;
			return flowRestrictionsForCall(informationFlow, flowSourceCallFor(rawCall, cwd));
		},
		metadata() {
			return {
				version: 1,
				rulePackHash: rulePackHash(packs),
				rulePackVersion: packs.base.version,
				activeRuleIds: sourcedRules.map((entry) => entry.rule.id),
				projectPolicyPath: projectPolicy.path,
				projectPolicyHash: projectPolicy.hash,
				projectPolicyValid: projectPolicy.valid,
				projectPolicyErrors: [...projectPolicy.errors, ...pathPolicy.diagnostics],
				disableDefaultPathPolicy: projectPolicy.disableDefaultPathPolicy,
				workspaceTrustVerdict: projectPolicy.trustVerdict ?? "trusted",
				cwd,
			};
		},
	};
	return engine;
}

/** Absolute path of Clio's user skills, when resolvable. */
function clioSkillsRootPaths(): string[] {
	try {
		return [path.join(clioConfigDir(), "skills")];
	} catch {
		return [];
	}
}

/**
 * The exact safe presence form: `grep -q` or `grep -sq` (either flag order)
 * with a `^NAME=`-shaped pattern and a single file argument. Exit code only;
 * the value never enters context. Anything broader stays blocked.
 */
const SAFE_PRESENCE_RE = /^\s*grep\s+(?:-(?:q|sq|qs)\s+)('[^']*'|"[^"]*"|\S+)\s+\S+\s*$/;

function isSafePresenceCheck(command: string): boolean {
	const match = SAFE_PRESENCE_RE.exec(command);
	if (!match || match[1] === undefined) return false;
	const pattern = stripQuotes(match[1]);
	return /^\^[A-Za-z_][A-Za-z0-9_]*=/.test(pattern);
}

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1);
	}
	return token;
}

/**
 * Split a bash command into candidate path tokens. Quotes bind: a quoted
 * string is one token, so `git commit -m "handle .env parsing"` yields the
 * whole message (not a path) while `cat ".env"` still yields `.env`. Shell
 * metacharacters outside quotes act as separators. Tokens are matched as
 * paths against the compiled zero-access entries (which handle tilde
 * expansion and globs), never against a list of reader binaries: a
 * zero-access path appearing anywhere in the command is the signal.
 */
function bashPathTokenCandidates(command: string): string[] {
	const candidates: string[] = [];
	// `sh -c 'cat .env'` is one whitespace-bearing token below, skipped as prose,
	// yet recognition judges exactly that inner script. Scan it as its own command.
	const inner = inlineShellScript(command);
	if (inner !== null && inner !== command) candidates.push(...bashPathTokenCandidates(inner));
	for (const scanned of scanShellLikeDeep(command)) {
		if (scanned.operator) continue;
		const token = scanned.value;
		if (token.length === 0) continue;
		// A token containing whitespace usually came from a quoted string of
		// prose, not a path argument. One that also holds a slash can still be a
		// path through a directory with a space in its name (`"a b/../.env"`), so
		// it is tested whole. Flags are not paths unless they embed one
		// (--file=~/.aws/credentials).
		if (/\s/.test(token) && !token.includes("/")) continue;
		if (token.startsWith("-") && !token.includes("/") && !token.includes("=")) continue;
		candidates.push(token);
		const eq = token.indexOf("=");
		if (eq > 0 && eq < token.length - 1) candidates.push(token.slice(eq + 1));
	}
	return candidates;
}

/**
 * What a call reads, as the information-flow evaluator judges it: the path
 * arguments of the read-class tools, and the path operands a bash command
 * names. The exit-code-only presence check reads no content, so it names none.
 */
export function flowSourceCallFor(rawCall: ClassifierCall, cwd: string): FlowSourceCall {
	const call = normalizeCallPaths(rawCall);
	const command = call.tool === ToolNames.Bash ? commandArg(call.args) : null;
	const readTokens = command === null || isSafePresenceCheck(command) ? [] : bashPathTokenCandidates(command);
	return {
		tool: call.tool,
		args: call.args,
		cwd: cwdArg(call.args, cwd),
		...(readTokens.length > 0 ? { readTokens } : {}),
	};
}

function evaluateBashZeroAccessRead(
	zeroAccessPolicy: CompiledPathPolicy,
	command: string,
	callCwd: string,
): { token: string; entrySource: string } | null {
	if (zeroAccessPolicy.entries.length === 0) return null;
	if (isSafePresenceCheck(command)) return null;
	for (const token of bashPathTokenCandidates(command)) {
		const decision = evaluatePathPolicy(zeroAccessPolicy, "read", token, callCwd);
		if (decision.kind === "block") {
			return { token, entrySource: `zeroAccessPaths entry ${decision.matchedPath}` };
		}
	}
	return null;
}

function evaluateProjectPathPolicy(
	policy: CompiledPathPolicy,
	deletePolicy: CompiledPathPolicy,
	call: ClassifierCall,
	callCwd: string,
	memo: PathWalkMemo,
): Extract<PathPolicyDecision, { kind: "block" }> | null {
	if (policy.entries.length === 0 && deletePolicy.entries.length === 0) return null;
	for (const target of pathPolicyTargets(call, callCwd)) {
		const decision = evaluatePathPolicy(
			target.operation === "delete" ? deletePolicy : policy,
			target.operation,
			target.path,
			callCwd,
			memo,
		);
		if (decision.kind === "block") return decision;
	}
	return null;
}

function pathPolicyTargets(
	call: ClassifierCall,
	callCwd: string,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const args = call.args;
	switch (call.tool) {
		case ToolNames.Read:
		case ToolNames.Ls:
		case ToolNames.Grep:
		case ToolNames.Find: {
			const target = pathArg(args) ?? ".";
			return readScopeSpellings(target, callCwd).map((spelling) => ({ operation: "read" as const, path: spelling }));
		}
		case ToolNames.Data: {
			// data streams one named file; a zero-access path is refused here,
			// before the reader opens it, under every spelling a read of the
			// same path is checked against.
			const target = pathArg(args);
			return target === null
				? []
				: readScopeSpellings(target, callCwd).map((spelling) => ({ operation: "read" as const, path: spelling }));
		}
		case ToolNames.Write:
		case ToolNames.Edit: {
			const target = pathArg(args);
			return target === null ? [] : [{ operation: "write", path: target }];
		}
		case ToolNames.Artifact:
			return [{ operation: "write", path: pathArg(args) ?? artifactDefaultPath(args?.kind) }];
		case ToolNames.CredentialPresent:
			// Sanctioned typed presence check: it may inspect secret-shaped paths
			// internally, but its tool contract can return only boolean metadata.
			return [];
		case ToolNames.Bash: {
			const command = commandArg(args);
			if (command === null) return [];
			return [
				...extractCommandWriteTargets(command).map((target) => ({ operation: "write" as const, path: target })),
				...extractCommandDeleteTargets(command).map((target) => ({ operation: "delete" as const, path: target })),
			];
		}
		default:
			return [];
	}
}

/**
 * The operator's default judges a filtered `find -delete` by what lies under
 * its root, so its root reaches the authority rails as a write: a root inside
 * a rail tree still blocks, a root that merely contains one does not (#419).
 */
function operatorAuthorityTargets(
	targets: Array<{ operation: PathPolicyOperation; path: string }>,
	command: string,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const filtered = extractFilteredFindDeleteRoots(command);
	if (filtered.length === 0) return targets;
	return targets.map((target) => {
		if (target.operation !== "delete") return target;
		const at = filtered.indexOf(target.path);
		if (at < 0) return target;
		filtered.splice(at, 1);
		return { operation: "write", path: target.path };
	});
}

/**
 * Bash net evaluation (sd-01 §2.2). Net blocks: empty commands and cwd
 * escapes. Net confirms: project policy `requireConfirmation` and command
 * substitution (the content-hiding channel). Everything else passes with an
 * `execRecognition` tag: project policy commands and the built-in no-prompt
 * allowlist are recognized; arbitrary bash, including commands with
 * sequencing operators, is unrecognized and the autonomy mapping at the
 * admission seam decides whether it runs, asks, or is denied. A `contained`
 * command runs in the main-session sandbox (Phase 2c), which bounds what a
 * cwd outside the workspace, a variable, a script or a substitution could
 * reach, so none of those rails apply to it.
 */
function evaluateBashPolicy(
	input: string | ReadonlyArray<string>,
	callCwd: string,
	workspaceRoot: string,
	posture: string | undefined,
	policy: LoadedProjectSafetyPolicy,
	readScope: ReadScopeInputs,
	contained: boolean,
): Omit<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> {
	// Catalog commands execute as argv, never as shell source. Only bare words
	// have an unambiguous representation in the canonical command matcher.
	// Keep whitespace, empty arguments, and shell syntax out of recognition;
	// joining them would erase argument boundaries or invent a shell chain.
	if (typeof input !== "string" && !input.every((arg) => /^[\w=./:-]+$/u.test(arg))) {
		return {
			kind: posture === "confirmed" || posture === "yolo" ? "allow" : "ask",
			ruleId: "verify-unrecognized-argv",
			reasonCode: "verify-unrecognized-argv",
			reasons: ["project verifier argv is outside the bare-word no-prompt command set"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const command = typeof input === "string" ? input : input.join(" ");
	if (command.trim().length === 0) {
		return {
			kind: "block",
			ruleId: "bash-empty-command",
			reasonCode: "bash-empty-command",
			reasons: ["bash command must not be empty"],
			policySource: "builtin-command-allowlist",
		};
	}

	if (
		typeof input === "string" &&
		posture !== "confirmed" &&
		!contained &&
		(hasUnparsedShellScript(command) ||
			(posture !== "yolo" &&
				(/\$(?:[A-Za-z_{0-9@*#?!-])/.test(command) ||
					/(?:^|[\s;&|])(?:python[\d.]*|node|ruby|perl|php|lua)\s+(?:[^\n]*?\s)?-[ce]\b/.test(command))))
	) {
		return {
			kind: "ask",
			reasonCode: "bash-hidden-content",
			ruleId: "bash-hidden-content",
			reasons: [
				"shell variables, unparsed shell scripts, or interpreter source hide paths from the safety scan and require one-shot confirmation",
				// A loop over files was the common case in recorded Opus runs; one
				// command over literal operands does the same without the variable.
				...(/\bfor\s+[A-Za-z_]\w*\s+in\b/u.test(command)
					? [
							"Instead of a loop variable, pass the files as literal operands: `tail -n +1 a.js b.js` prints a header before each file.",
						]
					: []),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const projectMatch = matchingProjectCommand(policy, command, callCwd);
	if (projectMatch) {
		const base: Omit<
			SafetyPolicyDecision,
			"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
		> = {
			ruleId: projectMatch.id,
			reasonCode: `project-policy:${projectMatch.id}`,
			reasons: [`allowed by project safety policy command '${projectMatch.id}'`],
			policySource: "project-policy" as const,
			execRecognition: "recognized",
		};
		if (policy.hash !== null) base.policyHash = policy.hash;
		if (policy.path !== null) base.projectPolicyPath = policy.path;
		if (projectMatch.requireConfirmation && posture !== "confirmed" && posture !== "yolo") {
			return {
				...base,
				kind: "ask",
				reasons: [...base.reasons, "project policy requires confirmation"],
			};
		}
		return { ...base, kind: "allow" };
	}
	// A contained command may run from a directory outside the workspace; the
	// sandbox bounds where it writes. Delete and write targets are still judged
	// from that cwd.
	if (!contained && !isUnderOrSame(callCwd, workspaceRoot)) {
		return {
			kind: "block",
			ruleId: "bash-cwd-escape",
			reasonCode: "bash-cwd-escape",
			reasons: [
				`bash cwd '${callCwd}' escapes workspace root '${workspaceRoot}'; use a typed tool or a project policy entry with explicit cwd`,
			],
			policySource: "builtin-command-allowlist",
		};
	}
	// Command substitution is the content-hiding channel: the net cannot scan
	// what `$(...)` or backticks produce at runtime, so default asks. A
	// confirmed one-shot grant or yolo posture admits it after the safety scan.
	// A command that is nothing but `sh -c '<script>'` is recognized by its
	// script. Recognition can only narrow this way: the script is what runs, and
	// judging the wrapper instead is what let the wrapper be a bypass.
	const recognitionSource = inlineShellScript(command) ?? command;
	const recognitionCommand = decodedAnsiCCommand(recognitionSource) ?? recognitionSource;
	if (hasCommandSubstitution(recognitionCommand) && posture !== "confirmed" && posture !== "yolo" && !contained) {
		return {
			kind: "ask",
			ruleId: "bash-command-substitution",
			reasonCode: "bash-command-substitution",
			reasons: ["command substitution hides the executed content from the safety net and requires one-shot confirmation"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const testRunner =
		TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(recognitionCommand)) ??
		pythonRunnerBehindWorkspacePythonPath(recognitionCommand);
	if (testRunner !== undefined) {
		return {
			kind: "allow",
			ruleId: testRunner.id,
			reasonCode: testRunner.id,
			reasons: [`matched built-in test runner '${testRunner.id}'`, projectScriptPreview(recognitionCommand, callCwd)],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
			runsWorkspaceCode: true,
		};
	}
	const projectScript = PROJECT_SCRIPT_COMMANDS.find((entry) => entry.re.test(recognitionCommand));
	if (projectScript !== undefined) {
		return {
			kind: "allow",
			reasonCode: "project-script-autonomy",
			ruleId: projectScript.id,
			reasons: [
				"Repository-authored validation code passed the safety checks; default asks for it unless a trusted safety command declaration approves it, and yolo runs it.",
				projectScriptPreview(recognitionCommand, callCwd),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	// Whitespace checking inspects the diff. Recognize only these standalone
	// spellings: keeping this outside
	// BUILTIN_ALLOWLIST prevents a new no-prompt path through && chains.
	if (/^git[ \t]+diff(?:[ \t]+--cached)?[ \t]+--check$/.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: "builtin:git-diff-check",
			reasonCode: "builtin:git-diff-check",
			reasons: ["matched built-in whitespace inspection 'builtin:git-diff-check'"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	if (VERSION_PROBE.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: "builtin:version-probe",
			reasonCode: "builtin:version-probe",
			reasons: ["matched built-in toolchain version probe 'builtin:version-probe'"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	const chain = recognizeCommandChain(recognitionCommand, callCwd, workspaceRoot, policy, readScope);
	if (chain !== null) {
		const chainReasons = [
			`every step of the command is recognized: ${chain.ruleIds.join(", ")}`,
			...chain.scriptPreviews,
		];
		const runsWorkspaceCode = chain.runsTestRunner ? { runsWorkspaceCode: true as const } : {};
		if (chain.requiresConfirmation && posture !== "confirmed" && posture !== "yolo") {
			return {
				kind: "ask",
				ruleId: "bash-recognized-chain",
				reasonCode: "bash-recognized-chain",
				reasons: [...chainReasons, "project policy requires confirmation for one step"],
				policySource: "builtin-command-allowlist",
				execRecognition: "recognized",
				...runsWorkspaceCode,
			};
		}
		return {
			kind: "allow",
			ruleId: "bash-recognized-chain",
			reasonCode: "bash-recognized-chain",
			reasons: chainReasons,
			policySource: "builtin-command-allowlist",
			execRecognition: chain.requiresAutonomyApproval ? "unrecognized" : "recognized",
			...runsWorkspaceCode,
		};
	}
	// Remaining sequencing operators (pipes, ;, redirects, and && chains with an
	// unrecognized member) defeat per-command recognition, so the command is
	// unrecognized by definition: the autonomy mapping asks in default,
	// runs in yolo, and is denied in a read-only run. The rule pack scanned
	// the full string, so a destructive verb behind an operator was caught before
	// this point.
	if (hasSequencingOperators(command)) {
		// Redirection syntax changes where output goes, not whether repository
		// code executes. Keep script previews even though autonomy admits the call.
		const scriptSegments = commandArgumentSegments(recognitionCommand)
			.map((args) => args.join(" "))
			.filter((part) => matchesRepositoryCommand(part));
		return {
			kind: "allow",
			ruleId: "bash-shell-operators",
			reasonCode: "bash-shell-operators",
			reasons: [
				"shell operators defeat per-command recognition; the autonomy level decides admission",
				...rgConfigReasons(recognitionCommand),
				...readScope.notes.slice(0, 1),
				BASH_RECOGNIZED_FORM_HINT,
				...scriptSegments.map((part) => projectScriptPreview(part, callCwd)),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	for (const entry of BUILTIN_ALLOWLIST) {
		if (entry.re.test(recognitionCommand)) {
			return {
				kind: "allow",
				ruleId: entry.id,
				reasonCode: entry.id,
				reasons: [`matched built-in no-prompt command allowlist '${entry.id}'`],
				policySource: "builtin-command-allowlist",
				execRecognition: "recognized",
			};
		}
	}
	const standaloneWords = scanShellLike(recognitionCommand);
	if (
		standaloneWords.every((word) => !word.operator) &&
		isGitInspection(standaloneWords, recognitionCommand, callCwd, workspaceRoot, readScope)
	) {
		return {
			kind: "allow",
			ruleId: GIT_INSPECT_RULE_ID,
			reasonCode: GIT_INSPECT_RULE_ID,
			reasons: ["the shared Git policy reads this plain git command as inspection only"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	return {
		kind: "allow",
		ruleId: "bash-unrecognized",
		reasonCode: "bash-unrecognized",
		reasons: [
			"bash command is outside the no-prompt set; the autonomy level decides admission",
			...rgConfigReasons(recognitionCommand),
			...readScope.notes.slice(0, 1),
			BASH_RECOGNIZED_FORM_HINT,
		],
		policySource: "builtin-command-allowlist",
		execRecognition: "unrecognized",
	};
}

/**
 * The roots stay lexical: `cwd` is already canonical and the settings loader
 * refuses a symlinked `.clio-coder`, so resolving them would only add the two
 * realpath calls the admission fs budget forbids. A candidate's resolved path
 * still catches an alias that lands on either file.
 */
function mutatesProjectSettings(cwd: string, candidates: ReadonlyArray<MutationCandidate>): boolean {
	const roots = [path.join(cwd, ".clio-coder", "settings.yaml"), path.join(cwd, ".clio-coder", "settings.local.yaml")];
	return candidates.some((candidate) =>
		roots.some((root) =>
			[candidate.lexical, candidate.resolved].some(
				(location) =>
					isSameOrDescendant(location, root) || (candidate.operation === "delete" && isSameOrDescendant(root, location)),
			),
		),
	);
}

function baseDecision(
	call: ClassifierCall,
	classification: Classification,
	cwd: string,
	posture: string | undefined,
	command: string | null,
): Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> {
	const out: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> = {
		classification,
		tool: call.tool,
		actionClass: classification.actionClass,
		cwd,
	};
	if (posture !== undefined) out.posture = posture;
	if (command !== null) out.command = command;
	return out;
}

function allowDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
): SafetyPolicyDecision {
	return { ...base, ...input, kind: "allow" };
}

function askDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
): SafetyPolicyDecision {
	const rejectionInput: Parameters<typeof formatRejection>[0] = {
		tool: base.tool,
		actionClass: base.classification.actionClass,
		reasons: input.reasons,
	};
	if (base.posture !== undefined) rejectionInput.posture = base.posture;
	if (input.ruleId !== undefined) rejectionInput.ruleId = input.ruleId;
	const rejection = formatRejection(rejectionInput);
	return { ...base, ...input, kind: "ask", rejection };
}

function blockDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
): SafetyPolicyDecision {
	const rejectionInput: Parameters<typeof formatRejection>[0] = {
		tool: base.tool,
		actionClass: base.classification.actionClass,
		reasons: input.reasons,
	};
	if (base.posture !== undefined) rejectionInput.posture = base.posture;
	if (input.ruleId !== undefined) rejectionInput.ruleId = input.ruleId;
	const rejection = formatRejection(rejectionInput);
	return { ...base, ...input, kind: "block", rejection };
}

/** Most of a script the floor reads before the call runs (#419, #407). */
const FLOOR_SCRIPT_SCAN_BYTES = 256 * 1024;

interface ScriptHit {
	file: string;
	line: number;
	text: string;
	match: DamageControlMatch;
	source: SafetyPolicySource;
}

/** True for run_script and for a bash command that hands a shell a script file it names (#419). */
function runsScriptFile(call: ClassifierCall): boolean {
	if (call.tool === ToolNames.RunScript) return true;
	if (call.tool !== ToolNames.Bash) return false;
	const command = commandArg(call.args);
	return command !== null && hasUnparsedShellScript(command) && (shellScriptSources(command)?.length ?? 0) > 0;
}

/** The `RUN_SCRIPT_INTERPRETERS` entries that read their script as shell source (#421). */
const RUN_SCRIPT_SHELLS: ReadonlySet<string> = new Set<RunScriptInterpreter>(["bash", "sh"]);

/** True when run_script hands its script to a shell, the only interpreter whose lines the floor scan can read. */
function runsUnderShell(args: Record<string, unknown> | undefined): boolean {
	const interpreter = args?.interpreter;
	return typeof interpreter === "string" && RUN_SCRIPT_SHELLS.has(interpreter.trim());
}

/** Why yolo refuses a script when `safety.sandbox` is `required` and the host has no backend. */
const YOLO_SCRIPT_SANDBOX_REFUSED =
	'safety.sandbox is "required" and no OS sandbox is available, so yolo does not run a script; run its commands directly or set safety.sandbox to auto';

/** Rule id of that refusal, a ceiling the operator set (#407). */
const YOLO_SANDBOX_REQUIRED_RULE_ID = "yolo-sandbox-required";

/** Reason code prefix of a call yolo admitted past a rail that would have asked or blocked (#407). */
const YOLO_ADMITTED_REASON_PREFIX = "yolo-admitted:";

/**
 * Net blocks that hold at yolo besides the floor and operator rules: the
 * run's write-root ceiling, a call that cannot run as given, and an approved
 * project policy that no longer parses, whose operator rules cannot be read.
 */
const YOLO_HELD_RULE_IDS: ReadonlySet<string> = new Set([
	"write-root",
	"bash-empty-command",
	"verify-cwd-invalid",
	"project-policy-invalid",
	YOLO_SANDBOX_REQUIRED_RULE_ID,
]);

/** True for a block the true-yolo evaluation keeps (#407). */
function holdsAtYolo(decision: SafetyPolicyDecision): boolean {
	if (decision.kind !== "block") return false;
	if (decision.ruleId !== undefined && YOLO_HELD_RULE_IDS.has(decision.ruleId)) return true;
	return decision.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX) || decision.reasonCode.startsWith("operator-rule:");
}

/** A script operand as the shell resolves it; a name it expands at run time stays unplaceable. */
function scriptPath(operand: string, callCwd: string): string | null {
	if (/[$`*?[{]/u.test(operand)) return null;
	const expanded = operand === "~" || operand.startsWith("~/") ? expandPath(operand) : operand;
	return path.resolve(callCwd, expanded);
}

/** Most levels of `source`, `bash` or `exec` a scan follows below the script the command names. */
const FLOOR_SCRIPT_NEST_DEPTH = 3;

/** Bytes left for one command's scripts, shared by every file the scan follows. */
interface ScriptBudget {
	remaining: number;
}

function newScriptBudget(): ScriptBudget {
	return { remaining: FLOOR_SCRIPT_SCAN_BYTES };
}

/** The floor a script line meets, judged from `callCwd` where the scan lost the line's own directory. */
type FloorLine = (
	raw: string,
	read: ScriptLine,
	callCwd: string,
) => { match: DamageControlMatch; source: SafetyPolicySource } | null;

/** One scan's shared state: the floor it applies, the call it serves and its byte budget. */
interface ScriptScan {
	floorLine: FloorLine;
	callCwd: string;
	budget: ScriptBudget;
	/** Files earlier lines write or download, which a later line's script may not be read from. */
	written: WrittenPaths;
}

/** Files and trees a command or the script lines so far write before a later script runs. */
interface WrittenPaths {
	files: Set<string>;
	trees: Set<string>;
}

function newWrittenPaths(): WrittenPaths {
	return { files: new Set(), trees: new Set() };
}

function isWrittenFirst(file: string, written: WrittenPaths): boolean {
	return written.files.has(file) || [...written.trees].some((tree) => isSameOrDescendant(file, tree));
}

/** The nearest directory at or above `dir` that holds `.git`, else `dir`. */
function gitWorkTree(dir: string): string {
	for (let current = dir; ; current = path.dirname(current)) {
		try {
			if (statSync(path.join(current, ".git"), { throwIfNoEntry: false }) !== undefined) return current;
		} catch {
			// An unreadable level cannot hold the marker for us; keep walking up.
		}
		if (path.dirname(current) === current) return dir;
	}
}

/**
 * A script a bash command runs through a shell, scanned against the floor
 * from where the command leaves it (#407). A name the shell builds at run time
 * (a variable, a command or process substitution), a file the same command
 * writes or downloads first, and anything but a regular file run unread.
 */
function scanCommandScript(
	script: ScriptSource,
	floorLine: FloorLine,
	callCwd: string,
	cwds: string[] | null,
	written: WrittenPaths,
	budget: ScriptBudget,
): ScriptHit | null {
	const operand = script.path;
	if (/^[<>]\(/u.test(operand)) return null;
	const candidates = scriptCandidates(operand, cwds);
	const files = candidates.filter((candidate): candidate is string => candidate !== null);
	if (files.length < candidates.length) return null;
	for (const file of files) {
		if (isWrittenFirst(file, written)) return null;
		let regular: boolean | undefined;
		try {
			regular = statSync(file, { throwIfNoEntry: false })?.isFile();
		} catch {
			// A path the stat cannot reach is not one the scan can call a regular file.
			regular = false;
		}
		if (regular !== true) return null;
	}
	// `bash x.sh` runs with `$0` as written; on standard input `$0` names the shell.
	const name = operand === "~" || operand.startsWith("~/") ? expandPath(operand) : operand;
	const names: ScriptNames = script.stdin ? { zero: null, source: null } : { zero: name, source: name };
	for (const file of files) {
		const scan = scanNamedScript(file, floorLine, callCwd, cwds, budget, names);
		if (scan !== null) return scan;
	}
	return null;
}

/**
 * Adds the files a command writes or downloads, and the trees it extracts,
 * clones, checks out or copies into, placed from every directory it may run
 * in, to `into`.
 */
function commandWrittenPaths(command: string, cwds: ReadonlyArray<string>, into: WrittenPaths): WrittenPaths {
	const place = (target: string): string[] => {
		const expanded = target === "~" || target.startsWith("~/") ? expandPath(target) : target;
		return (path.isAbsolute(expanded) ? ["/"] : cwds).map((cwd) => path.resolve(cwd, expanded));
	};
	if (command === "") return into;
	for (const target of [...extractCommandWriteTargets(command), ...downloadedFiles(command)]) {
		for (const placed of place(target)) into.files.add(placed);
	}
	for (const target of unpackedTargets(command)) {
		for (const placed of place(target.path)) into.trees.add(target.scope === "repository" ? gitWorkTree(placed) : placed);
	}
	return into;
}

/** Scans a script the command or `run_script` names against the floor, starting in `cwds`. */
function scanNamedScript(
	file: string | null,
	floorLine: FloorLine,
	callCwd: string,
	cwds: string[] | null,
	budget: ScriptBudget,
	names: ScriptNames,
): ScriptHit | null {
	const scan: ScriptScan = { floorLine, callCwd, budget, written: newWrittenPaths() };
	return scanScript(file, scan, newScriptShell(cwds), newScriptReader("plain", names));
}

/**
 * The first line of a script the floor refuses (#407). Each line is judged
 * from every directory the script can be in by then, with the literal
 * variables assigned before it substituted, and the scan follows the scripts
 * its lines `source`, run through a shell or `exec` by literal path. What the
 * scan cannot read or follow (an unreadable or binary file, one over the cap,
 * a script named at run time or written first, a nesting deeper than the
 * limit) is skipped, never a reason to stop, so a script nothing on the floor
 * touches runs. Backslash continuations join before matching.
 */
function scanScript(
	file: string | null,
	scan: ScriptScan,
	shell: ScriptShell,
	reader: ScriptReader,
	depth = 0,
): ScriptHit | null {
	if (file === null) return null;
	let text: string;
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > scan.budget.remaining) return null;
		scan.budget.remaining -= info.size;
		text = readFileSync(file, "utf8");
	} catch {
		// An unreadable script runs unscanned, like any interpreter's file.
		return null;
	}
	// A binary `exec` target is a program, not a script to read.
	if (text.includes("\0")) return null;
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const start = index;
		let logical = lines[index] ?? "";
		while (logical.endsWith("\\") && index + 1 < lines.length) {
			index += 1;
			logical = `${logical.slice(0, -1)} ${lines[index] ?? ""}`;
		}
		const at = { file, line: start + 1, text: logical.trim() };
		const read = readScriptLine(reader, shell, logical);
		const verdict = scan.floorLine(logical, read, scan.callCwd);
		if (verdict !== null) return { ...at, ...verdict };
		if (read.data) continue;
		advanceScriptShell(reader, shell, logical, read);
		const sources = scriptLineSources(read.expanded);
		if (sources === null) continue;
		const cwds = read.context === "function" ? null : shell.cwds;
		commandWrittenPaths(read.expanded, cwds ?? [scan.callCwd], scan.written);
		if (depth >= FLOOR_SCRIPT_NEST_DEPTH) continue;
		for (const source of sources) {
			for (const candidate of scriptCandidates(source.path, cwds)) {
				if (candidate !== null && isWrittenFirst(candidate, scan.written)) continue;
				// `source` runs in this shell; `bash`, `sh` and `exec` start a child that changes nothing here.
				// A sourced file keeps the script's `$0`; a child shell gets the name it was run by.
				const names: ScriptNames = source.stdin
					? { zero: null, source: null }
					: source.sourced
						? { zero: reader.names.zero, source: source.path }
						: { zero: source.path, source: source.path };
				const inner = source.sourced
					? scanScript(candidate, scan, shell, newScriptReader(read.context, names), depth + 1)
					: scanScript(candidate, scan, childScriptShell(shell, read.context), newScriptReader("plain", names), depth + 1);
				if (inner !== null) return inner;
			}
		}
	}
	return null;
}

/**
 * The files a script operand can name from the directories the shell may be
 * in: the ones that exist, or the first candidate when none does, so its scan
 * reports it. A dynamic name, or a relative one from an unknown directory, is
 * a null candidate.
 */
function scriptCandidates(operand: string, cwds: ReadonlyArray<string> | null): Array<string | null> {
	if (/[$`*?[{]/u.test(operand)) return [null];
	if (operand === "~" || operand.startsWith("~/") || path.isAbsolute(operand)) return [scriptPath(operand, "/")];
	if (cwds === null) return [null];
	const candidates = [...new Set(cwds.map((cwd) => path.resolve(cwd, operand)))];
	const existing = candidates.filter((candidate) => statSync(candidate, { throwIfNoEntry: false }) !== undefined);
	return existing.length > 0 ? existing : candidates.slice(0, 1);
}

/** Clio's resolved config, data, state and cache trees, and the ways a command can spell them. */
interface ClioOwnedTrees {
	roots: ReadonlyArray<string>;
	spellings: ReadonlyArray<string>;
}

function clioOwnedTrees(): ClioOwnedTrees {
	const dirs = resolveClioDirs();
	const roots = new Set<string>();
	for (const dir of [dirs.config, dirs.data, dirs.state, dirs.cache]) {
		roots.add(path.resolve(dir));
		const canonical = canonicalizePath(dir);
		if (canonical !== null) roots.add(canonical);
	}
	const home = homedir();
	const spellings = new Set<string>(roots);
	for (const root of roots) {
		if (!isSameOrDescendant(root, home) || root === home) continue;
		const rest = root.slice(home.length);
		for (const prefix of ["~", "$HOME", `\${HOME}`]) spellings.add(`${prefix}${rest}`);
	}
	return { roots: [...roots], spellings: [...spellings] };
}

/** Commands that print names and metadata, never contents. */
const NAME_LISTERS: ReadonlySet<string> = new Set(["ls", "stat", "du", "test", "["]);

/** `$CLIO_CODER_CONFIG_DIR`, `$CLIO_CODER_HOME` and `$XDG_CONFIG_HOME` spell the root Clio's credential store lives under at run time. */
const CLIO_CONFIG_VARIABLE = /\$\{?(?:CLIO_CODER_CONFIG_DIR|CLIO_CODER_HOME|XDG_CONFIG_HOME)\b/u;

/** `$CLIO_CODER_CONFIG_DIR`, `$XDG_CONFIG_HOME/clio-coder` and their kin name a Clio tree at run time. */
const CLIO_OWNED_VARIABLE = /\$\{?(?:CLIO_CODER_\w+|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME\}?\/clio-coder)/u;

/** What the operator's default made of a call's damage-control hits (Phase 2c). */
interface ResortedDamageControl {
	/** The class the rest of the evaluation judges the call by. */
	classification: Classification;
	/** A former hard block, now an ask for the safety judge. */
	ask: DeferredAsk | null;
	/** An authored ask rule no snapshot undoes; its ask rail asks as before. */
	askRule: { match: DamageControlMatch; source: SafetyPolicySource } | null;
	/** The hit a snapshot undoes, or a match-less mark for a recoverable classifier pattern; null when none yielded. */
	recoverable: { match: DamageControlMatch | null } | null;
}

/** Reason every former hard block carries when the operator's default asks for it instead (Phase 2c). */
const DEFAULT_RESORTED_REASON =
	"at autonomy default this damage-control rule asks instead of blocking, so the safety judge decides it against the operator's request";

/** Reason a contained call carries for a rail the main-session sandbox stands in for (Phase 2c). */
const CONTAINED_REASON =
	"the call runs in the main-session sandbox, which bounds where it writes and hides credentials, so it needs no approval";

/** Reason a call a workspace snapshot undoes carries (Phase 2c). */
const SNAPSHOT_RECOVERABLE_REASON =
	"a workspace snapshot is taken right before this call runs, so /rewind undoes it; it needs no approval";

/** Asks only the operator answers; a deferred former block joins their reasons instead of replacing them. */
const OPERATOR_ONLY_ASKS: ReadonlySet<string> = new Set(["project-settings-confirm", "library-confirm"]);

/** A single git worktree discard with no global options, which runs nothing else. */
const LONE_GIT_DISCARD = /^git\s+(?:reset|checkout|restore|clean|stash)\s/u;

/** Rule id of a workspace delete the operator's default asks for because no snapshot can undo it. */
const DELETE_WITHOUT_SNAPSHOT_RULE_ID = "delete-without-snapshot";

/**
 * Delete targets of a command that only a workspace snapshot could undo: a
 * relative target, which the shell places from wherever it stands, and an
 * absolute one inside the workspace. A scratch root's contents are
 * disposable, and a path elsewhere already meets the delete judge.
 */
function deletesNeedingSnapshot(command: string, workspace: string): string[] {
	const targets: string[] = [];
	const canonicalWorkspace = canonicalizePath(workspace);
	for (const walk of extractCommandPathWalks(command)) {
		for (const event of walk) {
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			if (path.isAbsolute(event.target)) {
				const resolved = canonicalizeRawPath(event.target, "/");
				if (resolved === null || canonicalWorkspace === null || !isUnderOrSame(resolved, canonicalWorkspace)) continue;
			}
			targets.push(event.target);
		}
	}
	return targets;
}

/** A single rm, rmdir or unlink, which runs nothing else; the delete judge has already placed its operands. */
const LONE_DELETE = /^(?:rm|rmdir|unlink)\s/u;

/**
 * True when the operator's default runs this call in the main-session sandbox
 * (Phase 2c): bash and run_script, unless the call asks to leave it with
 * `unsandboxed: true` or reaches outward (a push, a publish, a code host or
 * cloud CLI, a network write), which needs the credentials the sandbox hides.
 */
function containedShellCall(call: ClassifierCall, classification: Classification): boolean {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return false;
	if (call.args?.unsandboxed === true) return false;
	if (classification.exposure === "outward") return false;
	const command = commandArg(call.args);
	return command === null || outwardShellReason(command) === null;
}

/** A hard rule blocks; an `ask: true` rule asks. The same test matchSourcedRule ranks by. */
function isHardMatch(match: DamageControlMatch): boolean {
	return match.block === true || (match.ask !== true && match.actionClass === "git_destructive");
}

/** Pack rules that flag a delete by its shape; the delete judge then places every operand. */
const DELETE_SHAPED_RULES: ReadonlySet<string> = new Set(["rsync-delete", "rmdir-ignore-non-empty"]);

const FIND_FOLLOWS_LINKS = /(?:^|[\s;&|(])-(?:L|H|follow)(?=$|[\s;&|)])/u;

/**
 * True when the workspace snapshot taken right before the call undoes what
 * this damage-control rule flagged (Phase 2c): a worktree discard or stash
 * drop, or a delete the delete judge places inside the workspace or a scratch
 * root. Each delete reading counts the steps it parsed and yields only when
 * that covers every textual match, so a command the parser cannot see keeps
 * the rule (#419).
 */
function snapshotRecoverableRule(
	ruleId: string,
	pattern: RegExp,
	scans: ReadonlyArray<string>,
	command: string | null,
	scratchRoots: ReadonlyArray<string>,
	workspace: string,
): boolean {
	if (SNAPSHOT_RECOVERABLE_GIT_RULE_IDS.has(ruleId)) {
		return ruleId !== "git-clean-force-directory" || !cleansIgnoredFiles(command ?? "");
	}
	if (command === null) return false;
	// A remote rsync destination is not the workspace's to restore.
	if (DELETE_SHAPED_RULES.has(ruleId)) return outwardShellReason(command) === null;
	if (ruleId === "find-delete") {
		if (scans.some((scan) => FIND_FOLLOWS_LINKS.test(scan))) return false;
		const finds = findDeletesNotFollowing(command);
		return finds !== null && finds >= mostMatches(pattern, scans);
	}
	if (ruleId !== "rm-rf-root") return false;
	// Read both ways: the text for a delete the parser cannot see and the
	// parsed words for one whose quoting hides the path from the text.
	const removed = removedAbsolutePaths(command);
	return (
		removed !== null &&
		removed.steps >= mostMatches(pattern, scans) &&
		everyMatchedPathRecoverable(pattern, scans, scratchRoots, workspace) &&
		removed.paths.every((removedPath) => isRecoverableDeletePath(removedPath, scratchRoots, workspace))
	);
}

function mostMatches(pattern: RegExp, scans: ReadonlyArray<string>): number {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	return Math.max(0, ...scans.map((scan) => [...scan.matchAll(global)].length));
}

/**
 * `rm-rf-root` flags every `rm -rf /<path>` outside /tmp. Under the operator's
 * default it yields when the path each of its matches names, in every scan,
 * resolves strictly inside the workspace or a scratch root. This reads the
 * text so a delete the parser cannot see keeps the rule; the caller also reads
 * the parsed words, and the delete judge still places every operand.
 */
function everyMatchedPathRecoverable(
	pattern: RegExp,
	scans: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
	workspace: string,
): boolean {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	let matched = false;
	for (const scan of scans) {
		for (const found of scan.matchAll(global)) {
			matched = true;
			const start = (found.index ?? 0) + found[0].length - 1;
			const operand = scan[start] === "/" ? /^[^\s;&|()<>'"`]+/u.exec(scan.slice(start))?.[0] : undefined;
			if (operand === undefined || operand.includes("$")) return false;
			if (!isRecoverableDeletePath(operand, roots, workspace)) return false;
		}
	}
	return matched;
}

/** True when an absolute path lies strictly inside a scratch root, or strictly inside the workspace and outside its .git. */
function isRecoverableDeletePath(operand: string, roots: ReadonlyArray<string>, workspace: string): boolean {
	const resolved = canonicalizeRawPath(operand, "/");
	if (resolved === null) return false;
	if (roots.some((root) => resolved !== root && isUnderOrSame(resolved, root))) return true;
	const canonicalWorkspace = canonicalizePath(workspace);
	if (canonicalWorkspace === null || resolved === canonicalWorkspace) return false;
	return isUnderOrSame(resolved, canonicalWorkspace) && !isUnderOrSame(resolved, path.join(canonicalWorkspace, ".git"));
}

/** Whether one rule matches any scan candidate outside an inert quoted argument. */
function ruleMatches(candidates: ReadonlyArray<string>, entry: SourcedRule): boolean {
	return candidates.some(
		(candidate) =>
			entry.rule.pattern.test(candidate) &&
			!(
				inertQuotedMatch(candidates[0] ?? candidate, entry.rule.pattern, entry.rule.id) &&
				inertQuotedMatch(candidate, entry.rule.pattern, entry.rule.id)
			),
	);
}

function ruleMatch(entry: SourcedRule): DamageControlMatch {
	const match: DamageControlMatch = {
		ruleId: entry.rule.id,
		reason: `matched ${entry.rule.id}: ${entry.rule.description}`,
		actionClass: entry.rule.class,
		block: entry.rule.block,
	};
	if (entry.rule.ask !== undefined) match.ask = entry.rule.ask;
	return match;
}

/** Every rule a call matches, in rule order: the operator's default judges each one (Phase 2c). */
function matchingSourcedRules(
	candidates: ReadonlyArray<string>,
	rules: ReadonlyArray<SourcedRule>,
): Array<{ match: DamageControlMatch; source: SafetyPolicySource; pattern: RegExp }> {
	return rules
		.filter((entry) => ruleMatches(candidates, entry))
		.map((entry) => ({ match: ruleMatch(entry), source: entry.source, pattern: entry.rule.pattern }));
}

/**
 * A hard rule outranks every confirmation rule; within one severity, rule order
 * is precedence. Returning the first match in rule order let an authored ask
 * rule for one segment of a compound command hide a later hard block for
 * another: `gcloud iam policies list; firebase projects:delete x` asked, and a
 * confirmed posture then admitted the project deletion (F1). Every rule is
 * offered every scan candidate, so each segment is judged.
 */
function matchSourcedRule(candidates: ReadonlyArray<string>, rules: ReadonlyArray<SourcedRule>) {
	let first: { match: DamageControlMatch; source: SourcedRule["source"] } | null = null;
	for (const entry of rules) {
		if (!ruleMatches(candidates, entry)) continue;
		const match = ruleMatch(entry);
		// The same test evaluate() applies before its block rail.
		if (isHardMatch(match)) return { match, source: entry.source };
		first ??= { match, source: entry.source };
	}
	return first;
}

// Excludes "unknown" because damage control overrides must classify actions into concrete, actionable categories.
const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"system_modify",
	"git_destructive",
	"destructive",
	"dispatch",
]);

function effectiveClassification(
	classification: Classification,
	match: DamageControlMatch | undefined,
): Classification {
	if (!match || !ACTION_CLASSES.has(match.actionClass as ActionClass)) return classification;
	const actionClass = match.actionClass as ActionClass;
	if (actionClass === classification.actionClass) return classification;
	return {
		...classification,
		actionClass,
		reasons: [...classification.reasons, `damage-control:${match.ruleId}`],
	};
}

function matchingProjectCommand(
	policy: LoadedProjectSafetyPolicy,
	command: string,
	cwd: string,
): ProjectCommandPolicy | null {
	if (!policy.valid || policy.path === null) return null;
	const policyRoot = path.dirname(path.dirname(policy.path));
	for (const entry of policy.commands) {
		if (entry.command !== command) continue;
		if (entry.shellOperators === "deny" && hasShellOperators(command)) continue;
		const allowedCwd = entry.cwd !== undefined ? path.resolve(policyRoot, entry.cwd) : policyRoot;
		if (!isUnderOrSame(cwd, allowedCwd)) continue;
		return entry;
	}
	return null;
}

/**
 * Segment ceiling. Models pad inspection chains with `echo "---X---"` headers,
 * and a flywheel chain of twelve such steps parked at a ceiling of eight. Every
 * step is still judged on its own.
 */
const CHAIN_MAX_SEGMENTS = 16;

/** What read-only recognition needs to hold a path operand to the workspace, as the read tools are. */
interface ReadScopeInputs {
	exemptRoots: ReadonlyArray<ReadScopeExemptRoot>;
	memo: PathWalkMemo;
	/** False for a path a zero-access entry covers, the way `readablePath` judges it. */
	readable(target: string): boolean;
	/** Directory entries rg recognition may still visit in this one evaluation, across every operand and chain step. */
	walkBudget: { remaining: number };
	/**
	 * Why recognition refused a step, in the order it found them. The first one
	 * leads the guidance an unrecognized decision carries, so a headless denial
	 * names the step to change instead of only the generic recognized forms.
	 */
	notes: string[];
}

interface ChainRecognition {
	ruleIds: ReadonlyArray<string>;
	/** Explicit project policy confirmation asks in default and is skipped in yolo. */
	requiresConfirmation: boolean;
	/** Built-in project scripts ask in default and run in yolo. */
	requiresAutonomyApproval: boolean;
	/** One step is a built-in test runner, which executes repository code. */
	runsTestRunner: boolean;
	scriptPreviews: ReadonlyArray<string>;
}

/** Operators that join two commands the recognizer checks one by one. `&`, subshells and here-strings stay out. */
const CHAIN_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|"]);

/**
 * A redirection that only discards output or merges descriptors: `2>/dev/null`,
 * `&>/dev/null`, `2>&1`, `>&2`. Anything that names a file is a write.
 */
function isDiscardRedirection(operator: string, target: string | undefined): boolean {
	if (target === undefined) return false;
	if ((operator === ">" || operator === ">>" || operator === "&>" || operator === "&>>") && target === "/dev/null")
		return true;
	return operator === ">&" && /^[12]$/u.test(target);
}

/**
 * Commands that only read files or transform their input, each with the options
 * that would make it write, execute, walk a tree, or name an input list or
 * output file. A command outside this table, or one carrying a refused option,
 * leaves the whole compound unrecognized, so the autonomy level decides it as
 * before. The table stays short on purpose: every wider member (jq, diff, cmp,
 * du, file, tree, sort, column) had an option that read a list file, walked a
 * tree, printed the environment or wrote a file, and a per-option denylist over
 * a wide vocabulary kept leaking. awk, xargs, env and the shells stay out
 * because their arguments are programs.
 */
const READ_ONLY_INSPECTORS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["cat", []],
	["head", []],
	["tail", ["-f", "-F", "--follow", "--retry"]],
	["wc", ["--files0-from"]],
	["nl", []],
	[
		"ls",
		[
			"-L",
			"-H",
			"-R",
			"--recursive",
			"--dereference",
			"--dereference-command-line",
			"--dereference-command-line-symlink-to-dir",
		],
	],
	["pwd", []],
	["stat", []],
	["basename", []],
	["dirname", []],
	["realpath", []],
	["readlink", []],
	["echo", []],
	// printf -v assigns a shell variable, so `printf -v PATH bin && cat a.txt` would run a workspace
	// binary as cat. No other entry here assigns one.
	["printf", ["-v"]],
	["true", []],
	["which", []],
	["cut", []],
	["tr", []],
	["grep", ["-f", "--file", "--exclude-from"]],
	["egrep", ["-f", "--file", "--exclude-from"]],
	["fgrep", ["-f", "--file", "--exclude-from"]],
	["rg", ["-f", "--file", "-L", "--follow", "--pre", "--pre-glob", "-z", "--search-zip", "--hostname-bin"]],
	[
		"find",
		[
			"-L",
			"-follow",
			"-files0-from",
			"-exec",
			"-execdir",
			"-ok",
			"-okdir",
			"-delete",
			"-fprint",
			"-fprint0",
			"-fprintf",
			"-fls",
		],
	],
]);

/**
 * Short option letters that take a value, per command. In a cluster the first
 * such letter ends the flags: everything after it is that option's value
 * (`grep -efoo`, `head -qn20`, `cut -d,`), a number, pattern or format that
 * names no file, so it must not be read as more flags. Letters that would take
 * a file (`grep -f`) are in the refused list instead, and a refused letter is
 * still caught when it is the value-taking one (`grep -f.env`, `grep -nf.env`).
 */
const SHORT_VALUE_LETTERS: ReadonlyMap<string, string> = new Map([
	["head", "nc"],
	["tail", "ncs"],
	["cut", "dfbc"],
	["grep", "efmABCdD"],
	["egrep", "efmABCdD"],
	["fgrep", "efmABCdD"],
	["rg", "eABCmgtT"],
	["ls", "wIT"],
	["stat", "c"],
	["nl", "bdfhilnsvw"],
	["basename", "s"],
]);

/** `sed -n` with a print-only line script (`1,80p`, `5p`, `10,$p`); every other sed program can write or execute. */
const SED_PRINT_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u;

/**
 * True when the source text of one shell word carries an expansion the
 * recognizer does not perform: tilde and brace expansion, pathname globs, and
 * ANSI-C or locale quoting (`$'\x2fetc'`). The word's own `quoted` flag is
 * too coarse for this, because one quoted fragment marks the whole word
 * (`.e*''` is still a glob), so the raw text is walked with its quoting.
 * `revisions` reads the word as a Git argument, where `HEAD~3`, `HEAD@{1}`
 * and `v1^{commit}` are revision spellings: a tilde counts only at the start
 * of the word and a brace only when bash would expand it (a comma or `..`).
 */
function hasUnquotedExpansion(raw: string, revisions = false): boolean {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (revisions && char === "~" && index > 0) continue;
		if (revisions && char === "{") {
			const close = raw.indexOf("}", index);
			if (close === -1 || /,|\.\./u.test(raw.slice(index + 1, close))) return true;
			continue;
		}
		if (revisions && char === "}") continue;
		if (char !== undefined && "~{}*?[".includes(char)) return true;
		if (char === "$" && (raw[index + 1] === "'" || raw[index + 1] === '"')) return true;
	}
	return false;
}

/**
 * GNU getopt_long accepts any unambiguous prefix of a long option, so `--out`
 * is `--output`. An ambiguous prefix is an error there, which makes refusing
 * every prefix (with or without `=value`) safe: it costs an ask at worst.
 */
function abbreviatesLongOption(arg: string, option: string): boolean {
	if (!arg.startsWith("--") || arg === "--" || !option.startsWith("--")) return false;
	const name = (arg.split("=", 1)[0] ?? "").slice(2);
	return name.length > 0 && option.slice(2).startsWith(name);
}

const RG_FLAG_LETTERS = /^-[nisSwxvlcHIFNoqa]+$/u;
const RG_VALUE_SHORT = new Set(["-A", "-B", "-C", "-m", "-g", "-t", "-T"]);
const RG_FLAGS: ReadonlySet<string> = new Set([
	"--line-number",
	"--ignore-case",
	"--smart-case",
	"--case-sensitive",
	"--fixed-strings",
	"--word-regexp",
	"--line-regexp",
	"--invert-match",
	"--count",
	"--files-with-matches",
	"--files-without-match",
	"--only-matching",
	"--no-heading",
	"--heading",
	"--with-filename",
	"--no-filename",
	"--no-line-number",
	"--no-messages",
	"--quiet",
	"--text",
]);
const RG_VALUE_LONG = new Set([
	"--regexp",
	"--glob",
	"--type",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
]);

/**
 * rg recurses by default, and a directory walk reaches zero-access files
 * (`*.pem`, `kubeconfig`) that naming the directory does not mention. It is
 * recognized only when it names at least one operand after the pattern and
 * every operand is an existing regular file, or a directory
 * {@link directoryHoldsNoProtectedFile} proves cannot reach one. The pattern
 * position shifts with `-e`/`--regexp`, so only flags this parser knows are
 * accepted; any other option, `-f`, or a stdin `-` operand is ambiguous and
 * refused.
 */
interface RgArgs {
	/** Non-option words with their index in the argument list. */
	positionals: ReadonlyArray<{ arg: string; index: number }>;
	explicitPattern: boolean;
	listsFiles: boolean;
}

/** Only the options this parser knows; any other option, or a stdin `-` operand, is null. */
function parseRgArgs(args: ReadonlyArray<string>): RgArgs | null {
	const positionals: Array<{ arg: string; index: number }> = [];
	let explicitPattern = false;
	let listsFiles = false;
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (!optionsEnded && arg === "--files") {
			listsFiles = true;
			continue;
		}
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			if (arg === "-") return null;
			positionals.push({ arg, index });
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg : arg.slice(0, eq);
			if (RG_FLAGS.has(arg)) continue;
			if (!RG_VALUE_LONG.has(name)) return null;
			if (name === "--regexp") explicitPattern = true;
			if (eq === -1) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		if (RG_FLAG_LETTERS.test(arg)) continue;
		const flag = arg.slice(0, 2);
		if (flag === "-e") {
			explicitPattern = true;
			if (arg.length === 2) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		if (RG_VALUE_SHORT.has(flag)) {
			if (arg.length === 2) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		return null;
	}
	return { positionals, explicitPattern, listsFiles };
}

function rgSearchStaysReadable(
	args: ReadonlyArray<string>,
	cwd: string,
	piped: boolean,
	readScope: ReadScopeInputs,
): boolean {
	const parsed = parseRgArgs(args);
	if (parsed === null) return false;
	const { explicitPattern, listsFiles } = parsed;
	const positionals = parsed.positionals.map((entry) => entry.arg);
	// `--files` prints the paths rg would search and opens no file, so it lists
	// like `find` does. Its operands are walk roots; the caller holds them to
	// the workspace.
	if (listsFiles) return !explicitPattern;
	const operands = explicitPattern ? positionals : positionals.slice(1);
	if (!explicitPattern && positionals.length === 0) return false;
	// Fed by a pipe and naming no file, rg reads stdin and opens nothing.
	if (operands.length === 0) return piped;
	return operands.every((operand) => {
		try {
			const target = path.resolve(cwd, operand);
			const stats = statSync(target);
			return stats.isFile() || (stats.isDirectory() && directoryHoldsNoProtectedFile(target, readScope));
		} catch {
			// A path that cannot be stat'ed is not an existing file or directory.
			return false;
		}
	});
}

/**
 * Entries the directory walks of one evaluation may visit in total before
 * recognition gives up and the call asks. The walk is synchronous, so an
 * allowance per operand would let a long argument list or a chain of rg steps
 * multiply the time admission blocks the event loop.
 */
const RG_WALK_BUDGET = 10_000;

/**
 * True when every entry under `dir` is readable, so an rg walk of it cannot
 * print a zero-access file. The walk is a superset of what rg searches: it
 * prunes nothing. Hidden entries stay in because an ignore file's `!.env`
 * line or a `--glob` whitelist makes rg search them without any flag this
 * parser refuses. Symlinks are listed but not followed, as rg without `-L`
 * (refused above) does not follow them either; `readable` still judges one by
 * where it points. A tree larger than the budget, or a directory that cannot
 * be listed, is not proven and asks.
 */
function directoryHoldsNoProtectedFile(dir: string, { readable, walkBudget }: ReadScopeInputs): boolean {
	if (!readable(dir)) return false;
	const pending = [dir];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			// A directory that cannot be listed cannot be proven free of protected files.
			return false;
		}
		for (const entry of entries) {
			walkBudget.remaining -= 1;
			if (walkBudget.remaining < 0) return false;
			const full = path.join(current, entry.name);
			if (!readable(full)) return false;
			if (entry.isDirectory()) pending.push(full);
		}
	}
	return true;
}

const GREP_FAMILY: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);

const GREP_VALUELESS_LONG: ReadonlySet<string> = new Set([
	"--line-number",
	"--ignore-case",
	"--word-regexp",
	"--line-regexp",
	"--invert-match",
	"--count",
	"--files-with-matches",
	"--files-without-match",
	"--only-matching",
	"--no-messages",
	"--quiet",
	"--silent",
	"--text",
	"--extended-regexp",
	"--fixed-strings",
	"--perl-regexp",
	"--basic-regexp",
	"--with-filename",
	"--no-filename",
]);
const GREP_ATTACHED_LONG: ReadonlySet<string> = new Set([
	"--include",
	"--exclude",
	"--exclude-dir",
	"--color",
	"--colour",
	"--max-count",
	"--context",
	"--after-context",
	"--before-context",
]);

/**
 * Where the search pattern sits in the arguments of `rg` or a grep-family
 * command, or null when the form is not read with certainty. The pattern is a
 * regular expression, never opened as a path, so the operand checks skip it.
 * A pattern such as `"balance\(|income statement"` carries whitespace and a
 * backslash, which `spacedPathOperand` reads as a path hiding a traversal. An
 * `-e`/`-f`/`--regexp` form has no positional pattern, and any option this
 * parse does not know could take a value that shifts the position, so those
 * stay null and every word keeps the path checks.
 */
function searchPatternIndex(command: string, args: ReadonlyArray<string>): number | null {
	if (command === "rg") {
		const parsed = parseRgArgs(args);
		if (parsed === null || parsed.explicitPattern || parsed.listsFiles) return null;
		return parsed.positionals[0]?.index ?? null;
	}
	if (!GREP_FAMILY.has(command)) return null;
	const valueLetters = SHORT_VALUE_LETTERS.get(command) ?? "";
	let optionsEnded = false;
	for (const [index, arg] of args.entries()) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (optionsEnded || !arg.startsWith("-") || arg === "-") return arg === "-" ? null : index;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq === -1 ? GREP_VALUELESS_LONG.has(arg) : GREP_ATTACHED_LONG.has(arg.slice(0, eq))) continue;
			return null;
		}
		if (!/^-[A-Za-z]+$/u.test(arg) || [...arg.slice(1)].some((letter) => valueLetters.includes(letter))) return null;
	}
	return null;
}

/**
 * grep walks directories with `-r`, `-R`, `--recursive` and `-d recurse`
 * (`--directories=recurse`, also inside a short cluster like `-rn` or `-drecurse`).
 * The walk reaches zero-access files that naming them directly would not.
 */
function recursesDirectories(args: ReadonlyArray<string>): boolean {
	for (const [index, arg] of args.entries()) {
		if (arg === "--") break;
		if (abbreviatesLongOption(arg, "--recursive") || abbreviatesLongOption(arg, "--dereference-recursive")) return true;
		if (abbreviatesLongOption(arg, "--directories")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[index + 1] ?? "");
			if (value.startsWith("rec")) return true;
			continue;
		}
		if (/^-[^-]/u.test(arg)) {
			const cluster = arg.slice(1);
			if (/[rR]/u.test(cluster)) return true;
			const dAt = cluster.indexOf("d");
			if (dAt !== -1) {
				const attached = cluster.slice(dAt + 1);
				if ((attached.length > 0 ? attached : (args[index + 1] ?? "")).startsWith("rec")) return true;
			}
		}
	}
	return false;
}

/**
 * A recursive grep walks exactly as rg does, so it is held to the same proof
 * rg got in 63d15ea8e: every operand is an existing regular file or a
 * directory {@link directoryHoldsNoProtectedFile} proves cannot reach a
 * zero-access file. GNU grep -r follows no symlink below the command line,
 * which matches that walk; -R follows them all, so it is never recognized.
 * The pattern must sit where {@link searchPatternIndex} places it with
 * certainty, and with no operand grep -r searches the working directory.
 * Words after the pattern that start with `-` are options, since GNU grep
 * permutes its arguments; an option value spelled as a separate word reads as
 * an operand here, fails the walk check, and costs only an ask.
 */
function grepWalkStaysReadable(
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	readScope: ReadScopeInputs,
): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (abbreviatesLongOption(arg, "--dereference-recursive")) return false;
		if (/^-[^-]/u.test(arg) && arg.slice(1).includes("R")) return false;
	}
	const patternAt = searchPatternIndex(command, args);
	if (patternAt === null) return false;
	const operands: string[] = [];
	let optionsEnded = args.slice(0, patternAt).includes("--");
	for (const arg of args.slice(patternAt + 1)) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && arg.startsWith("-")) {
			if (arg === "-") return false;
			continue;
		}
		operands.push(arg);
	}
	return (operands.length === 0 ? ["."] : operands).every((operand) => {
		try {
			const target = path.resolve(cwd, operand);
			const stats = statSync(target);
			return stats.isFile() || (stats.isDirectory() && directoryHoldsNoProtectedFile(target, readScope));
		} catch {
			// A path that cannot be stat'ed is not an existing file or directory.
			return false;
		}
	});
}

/**
 * The words bash passes for one shell word whose only expansion is `*` or `?`,
 * or null when the expansion cannot be bounded. The matcher is deliberately
 * wider than bash's defaults: `*` and `?` also match a leading dot and ignore
 * case, so an inherited `dotglob`, `GLOBIGNORE` or `nocaseglob` can only
 * narrow what bash passes, and every candidate here is held to the operand
 * checks. A glob component that starts with a literal dot is refused because
 * `.*` matches `..` in older bash. `**` (globstar), brackets, braces, tilde,
 * extglob, quoting escapes and variables are refused rather than modeled.
 * Directory listings draw on the evaluation's shared walk budget.
 */
function expandOperandGlob(raw: string, cwd: string, readScope: ReadScopeInputs): string[] | null {
	const chars: Array<{ char: string; glob: boolean }> = [];
	let quote: "'" | '"' | null = null;
	for (const char of raw) {
		if (quote !== null) {
			if (char === quote) quote = null;
			else if (quote === '"' && "$`\\".includes(char)) return null;
			else chars.push({ char, glob: false });
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if ("\\$`~{}[]()!@+".includes(char)) return null;
		chars.push({ char, glob: char === "*" || char === "?" });
	}
	if (quote !== null) return null;
	const components: Array<Array<{ char: string; glob: boolean }>> = [[]];
	for (const entry of chars) {
		if (entry.char === "/" && !entry.glob) components.push([]);
		else components.at(-1)?.push(entry);
	}
	const absolute = components[0]?.length === 0 && components.length > 1;
	if (absolute) components.shift();
	// An empty component (`a//b`, a trailing `/`) changes what bash matches; refuse it.
	if (components.some((component) => component.length === 0)) return null;
	let candidates: string[] = [absolute ? "/" : ""];
	for (const [index, component] of components.entries()) {
		const text = component.map((entry) => entry.char).join("");
		const join = (base: string, name: string): string =>
			base === "" ? name : base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
		if (!component.some((entry) => entry.glob)) {
			candidates = candidates.map((base) => join(base, text));
			continue;
		}
		if (component[0]?.char === ".") return null;
		if (component.some((entry, at) => entry.char === "*" && entry.glob && component[at + 1]?.char === "*")) return null;
		const pattern = new RegExp(
			`^${component
				.map((entry) =>
					entry.glob ? (entry.char === "*" ? "[^/]*" : "[^/]") : entry.char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
				)
				.join("")}$`,
			"iu",
		);
		const last = index === components.length - 1;
		const next: string[] = [];
		for (const base of candidates) {
			let entries: Dirent[];
			try {
				entries = readdirSync(path.resolve(cwd, base === "" ? "." : base), { withFileTypes: true });
			} catch {
				// bash matches nothing in a directory it cannot list.
				continue;
			}
			for (const entry of entries) {
				readScope.walkBudget.remaining -= 1;
				if (readScope.walkBudget.remaining < 0) return null;
				if (!pattern.test(entry.name)) continue;
				const candidate = join(base, entry.name);
				if (!last && !entry.isDirectory()) {
					if (!entry.isSymbolicLink()) continue;
					try {
						if (!statSync(path.resolve(cwd, candidate)).isDirectory()) continue;
					} catch {
						// A dangling link is no directory for bash to descend into.
						continue;
					}
				}
				next.push(candidate);
			}
		}
		candidates = next;
	}
	// A literal component after a glob matches only when the path exists.
	return candidates.filter(
		(candidate) => lstatSync(path.resolve(cwd, candidate), { throwIfNoEntry: false }) !== undefined,
	);
}

function refusedOption(arg: string, refused: ReadonlyArray<string>, valueLetters = ""): boolean {
	// The flags of a short cluster end at its first value-taking letter; what
	// follows is that option's value, not more flags.
	let flags = /^-[^-]/u.test(arg) ? arg.slice(1) : "";
	for (let at = 0; at < flags.length; at += 1) {
		if (valueLetters.includes(flags[at] ?? "")) {
			flags = flags.slice(0, at + 1);
			break;
		}
	}
	return refused.some((option) => {
		// GNU tools take any unambiguous prefix of a long option: `wc --files0=x`
		// reads a list file, `tail --fo` follows forever. find's single-dash words do not abbreviate.
		if (abbreviatesLongOption(arg, option)) return true;
		if (arg === option || arg.startsWith(`${option}=`)) return true;
		// A short option can sit anywhere in a cluster (`ls -lR`); a false
		// match only costs an ask.
		return /^-[A-Za-z]$/u.test(option) && flags.includes(option.slice(1));
	});
}

/**
 * The rule id for a read-only inspection segment, or null. Every operand is
 * held to the workspace the way `read` holds its path (readScopeEscape), so
 * `cat ../x` or `grep -r key ~/` asks exactly where `read` would. The search
 * pattern of `rg` and grep is not an operand when {@link searchPatternIndex}
 * places it with certainty; in any form it cannot place, the pattern is
 * checked as if it were a path, and one that looks like an outside path only
 * costs an ask. Zero-access paths were already refused for the whole command
 * string before recognition.
 */
function readOnlyInspectionRule(
	words: ReadonlyArray<ShellToken>,
	source: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
	/** The join in front of this segment is `|`, so its stdin is the previous command's output. */
	piped = false,
): string | null {
	const [commandWord, ...argWords] = words;
	const command = commandWord?.value;
	if (commandWord === undefined || command === undefined) return null;
	const refuse = (note: string): null => {
		readScope.notes.push(`${quotedStep(words.map((word) => word.value).join(" "))}: ${note}`);
		return null;
	};
	// The operand check below sees the literal word; the shell sees what the
	// word expands to. A `*` or `?` glob is expanded here the way bash would
	// expand it, and the checks then judge every match. Any other expansion
	// hides the real path, so a word carrying one is never recognized.
	if (hasUnquotedExpansion(source.slice(commandWord.start, commandWord.end))) return null;
	const args: string[] = [];
	for (const word of argWords) {
		const raw = source.slice(word.start, word.end);
		if (!hasUnquotedExpansion(raw)) {
			args.push(word.value);
			continue;
		}
		const matches = expandOperandGlob(raw, cwd, readScope);
		if (matches === null)
			return refuse(`glob \`${raw}\` is not checked (only * and ?, not after a leading dot); name the files`);
		// bash passes an unmatched glob through as written. Under an inherited
		// nullglob the word disappears instead, which only narrows a read: the
		// walk proofs of rg and grep -r require every operand to exist, so the
		// literal word already fails them, and every other inspector given no
		// operand reads stdin or lists names in the working directory.
		if (matches.length === 0) {
			args.push(word.value);
			continue;
		}
		if (matches.some((match) => !readScope.readable(path.resolve(cwd, match))))
			return refuse(`\`${raw}\` matches a zero-access file`);
		// Glob matches can become options or search patterns and skip the operand loop.
		// Prove containment before that classification, including names after `--`.
		if (matches.some((match) => !operandStaysInWorkspace(match, cwd, workspaceRoot, readScope)))
			return refuse(`\`${raw}\` matches a path outside the workspace`);
		args.push(...matches);
	}
	if (command === "rg" && rgConfigRefusal() !== null) return null;
	if (command === "sed") {
		if (!args.includes("-n")) return null;
		let sawScript = false;
		for (const arg of args) {
			if (arg === "-n") continue;
			if (!sawScript) {
				if (!SED_PRINT_SCRIPT.test(arg)) return null;
				sawScript = true;
				continue;
			}
			if (arg.startsWith("-") || !operandStaysInWorkspace(arg, cwd, workspaceRoot, readScope) || spacedPathOperand(arg))
				return null;
		}
		return sawScript ? "builtin:read-only:sed" : null;
	}
	const refused = READ_ONLY_INSPECTORS.get(command);
	if (refused === undefined) return null;
	const patternAt = searchPatternIndex(command, args);
	for (const [index, arg] of args.entries()) {
		if (index === patternAt) continue;
		if (arg === "-" || arg === "--") continue;
		if (arg.startsWith("-")) {
			if (refusedOption(arg, refused, SHORT_VALUE_LETTERS.get(command) ?? "")) return null;
			// An option that embeds a path (--file=/x, -f/x) is refused rather than parsed per command.
			if (arg.includes("/") || arg.includes("~")) return null;
			continue;
		}
		if (!operandStaysInWorkspace(arg, cwd, workspaceRoot, readScope) || spacedPathOperand(arg)) return null;
	}
	// Last, so no directory is walked for an operand the workspace hold refuses.
	if (command === "rg" && !rgSearchStaysReadable(args, cwd, piped, readScope))
		return refuse("rg reaches a zero-access file or too many entries");
	if (GREP_FAMILY.has(command) && recursesDirectories(args) && !grepWalkStaysReadable(command, args, cwd, readScope))
		return refuse(
			"recursive grep reaches a zero-access file or too many entries, or uses -R; name the files or use the grep tool",
		);
	return `builtin:read-only:${command}`;
}

/**
 * An operand with whitespace that also reads as a path (`a b/../.env`). The
 * word-level scans treated whitespace as prose and never tested it, so it is
 * not recognized even when the whole-token zero-access test passes. Prose with
 * no path character (`grep "two words" f`) is not one.
 */
function spacedPathOperand(arg: string): boolean {
	return /\s/u.test(arg) && /[/\\$`~]/u.test(arg);
}

function operandStaysInWorkspace(arg: string, cwd: string, workspaceRoot: string, readScope: ReadScopeInputs): boolean {
	return readScopeEscape(arg, cwd, workspaceRoot, readScope.exemptRoots, readScope.memo) === null;
}

/**
 * Recognition for compound commands built from recognized parts: `cd <workspace
 * dir> && <recognized command>`, test runners and project scripts, and
 * read-only inspection joined by `&&`, `||`, `;` or `|` (`ls -la && cat
 * package.json`, `npm test 2>&1 | tail -30`, `find src -name '*.ts' | head`).
 * Every member is checked on its own and the chain takes its most restrictive
 * member's verdict, so the chain can never admit something its members would
 * not. Redirection is admitted only to /dev/null or between descriptors.
 *
 * This exists because the compound form is what a model reaches for first and
 * the flat rule cost more than it bought: in a recorded live drive 34 of 75
 * calls were blocked, nearly all of them `cd x && y`, since an unrecognized
 * execute asks in default mode and a headless run answers every ask with a
 * denial (REPORT-dispatch-drive-1.md S2). The v0.6.0 flywheel showed the same
 * tax on read-only openers (`ls src/ && cat package.json`, `find . -name
 * "*.test.js" | head -5`) parked behind approval cards during a plan-only turn.
 * Meanwhile `sh -c '<anything>'` sailed past the same rail, so the rail was
 * mostly taxing the honest spelling. The `sh -c` half is closed at both ends
 * now: this function recognizes such a command by its inner script, and the
 * shared write-target scanner reads inside the script too.
 */
function recognizeCommandChain(
	command: string,
	callCwd: string,
	workspaceRoot: string,
	policy: LoadedProjectSafetyPolicy,
	readScope: ReadScopeInputs,
): ChainRecognition | null {
	const tokens = scanShellLike(command);
	const segments: ShellToken[][] = [];
	// joins[i] is the operator in front of segments[i].
	const joins: Array<string | undefined> = [undefined];
	let current: ShellToken[] = [];
	// Only && makes a later step conditional on a cd having taken effect.
	let onlyAnd = true;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (!token.operator) {
			current.push(token);
			continue;
		}
		if (CHAIN_OPERATORS.has(token.value)) {
			segments.push(current);
			joins.push(token.value);
			current = [];
			if (token.value !== "&&") onlyAnd = false;
			continue;
		}
		const target = tokens[index + 1];
		if (target === undefined || target.operator || !isDiscardRedirection(token.value, target.value)) {
			readScope.notes.push(
				`redirection \`${token.value}${target === undefined ? "" : ` ${target.value}`}\` is recognized only to /dev/null or between descriptors`,
			);
			return null;
		}
		// An adjacent unquoted number is the redirection's descriptor, not an argument.
		const previous = current.at(-1);
		if (previous !== undefined && previous.end === token.start && !previous.quoted && /^\d+$/u.test(previous.value))
			current.pop();
		index += 1;
	}
	segments.push(current);
	if (segments.length > CHAIN_MAX_SEGMENTS) {
		readScope.notes.push(
			`the command has ${segments.length} steps and at most ${CHAIN_MAX_SEGMENTS} are recognized in one call; split it or pass several files to one cat`,
		);
		return null;
	}
	// A lone command keeps its standalone rules; this path adds only what the
	// compound or a discard redirection needs, plus read-only inspection.
	if (segments.length < 2 && tokens.every((token) => !token.operator)) {
		const [only] = segments;
		const rule = only === undefined ? null : readOnlyInspectionRule(only, command, callCwd, workspaceRoot, readScope);
		return rule === null
			? null
			: {
					ruleIds: [rule],
					requiresConfirmation: false,
					requiresAutonomyApproval: false,
					runsTestRunner: false,
					scriptPreviews: [],
				};
	}
	const ruleIds: string[] = [];
	let requiresConfirmation = false;
	let requiresAutonomyApproval = false;
	let runsTestRunner = false;
	let chainCwd = callCwd;
	// Every directory a later step may run in. In a pure && chain a failed cd
	// stops the chain, so there is exactly one. After `||` or `;` a cd may not
	// have taken effect, so each step is judged from every directory it could
	// run in.
	let cwds = [callCwd];
	const scriptPreviews: string[] = [];
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) return null;
		if (segment[0]?.value === "cd") {
			// A cd inside a pipeline runs in a subshell and moves nothing.
			if (joins[index] === "|" || joins[index + 1] === "|") return null;
			// Each later command runs in this directory, including project-policy
			// cwd matching and script previews. Keep both logical and physical
			// readings inside the workspace before recognizing the transition.
			if (segment.length !== 2) return null;
			const target = segment[1]?.value ?? "";
			if (target.startsWith("~")) return null;
			// `cd li?` resolves lexically here but the shell expands the glob, which can
			// land in a symlink target outside the workspace.
			const targetWord = segment[1];
			if (targetWord !== undefined && hasUnquotedExpansion(command.slice(targetWord.start, targetWord.end))) return null;
			const reached: string[] = [];
			for (const from of cwds) {
				const nextCwd = path.resolve(from, target);
				if (!isUnderOrSame(nextCwd, workspaceRoot)) return null;
				// A shell `cd` is logical unless `-P` or `set -P` makes it physical;
				// recognize it only when both readings stay inside.
				const physical = canonicalizeRawPath(target, from);
				if (physical === null || !isUnderOrSame(physical, workspaceRoot)) return null;
				reached.push(nextCwd);
			}
			chainCwd = reached.at(-1) ?? chainCwd;
			cwds = onlyAnd ? reached : [...new Set([...cwds, ...reached])];
			ruleIds.push("builtin:cd-workspace");
			continue;
		}
		// Re-rendered from tokens, so quoting is gone: a member that needed its
		// quotes fails the allowlist regex and the whole chain stays unrecognized.
		const rendered = segment.map((word) => word.value).join(" ");
		const projectScript = PROJECT_SCRIPT_COMMANDS.find((entry) => entry.re.test(rendered));
		if (projectScript !== undefined) scriptPreviews.push(projectScriptPreview(rendered, chainCwd));
		const projectMatches = cwds.map((from) => matchingProjectCommand(policy, rendered, from));
		const projectMatch = projectMatches.every((match) => match !== null) ? projectMatches[0] : null;
		if (projectMatch) {
			ruleIds.push(projectMatch.id);
			if (projectMatch.requireConfirmation) requiresConfirmation = true;
			continue;
		}
		const testRunner = TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(rendered));
		if (testRunner !== undefined) {
			ruleIds.push(testRunner.id);
			runsTestRunner = true;
			continue;
		}
		if (projectScript !== undefined) {
			ruleIds.push(projectScript.id);
			requiresAutonomyApproval = true;
			continue;
		}
		const builtin = BUILTIN_ALLOWLIST.find((entry) => entry.re.test(rendered));
		if (builtin !== undefined) {
			ruleIds.push(builtin.id);
			continue;
		}
		if (
			!hasSequencingOperators(rendered) &&
			cwds.every((from) => isGitInspection(segment, command, from, workspaceRoot, readScope))
		) {
			ruleIds.push(GIT_INSPECT_RULE_ID);
			continue;
		}
		// Quoted words stay whole here (`find . -name "*.ts"`), which the
		// re-rendered allowlist string above cannot express.
		const inspections = cwds.map((from) =>
			readOnlyInspectionRule(segment, command, from, workspaceRoot, readScope, joins[index] === "|"),
		);
		const inspection = inspections.every((rule) => rule !== null) ? inspections[0] : null;
		if (inspection !== null && inspection !== undefined) {
			ruleIds.push(inspection);
			continue;
		}
		if (readScope.notes.length === 0) readScope.notes.push(`${quotedStep(rendered)} is not a recognized read-only step`);
		return null;
	}
	return { ruleIds, requiresConfirmation, requiresAutonomyApproval, runsTestRunner, scriptPreviews };
}

const GIT_INSPECT_RULE_ID = "builtin:git-inspect";

/**
 * A plain `git` command the shared Git policy classifies as inspection only.
 * The fixed regexes above recognize `git log --oneline -n 3` but asked for
 * `git log --oneline -3`, and a headless run denied it. The policy already
 * refuses global options, helpers and output files (`-c`, `--ext-diff`,
 * `--output`), so it decides instead of one regex per spelling. An env or
 * path prefix is not plain `git` and stays unrecognized. Leading `-C <dir>`
 * options are the one global option accepted: see {@link gitChdirTarget}.
 */
function isGitInspection(
	words: ReadonlyArray<ShellToken>,
	source: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
): boolean {
	if (words[0]?.value !== "git") return false;
	// Every word is judged as written. One the shell expands or substitutes
	// names files the checks below cannot see.
	if (words.some((word) => (word.substitutions?.length ?? 0) > 0)) return false;
	if (words.some((word) => hasUnquotedExpansion(source.slice(word.start, word.end), true))) return false;
	// `git -C <dir> ...` runs as plain git from <dir>. The directories are held
	// to the workspace like a read path and the rest is judged from the last one.
	const split = splitGitChdir(words.slice(1).map((word) => word.value));
	if (split === null) return false;
	let gitCwd = cwd;
	for (const dir of split.dirs) {
		const next = gitChdirTarget(dir, gitCwd, workspaceRoot);
		if (next === null) return false;
		gitCwd = next;
	}
	const values = ["git", ...split.rest];
	const verdict = classifyBashGit(values.join(" "));
	if (verdict === null || verdict.class !== "inspect" || verdict.subcommand === null) return false;
	if (GIT_UNRECOGNIZED_SUBCOMMANDS.has(verdict.subcommand)) return false;
	// Whitespace checks keep their own standalone-only recognition above.
	if (verdict.argv.includes("--check")) return false;
	// Non-option words are revisions, pathspecs and option values. They are held
	// to the workspace as readOnlyInspectionRule holds an operand, so an option
	// value that names a file (`--contents /etc/hosts`, `-S /proc/self/environ`)
	// or a pathspec outside the tree is not recognized.
	const operands = values.slice(values.indexOf(verdict.subcommand) + 1);
	for (const value of operands) {
		if (value === "--" || value === "-") continue;
		if (value.startsWith("-")) {
			const attached = value.includes("=") ? value.slice(value.indexOf("=") + 1) : "";
			if (attached.startsWith("/") || attached.startsWith("~") || attached.split("/").includes("..")) return false;
			continue;
		}
		if (!operandStaysInWorkspace(value, gitCwd, workspaceRoot, readScope)) return false;
	}
	return true;
}

/**
 * The physical directory a `git -C <dir>` word lands in, or null when it is not
 * provably inside the workspace. Exempt read roots do not count: they exist so
 * a dependency file can be read, and a repository there carries a `.git/config`
 * (`core.fsmonitor`, `core.pager`) the operator never vetted, which Git runs
 * even for inspection. The word is a literal:
 * a variable, backslash, glob, brace, whitespace or tilde may name something
 * else at run time, so any of them asks. A directory that does not exist is
 * Git's own error. The zero-access scan already covered the whole command
 * string, so a protected path named here is blocked before this runs.
 */
function gitChdirTarget(dir: string, from: string, workspaceRoot: string): string | null {
	if (/[*?[\]{}$`\\\s]/u.test(dir) || dir.startsWith("~")) return null;
	const physical = canonicalizeRawPath(dir, from);
	return physical !== null && isUnderOrSame(physical, workspaceRoot) ? physical : null;
}

/**
 * Read-only for Git, but not for the no-prompt rail. `grep` and `blame` print
 * file contents across the whole tree or read files their options name, and
 * `cat-file` dumps any object. The shared Git policy still classes them as
 * inspection, so workers and the typed Git allowance are unchanged; only bash
 * recognition leaves them to the autonomy level.
 */
const GIT_UNRECOGNIZED_SUBCOMMANDS: ReadonlySet<string> = new Set(["grep", "blame", "annotate", "cat-file"]);

/**
 * Sequencing and redirection operators. These defeat per-command allowlist
 * matching but hide nothing from the rule pack, which scans the full string.
 */
function hasSequencingOperators(command: string): boolean {
	return /(\|\||&&|;|\||>>?|<|\n|\r)/.test(command);
}

/**
 * Content-hiding constructs: `$(...)`, backticks and process substitution
 * (`<(...)`, `>(...)`) execute text the net cannot see until runtime. Kept separate from sequencing (sd-01 M5) so they
 * can ask in default while yolo passes the ordinary confirmation.
 */
function hasCommandSubstitution(command: string): boolean {
	// `<(...)` and `>(...)` run their script exactly as `$(...)` does.
	return /(`|\$\(|[<>]\()/.test(command);
}

/** Any shell operator at all; project policy entries with `shellOperators: deny` reject both kinds. */
function hasShellOperators(command: string): boolean {
	return hasSequencingOperators(command) || hasCommandSubstitution(command);
}

/** A path that cannot be canonicalized is under nothing. */
function isUnderOrSame(child: string, parent: string): boolean {
	const canonicalParent = canonicalizePath(path.resolve(parent));
	const canonicalChild = canonicalizePath(path.resolve(child));
	if (canonicalParent === null || canonicalChild === null) return false;
	const rel = path.relative(canonicalParent, canonicalChild);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function commandArg(args: Record<string, unknown> | undefined): string | null {
	return typeof args?.command === "string" ? args.command : null;
}

/** The directory a bash call names for itself; relative deletes resolve from it. */
function bashCwdArg(args: Record<string, unknown> | undefined): string | undefined {
	return typeof args?.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
}

const DELETE_TARGET_RULE_ID = "delete-outside-workspace";
const DELETE_TARGET_RULE_DESCRIPTION =
	"deletes a path outside the workspace, the workspace root or its .git, or a path named only at run time, through rm, rmdir, unlink or find however quoted or wrapped";

function pathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Typed tools whose writes the operator's default admits inside a scratch root. */
const SCRATCH_WRITE_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit]);

/**
 * Directories below a scratch root that a typed write still asks for, as the
 * main-session sandbox keeps them read-only: a repository's hooks and config
 * run later outside any sandbox, and `.clio-coder` holds project authority.
 */
const SCRATCH_WRITE_PROTECTED_DIRS: ReadonlySet<string> = new Set([".git", ".clio-coder"]);

/**
 * The operator's default admits a typed write or edit that lands strictly
 * inside a scratch root the way it admits one inside the workspace, as the
 * contained shell already may: the classifier's outside-the-workspace
 * system_modify becomes a write, so neither system-modify-confirm nor
 * outside-file-replacement asks and no safety judge call is spent. The target
 * is walked as the tool walks it (resolveMutationTarget), so a link inside a
 * scratch root is judged by where it lands. Every rail that judges the target
 * itself (the floor, path policy, authority rails, write roots) still runs.
 */
function scratchRootWrite(
	classification: Classification,
	call: ClassifierCall,
	scratchRoots: ReadonlyArray<string> | undefined,
): Classification {
	if (scratchRoots === undefined || scratchRoots.length === 0) return classification;
	if (classification.actionClass !== "system_modify" || !SCRATCH_WRITE_TOOLS.has(call.tool)) return classification;
	// Only the classifier's placement of the target is relaxed, never another reason.
	if (!classification.reasons.every((reason) => reason.startsWith("write-path-"))) return classification;
	const target = pathArg(call.args);
	const landing = target === null ? null : canonicalizeRawPath(expandPath(target), process.cwd());
	if (landing === null) return classification;
	// Scratch roots and the landing are both canonical, so a lexical comparison is exact.
	const inside = scratchRoots
		.map((root) => path.relative(root, landing))
		.filter((rel) => rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
	if (inside.length === 0) return classification;
	if (inside.some((rel) => rel.split(path.sep).some((part) => SCRATCH_WRITE_PROTECTED_DIRS.has(part)))) {
		return classification;
	}
	return { actionClass: "write", reasons: [`scratch-root-write: ${landing}`] };
}

const GIT_CONTROL_FILE_RULE_ID = "git-control-file";

/**
 * The workspace repository's git control path a typed file mutation lands
 * on, or null: a hooks directory, a config or commondir file, or a `.git`
 * pointer file, the set the main-session sandbox keeps read-only. Read per
 * call, so a repository created mid-session is covered. The target as named
 * and where it lands are both compared with each control path as listed and
 * as resolved, so a link on either side cannot hide a hook.
 */
function gitControlTarget(call: ClassifierCall, workspace: string): string | null {
	const target = writeRootTargetPath(call);
	if (target === null) return null;
	const controls = mainSandboxGitControlPaths(workspace);
	if (controls.length === 0) return null;
	const expanded = expandPath(target);
	const lexical = path.resolve(process.cwd(), expanded);
	const physical = canonicalizeRawPath(expanded, process.cwd());
	const landings = physical === null || physical === lexical ? [lexical] : [lexical, physical];
	for (const control of controls) {
		const real = canonicalizePath(control);
		const forms = real === null || real === control ? [control] : [control, real];
		if (landings.some((landing) => forms.some((form) => isSameOrDescendant(landing, form)))) return control;
	}
	return null;
}

/**
 * Write and edit can replace an existing file outside the checkout. The
 * classifier has already resolved where the write lands and files every target
 * outside the workspace under a `write-path-*` reason, so a call it left
 * unmarked is inside and pays no second canonicalization: the admission
 * filesystem-call counts are pinned per call (admission-fs-ops).
 */
function outsideExistingTypedMutationTarget(
	call: ClassifierCall,
	workspaceRoot: string,
	classification: Classification,
	posture: string | undefined,
): string | null {
	if (call.tool !== ToolNames.Write && call.tool !== ToolNames.Edit) return null;
	if (!classification.reasons.some((reason) => reason.startsWith("write-path-"))) return null;
	const target = pathArg(call.args);
	if (target === null) return null;
	const resolved = canonicalizeRawPath(target, process.cwd());
	if (resolved === null || isUnderOrSame(resolved, workspaceRoot)) return null;
	try {
		const info = statSync(resolved);
		if (!info.isFile()) return null;
		// YOLO revises the session's own outside draft without asking, but only
		// while nothing else has written it since the session's last write.
		if (posture === "yolo" && isSessionAuthoredFile(resolved, info)) return null;
		return resolved;
	} catch {
		return null;
	}
}

function cwdArg(args: Record<string, unknown> | undefined, fallback: string): string {
	const resolved = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(fallback, args.cwd) : fallback;
	return canonicalizeExistingPath(resolved);
}

/**
 * Tools whose arguments carry file contents or task prose, not command lines.
 * Their damage-control scan is the destination path alone, when present.
 */
const CONTENT_BEARING_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Write,
	ToolNames.Edit,
	ToolNames.Artifact,
	ToolNames.Dispatch,
	ToolNames.Tasks,
]);

/**
 * The text damage-control rules are matched against.
 *
 * Every rule in the pack is a command pattern: shell (`rm -rf /`, `chmod -R
 * 777`), cloud CLI (`aws s3 rm --recursive`), or SQL (`DROP TABLE`). Matching
 * them against a file's contents asks whether the file *mentions* a dangerous
 * command, which is a different question from whether the call *runs* one, and
 * the two are indistinguishable once the text is in the haystack.
 *
 * That cost a real feature. `clio-coder context wiki` could not write its own
 * `domains/safety.md`: the page documents what the classifier blocks, so it
 * quotes `rm -rf /`, and the write was refused as `system_modify` with reason
 * `damage-control:rm-rf-root`. The same defect blocks writing a SQL migration
 * containing `DROP TABLE` or a test fixture for the classifier itself.
 *
 * Writing a file is not executing it. A script written with a destructive body
 * still has to be run, and that run is an execute-class call scanned here in
 * full. Only the destination path is scanned for a mutation tool, which keeps
 * any path-shaped rule working; where the file may land is the write tool's own
 * gate in `writePathClass`.
 * Dispatch and task-board prose likewise does not execute; worker commands
 * are scanned when the worker calls an execute-class tool.
 */
function decodedAnsiCCommand(command: string): string | null {
	let decoded = "";
	let copied = 0;
	for (const token of scanShellLike(command)) {
		if (!token.ansiCQuoted || token.hiddenContent) continue;
		const literal = /^[\w./~+-]+$/u.test(token.value) ? token.value : `'${token.value.replaceAll("'", "'\\''")}'`;
		decoded += command.slice(copied, token.start) + literal;
		copied = token.end;
	}
	if (copied === 0) return null;
	// Preserve quoted operators as literal words while giving path rules their decoded operands.
	return decoded + command.slice(copied);
}

/**
 * Strings a damage-control rule is tested against. Joining every argument into
 * one blob put the command in the middle of it, so a rule anchored with `$`
 * stopped matching the moment the model also supplied `cwd` or `timeout_ms`:
 * `git restore .` ran at both levels and the authored `git checkout -- .`
 * confirm rail fell through to the classifier's unconditional git_destructive
 * block. The command is offered on its own as well. The blob stays a
 * candidate so no rule that matched before stops matching now.
 */

function damageControlScans(call: ClassifierCall, classification: Classification): string[] {
	if (CONTENT_BEARING_TOOLS.has(call.tool)) {
		const pathArg = call.args?.path;
		return typeof pathArg === "string" ? [pathArg] : [];
	}
	// Read payloads describe data, not executable commands.
	// Gateway capabilities and trusted argv projections receive their own admission.
	if (classification.actionClass === "read") return [];
	// `bash` is the only tool with a `command` argument, and its others (`cwd`,
	// `timeout_ms`, `output_policy`) are not commands. Scanning the blob as well
	// would let a bare `cwd: "."` complete a pathspec the command did not write,
	// so a call that carries a command is scanned as a command. `cwd` keeps its
	// own path policy.
	const command = call.args?.command;
	if (typeof command === "string") {
		const decoded = decodedAnsiCCommand(command);
		return [
			command,
			...(decoded === null ? [] : [decoded]),
			...shellCommandSegments(command),
			...normalizedGitCommands(command),
		];
	}
	return [serializeArgs(call.args)];
}

/**
 * Source text of each command a shell string would actually execute, including
 * the ones inside a `$(...)` substitution or an `sh -c` script.
 *
 * A damage-control pattern anchored with `$` matches only at the end of the
 * string it is tested against, so `git restore . && echo RESTORED` hid its
 * destructive segment and ran at yolo with no card, discarding a dirty tracked
 * file. Every operator opened the same hole, and the audit blamed
 * `bash-shell-operators` because no rule had matched.
 *
 * Segments are sliced out of the original text rather than rebuilt from tokens,
 * so quoting survives and a rule cannot fire on a word that merely spells a
 * command inside a quoted argument.
 */
function shellCommandSegments(command: string, depth = 0): string[] {
	const segments: string[] = [];
	let start: number | null = null;
	let end = 0;
	const flush = (): void => {
		if (start === null) return;
		const segment = command.slice(start, end).trim();
		if (segment !== "" && segment !== command) segments.push(segment);
		const decoded = decodedAnsiCCommand(segment);
		if (decoded !== null) segments.push(decoded);
		start = null;
	};
	for (const token of scanShellLike(command)) {
		if (token.operator) {
			flush();
			continue;
		}
		start ??= token.start;
		end = token.end;
		if (depth >= SEGMENT_MAX_DEPTH) continue;
		for (const script of token.substitutions ?? []) {
			segments.push(script.trim(), ...shellCommandSegments(script, depth + 1));
		}
	}
	flush();
	if (depth < SEGMENT_MAX_DEPTH) {
		for (const segment of [...segments]) {
			const inner = inlineShellScript(segment);
			if (inner === null || inner.trim() === "") continue;
			segments.push(inner.trim(), ...shellCommandSegments(inner, depth + 1));
		}
		const inner = inlineShellScript(command);
		if (inner !== null && inner.trim() !== "") {
			segments.push(inner.trim(), ...shellCommandSegments(inner, depth + 1));
		}
	}
	return segments.filter((segment) => segment !== "");
}

/** Matches the inner-shell depth the trust and write-target scanners already use. */
const SEGMENT_MAX_DEPTH = 3;

function serializeArgs(args?: Record<string, unknown>): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const v of Object.values(args)) {
		if (v == null) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(String(v));
		else {
			try {
				parts.push(JSON.stringify(v));
			} catch {
				// ignore values that cannot be serialized
			}
		}
	}
	return parts.join(" ");
}

function rulePackHash(packs: RulePacks): string {
	const payload: Record<PackId, Array<Record<string, unknown>>> = {
		base: packPayload(packs.base.rules),
	};
	return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function packPayload(rules: ReadonlyArray<DamageControlRule>): Array<Record<string, unknown>> {
	return rules.map((rule) => ({
		id: rule.id,
		description: rule.description,
		pattern: rule.pattern.source,
		class: rule.class,
		block: rule.block,
		...(rule.ask !== undefined ? { ask: rule.ask } : {}),
	}));
}

function invokesTrustMutation(command: string): boolean {
	// Wrappers, package launchers, quoted argv and source-tree CLI invocations
	// must not turn an operator-only grant into model authority.
	const words = scanShellLikeDeep(command)
		.filter((token) => !token.operator)
		.map((token) => token.value);
	return (
		words.some((word, index) => word === "config" && words[index + 1] === "trust") ||
		/\bconfig\s+trust\b/.test(inlineShellScript(command) ?? "")
	);
}

function projectScriptPreview(command: string, cwd: string): string {
	const match = /^npm\s+(?:run\s+)?([\w:-]+)/.exec(command);
	if (match) {
		try {
			const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as {
				scripts?: Record<string, unknown>;
			};
			const name = match[1] ?? "test";
			const scripts = [`pre${name}`, name, `post${name}`].flatMap((key) =>
				typeof manifest.scripts?.[key] === "string" ? [`${key}: ${manifest.scripts[key]}`] : [],
			);
			return `package.json scripts (repository data): ${scripts.join("; ") || "no script resolved"}`;
		} catch {
			return "package.json script body could not be resolved; repository code will execute.";
		}
	}
	return `Repository command: ${command}. Its test/build files and dependencies execute with the child process permissions.`;
}
