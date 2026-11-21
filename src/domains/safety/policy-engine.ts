import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, type Dirent, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { bashSearchPath, probeToolEnv } from "../../core/bash-exec.js";
import { internalGitArgv } from "../../core/internal-git.js";
import { asDirectoryPathBoundary, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import {
	canonicalizeExistingPath,
	canonicalizePath,
	canonicalizeRawPath,
	createPathWalkMemo,
	type PathWalkMemo,
} from "../../core/path-canonical.js";
import type { GitHookChange } from "../../core/sandbox/git-hooks-fingerprint.js";
import {
	mainSandboxGitControlPaths,
	mainSandboxWritableRoots,
	type YoloScriptSandboxState,
} from "../../core/sandbox/main-session.js";
import { isSkippedSecretScanDirectory, SECRET_SCAN_LIMITS } from "../../core/sandbox/secret-files.js";
import { isSessionAuthoredFile } from "../../core/session-authored-files.js";
import { storeBookkeepingPaths, storeGrantProbes, storeWriteSet } from "../../core/store-paths.js";
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
	resolveScratchDeleteOperands,
	STORE_UNGRANTED_ARG,
} from "./action-classifier.js";
import { downloadedFiles, findDeletesNotFollowing, removedAbsolutePaths, unpackedTargets } from "./command-readings.js";
import {
	cleansIgnoredFiles,
	GIT_CONTROL_FILE_RULE_ID,
	gitControlFileReason,
	type OutwardPlaces,
	outwardLineLeaves,
	outwardShellReason,
	SCRATCH_DISPOSABLE_REASON_CODE,
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
import { commandInvokesGit, describeGitHookChange, type GitHookDriftGuard } from "./hook-drift.js";
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
	bareInlineShellScript,
	commandArgumentSegments,
	declaredWrapperReadings,
	decodedLocaleQuoting,
	extractCommandCdScopedTargets,
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
	withoutDataHeredocBodies,
} from "./protected-artifacts.js";
import {
	fetchCouldCarryLocalData,
	isOutboundWebTool,
	isSecretBearingPath,
	SECRET_READ_THEN_FETCH_RULE_ID,
} from "./read-fetch-taint.js";
import {
	isReadScopeTool,
	type ReadScopeExemptRoot,
	readScopeEscape,
	readScopeExemptRoots,
	readScopeSpellings,
} from "./read-scope.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { ROUTING_PIN_HINT } from "./routing-settings.js";
import { getCachedBaseRuleset } from "./rule-pack-loader.js";
import { SANDBOX_ESCAPE_REASON, SANDBOX_ESCAPE_RULE_ID } from "./sandbox-escape.js";
import { effectiveScratchRoots } from "./scratch-roots.js";
import {
	advanceScriptShell,
	childScriptShell,
	commandMoveBases,
	forkScriptShell,
	newScriptReader,
	newScriptShell,
	readScriptLine,
	type ScriptLine,
	type ScriptNames,
	type ScriptReader,
	type ScriptShell,
} from "./script-shell.js";
import { clioControlPaths, clioCredentialStorePaths, conditionalSecretPaths } from "./secret-paths.js";
import {
	invokesSettingsMutation,
	SETTINGS_AUTHORITY_REASON,
	SETTINGS_AUTHORITY_RULE_ID,
} from "./settings-authority.js";
import type { MutationCandidate } from "./skill-authority.js";
import {
	activeClioSkillRoots,
	foreignDevRootReason,
	mutationCandidates,
	skillMutationReason,
} from "./skill-authority.js";
import { gateProjectSafetyPolicy, workspaceTrustDirectory } from "./workspace-trust.js";
import {
	MAX_RAW_TEXT_BYTES,
	pinnedClioCommand,
	YOLO_FLOOR_AUTHORITY_REMEDY,
	YOLO_FLOOR_AUTHORITY_RULE_IDS,
	YOLO_FLOOR_PACK_RULE_IDS,
	YOLO_FLOOR_REASON_PREFIX,
	YOLO_FLOOR_RULE_IDS,
	YOLO_FLOOR_TEXT_RULES,
	type YoloFloorHit,
	yoloFloorCommandText,
	yoloFloorDeleteHit,
	yoloFloorExecutableHit,
	yoloFloorRawCandidates,
	yoloFloorScriptRuns,
	yoloFloorShellScript,
	yoloFloorTrustGrant,
	yoloFloorWorkspaceGitHit,
} from "./yolo-floor.js";

export type SafetyPolicySource =
	| "damage-control:base"
	| "mcp-trust"
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
	 * Why a yolo floor rule blocked a call when the call's action class played no part, as with the raw-text
	 * reading. The model's refusal line states it in place of the class (bt-12 #1).
	 */
	floorBasis?: string;
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
	 * `safety.sandbox: required` (#419). `readOnly` marks a call of a read-only
	 * main session, which runs in the read-only sandbox instead and writes
	 * nothing the operator owns.
	 */
	shellSandbox?: { workspace: string; scratchRoots: ReadonlyArray<string>; readOnly?: true };
	/**
	 * Set when the operator's default admits a destructive call because the
	 * workspace snapshot taken right before it can undo it: a worktree discard,
	 * a stash drop, or a delete inside the workspace or a scratch root. The
	 * registry snapshots before the body and refuses the call when that
	 * snapshot cannot be taken.
	 */
	recoverable?: true;
	/**
	 * Set on an allowed typed file mutation outside the operator's own scopes
	 * that lands on a git control path (a hooks directory, the core.hooksPath
	 * directory, a config or commondir file, a `.git` pointer) of this
	 * engine's repository or, by name, of any repository. Admission asks
	 * the main agent for it when a worker at autonomy default makes the call.
	 */
	gitControl?: string;
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
	/**
	 * How a command runs on this host under the operator's yolo; absent reads
	 * as `unsandboxed`. `sandboxed` and `refused` come from `safety.sandbox:
	 * required` and cover every command the default contains plus every script.
	 */
	scriptSandbox?: YoloScriptSandboxState;
	/**
	 * The main session's git hook drift guard. Under a required sandbox an
	 * outward git or gh line leaves it only while no hook file or executable
	 * git config value changed since the operator's baseline: git would run
	 * them outside, with the credentials the line keeps.
	 */
	hookDrift?: Pick<GitHookDriftGuard, "check">;
}

/**
 * The operator's own session at autonomy default: containment first,
 * judgment second, asking last. Only the main session's registry passes it,
 * so workers, grants and scheduled command jobs keep today's rails. Under it
 * the yolo floor blocks first, then the path, authority and ceiling rails
 * still block; a contained bash, run_script or verify call needs no ask for what its
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
	/** True when this session's bash, run_script and verify commands run in the main-session sandbox on this host. */
	sandbox: boolean;
	/** True when a workspace snapshot is taken before a destructive call runs (a git work tree, `safety.snapshots` on). */
	snapshots: boolean;
	/**
	 * A read-only main session at either level: a contained call runs in the
	 * read-only sandbox, which `sandbox` then says is available on this host.
	 */
	readOnly?: true;
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
	/** The contained call runs in the read-only sandbox. */
	readOnly?: true;
	/** The call would run contained but asks to leave the sandbox with `unsandboxed: true`. */
	leavesSandbox?: true;
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
 * Interpreter flags a `python -m pytest|unittest` run may carry (bt-12): short
 * switches that only buffer, warn, isolate or skip bytecode (`-B`, `-u`, `-I`,
 * clustered as `-Bu`), a closed `-X` list, and `-W` with a builtin warning
 * category. `-c`, `-i`, `-X pycache_prefix=` and a dotted `-W` category (which
 * Python imports) stay unrecognized, so no flag runs code beyond the runner.
 */
const PYTHON_RUNNER_FLAGS = String.raw`(?:[ \t]+(?:-[BbEIOPqsu]+|-X[ \t]*(?:dev|utf8(?:=[01])?|faulthandler|importtime|tracemalloc(?:=\d+)?|warn_default_encoding)|-W[ \t]*(?:default|error|always|module|once|ignore)(?:::[A-Za-z]*Warning)?))*`;

/**
 * Test runners run without an ask in default and yolo modes (#377). They
 * execute repository-authored code, which the maintainer accepted so a
 * headless run can verify its own work by the project's own command. Every id
 * here maps to a `detectValidationCommand` label, and
 * `tests/contracts/test-runner-vocabulary.test.ts` fails when the two drift.
 * Arguments stay bare words: quoting, substitution, and operators fall through
 * to the rails below. A package script's arguments after `--` may not begin
 * with `-`, so `--import`, `--require`, `--config` or `--prefix` keeps its ask.
 * Words are separated by spaces and tabs only, so a line break cannot start a
 * second command inside a recognized one.
 */
export const TEST_RUNNER_COMMANDS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{
		id: "builtin:npm-test",
		re: /^npm[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:pnpm-test",
		re: /^pnpm[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:yarn-test",
		re: /^yarn[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:bun-test",
		re: /^bun[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-test-script",
		re: /^npm[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:pnpm-test-script",
		re: /^pnpm[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:yarn-test-script",
		re: /^yarn[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:bun-test-script",
		re: /^bun[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	// uv can provision dependencies before pytest; --no-sync keeps #377's
	// unattended allowance from authorizing environment synchronization.
	{
		id: "builtin:uv-pytest",
		re: /^uv[ \t]+run(?:[ \t]+--(?:frozen|locked))*[ \t]+--no-sync(?:[ \t]+--(?:no-sync|frozen|locked))*[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$/,
	},
	{
		id: "builtin:uv-python-pytest",
		re: /^uv[ \t]+run(?:[ \t]+--(?:frozen|locked))*[ \t]+--no-sync(?:[ \t]+--(?:no-sync|frozen|locked))*[ \t]+python[ \t]+-m[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$/,
	},
	{ id: "builtin:node-test", re: /^node[ \t]+--test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:pytest", re: /^pytest(?:[ \t]+[\w=./:-]+)*$/ },
	{
		id: "builtin:python-pytest",
		re: new RegExp(String.raw`^python(?:3(?:\.\d+)?)?${PYTHON_RUNNER_FLAGS}[ \t]+-m[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$`),
	},
	{
		id: "builtin:python-unittest",
		re: new RegExp(String.raw`^python(?:3(?:\.\d+)?)?${PYTHON_RUNNER_FLAGS}[ \t]+-m[ \t]+unittest(?:[ \t]+[\w=./:-]+)*$`),
	},
	{ id: "builtin:cargo-test", re: /^cargo[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:go-test", re: /^go[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:ctest", re: /^ctest(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:make-test", re: /^make[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:make-check", re: /^make[ \t]+check(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:ninja-test", re: /^ninja[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:meson-test", re: /^meson[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:mvn-test", re: /^mvn[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:gradle-test", re: /^(?:gradle|(?:\.\/)?gradlew)[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
];

/**
 * The clean step of `make clean && make test`, which ended sdlc coders at
 * WORKER_REFUSAL_LIMIT. It runs the same Makefile `make test` already runs
 * unattended, so it carries the same workspace-code gate. It stays out of
 * TEST_RUNNER_COMMANDS because a clean validates nothing and must not count as
 * evidence, and it takes no arguments, so `make clean all` stays unrecognized.
 */
const MAKE_CLEAN_COMMAND = { id: "builtin:make-clean", re: /^make[ \t]+clean$/ };

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
	{
		id: "builtin:npm-lint",
		re: /^npm[ \t]+run[ \t]+lint(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-build",
		re: /^npm[ \t]+run[ \t]+build(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-typecheck",
		re: /^npm[ \t]+run[ \t]+typecheck(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-ci-script",
		re: /^npm[ \t]+run[ \t]+ci(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
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
 * login profile has been captured the tool environment is unknown, and rg is
 * not recognized either, so admission judges it as it does any unrecognized command.
 */
const RG_CONFIG_ENV = "RIPGREP_CONFIG_PATH";

const RG_CONFIG_REASONS = {
	set: `ripgrep reads options from the file ${RG_CONFIG_ENV} names, which can add --follow, --pre or -z behind the command text; with it set rg is not recognized as read-only`,
	pending: `the login environment bash commands run with is still being captured, so whether ${RG_CONFIG_ENV} names a ripgrep config that can add --follow, --pre or -z is unknown; rg is not recognized as read-only until it is`,
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
 * Whether a tool escapes write-root confinement whatever its arguments: by its
 * own class it runs a project script, a shell, or an unconfined child, so no
 * lexical check can bound where it writes. The envelope reads the same test to
 * withhold such a tool from a run whose roots nothing binds (fleet M7), and the
 * class of the call itself is checked again below.
 */
export function toolEscapesWriteRoots(tool: string): boolean {
	const action = classify({ tool }).actionClass;
	return action === "execute" || action === "dispatch";
}

// Write-class tools (action class "write"). bash is execute class and runs its
// own loop, so it is not covered by the lexical write-root containment below.
const WRITE_ROOT_TOOLS = new Set<string>([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

/** A call this session may not make writes nothing; the tool refuses it with how to get a grant. */
function storeWriteTargets(call: ClassifierCall, cwd: string): string[] {
	return call.args?.[STORE_UNGRANTED_ARG] === true ? [] : storeWriteSet(cwd, call.args);
}

/**
 * A store write lands where `storeWriteSet` predicts, never at its `path`
 * argument (the source), so the store is judged by that target here. It stays
 * out of WRITE_ROOT_TOOLS, which also drives the git-control check over the
 * call's path arguments.
 */
function writeRootTargetPath(call: ClassifierCall, cwd: string = process.cwd()): string | null {
	if (call.tool === ToolNames.Store) return storeWriteTargets(call, cwd)[0] ?? null;
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
	if (toolEscapesWriteRoots(call.tool)) return true;
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
	const memo = createPathWalkMemo();
	const violationOf = (target: string): string | null =>
		writeRootViolation(roots, target, canonicalizeRawPath(expandPath(target), writeRootCwd, memo), memo);
	const targets =
		call.tool === ToolNames.Store
			? storeWriteRootTargets(call, writeRootCwd, violationOf)
			: [writeRootTargetPath(call, writeRootCwd)];
	for (const target of targets) {
		if (target === null) continue;
		const violation = violationOf(target);
		if (violation !== null) return violation;
	}
	return null;
}

/**
 * A store write touches its records, project.json and locks besides its
 * target, so each is judged. When the roots hold a grant of the call's tag
 * (they cover the inside of the tag and of its records tag), the store's own
 * bookkeeping for the call is admitted with it: a grant adds only the two tag
 * directories to the roots, so the shell sandbox never gets project.json or
 * the locks. The op's own target is still judged.
 */
function storeWriteRootTargets(
	call: ClassifierCall,
	cwd: string,
	violationOf: (target: string) => string | null,
): string[] {
	const targets = storeWriteTargets(call, cwd);
	if (targets.length === 0) return targets;
	const probes = storeGrantProbes(cwd, call.args);
	if (probes.length === 0 || probes.some((probe) => violationOf(probe) !== null)) return targets;
	const bookkeeping = new Set(storeBookkeepingPaths(cwd, String(call.args?.tag)));
	return targets.filter((target) => !bookkeeping.has(target));
}

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = canonicalizeExistingPath(path.resolve(options.cwd ?? process.cwd()));
	// Write targets resolve relative to the cwd the tools use, un-canonicalized,
	// and both targets and roots are walked physically at each check (F3).
	const writeRootCwd = path.resolve(options.cwd ?? process.cwd());
	const writeRoots = (options.writeRoots ?? []).map((root) => resolvePathBoundary(writeRootCwd, root));
	const writeRootsOsConfined = options.writeRootsOsConfined === true;
	// The cwd repository's git control paths (the shell sandbox's read-only
	// set, the core.hooksPath directories included) are resolved when the
	// engine is built and again only after a call that may have rewritten a
	// git config, so a typed write pays no walk for them: the per-call fs
	// budget is pinned (admission-fs-ops). The name pattern covers a
	// repository created after that.
	let gitControls = resolveGitControls(cwd);
	let gitControlsStale = false;
	/** First secret-bearing path an admitted call read, or null; taints later outbound fetches. */
	let secretRead: string | null = null;
	const secretBearingReadOf = (rawCall: ClassifierCall): string | null => {
		if (rawCall.tool === ToolNames.Read || rawCall.tool === ToolNames.Grep) {
			const target = rawCall.args?.path;
			return typeof target === "string" && isSecretBearingPath(target) ? target : null;
		}
		if (rawCall.tool !== ToolNames.Bash) return null;
		const tokens = flowSourceCallFor(rawCall, cwd).readTokens ?? [];
		return tokens.find((token) => isSecretBearingPath(token)) ?? null;
	};
	const gitControlHit = (call: ClassifierCall, candidates: ReturnType<typeof mutationCandidates>): string | null => {
		if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
		if (gitControlsStale) {
			gitControls = resolveGitControls(cwd);
			gitControlsStale = false;
		}
		return gitControlLanding(candidates, gitControls);
	};
	const skillRoots = activeClioSkillRoots(cwd);
	const readExemptRoots = [
		...readScopeExemptRoots(cwd),
		...(options.readExemptRoots ?? []).map((root) => ({ path: root, operatorOwned: false })),
	];
	const baseRules = getCachedBaseRuleset();
	const projectPolicy = options.projectPolicy ?? gateProjectSafetyPolicy(cwd, loadProjectSafetyPolicy(cwd));
	const projectPolicyRoot =
		projectPolicy.path === null ? cwd : path.dirname(path.dirname(path.resolve(projectPolicy.path)));
	const compileEnginePathPolicy = (defaults: PathPolicyInput): CompiledPathPolicy => {
		const pathPolicyInput = projectPolicy.disableDefaultPathPolicy
			? projectPolicy.pathPolicy
			: mergePathPolicyInputs(defaults, projectPolicy.pathPolicy);
		// Clio's own secret store, the desktop app's launch token, the config and build-tool files that hold a secret now and user
		// skills, by absolute path.
		// Config directory expansion has to happen here because
		// the list cannot call config helpers at module scope.
		const expandedDefaults = mergePathPolicyInputs(mergePathPolicyInputs(pathPolicyInput, OPERATOR_PATH_POLICY), {
			zeroAccessPaths: [...clioCredentialStorePaths(), ...clioControlPaths(), ...configSecrets],
			readOnlyPaths: [...clioSkillsRootPaths(), path.join(clioConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
		});
		return compilePathPolicy(expandedDefaults, projectPolicyRoot);
	};
	let configSecrets = conditionalSecretPaths();
	let pathPolicy = compileEnginePathPolicy(DEFAULT_DAMAGE_CONTROL_PATH_POLICY);
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
	const zeroAccessOf = (policy: CompiledPathPolicy): CompiledPathPolicy => ({
		root: policy.root,
		entries: policy.entries.filter((entry) => entry.kind === "zeroAccessPaths"),
		diagnostics: [],
	});
	let zeroAccessPolicy = zeroAccessOf(pathPolicy);
	/**
	 * settings.yaml, mcp.yaml and the build-tool settings turn secret when the operator adds a header target, a server
	 * token or a repository password mid-session, so a call that can read checks them again. A write or edit skips it: its fs calls are pinned (admission-fs-ops).
	 */
	const refreshConfigSecrets = (): void => {
		const next = conditionalSecretPaths();
		if (next === configSecrets) return;
		configSecrets = next;
		pathPolicy = compileEnginePathPolicy(DEFAULT_DAMAGE_CONTROL_PATH_POLICY);
		zeroAccessPolicy = zeroAccessOf(pathPolicy);
		operatorDeletePathPolicy = null;
	};

	// Base pack rules apply at every posture, so they are sourced once at
	// construction. Building the array inside evaluate() re-allocated it on
	// every admission for no behavioral gain.
	const sourcedRules: SourcedRule[] = baseRules.rules.map((rule) => ({ rule, source: "damage-control:base" }));
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
		if (mutationCommand !== null && invokesSettingsMutation(mutationCommand)) {
			return {
				reasonCode: SETTINGS_AUTHORITY_RULE_ID,
				reasons: [SETTINGS_AUTHORITY_REASON],
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
			// Only an entry the project authored is the project's policy; the rest is Clio's built-in protection.
			const authored = evaluateProjectPathPolicy(operatorPolicy(), operatorPolicy(), call, callCwd, walkMemo) !== null;
			return {
				reasonCode: pathBlock.reasonCode,
				reasons: [pathBlock.reason],
				policySource: authored ? "project-policy" : "damage-control:base",
			};
		}
		// A shell target after a literal cd is also judged from the directory
		// that cd leaves the shell in, so `cd .clio-coder && echo x > safety.yaml`
		// meets the same rail as `echo x > .clio-coder/safety.yaml`.
		if (call.tool === ToolNames.Bash && mutationCommand !== null) {
			for (const target of extractCommandCdScopedTargets(mutationCommand)) {
				const decision = evaluatePathPolicy(
					target.operation === "delete" ? deletes : pathPolicy,
					target.operation,
					target.path,
					callCwd,
					walkMemo,
				);
				if (decision.kind === "block") {
					return { reasonCode: decision.reasonCode, reasons: [decision.reason], policySource: "project-policy" };
				}
			}
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
				// Only an entry the project authored is the project's policy; the rest is Clio's built-in protection.
				const own = operatorPolicy();
				const ownZero = { ...own, entries: own.entries.filter((entry) => entry.kind === "zeroAccessPaths") };
				const authored = evaluateBashZeroAccessRead(ownZero, scannedCommand, callCwd) !== null;
				return {
					reasonCode: "secret_path_bash",
					reasons: [
						`${bashZeroAccessReason(secretRead)}. Check presence with exit codes only (grep -sq "^NAME=" <file>); have the user supply values through their own terminal (read -s), never through chat or command output.`,
					],
					policySource: authored ? "project-policy" : "damage-control:base",
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
		const scanned = pathPolicyTargets(call, callCwd).filter((target) => target.operation !== "read");
		const targets = command === null ? scanned : [...scanned, ...sameCommandWriteTargets(command, scanned, callCwd)];
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
	/**
	 * The workspace `.git` floor over a command as written, then over its scratch projection (`$TMPDIR` spelled out),
	 * which only adds placeable paths: a hit in either reading holds (row 261).
	 */
	const workspaceGitHit = (command: string, callCwd: string): YoloFloorHit | null => {
		const written = yoloFloorWorkspaceGitHit(command, callCwd, cwd);
		if (written !== null) return written;
		const projected = resolveScratchDeleteOperands(command).command;
		return projected === command ? null : yoloFloorWorkspaceGitHit(projected, callCwd, cwd);
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
		rawText = false,
		gitOnly = false,
	): { match: DamageControlMatch; source: SafetyPolicySource } | null => {
		if (gitOnly) {
			for (const candidate of commands) {
				const git = workspaceGitHit(candidate, callCwd);
				if (git !== null) return floorMatch(git);
			}
			return null;
		}
		const text = matchSourcedRule(texts, floorRules);
		if (text !== null) return text;
		const command = commands[0] ?? "";
		for (const candidate of commands) {
			const executable = yoloFloorExecutableHit(candidate);
			if (executable !== null) return floorMatch(executable);
			const deleted = yoloFloorDeleteHit(candidate, callCwd, cwd);
			if (deleted !== null) return floorMatch(deleted);
			// Relative deletes resolve from the call's directory and every cd landing, whatever separates them (row 261).
			const git = workspaceGitHit(candidate, callCwd);
			if (git !== null) return floorMatch(git);
		}
		if (invokesTrustMutation(command, rawText)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.trustAuthority,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.trustAuthority}: workspace trust grants require the operator CLI`,
			});
		}
		if (invokesSettingsMutation(command)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.settingsAuthority,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.settingsAuthority}: ${SETTINGS_AUTHORITY_REASON}`,
			});
		}
		// A Clio variable the command pins to a literal path is judged by that path (CLI-H4).
		const owned = pinnedClioCommand(command);
		if (clioOwnedMutation({ tool: ToolNames.Bash, args: { command: owned } }, callCwd, owned, trees)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.clioOwned,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.clioOwned}: writes into or deletes Clio's own config, data, state or trust records, which only the operator changes`,
			});
		}
		return null;
	};
	/** One script line against the floor, from every directory the scan places it in. */
	const floorLine =
		(trees: ClioOwnedTrees, gitOnly = false) =>
		(raw: string, read: ScriptLine, callCwd: string) => {
			// A here-document body or a comment is data the script carries, not a command.
			if (read.data) return null;
			const texts = read.expanded === raw ? [raw] : [read.expanded, raw];
			for (const base of read.bases ?? [callCwd]) {
				const hit = commandFloorHit(texts, texts, base, trees, false, gitOnly);
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
		const memo = createPathWalkMemo();
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
			const real = canonicalizeRawPath(target, callCwd, memo);
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
		// Each distinct token once: a long heredoc repeats most of its words (x6-7b).
		const judged = new Set<string>();
		for (const token of bashPathTokenCandidates(command)) {
			if (judged.has(token)) continue;
			judged.add(token);
			if (lands(token, !listsOnly)) return hit(token);
		}
		return null;
	};
	/**
	 * The floor for one call (#407), at yolo and at the operator's default: the
	 * command's own text and targets, reads of Clio's credential store, then
	 * each shell script the call runs by literal path, read line by line. A
	 * script the scan cannot read through runs. `gitOnly` reads the command and its scripts for the workspace `.git`
	 * rule alone, for a call judged without the operator's scope, and leaves what it cannot read to the caller.
	 */
	const floorBlock = (
		call: ClassifierCall,
		callCwd: string,
		originalCommand: string | null,
		gitOnly = false,
	): Omit<
		SafetyPolicyDecision,
		"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
	> | null => {
		const command = originalCommand === null ? null : yoloFloorCommandText(originalCommand);
		const trees = clioOwnedTrees(cwd);
		const held = (
			hit: { match: DamageControlMatch; source: SafetyPolicySource },
			reasons: string[] = [],
			floorBasis?: string,
		) => ({
			ruleId: hit.match.ruleId,
			reasonCode: `${YOLO_FLOOR_REASON_PREFIX}${hit.match.ruleId}`,
			reasons: [
				...reasons,
				hit.match.reason,
				...(YOLO_FLOOR_AUTHORITY_RULE_IDS.has(hit.match.ruleId) ? [YOLO_FLOOR_AUTHORITY_REMEDY] : []),
				"the yolo floor holds at every autonomy level",
			],
			match: hit.match,
			policySource: hit.source,
			...(floorBasis !== undefined ? { floorBasis } : {}),
		});
		if (command !== null) {
			const decoded = [decodedAnsiCCommand(command), decodedLocaleQuoting(command)].filter(
				(text): text is string => text !== null,
			);
			const commands = [...new Set([command, ...decoded])];
			const hit = commandFloorHit(
				[...new Set([...commands, ...shellCommandSegments(command)])],
				commands,
				callCwd,
				trees,
				false,
				gitOnly,
			);
			if (hit !== null) return held(hit);
		} else if (!gitOnly && clioOwnedMutation(call, callCwd, null, trees)) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.clioOwned,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.clioOwned}: writes into Clio's own config, data, state or trust records, which only the operator changes`,
				}),
			);
		}
		const floorCall = command === originalCommand ? call : { ...call, args: { ...call.args, command } };
		const credentials = gitOnly ? null : credentialReadHit(floorCall, callCwd, command);
		if (credentials !== null) return held(floorMatch(credentials, "read"));
		const raw = command === null || gitOnly ? null : yoloFloorRawCandidates(command);
		if (raw?.overflow === true) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.rawText,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.rawText}: ${RAW_TEXT_REASON}, and this one is too large to read that way; split it, or write its text to a file with the write tool and pass the file`,
				}),
				[],
				`a line holding a command substitution is also read as raw text, and this one's reading passes the floor's ${MAX_RAW_TEXT_BYTES}-byte raw-text budget`,
			);
		}
		for (const candidate of raw?.candidates ?? []) {
			const read = credentialReadHit({ tool: ToolNames.Bash, args: { command: candidate } }, callCwd, candidate);
			const hit =
				commandFloorHit([candidate], [candidate], callCwd, trees, true) ??
				(read === null ? null : floorMatch(read, "read"));
			if (hit !== null) {
				// Moving an operator-only command into a file changes nothing: the script scan refuses it there too (CLI-P31).
				const remedy = YOLO_FLOOR_AUTHORITY_RULE_IDS.has(hit.match.ruleId)
					? YOLO_FLOOR_AUTHORITY_REMEDY
					: "write that text to a file with the write tool and pass the file";
				const reason = `matched ${YOLO_FLOOR_RULE_IDS.rawText}: ${RAW_TEXT_REASON}: "${candidate.slice(0, 200)}" is a floor command even if it is only quoted data (fail-closed); ${remedy}`;
				return held(
					{ match: { ...hit.match, ruleId: YOLO_FLOOR_RULE_IDS.rawText, reason }, source: hit.source },
					[hit.match.reason],
					`a line holding a command substitution is also read as raw text, and that reading holds the floor command ${hit.match.ruleId}`,
				);
			}
		}
		const line = floorLine(trees, gitOnly);
		const scriptHit = (scan: ScriptHit | null) =>
			scan === null ? null : held(scan, [`script ${scan.file} line ${scan.line}: ${scan.text.slice(0, 200)}`]);
		const budgets: ScriptBudget[] = [];
		const budgetFor = (): ScriptBudget => {
			const budget = newScriptBudget();
			budgets.push(budget);
			return budget;
		};
		if (call.tool === ToolNames.RunScript && runsUnderShell(call.args)) {
			const script = typeof call.args?.script === "string" ? call.args.script.trim() : "";
			const file = script === "" ? null : scriptPath(script, cwd);
			const hit = scriptHit(
				file === null ? null : scanNamedScript(file, line, callCwd, [callCwd], budgetFor(), { zero: file, source: file }),
			);
			if (hit !== null) return hit;
		}
		// A leading `~`, `$HOME` or `${HOME}` is the operator's home only while nothing before it may set HOME (row 215).
		const homeKnown = command === null || !commandMayChangeHome(command);
		const runs = call.tool === ToolNames.Bash && command !== null ? yoloFloorScriptRuns(command, "~") : [];
		if (call.tool === ToolNames.Bash && command !== null && hasUnparsedShellScript(command)) {
			const cwds = commandMoveBases(command, callCwd);
			const written = commandWrittenPaths(command, cwds ?? [callCwd], newWrittenPaths());
			const budget = budgetFor();
			const scripts = shellScriptSources(command, "~");
			// A script piped in, fed as a here-document or here-string, read through `-s` or a startup file, or nested past
			// the parse is never read; the scripts the command names beside it still are (row 215).
			if (scripts.unnamed) recordUnplaced(budget, "a script the command runs without naming it");
			// A file the command sources may set HOME before a shell runs a named script.
			const shellHome = homeKnown && !runs.some((run) => run.sourced);
			for (const script of scripts.sources) {
				const hit = scriptHit(scanCommandScript(script, line, callCwd, cwds, written, budget, false, shellHome));
				if (hit !== null) return hit;
			}
		}
		// `./x.sh` and `source x.sh` run a file as `bash x.sh` does, so the floor reads it the same way (CLI-P31). A file
		// the scan cannot place or read goes to the safety judge (row 215).
		if (command !== null && runs.length > 0) {
			const cwds = commandMoveBases(command, callCwd);
			const written = commandWrittenPaths(command, cwds ?? [callCwd], newWrittenPaths());
			const budget = budgetFor();
			let home = homeKnown;
			for (const run of runs) {
				const source = { path: run.path, program: !run.sourced, sourced: run.sourced, stdin: false };
				const hit = scriptHit(scanCommandScript(source, line, callCwd, cwds, written, budget, !run.sourced, home));
				if (hit !== null) return hit;
				// A sourced file may set HOME for every script after it.
				if (run.sourced) home = false;
			}
		}
		if (gitOnly) return null;
		// No copy the scan could read refuses, but a sourced name was looked up before the bash tool's PATH was known.
		if (budgets.some((budget) => budget.pathPending)) {
			return {
				ruleId: LOGIN_PATH_PENDING_RULE_ID,
				reasonCode: LOGIN_PATH_PENDING_RULE_ID,
				reasons: [LOGIN_PATH_PENDING_REASON],
				policySource: "builtin-classifier",
			};
		}
		// No script the scan read refuses, but one it runs could not be placed or read: the judge decides it (row 215).
		const unplaced = budgets.flatMap((budget) => budget.unplaced);
		if (unplaced.length > 0) {
			return {
				ruleId: SCRIPT_UNPLACEABLE_RULE_ID,
				reasonCode: SCRIPT_UNPLACEABLE_RULE_ID,
				reasons: [scriptUnplaceableReason(unplaced)],
				policySource: "builtin-classifier",
			};
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
			reasons: [bashZeroAccessReason(secretRead), held],
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
			out = gateDecision("ask", base, deferred);
		} else if (deferred !== null) {
			out = { ...out, reasons: [...out.reasons, ...deferred.reasons] };
		}
		if (resort.contained) {
			out = {
				...out,
				shellSandbox: {
					workspace: canonicalizePath(cwd) ?? cwd,
					scratchRoots: resort.scratchRoots,
					...(resort.readOnly === true ? { readOnly: true as const } : {}),
				},
			};
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
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain" || verifyResolution?.kind === "task"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		const callCwd = typeof resolvedCheckCwd === "string" ? resolvedCheckCwd : cwdArg(call.args, cwd);
		const verifyArgv =
			verifyResolution === null || verifyArgs === null ? null : verifyResolutionArgv(verifyResolution, verifyArgs, cwd);
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
			return gateDecision("block", base, {
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
			return gateDecision("block", base, {
				ruleId: "write-root",
				reasonCode: "write-root",
				reasons: [
					`tool '${call.tool}' (${classification.actionClass}) can mutate the filesystem outside the permitted write roots and is blocked under write-root confinement`,
				],
				policySource: "builtin-classifier",
			});
		}
		if (resolvedCheckCwd instanceof Error) {
			return gateDecision("block", base, {
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
			return gateDecision("block", base, blockInput);
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
			if (resort === undefined) return gateDecision("block", base, input);
			deferred =
				deferred === null
					? { ...input, reasons: [...input.reasons, DEFAULT_RESORTED_REASON] }
					: { ...deferred, reasons: [...deleteReasons, ...deferred.reasons] };
		}
		// A delete inside the workspace is undone only by the workspace snapshot
		// taken before it: without one the operator's default asks for it even
		// when contained, and with one the call is refused if that snapshot fails.
		const scratchProjection =
			resort === undefined || command === null ? null : resolveScratchDeleteOperands(command).command;
		const workspaceDeletes = scratchProjection === null ? [] : deletesNeedingSnapshot(scratchProjection, cwd);
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
		// Leaving the sandbox is what containment exists to bound: a recognized
		// command asks for it too, so the judge reads the operator's request
		// first and an escape the operator named passes.
		if (resort?.leavesSandbox === true) {
			deferred =
				deferred === null
					? {
							ruleId: SANDBOX_ESCAPE_RULE_ID,
							reasonCode: SANDBOX_ESCAPE_RULE_ID,
							reasons: [SANDBOX_ESCAPE_REASON],
							policySource: "builtin-classifier",
						}
					: { ...deferred, reasons: [...deferred.reasons, SANDBOX_ESCAPE_REASON] };
		}
		// A delete that lands only inside scratch roots is disposable, and no workspace snapshot covers it.
		const scratchOnly =
			resort !== undefined &&
			scratchProjection !== null &&
			workspaceDeletes.length === 0 &&
			deletesOnlyScratch(scratchProjection, resort.scratchRoots);
		// Every decision below settles the operator's default when it applies.
		const settle = (decision: SafetyPolicyDecision): SafetyPolicyDecision =>
			resort === undefined
				? decision
				: settleDefault(
						decision,
						base,
						deferred,
						resort,
						((sorted?.recoverable ?? null) !== null && !scratchOnly) || workspaceDeletes.length > 0,
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
			return gateDecision("block", base, blockInput);
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
			return gateDecision("block", base, blockInput);
		}
		// The contained shell cannot write the repository's hooks, config or git
		// dir pointers, so under the operator's default a typed write asks for
		// them too and the safety judge weighs it against the operator's intent.
		const gitControl = resort === undefined ? null : gitControlHit(call, candidates);
		if (gitControl !== null) {
			const input = {
				ruleId: GIT_CONTROL_FILE_RULE_ID,
				reasonCode: GIT_CONTROL_FILE_RULE_ID,
				reasons: [gitControlFileReason(gitControl)],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
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
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
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
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
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
				gateDecision("ask", base, {
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
			return settle(
				posture === "confirmed" || posture === "yolo" ? allowDecision(base, input) : gateDecision("ask", base, input),
			);
		}

		// The authored ask rail (sd-01 M3) decides only among calls that
		// survived every hard block above. A confirmed posture admits the
		// matched command; an unconfirmed one parks it for confirmation.
		if (askHit !== null && posture !== "confirmed") {
			return settle(
				gateDecision("ask", base, {
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
		if (loneDelete && !loneDiscard && scratchOnly) {
			return settle(
				allowDecision(base, {
					ruleId: undone?.match?.ruleId ?? SCRATCH_DISPOSABLE_REASON_CODE,
					reasonCode: SCRATCH_DISPOSABLE_REASON_CODE,
					reasons: [...classification.reasons, SCRATCH_DISPOSABLE_REASON],
					policySource: "damage-control:base",
					execRecognition: "recognized",
					...(undone?.match !== null && undone?.match !== undefined ? { match: undone.match } : {}),
				}),
			);
		}
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
								: "at the default autonomy level every change outside the workspace needs your approval",
				],
				policySource: "builtin-classifier",
			};
			return settle(
				posture === "confirmed" || posture === "yolo" || resort?.contained === true
					? allowDecision(base, input)
					: gateDecision("ask", base, input),
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
			if (bash.kind === "block") return gateDecision("block", base, bash);
			const scanned = call.projection === "mcp-server" ? mcpExecutePolicy(bash) : bash;
			if (scanned.kind === "ask") return settle(gateDecision("ask", base, scanned));
			return settle(allowDecision(base, scanned));
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
		// Outside the operator's own scopes the net only marks a typed write to
		// a git control path; admission asks the main agent when a worker at
		// default made it. A yolo posture admits it unread.
		if (resort === undefined && posture !== "yolo") {
			const gitControl = gitControlHit(call, candidates);
			if (gitControl !== null) allowInput.gitControl = gitControl;
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
				: (verifyResolutionArgv(verifyResolution, verifyArgs, cwd)?.join(" ") ?? null);
		const checkCwd =
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain" || verifyResolution?.kind === "task"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		return {
			callCwd: typeof checkCwd === "string" ? checkCwd : cwdArg(call.args, cwd),
			judgedCommand: call.tool === ToolNames.Bash ? command : verifyCommand,
		};
	};

	/**
	 * Where an outward line of a call run from `callCwd` would run, and every tree the main-session sandbox
	 * lets a contained command write, as written and with links resolved.
	 */
	const outwardPlaces = (scope: OperatorYoloScope, callCwd: string): OutwardPlaces => {
		const workspace = canonicalizePath(cwd) ?? cwd;
		const roots = mainSandboxWritableRoots(workspace, effectiveScratchRoots(scope.scratchRoots, cwd));
		return {
			workspace,
			fileRoots: [...new Set(roots.flatMap((root) => [root, canonicalizePath(root) ?? root]))],
			cwd: canonicalizePath(callCwd) ?? callCwd,
			searchPath: bashSearchPath(),
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
		const scanned = floorBlock(call, callCwd, judgedCommand);
		// Unconfined yolo has no judge, and a script the floor cannot place or read is never refused outright (row 215), so
		// it runs as it did before.
		const floor = scanned?.ruleId === SCRIPT_UNPLACEABLE_RULE_ID ? null : scanned;
		// Unconfined yolo has no judge and admits every ask, so a call whose sourced file is unknown yet is held instead.
		if (floor?.ruleId === LOGIN_PATH_PENDING_RULE_ID)
			return gateDecision("block", base, { ...floor, reasons: [...floor.reasons, LOGIN_PATH_PENDING_YOLO_HOLD] });
		if (floor !== null) return gateDecision("block", base, floor);
		const held: string[] = [];
		const required = yoloRequiredSandbox(rawCall, call, base.classification, judgedCommand, scope, () => ({
			...outwardPlaces(scope, callCwd),
			held,
		}));
		if (required === "refused" || required === "unsandboxed") {
			return gateDecision("block", base, {
				ruleId: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasonCode: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasons: [
					required === "unsandboxed"
						? YOLO_SANDBOX_NOT_LEFT
						: reachesOutward(call, base.classification, judgedCommand)
							? `${YOLO_SANDBOX_REFUSED_OUTWARD}${held.length > 0 ? `; this one stays inside because ${held.join("; ")}` : ""}`
							: YOLO_SANDBOX_REFUSED,
				],
				policySource: "builtin-classifier",
			});
		}
		const normal = evaluateCall(rawCall, posture);
		if (normal.kind === "allow" || holdsAtYolo(normal)) return normal;
		const operator = operatorRuleBlock(call, callCwd, judgedCommand);
		if (operator !== null)
			return gateDecision(
				"block",
				{ ...base, classification: normal.classification, actionClass: normal.actionClass },
				operator,
			);
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
		const pending =
			floor?.ruleId === LOGIN_PATH_PENDING_RULE_ID || floor?.ruleId === SCRIPT_UNPLACEABLE_RULE_ID ? floor : null;
		if (floor !== null && pending === null)
			return gateDecision("block", baseDecision(call, classification, callCwd, posture, judgedCommand), floor);
		const leavesSandbox = scope.sandbox && call.args?.unsandboxed === true && runsProjectCommand(call, judgedCommand);
		const normal = evaluateCall(rawCall, posture, {
			scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
			contained: scope.sandbox && containedShellCall(call, classification, judgedCommand),
			snapshots: scope.snapshots,
			...(scope.readOnly === true ? { readOnly: true as const } : {}),
			...(leavesSandbox ? { leavesSandbox: true as const } : {}),
		});
		// The floor could not place the sourced file yet, or could not place or read a script the call runs: whatever the net
		// would block stays blocked, an ask the net raises keeps its rule (leaving the sandbox, an operator-only change, a
		// damage-control finding) with this reason added, and an allow asks, so the safety judge decides it rather than the
		// launching PATH or an unread script. An operator's approval of this exact call already answered it. A contained
		// call stays contained if it runs.
		if (pending === null || normal.kind === "block") return normal;
		if (normal.kind === "ask" || posture === CONFIRMED_POSTURE)
			return { ...normal, reasons: [...normal.reasons, ...pending.reasons] };
		const { rejection: _rejection, match: _match, ...rest } = normal;
		return gateDecision("ask", rest, {
			...pending,
			...(normal.shellSandbox !== undefined ? { shellSandbox: normal.shellSandbox } : {}),
		});
	};

	/**
	 * The workspace `.git` floor rule (row 261) holds at every level, so a call judged without the operator's scope (a
	 * worker, a grant, a bare evaluation) meets it too; a call that already blocks keeps its own reason.
	 */
	const unscopedWorkspaceGit = (
		rawCall: ClassifierCall,
		normal: SafetyPolicyDecision,
		posture: string | undefined,
	): SafetyPolicyDecision => {
		if (normal.kind === "block" || (rawCall.tool !== ToolNames.Bash && rawCall.tool !== ToolNames.RunScript))
			return normal;
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		// The scoped floor's own reading, the scripts the call runs included, narrowed to the `.git` rule.
		const floor = floorBlock(call, callCwd, judgedCommand, true);
		if (floor === null || floor.ruleId !== YOLO_FLOOR_RULE_IDS.workspaceGit) return normal;
		return gateDecision("block", baseDecision(call, normal.classification, callCwd, posture, judgedCommand), floor);
	};

	const evaluateScoped = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		const decision = evaluateScopedReading(rawCall, posture, scope);
		const command = rawCall.tool === ToolNames.Bash ? commandArg(rawCall.args) : null;
		if (command === null || decision.kind === "block") return decision;
		// FX-46: a declared validation wrapper runs the rest of its line, so what it runs is judged as if written bare,
		// and the strictest reading stands; readings at the same verdict merge. An undeclared script stays opaque.
		const { callCwd } = commandUnderJudgment(normalizeCallPaths(rawCall));
		let result = decision;
		for (const inner of declaredWrapperReadings(command, callCwd)) {
			const through = evaluateScopedReading({ ...rawCall, args: { ...rawCall.args, command: inner } }, posture, scope);
			result = mergedWrapperReading(result, through, inner);
			if (result.kind === "block") break;
		}
		return result;
	};

	/**
	 * The call as judged so far (`current`, the command as written first) merged with a wrapper-stripped reading, never
	 * looser than either (row 261): the stricter verdict names the call (its rule, reason code and match). On a tie the
	 * reading already standing keeps its classification, and a stripped reading names the call only by a rule the standing
	 * one lacks, never by a code admission treats more kindly (`snapshot-recoverable`). Reasons are the union; a snapshot requirement and an unrecognized command from
	 * either reading stay, as does a test runner's consent. The sandbox is the standing reading's on a tie, since one
	 * added to an allow would let admission run it unasked, and on an escalation the stricter reading's, or the standing
	 * one's when it names none, the read-only box first.
	 */
	const mergedWrapperReading = (
		current: SafetyPolicyDecision,
		through: SafetyPolicyDecision,
		inner: string,
	): SafetyPolicyDecision => {
		const rank = (kind: SafetyPolicyDecision["kind"]) => (kind === "block" ? 2 : kind === "ask" ? 1 : 0);
		const escalates = rank(through.kind) > rank(current.kind);
		const own = escalates ? through : current;
		const other = escalates ? current : through;
		const note = `a declared validation wrapper runs the rest of its line, judged as ${inner.trim()}`;
		const reasons = [...new Set([...(escalates ? [note] : []), ...own.reasons, ...other.reasons])];
		const boxes = escalates ? [through.shellSandbox, current.shellSandbox] : [current.shellSandbox];
		const present = boxes.filter((box) => box !== undefined);
		const shellSandbox = present.find((box) => box.readOnly === true) ?? present[0];
		const rest: SafetyPolicyDecision = { ...own };
		delete rest.shellSandbox;
		delete rest.execRecognition;
		// On a tie the standing reading keeps its classification; the stripped one names the call only when it names a
		// rule the standing one does not (a damage-control or path match), or the standing code is one admission runs
		// unasked, and never with such a code itself.
		const kindly = (reading: SafetyPolicyDecision) =>
			reading.reasonCode === SNAPSHOT_RECOVERABLE_REASON_CODE || reading.reasonCode === SCRATCH_DISPOSABLE_REASON_CODE;
		const specific = (reading: SafetyPolicyDecision) =>
			reading.match !== undefined || reading.reasonCode.includes("damage-control:");
		const renames =
			!escalates &&
			through.kind === current.kind &&
			!kindly(through) &&
			(kindly(current) || (specific(through) && !specific(current)));
		if (renames) {
			delete rest.ruleId;
			delete rest.match;
			rest.reasonCode = through.reasonCode;
			if (through.ruleId !== undefined) rest.ruleId = through.ruleId;
			if (through.match !== undefined) rest.match = through.match;
		}
		const execRecognition =
			current.execRecognition === "unrecognized" || through.execRecognition === "unrecognized"
				? ("unrecognized" as const)
				: own.execRecognition;
		return {
			...rest,
			...(shellSandbox !== undefined ? { shellSandbox } : {}),
			...(execRecognition !== undefined ? { execRecognition } : {}),
			...(current.command !== undefined ? { command: current.command } : {}),
			...(current.recoverable === true || through.recoverable === true ? { recoverable: true as const } : {}),
			...(current.runsWorkspaceCode === true || through.runsWorkspaceCode === true
				? { runsWorkspaceCode: true as const }
				: {}),
			reasons,
		};
	};

	const evaluateScopedReading = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		if (scope?.level === "default") return evaluateOperatorDefault(rawCall, posture, scope);
		const decision =
			scope === undefined
				? unscopedWorkspaceGit(rawCall, evaluateCall(rawCall, posture), posture)
				: evaluateTrueYolo(rawCall, posture, scope);
		// A command the operator's yolo admitted under `safety.sandbox: required`
		// runs in the main-session sandbox, whatever stage allowed it (#419, #407).
		if (decision.kind !== "allow" || scope?.scriptSandbox !== "sandboxed") return decision;
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const places = () => outwardPlaces(scope, callCwd);
		if (yoloRequiredSandbox(rawCall, call, classify(call), judgedCommand, scope, places) !== "sandboxed") return decision;
		const shellSandbox = {
			workspace: canonicalizePath(cwd) ?? cwd,
			scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
		};
		return { ...decision, shellSandbox };
	};

	const taskGateUnderJudgment = (call: ClassifierCall): TaskGateUnderJudgment | null => {
		const args = prepareVerifyArguments(call.args ?? {});
		const resolution = resolveVerifyCall(cwd, args);
		if (resolution.kind !== "task") return null;
		const argv = verifyResolutionArgv(resolution, args, cwd);
		return argv === null
			? null
			: { command: argv.join(" "), confined: resolution.confined, containable: resolution.containable };
	};

	/**
	 * A verifier's task gate is judged as the bash call of its argv, through
	 * every rail bash meets, so task text never buys an argv more authority than
	 * bash has. A gate never asks: whoever would answer sees only a check id.
	 */
	const evaluateTaskGate = (
		rawCall: ClassifierCall,
		gate: TaskGateUnderJudgment,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		const callCwd = typeof rawCall.args?.cwd === "string" ? { cwd: rawCall.args.cwd } : {};
		const bashCall: ClassifierCall = { tool: ToolNames.Bash, args: { command: gate.command, ...callCwd } };
		const bash = evaluateScoped(bashCall, posture, scope);
		const named = { ...bash, tool: ToolNames.Verify, command: gate.command };
		if (bash.kind === "allow") {
			if (gate.confined) return taskGatePolicy(named, true);
			// Main bash at default runs an unrecognized command unasked when the
			// main-session sandbox contains it; the gate gets that verdict and,
			// through the decision's shellSandbox, runs in that same sandbox.
			if (bash.execRecognition === "unrecognized" && gate.containable && posture === undefined && scope === undefined) {
				const contained = evaluateOperatorDefault(bashCall, posture, {
					level: "default",
					scratchRoots: [],
					sandbox: true,
					snapshots: false,
				});
				if (contained.kind === "allow" && contained.shellSandbox !== undefined) {
					return { ...contained, tool: ToolNames.Verify, command: gate.command };
				}
			}
			return named;
		}
		if (bash.kind === "block") return named;
		const { rejection: _rejection, ...rest } = named;
		return gateDecision("block", rest, {
			...rest,
			ruleId: TASK_GATE_REFUSED_RULE_ID,
			reasonCode: TASK_GATE_REFUSED_RULE_ID,
			reasons: [
				`task gate \`${gate.command}\` would ask as bash (${bash.ruleId ?? bash.reasonCode}); a task gate never asks, so it does not run: report it unverified with this reason`,
				...bash.reasons,
			],
		});
	};

	const engine: SafetyPolicyEngine = {
		evaluate(rawCall, posture, scope) {
			if (!WRITE_ROOT_TOOLS.has(rawCall.tool)) refreshConfigSecrets();
			const oversized = oversizedPathToken(rawCall.args);
			if (oversized !== null) {
				return gateDecision("block", baseDecision(rawCall, classify(rawCall), cwd, posture, commandArg(rawCall.args)), {
					ruleId: OVERSIZED_PATH_RULE_ID,
					reasonCode: OVERSIZED_PATH_RULE_ID,
					reasons: [
						`an argument holds a path of more than ${MAX_PATH_SEGMENTS} segments, longer than any path the system can open; it is refused unexamined`,
					],
					policySource: "builtin-classifier",
				});
			}
			const gate = rawCall.tool === ToolNames.Verify ? taskGateUnderJudgment(rawCall) : null;
			const decision =
				gate === null ? evaluateScoped(rawCall, posture, scope) : evaluateTaskGate(rawCall, gate, posture, scope);
			// A judge's allow runs the asked call without a second admission, so an
			// ask counts as well as an allow; the refresh waits for the next typed write.
			if (decision.kind !== "block" && mayRewriteGitConfig(rawCall, decision, cwd)) gitControlsStale = true;
			if (
				secretRead &&
				decision.kind === "allow" &&
				isOutboundWebTool(rawCall.tool) &&
				fetchCouldCarryLocalData(rawCall.args)
			) {
				return gateDecision("ask", decision, {
					ruleId: SECRET_READ_THEN_FETCH_RULE_ID,
					reasonCode: SECRET_READ_THEN_FETCH_RULE_ID,
					reasons: [
						`a secret-bearing file (${secretRead}) was read earlier in this session, and this fetch has headers, a body, a query, fragment, userinfo, or an opaque path segment or host label that could carry its contents outward`,
					],
					policySource: "builtin-classifier",
				});
			}
			// An ask counts: a judge's allow runs the read without a second admission.
			if (decision.kind !== "block" && secretRead === null) secretRead = secretBearingReadOf(rawCall);
			return decision;
		},
		writeTargetViolation(target) {
			if (writeRoots.length === 0) return null;
			const memo = createPathWalkMemo();
			return writeRootViolation(writeRoots, target, canonicalizeRawPath(target, writeRootCwd, memo), memo);
		},
		readablePath(target) {
			refreshConfigSecrets();
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
				rulePackHash: rulePackHash(baseRules.rules),
				rulePackVersion: baseRules.version,
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
	// The pattern must end at `=`: anything after it tests the value, and a
	// sequence of such checks reads the secret one character at a time.
	return /^\^[A-Za-z_][A-Za-z0-9_]*=$/.test(pattern);
}

/**
 * A presence check chained into a list (`grep -sq "^NAME=" .env && echo set`)
 * still reads nothing; the rest of the list is judged on its own. Returns the
 * command left after removing leading presence checks, "" when nothing
 * remains, or null when the command does not start with one. Pipes and
 * redirections never bind to the check: only `&&`, `||` and `;` separate it.
 */
const LEADING_PRESENCE_RE =
	/^\s*(grep\s+-(?:q|sq|qs)\s+(?:'[^']*'|"[^"]*"|[^\s;&|<>]+)\s+[^\s;&|<>]+)\s*(?:&&|\|\||;)(?!&|\|)/;

function stripPresenceChecks(command: string): string | null {
	if (isSafePresenceCheck(command)) return "";
	let rest = command;
	let stripped = false;
	for (;;) {
		const match = LEADING_PRESENCE_RE.exec(rest);
		if (!match || match[1] === undefined || !isSafePresenceCheck(match[1])) break;
		rest = rest.slice(match[0].length);
		stripped = true;
		if (isSafePresenceCheck(rest)) return "";
	}
	if (!stripped) return null;
	return rest.trim();
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
	command = withoutDataHeredocBodies(command, "stdin-only", "rails");
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
	const remaining = command === null ? null : (stripPresenceChecks(command) ?? command);
	const readTokens = remaining === null || remaining === "" ? [] : bashOperandRoles(remaining).reads;
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
): BashZeroAccessHit | null {
	if (zeroAccessPolicy.entries.length === 0) return null;
	const remaining = stripPresenceChecks(command);
	if (remaining === "") return null;
	if (remaining !== null) command = remaining;
	const roles = bashOperandRoles(command);
	// A 130 KB heredoc names ~17,000 read candidates, mostly repeats; each walked
	// the filesystem afresh, ~1.6 s of synchronous admission (x6-7b). A token's
	// decision cannot change within one evaluation, so each is judged once.
	const memo = createPathWalkMemo();
	const judged = new Set<string>();
	// A glob entry such as `*.key` names a file by its suffix alone, so it holds a word only in a path position or one
	// that names a file on disk: `event.key` in a sed script, a heredoc or an echo is a field, not a key file (FX-7).
	let literalPolicy: CompiledPathPolicy | null = null;
	for (const token of roles.reads) {
		if (judged.has(token)) continue;
		judged.add(token);
		let decision = evaluatePathPolicy(zeroAccessPolicy, "read", token, callCwd, memo);
		if (
			decision.kind === "block" &&
			!roles.pathOperands.has(token) &&
			!pathExistsAt(token, callCwd) &&
			!(token.startsWith("@") && pathExistsAt(token.slice(1), callCwd))
		) {
			literalPolicy ??= {
				...zeroAccessPolicy,
				entries: zeroAccessPolicy.entries.filter((entry) => entry.pattern === undefined),
			};
			decision = evaluatePathPolicy(literalPolicy, "read", token, callCwd, memo);
		}
		if (decision.kind === "block") {
			return { verb: "read", token, entrySource: `zeroAccessPaths entry ${decision.matchedPath}` };
		}
	}
	// A write names its destination, not content it reads. Creating a new file
	// under a zero-access name (`cp .env.example .env.local`) exposes nothing;
	// truncating, appending to or replacing an existing one stays refused.
	for (const write of roles.writes) {
		for (const target of landedWriteTargets(write, callCwd)) {
			if (!pathExistsAt(target, callCwd)) continue;
			const decision = evaluatePathPolicy(zeroAccessPolicy, "write", target, callCwd);
			if (decision.kind === "block") {
				return { verb: "write", token: target, entrySource: `zeroAccessPaths entry ${decision.matchedPath}` };
			}
		}
	}
	for (const search of roles.searches) {
		const hit = recursiveSearchHit(search, zeroAccessPolicy, callCwd);
		if (hit !== null) return hit;
	}
	return null;
}

interface BashZeroAccessHit {
	verb: "read" | "write";
	token: string;
	entrySource: string;
	/** How to run the same command without reaching the protected file. */
	hint?: string;
}

/** The reason line both bash zero-access rails report. */
function bashZeroAccessReason(hit: BashZeroAccessHit): string {
	const base = `bash ${hit.verb} of zero-access path blocked: '${hit.token}' matches ${hit.entrySource}`;
	return hit.hint === undefined ? base : `${base}. ${hit.hint}`;
}

function pathExistsAt(target: string, cwd: string): boolean {
	const expanded = target === "~" ? homedir() : target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
	try {
		lstatSync(path.resolve(cwd, expanded));
		return true;
	} catch {
		return false;
	}
}

/** The file a write lands on: into an existing directory destination it is `dir/<source base name>`. */
function landedWriteTargets(write: BashWriteOperand, cwd: string): string[] {
	let directory = write.intoDirectory;
	if (!directory && write.sources.length > 0) {
		try {
			directory = statSync(path.resolve(cwd, write.target)).isDirectory();
		} catch {
			directory = false;
		}
	}
	if (!directory) return [write.target];
	return write.sources.map((source) => path.join(write.target, path.basename(source)));
}

interface BashWriteOperand {
	target: string;
	/** Source operands of cp/mv/install/ln; empty for redirects and tee. */
	sources: string[];
	/** `-t DIR`: the target is a directory the sources land in. */
	intoDirectory: boolean;
}

type RecursiveSearchTool = "grep" | "rg" | "ag" | "ack" | "git grep";

interface RecursiveSearch {
	tool: RecursiveSearchTool;
	roots: string[];
	/** Exclusion globs the command already passes (`--exclude`, `-g '!x'`, `--ignore`, `':!x'`). */
	excludes: string[];
	/** Directory-only exclusions (`--exclude-dir`, `--ignore-dir`). */
	excludeDirs: string[];
	/** git grep without --untracked or --no-index reads tracked files only. */
	trackedOnly: boolean;
}

interface BashOperandRoles {
	/** Words judged as reads: everything that is not a write destination, a search pattern or an exclusion. */
	reads: string[];
	/**
	 * The reads in a path position: an input redirect operand, a file operand of a known reader, a copy source or a
	 * search operand, and any word the shell expands (`$`, a backtick, an unquoted glob). Only these, and words naming
	 * a file that exists, meet glob entries such as `*.key`.
	 */
	pathOperands: Set<string>;
	writes: BashWriteOperand[];
	searches: RecursiveSearch[];
}

const ROLE_SEGMENT_SEPARATORS: ReadonlySet<string> = new Set([";", "&", "&&", "||", "|", "(", ")", "\n"]);
const ROLE_WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">&", ">|", "&>", "&>>"]);
const ROLE_OTHER_REDIRECTS: ReadonlySet<string> = new Set(["<", "<<", "<<<", "<&", "<>"]);
const ROLE_PREFIX_WRAPPERS: ReadonlySet<string> = new Set([
	"command",
	"builtin",
	"sudo",
	"doas",
	"env",
	"nohup",
	"time",
	"nice",
	"exec",
]);

/**
 * The role each word of a bash command plays for the zero-access rail.
 * Destinations of cp/mv/install/ln (the last operand, or `-t DIR`), tee files
 * and output redirect targets are writes; the pattern of a grep-family, rg,
 * ag, ack or git grep search and the values of its exclusion options name no
 * file; every other word is judged as a read exactly as
 * {@link bashPathTokenCandidates} judges it. Recursive searches are listed
 * with their roots so their walk can be judged.
 */
function bashOperandRoles(command: string): BashOperandRoles {
	command = withoutDataHeredocBodies(command, "stdin-only", "rails");
	const roles: BashOperandRoles = { reads: [], pathOperands: new Set(), writes: [], searches: [] };
	const inner = inlineShellScript(command);
	if (inner !== null && inner !== command) {
		const nested = bashOperandRoles(inner);
		roles.reads.push(...nested.reads);
		for (const operand of nested.pathOperands) roles.pathOperands.add(operand);
		roles.writes.push(...nested.writes);
		roles.searches.push(...nested.searches);
	}
	let segment: ShellToken[] = [];
	const flush = () => {
		if (segment.length > 0) segmentOperandRoles(segment, roles);
		segment = [];
	};
	for (const token of scanShellLikeDeep(command)) {
		if (token.operator && ROLE_SEGMENT_SEPARATORS.has(token.value)) flush();
		else segment.push(token);
	}
	flush();
	return roles;
}

function pushReadCandidate(token: string, reads: string[], pathOperands: Set<string> | null): void {
	if (token.length === 0) return;
	if (/\s/.test(token) && !token.includes("/")) return;
	if (token.startsWith("-") && !token.includes("/") && !token.includes("=")) return;
	reads.push(token);
	pathOperands?.add(token);
	const eq = token.indexOf("=");
	if (eq > 0 && eq < token.length - 1) {
		reads.push(token.slice(eq + 1));
		pathOperands?.add(token.slice(eq + 1));
	}
}

/**
 * Commands whose operands are files they open and print or hash: a word after one of these names a file even when it
 * does not exist yet (an earlier step may create it). Others reach a glob entry only through a word naming a file.
 */
const FILE_READERS: ReadonlySet<string> = new Set([
	"cat",
	"tac",
	"nl",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"batcat",
	"wc",
	"sort",
	"uniq",
	"cut",
	"paste",
	"join",
	"comm",
	"diff",
	"cmp",
	"base64",
	"base32",
	"basenc",
	"xxd",
	"od",
	"hexdump",
	"hd",
	"strings",
	"file",
	"stat",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"b2sum",
	"cksum",
	"source",
	".",
	"openssl",
	"ssh-keygen",
	"ssh-add",
	"gpg",
	"scp",
	"rsync",
	"tar",
	"zip",
	"gzip",
	"zcat",
	"xz",
	"bzip2",
	"zstd",
]);

/** Commands whose quoted patterns name the files they select, so every operand keeps the base judgement (FX-7). */
const FILE_FINDERS: ReadonlySet<string> = new Set(["find", "fd", "fdfind", "locate", "plocate", "mlocate", "slocate"]);

/** Reserved words that may stand before the command word of a segment (`if cat x.key; then`). */
const READER_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"{",
	"!",
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
]);

/** A word the shell expands before the command sees it, so its literal text is no file name to test. */
function shellExpandsWord(token: ShellToken): boolean {
	return /[$`]/u.test(token.value) || (!token.quoted && /[*?[{]/u.test(token.value));
}

function segmentOperandRoles(tokens: ReadonlyArray<ShellToken>, roles: BashOperandRoles): void {
	const skipped = new Set<ShellToken>();
	const inputs: ShellToken[] = [];
	const words: ShellToken[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (!token.operator) {
			words.push(token);
			continue;
		}
		const next = tokens[index + 1];
		if (next === undefined || next.operator) continue;
		// `2>err.log`: the descriptor number is part of the redirect, not an operand.
		const previous = words.at(-1);
		if (previous !== undefined && /^\d+$/u.test(previous.value) && previous.end === token.start) words.pop();
		if (ROLE_WRITE_REDIRECTS.has(token.value)) {
			skipped.add(next);
			index += 1;
			if (!(token.value === ">&" && /^(?:\d+|-)$/u.test(next.value))) {
				roles.writes.push({ target: next.value, sources: [], intoDirectory: false });
			}
		} else if (ROLE_OTHER_REDIRECTS.has(token.value)) {
			// Input redirects stay reads; they are just not command arguments. `< f` and `<> f` open a file, while a
			// here-document delimiter and a here-string are text.
			if (token.value === "<" || token.value === "<>") inputs.push(next);
			index += 1;
		}
	}
	let at = 0;
	let wrapped = false;
	while (at < words.length) {
		const word = words[at]?.value ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) || (wrapped && word.startsWith("-"))) at += 1;
		else if (ROLE_PREFIX_WRAPPERS.has(word)) {
			wrapped = true;
			at += 1;
		} else break;
	}
	const positioned = new Set<ShellToken>(inputs);
	const head = words[at];
	if (head !== undefined) {
		const name = path.basename(head.value);
		const args = words.slice(at + 1);
		let reader = at;
		while (READER_PREFIX_WORDS.has(words[reader]?.value ?? "")) reader += 1;
		const readerWord = words[reader]?.value ?? "";
		// A program named by path (`./tool`, `bin/run`) is the workspace's own code, so any operand may be a file it opens.
		// A file finder's pattern (`find -name '*.key'`) selects the files its -exec or a later xargs reads.
		const readerName = path.basename(readerWord);
		if (FILE_READERS.has(readerName) || FILE_FINDERS.has(readerName) || readerWord.includes("/")) {
			for (const arg of words.slice(reader + 1)) positioned.add(arg);
		}
		if (name === "cp" || name === "mv" || name === "install" || name === "ln") {
			for (const arg of args) positioned.add(arg);
			copyOperandRoles(name, args, skipped, roles);
		} else if (name === "tee") {
			for (const arg of args) {
				if (arg.value.startsWith("-")) continue;
				skipped.add(arg);
				roles.writes.push({ target: arg.value, sources: [], intoDirectory: false });
			}
		} else if (name === "clio-coder" && head.value === name) settingsPathOperand(args, skipped);
		else if (searchOperandRoles(name, args, skipped, roles)) {
			// What the search leaves after its pattern and exclusions are the files and roots it opens.
			for (const arg of args) positioned.add(arg);
		}
	}
	for (const token of tokens) {
		if (token.operator || skipped.has(token)) continue;
		// An unquoted word spelled with a separator (`../x.key`) is a path wherever it stands; a quoted script is not.
		const pathPosition = positioned.has(token) || shellExpandsWord(token) || (!token.quoted && token.value.includes("/"));
		pushReadCandidate(token.value, roles.reads, pathPosition ? roles.pathOperands : null);
	}
}

/** A dotted settings path such as `safety.scratchRoots`: no slash, so it never names a file below a directory. */
const SETTINGS_PATH = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/u;

/**
 * `clio-coder config get|set|unset <path>`: the dotted path names a setting, not a file, so `nope.key` is not read as
 * a key file (LEAD-2). Only the bare launcher on PATH counts, since a workspace script of that name could read its
 * argument; the value of `set` stays a read candidate.
 */
function settingsPathOperand(args: ReadonlyArray<ShellToken>, skipped: Set<ShellToken>): void {
	const words = args.filter((token, index) => !token.value.startsWith("-") && args[index - 1]?.value !== "--scope");
	const [command, verb, setting] = words;
	if (command?.value !== "config" || setting === undefined) return;
	if (["get", "set", "unset"].includes(verb?.value ?? "") && SETTINGS_PATH.test(setting.value)) skipped.add(setting);
}

/** Short options of cp/mv/install/ln that take a value. */
const COPY_VALUE_LETTERS: Readonly<Record<string, string>> = { cp: "St", mv: "St", install: "gmoSt", ln: "St" };
const COPY_VALUE_LONG: ReadonlyArray<string> = ["--suffix", "--mode", "--owner", "--group", "--strip-program"];

function copyOperandRoles(
	name: string,
	args: ReadonlyArray<ShellToken>,
	skipped: Set<ShellToken>,
	roles: BashOperandRoles,
): void {
	const operands: ShellToken[] = [];
	let targetDir: string | null = null;
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		const arg = token.value;
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			operands.push(token);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const takesValue =
				abbreviatesLongOption(arg, "--target-directory") ||
				COPY_VALUE_LONG.some((option) => abbreviatesLongOption(arg, option));
			if (!takesValue) continue;
			const valueToken = eq === -1 ? args[index + 1] : token;
			const value = eq === -1 ? valueToken?.value : arg.slice(eq + 1);
			if (eq === -1) index += 1;
			if (abbreviatesLongOption(arg, "--target-directory") && value !== undefined && valueToken !== undefined) {
				targetDir = value;
				skipped.add(valueToken);
			}
			continue;
		}
		const letters = COPY_VALUE_LETTERS[name] ?? "";
		for (let offset = 1; offset < arg.length; offset += 1) {
			const letter = arg[offset] ?? "";
			if (!letters.includes(letter)) continue;
			const attached = arg.slice(offset + 1);
			const valueToken = attached.length > 0 ? token : args[index + 1];
			if (attached.length === 0) index += 1;
			if (letter === "t" && valueToken !== undefined) {
				targetDir = attached.length > 0 ? attached : valueToken.value;
				skipped.add(valueToken);
			}
			break;
		}
	}
	if (targetDir !== null) {
		roles.writes.push({ target: targetDir, sources: operands.map((operand) => operand.value), intoDirectory: true });
		return;
	}
	const destination = operands.at(-1);
	if (destination === undefined || operands.length < 2) return;
	skipped.add(destination);
	roles.writes.push({
		target: destination.value,
		sources: operands.slice(0, -1).map((operand) => operand.value),
		intoDirectory: false,
	});
}

interface SearchSyntax {
	/** Short options that take a value. */
	valueLetters: string;
	/** Long options that take a value (also as an unambiguous prefix). */
	valueLong: ReadonlyArray<string>;
	/** Options whose value is the pattern. */
	patternShort: string;
	patternLong: ReadonlyArray<string>;
	/** Options whose value is a file of patterns: an explicit pattern, the file itself still read. */
	patternFileShort: string;
	patternFileLong: ReadonlyArray<string>;
}

const GREP_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efmABCdD",
	valueLong: [
		"--regexp",
		"--file",
		"--max-count",
		"--include",
		"--exclude",
		"--exclude-dir",
		"--exclude-from",
		"--context",
		"--after-context",
		"--before-context",
		"--directories",
		"--devices",
		"--label",
		"--binary-files",
	],
	patternShort: "e",
	patternLong: ["--regexp"],
	patternFileShort: "f",
	patternFileLong: ["--file"],
};
const RG_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efABCmgtTjMrE",
	valueLong: [
		"--regexp",
		"--file",
		"--glob",
		"--iglob",
		"--type",
		"--type-not",
		"--type-add",
		"--type-clear",
		"--max-count",
		"--context",
		"--after-context",
		"--before-context",
		"--max-columns",
		"--threads",
		"--replace",
		"--encoding",
		"--max-depth",
		"--ignore-file",
		"--sort",
		"--sortr",
		"--pre",
		"--pre-glob",
		"--path-separator",
		"--context-separator",
		"--field-match-separator",
		"--colors",
		"--engine",
		"--max-filesize",
	],
	patternShort: "e",
	patternLong: ["--regexp"],
	patternFileShort: "f",
	patternFileLong: ["--file"],
};
const AG_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "ABCGgm",
	valueLong: [
		"--ignore",
		"--ignore-dir",
		"--file-search-regex",
		"--depth",
		"--context",
		"--after",
		"--before",
		"--max-count",
		"--pager",
		"--workers",
	],
	patternShort: "",
	patternLong: [],
	patternFileShort: "",
	patternFileLong: [],
};
const ACK_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "ABCm",
	valueLong: ["--ignore-file", "--ignore-dir", "--ignore-directory", "--type", "--max-count", "--context"],
	patternShort: "",
	patternLong: [],
	patternFileShort: "",
	patternFileLong: [],
};
const GIT_GREP_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efmABC",
	valueLong: ["--max-depth", "--max-count", "--context", "--after-context", "--before-context", "--threads"],
	patternShort: "e",
	patternLong: [],
	patternFileShort: "f",
	patternFileLong: [],
};

interface ParsedSearch {
	positionals: ShellToken[];
	/** Option values with the option that carried them (`--exclude`, `-g`, ...). */
	values: Array<{ option: string; value: string; token: ShellToken; attached: boolean }>;
	explicitPattern: boolean;
	flags: string[];
}

function parseSearchArgs(args: ReadonlyArray<ShellToken>, syntax: SearchSyntax): ParsedSearch {
	const parsed: ParsedSearch = { positionals: [], values: [], explicitPattern: false, flags: [] };
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		const arg = token.value;
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			parsed.positionals.push(token);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		parsed.flags.push(arg);
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const option = syntax.valueLong.find((candidate) =>
				eq === -1 ? arg === candidate : arg.slice(0, eq) === candidate,
			);
			if (option === undefined) continue;
			if (syntax.patternLong.includes(option) || syntax.patternFileLong.includes(option)) parsed.explicitPattern = true;
			if (eq !== -1) parsed.values.push({ option, value: arg.slice(eq + 1), token, attached: true });
			else {
				const next = args[index + 1];
				index += 1;
				if (next !== undefined) parsed.values.push({ option, value: next.value, token: next, attached: false });
			}
			continue;
		}
		for (let offset = 1; offset < arg.length; offset += 1) {
			const letter = arg[offset] ?? "";
			if (!syntax.valueLetters.includes(letter)) continue;
			if (syntax.patternShort.includes(letter) || syntax.patternFileShort.includes(letter)) parsed.explicitPattern = true;
			const attached = arg.slice(offset + 1);
			const option = `-${letter}`;
			if (attached.length > 0) parsed.values.push({ option, value: attached, token, attached: true });
			else {
				const next = args[index + 1];
				index += 1;
				if (next !== undefined) parsed.values.push({ option, value: next.value, token: next, attached: false });
			}
			break;
		}
	}
	return parsed;
}

const GREP_SEARCH_NAMES: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "zgrep"]);

/** Options whose value only narrows what a search reads: it names no file to read. */
const EXCLUSION_OPTIONS: ReadonlySet<string> = new Set([
	"--exclude",
	"--exclude-dir",
	"--include",
	"-g",
	"--glob",
	"--iglob",
	"--ignore",
	"--ignore-dir",
	"--ignore-directory",
	"--ignore-file",
]);

function searchOperandRoles(
	name: string,
	rawArgs: ReadonlyArray<ShellToken>,
	skipped: Set<ShellToken>,
	roles: BashOperandRoles,
): boolean {
	let tool: RecursiveSearchTool;
	let syntax: SearchSyntax;
	let args = rawArgs;
	if (GREP_SEARCH_NAMES.has(name)) {
		tool = "grep";
		syntax = GREP_SEARCH_SYNTAX;
	} else if (name === "rg") {
		tool = "rg";
		syntax = RG_SEARCH_SYNTAX;
	} else if (name === "ag") {
		tool = "ag";
		syntax = AG_SEARCH_SYNTAX;
	} else if (name === "ack") {
		tool = "ack";
		syntax = ACK_SEARCH_SYNTAX;
	} else if (name === "git") {
		// git [-C dir] [-c k=v] [--flags] grep ...
		let index = 0;
		while (index < rawArgs.length) {
			const value = rawArgs[index]?.value ?? "";
			if (value === "-C" || value === "-c") index += 2;
			else if (value.startsWith("-")) index += 1;
			else break;
		}
		if (rawArgs[index]?.value !== "grep") return false;
		tool = "git grep";
		syntax = GIT_GREP_SEARCH_SYNTAX;
		args = rawArgs.slice(index + 1);
	} else return false;
	const parsed = parseSearchArgs(args, syntax);
	// The pattern (and an -e value) is a regular expression, never opened.
	for (const entry of parsed.values) {
		if (entry.attached) {
			if (entry.option === `-${syntax.patternShort}` || syntax.patternLong.includes(entry.option))
				skipped.add(entry.token);
			continue;
		}
		if (
			(syntax.patternShort.length > 0 && entry.option === `-${syntax.patternShort}`) ||
			syntax.patternLong.includes(entry.option) ||
			EXCLUSION_OPTIONS.has(entry.option)
		)
			skipped.add(entry.token);
	}
	for (const entry of parsed.values) {
		if (entry.attached && EXCLUSION_OPTIONS.has(entry.option)) skipped.add(entry.token);
	}
	const listsOnly = tool === "rg" && parsed.flags.includes("--files");
	const positionals = [...parsed.positionals];
	if (!parsed.explicitPattern && !listsOnly) {
		const pattern = positionals.shift();
		if (pattern !== undefined) skipped.add(pattern);
	}
	const recursive = tool === "grep" ? recursesDirectories(args.map((arg) => arg.value)) : tool !== "rg" || !listsOnly;
	if (!recursive) return true;
	const excludes: string[] = [];
	const excludeDirs: string[] = [];
	for (const entry of parsed.values) {
		const value = entry.value;
		if (tool === "grep" && entry.option === "--exclude") excludes.push(value);
		else if (tool === "grep" && entry.option === "--exclude-dir") excludeDirs.push(value);
		else if (tool === "rg" && ["-g", "--glob", "--iglob"].includes(entry.option) && value.startsWith("!"))
			excludes.push(value.slice(1));
		else if (tool === "ag" && entry.option === "--ignore") excludes.push(value);
		else if (tool === "ag" && entry.option === "--ignore-dir") excludeDirs.push(value);
		else if (tool === "ack" && entry.option === "--ignore-file" && value.startsWith("is:")) excludes.push(value.slice(3));
		else if (tool === "ack" && (entry.option === "--ignore-dir" || entry.option === "--ignore-directory"))
			excludeDirs.push(value);
	}
	const roots: string[] = [];
	for (const positional of positionals) {
		const value = positional.value;
		if (tool === "git grep") {
			const exclusion = /^:(?:!|\^|\(exclude\))(.+)$/u.exec(value);
			if (exclusion?.[1] !== undefined) {
				excludes.push(exclusion[1]);
				skipped.add(positional);
				continue;
			}
			if (value.startsWith(":")) continue;
		}
		roots.push(value);
	}
	roles.searches.push({
		tool,
		roots: roots.length === 0 ? ["."] : roots,
		excludes,
		excludeDirs,
		trackedOnly: tool === "git grep" && !parsed.flags.includes("--untracked") && !parsed.flags.includes("--no-index"),
	});
	return true;
}

function globExpression(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index += 1;
				if (glob[index + 1] === "/") index += 1;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	}
	return new RegExp(`^${source}$`, "u");
}

/** True when one of `globs` matches the base name or the root-relative path. */
function matchesAnyGlob(globs: ReadonlyArray<string>, name: string, relative: string): boolean {
	return globs.some((glob) => {
		const expression = globExpression(glob.replace(/^\.\//u, "").replace(/\/$/u, ""));
		return expression.test(name) || expression.test(relative);
	});
}

interface ProtectedTreeEntry {
	/** Path relative to the search root, `/`-separated. */
	relative: string;
	absolute: string;
	directory: boolean;
	matchedPath: string;
}

const RECURSIVE_SEARCH_MEMO_TTL_MS = 5_000;
const RECURSIVE_SEARCH_MEMO_LIMIT = 64;
const recursiveSearchMemo = new Map<string, { at: number; stamp: number; entries: ProtectedTreeEntry[] }>();

/**
 * The zero-access files and directories below `root`, found by a walk bounded
 * the way the sandbox's secret discovery is (its depth, entry budget and
 * skipped dependency trees). Memoized briefly per root and policy, keyed on
 * the root's mtime so a secret created beside the project is seen at once.
 * A walk that runs out of budget reports what it found; the rest is the
 * sandbox's to hide.
 */
function protectedEntriesUnder(root: string, policy: CompiledPathPolicy): ProtectedTreeEntry[] {
	let stamp: number;
	try {
		stamp = statSync(root).mtimeMs;
	} catch {
		return [];
	}
	const key = [root, ...policy.entries.map((entry) => `${entry.kind}:${entry.source}:${entry.path}`)].join("\0");
	const now = Date.now();
	const cached = recursiveSearchMemo.get(key);
	if (cached !== undefined && cached.stamp === stamp && now - cached.at < RECURSIVE_SEARCH_MEMO_TTL_MS)
		return cached.entries;
	const entries: ProtectedTreeEntry[] = [];
	const pending: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
	let visited = 0;
	walk: for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		const directory = frame.relative.length === 0 ? root : path.join(root, frame.relative);
		let listing: Dirent[];
		try {
			listing = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of listing) {
			visited += 1;
			if (visited > SECRET_SCAN_LIMITS.entryBudget) break walk;
			const relative = frame.relative.length === 0 ? entry.name : `${frame.relative}/${entry.name}`;
			const absolute = path.join(root, relative);
			const decision = evaluatePathPolicy(policy, "read", absolute, root);
			const isDirectory = entry.isDirectory();
			if (decision.kind === "block") {
				entries.push({ relative, absolute, directory: isDirectory, matchedPath: decision.matchedPath });
				continue;
			}
			if (isDirectory && !isSkippedSecretScanDirectory(entry.name) && frame.depth + 1 < SECRET_SCAN_LIMITS.depth) {
				pending.push({ relative, depth: frame.depth + 1 });
			}
		}
	}
	if (recursiveSearchMemo.size >= RECURSIVE_SEARCH_MEMO_LIMIT) recursiveSearchMemo.clear();
	recursiveSearchMemo.set(key, { at: now, stamp, entries });
	return entries;
}

/**
 * The subset of `entries` git tracks in `cwd`'s work tree; all of them when git cannot tell. This runs on the host
 * while a command is judged, in whatever repository `cwd` is in, so it is internal git: ls-files would otherwise run
 * that repository's core.fsmonitor program, which a contained command can write into a repository it creates.
 */
function trackedEntries(entries: ReadonlyArray<ProtectedTreeEntry>, cwd: string): ProtectedTreeEntry[] {
	if (entries.length === 0) return [];
	let argv: string[];
	try {
		argv = internalGitArgv(["ls-files", "-z", "--", ...entries.map((entry) => entry.absolute)], cwd);
	} catch {
		return [...entries];
	}
	const result = spawnSync("git", argv, {
		cwd,
		encoding: "utf8",
		timeout: 2_000,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return [...entries];
	const tracked = new Set(
		result.stdout
			.split("\0")
			.filter((line) => line.length > 0)
			.map((line) => path.resolve(cwd, line)),
	);
	return entries.filter(
		(entry) => entry.directory || [...tracked].some((file) => isSameOrDescendant(file, entry.absolute)),
	);
}

function exclusionHint(tool: RecursiveSearchTool, name: string, relative: string, directory: boolean): string {
	switch (tool) {
		case "grep":
			return directory ? `--exclude-dir=${name}` : `--exclude=${name}`;
		case "rg":
			return `-g '!${name}'`;
		case "ag":
			return `--ignore=${name}`;
		case "ack":
			return directory ? `--ignore-dir=${name}` : `--ignore-file=is:${name}`;
		case "git grep":
			return `':!${relative}'`;
	}
}

/**
 * A recursive search prints what it finds in every file under its roots, so a
 * root that holds a zero-access file reads it as surely as `cat` would. The
 * first protected entry the command does not already exclude refuses it, with
 * the exclusion that lets the same search run.
 */
function recursiveSearchHit(
	search: RecursiveSearch,
	policy: CompiledPathPolicy,
	cwd: string,
): BashZeroAccessHit | null {
	for (const raw of search.roots) {
		const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
		const root = path.resolve(cwd, expanded);
		let isDirectory: boolean;
		try {
			isDirectory = statSync(root).isDirectory();
		} catch {
			continue;
		}
		// A file root is an operand the read rail already judged.
		if (!isDirectory) continue;
		let found = protectedEntriesUnder(root, policy);
		if (search.trackedOnly) found = trackedEntries(found, cwd);
		for (const entry of found) {
			const segments = entry.relative.split("/");
			const name = segments.at(-1) ?? entry.relative;
			const ancestors = segments.slice(0, -1);
			const excludedByDir =
				ancestors.some((dir) => matchesAnyGlob(search.excludeDirs, dir, dir)) ||
				(entry.directory && matchesAnyGlob(search.excludeDirs, name, entry.relative));
			const excluded =
				excludedByDir ||
				matchesAnyGlob(search.excludes, name, entry.relative) ||
				ancestors.some((dir, index) =>
					search.tool === "grep" ? false : matchesAnyGlob(search.excludes, dir, segments.slice(0, index + 1).join("/")),
				);
			if (excluded) continue;
			const shown = path.relative(cwd, entry.absolute) || entry.relative;
			const exclusion = exclusionHint(search.tool, name, path.relative(cwd, entry.absolute), entry.directory);
			return {
				verb: "read",
				token: shown,
				entrySource: `zeroAccessPaths entry ${entry.matchedPath} (reached by the recursive ${search.tool} search)`,
				hint: `Exclude it so the search never opens it: add ${exclusion}`,
			};
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
		let decision = evaluatePathPolicy(
			target.operation === "delete" ? deletePolicy : policy,
			target.operation,
			target.path,
			callCwd,
			memo,
		);
		// A bash write that creates a new file under a zero-access name
		// (`cp .env.example .env.local`) exposes no secret; overwriting an
		// existing one stays refused. The other path rails still judge it.
		if (
			decision.kind === "block" &&
			decision.policyKind === "zeroAccessPaths" &&
			target.operation === "write" &&
			call.tool === ToolNames.Bash &&
			!pathExistsAt(target.path, callCwd)
		) {
			decision = evaluatePathPolicy(
				{ ...policy, entries: policy.entries.filter((entry) => entry.kind !== "zeroAccessPaths") },
				"write",
				target.path,
				callCwd,
				memo,
			);
		}
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
		case ToolNames.Count:
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
		case ToolNames.Store: {
			// put reads its workspace source the way data reads its file, so a
			// zero-access source is refused before the bytes are copied out.
			const target = args?.op === "put" ? pathArg(args) : null;
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
				(/\$(?:[A-Za-z_{0-9@*#?!-])/.test(maskPrintedExitStatus(command)) ||
					/(?:^|[\s;&|])(?:python[\d.]*|node|ruby|perl|php|lua)\s+(?:[^\n]*?\s)?-[ce]\b/.test(command))))
	) {
		return {
			kind: "ask",
			reasonCode: "bash-hidden-content",
			ruleId: "bash-hidden-content",
			reasons: [
				"shell variables, unparsed shell scripts or interpreter source hide which paths it touches from the safety net, so each such command needs your approval",
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
	// judging the wrapper instead is what let the wrapper be a bypass. Only the
	// bare form qualifies; an env prefix, extra operand, redirect or startup
	// option would run beside the script unexamined, so that line is judged whole.
	const recognitionSource = bareInlineShellScript(command) ?? command;
	const recognitionCommand = decodedAnsiCCommand(recognitionSource) ?? recognitionSource;
	if (
		(hasCommandSubstitution(command) || hasCommandSubstitution(recognitionCommand)) &&
		posture !== "confirmed" &&
		posture !== "yolo" &&
		!contained
	) {
		return {
			kind: "ask",
			ruleId: "bash-command-substitution",
			reasonCode: "bash-command-substitution",
			reasons: [
				"command substitution hides what will actually run from the safety net, so each such command needs your approval",
			],
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
	if (MAKE_CLEAN_COMMAND.re.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: MAKE_CLEAN_COMMAND.id,
			reasonCode: MAKE_CLEAN_COMMAND.id,
			reasons: [
				`matched built-in clean step '${MAKE_CLEAN_COMMAND.id}'`,
				projectScriptPreview(recognitionCommand, callCwd),
			],
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

interface TaskGateUnderJudgment {
	command: string;
	/** The worker's OS sandbox writes nothing. */
	confined: boolean;
	/** The worker could run the gate in the main-session sandbox. */
	containable: boolean;
}

/** Rule id of a verifier's task gate the scan passed, run in a sandbox that writes nothing. */
export const TASK_GATE_RULE_ID = "verify-task-gate";

/** Rule id of a task gate refused because bash would have asked for the same argv. */
export const TASK_GATE_REFUSED_RULE_ID = "verify-task-gate-asks";

/**
 * A gate the verifier's dispatched task names. The scan's rails still block or
 * ask; what it passed as unrecognized becomes recognized only when the worker
 * runs it under bubblewrap with no writable roots, so the gate can change
 * nothing. Anywhere else a gate gets exactly the admission bash would give the
 * same argv, so task text cannot carry an unrecognized command past an ask.
 */
function taskGatePolicy<T extends Pick<SafetyPolicyDecision, "kind" | "execRecognition" | "reasons">>(
	bash: T,
	confined: boolean,
): T {
	if (bash.kind !== "allow" || bash.execRecognition !== "unrecognized" || !confined) return bash;
	return {
		...bash,
		ruleId: TASK_GATE_RULE_ID,
		reasonCode: TASK_GATE_RULE_ID,
		reasons: [
			"a gate the dispatched verifier task names, run as plain argv inside the worker's OS sandbox",
			...bash.reasons,
		],
		execRecognition: "recognized",
	};
}

/** Rule id of an execute-class MCP tool call, whose admission the autonomy level decides. */
export const MCP_EXECUTE_RULE_ID = "mcp-execute";

/**
 * An execute-class MCP tool call through its launch vector's shell scan. The
 * scan's rails still block or ask, but no recognition of the launch command,
 * by the allowlist or an approved project policy, says anything about the
 * tool call, so an allowed call is never recognized and carries the MCP trust
 * rule rather than a bash or project rule.
 */
function mcpExecutePolicy<T extends Pick<SafetyPolicyDecision, "kind">>(bash: T): T {
	if (bash.kind !== "allow") return bash;
	return {
		...bash,
		ruleId: MCP_EXECUTE_RULE_ID,
		reasonCode: MCP_EXECUTE_RULE_ID,
		reasons: [
			"an execute-class MCP tool call runs on its trusted server's own process, outside the main-session sandbox; the autonomy level decides admission",
		],
		policySource: "mcp-trust",
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

function gateDecision(
	kind: "ask" | "block",
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
	if (input.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX)) rejectionInput.floor = true;
	const rejection = formatRejection(rejectionInput);
	return { ...base, ...input, kind, rejection };
}

/** Why the floor reads a line as raw text. */
const RAW_TEXT_REASON = "a line holding a command substitution is also read as raw text, quotes dropped";

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
	return command !== null && hasUnparsedShellScript(command) && shellScriptSources(command).sources.length > 0;
}

/** The `RUN_SCRIPT_INTERPRETERS` entries that read their script as shell source (#421). */
const RUN_SCRIPT_SHELLS: ReadonlySet<string> = new Set<RunScriptInterpreter>(["bash", "sh"]);

/** True when run_script hands its script to a shell, the only interpreter whose lines the floor scan can read. */
function runsUnderShell(args: Record<string, unknown> | undefined): boolean {
	const interpreter = args?.interpreter;
	return typeof interpreter === "string" && RUN_SCRIPT_SHELLS.has(interpreter.trim());
}

/** Why yolo refuses a command when `safety.sandbox` is `required` and the host has no backend. */
const YOLO_SANDBOX_REFUSED =
	'safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; use a typed tool, or have the operator set safety.sandbox to auto';

/** Why yolo refuses an outward line it would have run inside, when `safety.sandbox` is `required` and the host has no backend. */
const YOLO_SANDBOX_REFUSED_OUTWARD =
	'safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; an outward command runs only alone on its line, with literal arguments and only the options its CLI is allowed, from the workspace repository';

/** Why yolo refuses `unsandboxed: true` when `safety.sandbox` is `required`. */
const YOLO_SANDBOX_NOT_LEFT =
	'safety.sandbox is "required", so yolo does not run this command outside the sandbox; drop unsandboxed: true, or have the operator set safety.sandbox to auto';

/** Rule id of that refusal, a ceiling the operator set (#407). */
const YOLO_SANDBOX_REQUIRED_RULE_ID = "yolo-sandbox-required";

/** Reason code prefix of a call yolo admitted past a rail that would have asked or blocked (#407). */
export const YOLO_ADMITTED_REASON_PREFIX = "yolo-admitted:";

/**
 * Net blocks that hold at yolo besides the floor and operator rules: the
 * run's write-root ceiling, a call that cannot run as given, and an approved
 * project policy that no longer parses, whose operator rules cannot be read.
 */
const YOLO_HELD_RULE_IDS: ReadonlySet<string> = new Set([
	"write-root",
	"bash-empty-command",
	"oversized-path",
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
	/** Set when a sourced name with no slash was looked up while the bash tool's PATH was still being captured. */
	pathPending: boolean;
	/** The scripts the call runs that the scan could not place or read, each with why and where it is run. */
	unplaced: UnplacedChild[];
}

/** One script the scan could not place or read: its operand or path as written, and why and where it runs. */
interface UnplacedChild {
	name: string;
	note: string;
}

function newScriptBudget(): ScriptBudget {
	return { remaining: FLOOR_SCRIPT_SCAN_BYTES, pathPending: false, unplaced: [] };
}

/** Rule id of a call the floor could not finish reading because a script it runs cannot be placed or read (row 215). */
const SCRIPT_UNPLACEABLE_RULE_ID = "script-unplaceable";

/** Most unplaced scripts the reason names before it counts the rest. */
const SCRIPT_UNPLACEABLE_NAMED = 3;

/** The safety judge's longest finding line; the reason fits it, so the judge never sees it cut without a mark. */
const SCRIPT_UNPLACEABLE_REASON_CHARS = 400;

const SCRIPT_UNPLACEABLE_LEAD = "the floor could not place or read a script this call runs, so the judge decides it: ";

/**
 * Text on one line in at most `max` characters. A longer one keeps its head and its tail around a marker naming how
 * many characters were cut, so neither end of an operand is hidden and the judge sees the cut (row 215).
 */
function elided(text: string, max: number): string {
	const folded = text.replace(/\s+/gu, " ");
	if (folded.length <= max) return folded;
	const marker = (cut: number) => `...<${cut} chars>...`;
	const keep = Math.max(0, max - marker(folded.length).length);
	const head = Math.ceil(keep / 2);
	return `${folded.slice(0, head)}${marker(folded.length - keep)}${folded.slice(folded.length - (keep - head))}`;
}

function scriptUnplaceableReason(unplaced: ReadonlyArray<UnplacedChild>): string {
	const children = [...new Map(unplaced.map((child) => [`${child.name}\n${child.note}`, child])).values()];
	const shown = children.slice(0, SCRIPT_UNPLACEABLE_NAMED);
	const more =
		children.length > SCRIPT_UNPLACEABLE_NAMED ? `; and ${children.length - SCRIPT_UNPLACEABLE_NAMED} more` : "";
	// Each named child gets an equal share of the finding, less the `; ` between them; its name comes first.
	const room =
		Math.floor((SCRIPT_UNPLACEABLE_REASON_CHARS - SCRIPT_UNPLACEABLE_LEAD.length - more.length) / shown.length) - 2;
	const entries = shown.map((child) => {
		if (child.note === "") return elided(child.name, room);
		const name = elided(child.name, room - Math.min(child.note.length, Math.ceil(room / 2)) - 1);
		return `${name} ${elided(child.note, room - name.length - 1)}`;
	});
	return `${SCRIPT_UNPLACEABLE_LEAD}${entries.join("; ")}${more}`;
}

/** True for an operand the shell names at run time: a variable, substitution, glob, process substitution or `~-`/`~user`. */
function runTimeName(operand: string): boolean {
	return (
		/[$`*?[{]/u.test(operand) ||
		/^[<>]\(/u.test(operand) ||
		(operand.startsWith("~") && operand !== "~" && !operand.startsWith("~/"))
	);
}

/**
 * True when a command may set HOME before a script it names runs, so a leading `~` or `$HOME` there may not be the
 * operator's home (row 215): it names HOME other than to read it (`HOME=`, `HOME+=`, `unset HOME`, `read HOME`,
 * `for HOME in`, `${HOME:=x}`), with quotes or not, or runs eval, or hands a builtin that assigns a name it builds.
 */
function commandMayChangeHome(command: string): boolean {
	const unquoted = command.replace(/["'\\]/gu, "");
	if (/HOME/u.test(unquoted.replace(/\$(?:HOME(?!\w)|\{HOME\})/gu, ""))) return true;
	return shellCommandSteps(command).some((step) => {
		if (step.executable === "eval") return true;
		if (/^(?:declare|typeset|local|export|readonly|let)$/u.test(step.executable))
			return step.args.some((arg) => !arg.startsWith("-") && !/^[A-Za-z_]\w*(?:\+?=|$)/u.test(arg));
		if (/^(?:read|mapfile|readarray|unset|getopts)$/u.test(step.executable))
			return step.args.some((arg) => arg.includes("$") || arg.includes("`"));
		return step.executable === "printf" && step.args.some((arg) => arg.startsWith("-v"));
	});
}

/** True for an operand that starts with the home directory: `~` or `~/`, as the parse writes a placed `$HOME` too. */
function homeOperand(operand: string): boolean {
	return operand === "~" || operand.startsWith("~/");
}

/** Why and where the scan could not place a script operand: a name the shell builds at run time, or a relative name from an unknown directory. */
function unplacedNote(operand: string, where: string): string {
	return `(${runTimeName(operand) ? "named at run time" : "directory unknown"}), ${where}`;
}

/** Records a script the scan could not place or read; the reason names each once. */
function recordUnplaced(budget: ScriptBudget, name: string, note = ""): void {
	budget.unplaced.push({ name, note });
}

/** Rule id of a call the floor could not place because a bare `source name` waits on the login capture. */
const LOGIN_PATH_PENDING_RULE_ID = "login-path-pending";

const LOGIN_PATH_PENDING_REASON =
	"the login environment bash commands run with is still being captured, so which file a bare `source name` loads is unknown; the call is judged instead of resolved on the PATH Clio was launched with";

/** What unconfined yolo, which has no judge, adds to that reason. */
const LOGIN_PATH_PENDING_YOLO_HOLD =
	"yolo holds it until the capture settles, which happens once per session; run it again in a moment";

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

function copyWrittenPaths(written: WrittenPaths): WrittenPaths {
	return { files: new Set(written.files), trees: new Set(written.trees) };
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
	shellOnly = false,
	homeKnown = true,
): ScriptHit | null {
	const operand = script.path;
	const where = script.sourced ? "sourced by the command" : "run by the command";
	// A program run by its own path may be any binary, so a name the scan cannot place keeps today's rails; a sourced
	// name or one handed to a shell is a script, and the judge decides it (row 215).
	const unplaced = (name = operand, note = unplacedNote(operand, where)) => {
		if (!shellOnly) recordUnplaced(budget, name, note);
		return null;
	};
	// A home the command may move first is not the operator's (row 215).
	if (!homeKnown && homeOperand(operand)) return unplaced(operand, `(HOME may change before it runs), ${where}`);
	const candidates = scriptCandidates(operand, cwds, budget, script.sourced);
	if (candidates.includes(null)) return unplaced();
	// Each candidate is skipped on its own: rewriting one copy leaves another that bash may load (CLI-P31).
	const files = (candidates as string[]).filter((file) => {
		if (isWrittenFirst(file, written)) return false;
		const kind = pathKind(file);
		if (kind === "unreachable") unplaced(file, `(unreadable), ${where}`);
		return kind === "file";
	});
	// `bash x.sh` runs with `$0` as written; on standard input `$0` names the shell.
	const name = homeOperand(operand) ? expandPath(operand) : operand;
	const names: ScriptNames = script.stdin ? { zero: null, source: null } : { zero: name, source: name };
	for (const file of files) {
		// A program run by path is read only when it is shell source; a binary or another interpreter is not (CLI-P31).
		if (shellOnly && yoloFloorShellScript(file) !== true) continue;
		const scan = scanNamedScript(file, floorLine, callCwd, cwds, budget, names, homeKnown);
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
	homeKnown = true,
): ScriptHit | null {
	const scan: ScriptScan = { floorLine, callCwd, budget, written: newWrittenPaths() };
	const shell = newScriptShell(cwds);
	// A HOME the command may set first is not known inside the script either (row 215).
	if (!homeKnown) shell.vars.delete("HOME");
	return scanScript(file, scan, shell, newScriptReader("plain", names));
}

/**
 * The first line of a script the floor refuses (#407). Each line is judged
 * from every directory the script can be in by then, with the literal
 * variables assigned before it substituted, and the scan follows the scripts
 * its lines `source`, run through a shell or `exec` by literal path. What the
 * scan cannot follow (a binary file, a script written first, a nesting deeper
 * than the limit) is skipped, and what it cannot place or read (a name built
 * at run time, a relative name from an unknown directory, an unreadable file,
 * one over the byte budget) is recorded on the budget for the safety judge;
 * neither stops the scan, so a script nothing on the floor touches runs.
 * Backslash continuations join before matching.
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
		if (!info.isFile()) return null;
		// A binary `exec` target is a program, not a script to read, and costs none of the budget.
		if (info.size > scan.budget.remaining) {
			if (!binaryHead(file))
				recordUnplaced(scan.budget, file, `(past the floor's ${FLOOR_SCRIPT_SCAN_BYTES}-byte script budget)`);
			return null;
		}
		text = readFileSync(file, "utf8");
		if (text.includes("\0")) return null;
		scan.budget.remaining -= info.size;
	} catch (error) {
		// A missing script fails to run; one the scan cannot read is judged instead of run unread (row 215).
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") recordUnplaced(scan.budget, file, "(unreadable)");
		return null;
	}
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
		// A line the scan cannot follow (a loop cd, eval, a name reference, a HOME or CDPATH assignment) leaves the
		// script's directory and its variables unknown, so a later relative child or one built from a variable, HOME
		// included, is judged instead of placed from a stale value (row 215).
		if (advanceScriptShell(reader, shell, logical, read) !== null) {
			shell.cwds = null;
			shell.vars.clear();
		}
		const lineRuns = scriptLineSources(read.expanded);
		const where = `in ${file} line ${start + 1}`;
		if (lineRuns.unnamed) recordUnplaced(scan.budget, "a script the line runs without naming it", where);
		const cwds = read.context === "function" ? null : shell.cwds;
		commandWrittenPaths(read.expanded, cwds ?? [scan.callCwd], scan.written);
		for (const source of lineRuns.sources) {
			// A program `exec` runs by its own path may be any binary: one the scan cannot place keeps today's rails, and
			// only shell source is read (row 215, CLI-P31).
			if (depth >= FLOOR_SCRIPT_NEST_DEPTH) {
				if (!source.program)
					recordUnplaced(scan.budget, source.path, `(nested past ${FLOOR_SCRIPT_NEST_DEPTH} levels), ${where}`);
				continue;
			}
			// Every candidate is scanned for a refusal from its own copy of the shell and of the writes so far; bash
			// loads the first one not written first, so the script continues from that copy alone (CLI-P31).
			let loaded: { shell: ScriptShell; written: WrittenPaths } | null = null;
			const homeLost = !shell.vars.has("HOME") && homeOperand(source.path);
			const candidates = homeLost ? [null] : scriptCandidates(source.path, cwds, scan.budget, source.sourced);
			for (const candidate of candidates) {
				if (candidate === null) {
					if (!source.program) {
						const note = homeLost ? `(HOME unknown here), ${where}` : unplacedNote(source.path, where);
						recordUnplaced(scan.budget, source.path, note);
					}
					continue;
				}
				if (isWrittenFirst(candidate, scan.written)) continue;
				const kind = pathKind(candidate);
				if (kind === "unreachable" && !source.program) recordUnplaced(scan.budget, candidate, `(unreadable), ${where}`);
				if (kind !== "file" || (source.program && yoloFloorShellScript(candidate) !== true)) continue;
				const branch: ScriptScan = { ...scan, written: copyWrittenPaths(scan.written) };
				// `source` runs in this shell; `bash`, `sh` and `exec` start a child that changes nothing here.
				// A sourced file keeps the script's `$0`; a child shell gets the name it was run by.
				const names: ScriptNames = source.stdin
					? { zero: null, source: null }
					: source.sourced
						? { zero: reader.names.zero, source: source.path }
						: { zero: source.path, source: source.path };
				const branchShell = source.sourced ? forkScriptShell(shell) : childScriptShell(shell, read.context);
				const branchReader = newScriptReader(source.sourced ? read.context : "plain", names);
				const inner = scanScript(candidate, branch, branchShell, branchReader, depth + 1);
				if (inner !== null) return inner;
				loaded ??= { shell: branchShell, written: branch.written };
			}
			if (loaded === null) continue;
			for (const file of loaded.written.files) scan.written.files.add(file);
			for (const tree of loaded.written.trees) scan.written.trees.add(tree);
			if (source.sourced) Object.assign(shell, loaded.shell);
		}
	}
	return null;
}

/**
 * The files a script operand can name from the directories the shell may be
 * in: the ones that exist, or the first candidate when none does, so its scan
 * reports it. A dynamic name, or a relative one from an unknown directory, is
 * a null candidate. A sourced name with no slash is looked up as bash does, on
 * every directory of the bash tool's PATH in its order and then the directory,
 * and every regular file found is a candidate, the one bash loads first (CLI-P31).
 * While that PATH is still being captured only the directory is searched, and
 * the budget records it.
 */
function scriptCandidates(
	operand: string,
	cwds: ReadonlyArray<string> | null,
	budget: ScriptBudget,
	sourced = false,
): Array<string | null> {
	if (runTimeName(operand)) return [null];
	if (operand === "~" || operand.startsWith("~/") || path.isAbsolute(operand)) return [scriptPath(operand, "/")];
	const local = cwds === null ? [] : [...new Set(cwds.map((cwd) => path.resolve(cwd, operand)))];
	// A name under a directory the stat cannot enter is kept, so its scan records it as unreadable (row 215).
	const exists = (candidate: string) => pathKind(candidate) !== "missing";
	if (sourced && !operand.includes("/")) {
		const dirs = sourceSearchDirs(cwds);
		if (dirs === null) budget.pathPending = true;
		const found = [...new Set([...(dirs ?? []).map((dir) => path.join(dir, operand)), ...local].filter(regularFile))];
		if (found.length > 0) return found;
	}
	if (cwds === null) return [null];
	const existing = local.filter(exists);
	return existing.length > 0 ? existing : local.slice(0, 1);
}

/**
 * The directories `source name` searches, in bash's order: the PATH bash commands run with, alone, so the first hit is
 * the file bash loads; null while the login capture that sets it is pending, never the PATH Clio was launched with. A
 * relative entry is placed from every directory the shell may be in.
 */
function sourceSearchDirs(cwds: ReadonlyArray<string> | null): string[] | null {
	const searchPath = bashSearchPath();
	if (searchPath === null) return null;
	const dirs = new Set<string>();
	for (const entry of searchPath.split(path.delimiter)) {
		if (path.isAbsolute(entry)) dirs.add(entry);
		else for (const cwd of cwds ?? []) dirs.add(path.resolve(cwd, entry));
	}
	return [...dirs];
}

/** Whether a path is a regular file now; a path the stat cannot reach is not. */
function regularFile(candidate: string): boolean {
	return pathKind(candidate) === "file";
}

/** What a path is now: a regular file, something else, absent, or behind a directory the stat cannot enter. */
function pathKind(candidate: string): "file" | "other" | "missing" | "unreachable" {
	try {
		const info = statSync(candidate, { throwIfNoEntry: false });
		return info === undefined ? "missing" : info.isFile() ? "file" : "other";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "unreachable";
	}
}

/** True when the first bytes of a file hold a NUL, the mark of a binary program rather than a script. */
function binaryHead(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(8192);
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).includes(0);
	} finally {
		closeSync(fd);
	}
}

/** Clio's resolved config, data, state and cache trees, and the ways a command can spell them. */
interface ClioOwnedTrees {
	roots: ReadonlyArray<string>;
	spellings: ReadonlyArray<string>;
}

function clioOwnedTrees(workspace: string): ClioOwnedTrees {
	const dirs = resolveClioDirs();
	const roots = new Set<string>();
	const add = (dir: string) => {
		roots.add(path.resolve(dir));
		const canonical = canonicalizePath(dir);
		if (canonical !== null) roots.add(canonical);
	};
	const trees = [dirs.config, dirs.data, dirs.state, dirs.cache];
	for (const dir of trees) add(dir);
	// The CLIO_CODER_HOME that holds these trees is Clio's as a whole, so `cp -r x <home>/` lands in it (FX-8). Not
	// when it is the account's home, or holds the workspace, where it would claim every file the task edits.
	const clioHome = process.env.CLIO_CODER_HOME?.trim();
	if (clioHome !== undefined && path.isAbsolute(clioHome)) {
		const resolvedHome = path.resolve(clioHome);
		if (
			path.dirname(resolvedHome) !== resolvedHome &&
			resolvedHome !== path.resolve(homedir()) &&
			!isSameOrDescendant(path.resolve(workspace), resolvedHome) &&
			trees.some((dir) => isSameOrDescendant(path.resolve(dir), resolvedHome))
		)
			add(resolvedHome);
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

/**
 * Write targets the floor reads beyond the general scan (FX-8): an `rsync` destination, and a write that goes through a
 * symbolic link an `ln -s` in the same command plants, spelled at the link's target. The scan judges paths as they
 * stand before the command runs, when that link does not exist yet. A link a cd places elsewhere resolves from `cwd`.
 */
function sameCommandWriteTargets(
	command: string,
	targets: ReadonlyArray<{ operation: PathPolicyOperation; path: string }>,
	cwd: string,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const found: Array<{ operation: PathPolicyOperation; path: string }> = [];
	const links = new Map<string, { target: string; planted: number }>();
	const literal = (word: string) => !/[$`]/u.test(word);
	for (const step of shellCommandSteps(command, homedir())) {
		const operands: string[] = [];
		let targetDir: string | null = null;
		let symbolic = false;
		for (let index = 0, options = true; index < step.args.length; index += 1) {
			const word = step.args[index] as string;
			if (options && word === "--") options = false;
			else if (options && word.startsWith("--")) {
				if (word === "--symbolic") symbolic = true;
				else if (word.startsWith("--target-directory=")) targetDir = word.slice("--target-directory=".length);
				else if (word === "--target-directory" || word === "--suffix") {
					if (word === "--target-directory") targetDir = step.args[index + 1] ?? null;
					index += 1;
				}
			} else if (options && word.startsWith("-") && word.length > 1) {
				if (step.executable !== "ln") continue;
				if (word.includes("s")) symbolic = true;
				const valued = /[tS]/u.exec(word);
				if (valued !== null) {
					const rest = word.slice(valued.index + 1);
					if (rest.length === 0) index += 1;
					const value = rest.length > 0 ? rest : (step.args[index] ?? null);
					if (valued[0] === "t") targetDir = value;
				}
			} else operands.push(word);
		}
		if (step.executable === "rsync") {
			const destination = operands.at(-1);
			// `host:path` and `rsync://` are remote; a local destination is a path.
			if (operands.length >= 2 && destination !== undefined && !/^[^/]*:/u.test(destination))
				found.push({ operation: "write", path: destination });
			continue;
		}
		if (step.executable !== "ln" || !symbolic || !operands.every(literal)) continue;
		const plant = (link: string, source: string) => {
			const at = path.resolve(cwd, link);
			const entry = links.get(at);
			links.set(at, { target: path.resolve(path.dirname(at), source), planted: (entry?.planted ?? 0) + 1 });
		};
		if (targetDir !== null) {
			if (literal(targetDir)) for (const source of operands) plant(path.join(targetDir, path.basename(source)), source);
		} else if (operands.length === 1) plant(path.basename(operands[0] as string), operands[0] as string);
		else {
			const destination = operands.at(-1) as string;
			const sources = operands.slice(0, -1);
			// One source may name the link itself or, when the destination is a directory, a link inside it.
			if (sources.length === 1) plant(destination, sources[0] as string);
			for (const source of sources) plant(path.join(destination, path.basename(source)), source);
		}
	}
	if (links.size === 0) return found;
	const seen = new Map<string, number>();
	for (const target of targets) {
		if (!literal(target.path)) continue;
		const raw =
			target.path === "~" || target.path.startsWith("~/") ? path.join(homedir(), target.path.slice(1)) : target.path;
		const at = path.resolve(cwd, raw);
		for (const [link, { target: linked, planted }] of links) {
			if (at === link) {
				// The `ln` step names its own link once; another write naming it writes through it.
				const count = (seen.get(link) ?? 0) + 1;
				seen.set(link, count);
				if (count > planted) found.push({ operation: target.operation, path: linked });
			} else if (isSameOrDescendant(at, link)) {
				found.push({ operation: target.operation, path: path.join(linked, path.relative(link, at)) });
			}
		}
	}
	return found;
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

/** Reason a lone delete confined to scratch roots carries: nothing undoes it, and nothing there needs undoing. */
const SCRATCH_DISPOSABLE_REASON =
	"it deletes only inside scratch roots, whose contents are disposable; no workspace snapshot covers them, so /rewind does not undo it; it needs no approval";

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

/**
 * True when a command deletes something and every delete target is an
 * absolute path strictly inside a scratch root.
 */
function deletesOnlyScratch(command: string, roots: ReadonlyArray<string>): boolean {
	let deletes = 0;
	for (const walk of extractCommandPathWalks(command)) {
		// A link planted first may lead a later scratch path anywhere (row 261).
		let linked = false;
		for (const event of walk) {
			if (event.kind === "link" && event.symbolic) linked = true;
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			// A delete a row 261 reading adds (an env, xargs or here-document body the base walk skipped) never makes a
			// call scratch-only, so it cannot drop the snapshot a discard beside it needs.
			if (linked || event.added === true || !path.isAbsolute(event.target)) return false;
			const resolved = canonicalizeRawPath(event.target, "/");
			if (resolved === null || !roots.some((root) => resolved !== root && isUnderOrSame(resolved, root))) return false;
			deletes += 1;
		}
	}
	return deletes > 0;
}

/** A single rm, rmdir or unlink, which runs nothing else; the delete judge has already placed its operands. */
const LONE_DELETE = /^(?:rm|rmdir|unlink)\s/u;

/**
 * True for a call that runs a project command: bash, run_script, and a verify
 * call whose check resolves to an argv (`verifyCommand`). A verify call that
 * lists checks, names an unknown one or validates a frontend artifact runs no
 * project code.
 */
function runsProjectCommand(call: ClassifierCall, verifyCommand: string | null): boolean {
	if (call.tool === ToolNames.Bash || call.tool === ToolNames.RunScript) return true;
	return call.tool === ToolNames.Verify && verifyCommand !== null;
}

/** True when the call reaches outward (a push, a publish, a code host or cloud CLI, a network write). */
function reachesOutward(call: ClassifierCall, classification: Classification, verifyCommand: string | null): boolean {
	const command = call.tool === ToolNames.Verify ? verifyCommand : commandArg(call.args);
	// The classifier's outward `git push` is read again here, where a line that rebinds `git` stays in (R2-safety-secrets-09).
	if (classification.exposure === "outward" && command === null) return true;
	return command !== null && outwardShellReason(command) !== null;
}

/**
 * True when the operator's default runs this call in the main-session sandbox
 * (Phase 2c): bash, run_script and a verify check that runs a command, unless
 * the call asks to leave it with `unsandboxed: true` or reaches outward, which
 * needs the credentials the sandbox hides. `verifyCommand` is the argv a
 * verify call resolves to, joined, or null.
 */
function containedShellCall(
	call: ClassifierCall,
	classification: Classification,
	verifyCommand: string | null,
): boolean {
	if (!runsProjectCommand(call, verifyCommand)) return false;
	if (call.args?.unsandboxed === true) return false;
	// An MCP tool runs on its server's own process, which no main-session sandbox holds.
	if (call.projection === "mcp-server") return false;
	return !reachesOutward(call, classification, verifyCommand);
}

/**
 * How `safety.sandbox: required` holds one call of the operator's yolo: a
 * script, and every call the default would contain, runs `sandboxed`, or is
 * `refused` when the host has no backend; such a call that asks to leave the
 * sandbox with `unsandboxed: true` is refused as `unsandboxed`. An outward call
 * that names no script keeps the credentials it needs and runs `free` only when
 * its line is one simple command with literal arguments ({@link outwardLineLeaves});
 * any other outward line is held like a call that reaches nowhere. Every call
 * runs `free` when the operator did not require the sandbox.
 */
function yoloRequiredSandbox(
	rawCall: ClassifierCall,
	call: ClassifierCall,
	classification: Classification,
	verifyCommand: string | null,
	scope: OperatorYoloScope,
	places: () => OutwardPlaces,
): "sandboxed" | "refused" | "unsandboxed" | "free" {
	const state = scope.scriptSandbox;
	if (state !== "sandboxed" && state !== "refused") return "free";
	// The typed git tool runs a fixed argv, never through the sandbox; its hooks are the hooks guard's to judge.
	// Neither does an MCP tool call, which runs on its server's own process.
	if (call.projection === "typed-git" || call.projection === "mcp-server" || !runsProjectCommand(call, verifyCommand))
		return "free";
	const script = runsScriptFile(rawCall);
	if (!script && reachesOutward(call, classification, verifyCommand)) {
		const command = call.tool === ToolNames.Verify ? verifyCommand : commandArg(call.args);
		if (command === null) return "free";
		const where = places();
		if (outwardLineLeaves(command, where)) {
			const drift = commandInvokesGit(command) ? hookDriftHeld(scope, where.workspace) : null;
			if (drift === null) return "free";
			where.held?.push(drift);
		}
	}
	if (call.args?.unsandboxed === true) return "unsandboxed";
	return state;
}

/** Hook drift entries a held line's explanation names before it counts the rest. */
const HELD_DRIFT_NAMED = 5;

/**
 * Why an outward git or gh line stays inside a required sandbox: the hook
 * files and executable git config added or changed since the drift guard's
 * baseline, or null when there are none or no guard is wired. A check that
 * throws holds the line, since what git would run is then unknown.
 */
function hookDriftHeld(scope: OperatorYoloScope, workspace: string): string | null {
	if (scope.hookDrift === undefined) return null;
	let changes: ReadonlyArray<GitHookChange>;
	try {
		changes = scope.hookDrift.check({ silent: true })?.changes ?? [];
	} catch {
		return "the git hook fingerprint could not be read";
	}
	if (changes.length === 0) return null;
	const named = changes.slice(0, HELD_DRIFT_NAMED).map((change) => describeGitHookChange(change, workspace));
	const more = changes.length > HELD_DRIFT_NAMED ? `; and ${changes.length - HELD_DRIFT_NAMED} more` : "";
	return `git hook files or executable git config changed since the session started, and git would run them outside the sandbox: ${named.join("; ")}${more}`;
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
	// -s and --set change the clock, and -f reads a list of dates from a file. A bare operand that is not a `+FORMAT`
	// also sets the clock, which dateOperandsOnlyFormat refuses.
	["date", ["-s", "--set", "-f", "--file"]],
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
	["date", "dfrsI"],
]);

/** `sed -n` with a print-only line script (`1,80p`, `5p`, `10,$p`); every other sed program can write or execute. */
const SED_PRINT_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u;

/** `$?` or `${?}`, the previous command's exit status. */
const EXIT_STATUS_PARAMETER = /\$(?:\?|\{\?\})/gu;

/** Commands that only print their operands; `printf -v` is refused by READ_ONLY_INSPECTORS. */
const PRINT_ONLY_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf"]);

/**
 * The command with each `$?` that is an `echo` or `printf` operand replaced
 * by `0`. Bash expands `$?` to a decimal integer, so as a printed operand it
 * hides no path or option, and `pytest -q; echo $?` is how a model reads an
 * exit code. Fleet repair workers had that compound refused as hidden content
 * at default admission, so the loop could not inspect its own run. Anywhere
 * else `$?` stays hidden content: `cat "a$?"` reads `a0`, not the judged `a$?`.
 */
function maskPrintedExitStatus(command: string): string {
	if (!command.includes("$")) return command;
	let segmentHead: string | undefined;
	let masked = "";
	let cursor = 0;
	for (const token of scanShellLike(command)) {
		if (token.operator) {
			segmentHead = undefined;
			continue;
		}
		if (segmentHead === undefined) {
			segmentHead = token.value;
			continue;
		}
		if (!PRINT_ONLY_COMMANDS.has(segmentHead) || token.substitutions !== undefined) continue;
		masked +=
			command.slice(cursor, token.start) + command.slice(token.start, token.end).replace(EXIT_STATUS_PARAMETER, "0");
		cursor = token.end;
	}
	return masked + command.slice(cursor);
}

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
	// GNU grep permutes options, so `grep /etc/passwd -e root` takes its pattern
	// from the later `-e` and every positional is a file.
	if (
		args.some(
			(arg) => abbreviatesLongOption(arg, "--regexp") || abbreviatesLongOption(arg, "--file") || /^-[^-]*[ef]/u.test(arg),
		)
	)
		return null;
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
		// A printed `$?` is an integer; see maskPrintedExitStatus.
		const raw = PRINT_ONLY_COMMANDS.has(command)
			? source.slice(word.start, word.end).replace(EXIT_STATUS_PARAMETER, "0")
			: source.slice(word.start, word.end);
		if (!hasUnquotedExpansion(raw)) {
			args.push(PRINT_ONLY_COMMANDS.has(command) ? word.value.replace(EXIT_STATUS_PARAMETER, "0") : word.value);
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
	if (command === "date" && !dateOperandsOnlyFormat(args)) return null;
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
 * True when every bare `date` operand is a `+FORMAT`. `date MMDDhhmm` sets the clock with no option at all, so an operand
 * that is neither a format nor the value of `-d` or `-r` is not an inspection.
 */
function dateOperandsOnlyFormat(args: ReadonlyArray<string>): boolean {
	let valueNext = false;
	for (const arg of args) {
		if (valueNext) {
			valueNext = false;
			continue;
		}
		if (arg === "--") continue;
		if (arg.startsWith("--")) {
			valueNext = /^--(?:da|dat|date|r|re|ref|refe|refer|refere|referen|referenc|reference)$/u.test(arg);
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			// A cluster ending in -d or -r takes the next word as its value; attached text is the value itself.
			valueNext = /^-[A-Za-z]*[dr]$/u.test(arg) && !/^-[A-Za-z]*I/u.test(arg);
			continue;
		}
		if (!arg.startsWith("+")) return false;
	}
	return true;
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
		if (MAKE_CLEAN_COMMAND.re.test(rendered)) {
			ruleIds.push(MAKE_CLEAN_COMMAND.id);
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

/** A glob match Git may receive: plain file-name characters that rejoin and rescan as the same one word. */
const GIT_GLOB_MATCH = /^[A-Za-z0-9_./@%+,=-]+$/u;

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
	// A `*` or `?` pathspec glob (`git diff -- *.py`) is expanded the way bash
	// would expand it, as readOnlyInspectionRule does, and Git receives the
	// matches. Every match is judged below like a literal operand; one that
	// would read as an option or reparse as shell is refused. Any other
	// expansion hides the real argument.
	const gitArgs: string[] = [];
	const expanded = new Set<number>();
	for (const word of words.slice(1)) {
		const raw = source.slice(word.start, word.end);
		if (!hasUnquotedExpansion(raw, true)) {
			gitArgs.push(word.value);
			continue;
		}
		const matches = expandOperandGlob(raw, cwd, readScope);
		if (matches === null) return false;
		if (matches.length === 0) {
			// bash passes an unmatched glob through, and Git reads it as a pathspec pattern.
			expanded.add(gitArgs.length);
			gitArgs.push(word.value);
			continue;
		}
		if (matches.some((match) => match.startsWith("-") || !GIT_GLOB_MATCH.test(match))) return false;
		if (matches.some((match) => !readScope.readable(path.resolve(cwd, match)))) return false;
		for (const match of matches) {
			expanded.add(gitArgs.length);
			gitArgs.push(match);
		}
	}
	// `git -C <dir> ...` runs as plain git from <dir>. The directories are held
	// to the workspace like a read path and the rest is judged from the last one.
	const split = splitGitChdir(gitArgs);
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
	const subcommandAt = values.indexOf(verdict.subcommand);
	// A glob is a pathspec: in the global options or the subcommand word it
	// would pick what Git runs. `values` drops the `-C` pairs, so count from the end.
	const earliestFromEnd = Math.max(0, ...[...expanded].map((at) => gitArgs.length - at));
	if (earliestFromEnd >= values.length - subcommandAt) return false;
	const operands = values.slice(subcommandAt + 1);
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
	return isSameOrDescendant(canonicalChild, canonicalParent);
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

/** A git control path as listed and as resolved, both case-folded where the filesystem usually ignores case. */
interface GitControl {
	path: string;
	forms: ReadonlyArray<string>;
}

/** macOS and Windows volumes usually ignore case, so `.HUSKY/pre-commit` would land in `.husky`. */
const foldPathCase: (location: string) => string =
	process.platform === "darwin" || process.platform === "win32"
		? (location) => location.toLowerCase()
		: (location) => location;

/**
 * Impure: the cwd repository's git control paths, the hooks directories
 * (core.hooksPath included), config and commondir files and `.git` pointer
 * files the main-session sandbox keeps read-only, each as listed and as
 * resolved, so a link on the control side cannot hide one.
 */
function resolveGitControls(cwd: string): GitControl[] {
	return mainSandboxGitControlPaths(cwd).map((control) => {
		const real = canonicalizePath(control);
		const forms = real === null || real === control ? [control] : [control, real];
		return { path: control, forms: forms.map(foldPathCase) };
	});
}

/** Files of a git dir whose contents become code or move the git dir. */
const GIT_DIR_CONTROL_FILES: ReadonlySet<string> = new Set(["config", "config.worktree", "commondir"]);
/** Files of a linked worktree's git dir under `.git/worktrees/<name>/`. */
const GIT_WORKTREE_CONTROL_FILES: ReadonlySet<string> = new Set(["config.worktree", "commondir", "gitdir"]);

/**
 * Pure: whether `location` is a git control path by its name alone, with no
 * filesystem call: a `.git` pointer file, or below a `.git` directory its
 * hooks, `config`, `config.worktree`, `commondir` or `info/attributes`, a
 * linked worktree's `config.worktree`, `commondir` or `gitdir`, and the hooks
 * and those files of a submodule git dir under `modules`. Case is ignored.
 * It covers a repository created after the engine was built, wherever it sits.
 */
function isGitControlName(location: string): boolean {
	const parts = location
		.toLowerCase()
		.split(/[\\/]+/u)
		.filter((part) => part.length > 0);
	if (parts.at(-1) === ".git") return true;
	for (let at = parts.indexOf(".git"); at >= 0; at = parts.indexOf(".git", at + 1)) {
		const rest = parts.slice(at + 1);
		const [first, second] = rest;
		const last = rest.at(-1) ?? "";
		if (first === "hooks") return true;
		if (rest.length === 1 && GIT_DIR_CONTROL_FILES.has(last)) return true;
		if (rest.length === 2 && first === "info" && second === "attributes") return true;
		if (first === "worktrees" && rest.length === 3 && GIT_WORKTREE_CONTROL_FILES.has(last)) return true;
		if (
			first === "modules" &&
			(rest.includes("hooks") ||
				GIT_DIR_CONTROL_FILES.has(last) ||
				last === "gitdir" ||
				(last === "attributes" && rest.at(-2) === "info"))
		) {
			return true;
		}
	}
	return false;
}

/**
 * The git control path a typed file mutation lands on, or null. Each target
 * is judged as named and where the admission walk already resolved it, by
 * name and against the resolved set, so this costs no filesystem call.
 */
function gitControlLanding(
	candidates: ReturnType<typeof mutationCandidates>,
	controls: ReadonlyArray<GitControl>,
): string | null {
	for (const candidate of candidates) {
		for (const location of [candidate.lexical, candidate.resolved]) {
			if (isGitControlName(location)) return location;
			const folded = foldPathCase(location);
			for (const control of controls) {
				if (control.forms.some((form) => isSameOrDescendant(folded, form))) return control.path;
			}
		}
	}
	return null;
}

/**
 * Shell commands that may move core.hooksPath or create a repository: git
 * config, init, clone, worktree and submodule, husky, package installs whose
 * scripts run husky, and edits that name a git config file.
 */
const GIT_CONFIG_COMMAND =
	/\bhookspath\b|\bhusky\b|\.gitconfig\b|\.git[\\/]|\bgit\b[^\n]*\b(?:config|init|clone|worktree|submodule)\b|\b(?:npm|pnpm|yarn|bun)\b[^\n]*\b(?:install|i|ci|add)\b/iu;

/**
 * Pure: whether a call the net let through (allowed, or asked and possibly
 * approved later) may rewrite a git config, so the resolved git control set
 * is refreshed before the next typed write is judged: a typed write on a git
 * control path or a global git config, a shell command that names one, and
 * any script, whose source the net does not read.
 */
function mayRewriteGitConfig(call: ClassifierCall, decision: SafetyPolicyDecision, cwd: string): boolean {
	if (decision.gitControl !== undefined || decision.ruleId === GIT_CONTROL_FILE_RULE_ID) return true;
	if (call.tool === ToolNames.RunScript) return true;
	if (call.tool === ToolNames.Bash) {
		const command = commandArg(call.args);
		return command !== null && GIT_CONFIG_COMMAND.test(command);
	}
	const target = writeRootTargetPath(call, cwd);
	if (target === null) return false;
	const landing = path.resolve(cwd, expandPath(target));
	return (
		isGitControlName(landing) ||
		path.basename(landing) === ".gitconfig" ||
		landing.endsWith(`${path.sep}git${path.sep}config`)
	);
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

/** Hashes the `{ base: [...] }` payload persisted run records already carry, so the hash stays byte-identical. */
function rulePackHash(rules: ReadonlyArray<DamageControlRule>): string {
	const base = rules.map((rule) => ({
		id: rule.id,
		description: rule.description,
		pattern: rule.pattern.source,
		class: rule.class,
		block: rule.block,
		...(rule.ask !== undefined ? { ask: rule.ask } : {}),
	}));
	return createHash("sha256").update(JSON.stringify({ base }), "utf8").digest("hex");
}

function invokesTrustMutation(command: string, rawText = false): boolean {
	// Wrappers, package launchers, quoted argv and source-tree CLI invocations
	// must not turn an operator-only grant into model authority; a loop list,
	// a help request or quoted data is not a grant (CLI-P31).
	return yoloFloorTrustGrant(command, rawText);
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

const OVERSIZED_PATH_RULE_ID = "oversized-path";
/**
 * Linux opens paths of at most 4096 bytes, so no real path has more segments
 * than this. The path walks cost grows with the segment count, so a longer
 * token is refused before any of them run.
 */
const MAX_PATH_SEGMENTS = 4096;
const PATH_BEARING_ARGS = ["path", "paths", "cwd", "command", "argv", "file", "target", "root"] as const;

/** The first string argument holding a whitespace-free run with more than MAX_PATH_SEGMENTS separators. */
function oversizedPathToken(args: Record<string, unknown> | undefined): string | null {
	if (args === undefined) return null;
	// Only path and command arguments are walked; file content (write, edit)
	// may hold any number of slashes and is never resolved as a path.
	for (const key of PATH_BEARING_ARGS) {
		const value = args[key];
		const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
		for (const text of strings) {
			if (typeof text !== "string" || text.length <= MAX_PATH_SEGMENTS) continue;
			let separators = 0;
			for (let index = 0; index < text.length; index += 1) {
				const code = text.charCodeAt(index);
				if (code === 47 || code === 92) {
					separators += 1;
					if (separators > MAX_PATH_SEGMENTS) return text;
				} else if (code === 32 || code === 9 || code === 10 || code === 13) separators = 0;
			}
		}
	}
	return null;
}
