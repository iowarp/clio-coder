import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { pathBoundaryCovers, resolvePathBoundary } from "../../core/path-boundary.js";
import {
	canonicalizeExistingPath,
	canonicalizePath,
	canonicalizeRawPath,
	createPathWalkMemo,
	type PathWalkMemo,
} from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { clioConfigDir } from "../../core/xdg.js";
import { resolveProjectVerifierExecutionCwd } from "../../tools/verify/catalog.js";
import { resolveVerifyCall } from "../../tools/verify/resolve.js";
import { prepareVerifyArguments } from "../../tools/verify/surface.js";
import {
	type ActionClass,
	type Classification,
	type ClassifierCall,
	classify,
	normalizeCallPaths,
} from "./action-classifier.js";
import type { DamageControlMatch, DamageControlRule } from "./damage-control.js";
import {
	DEFAULT_DAMAGE_CONTROL_PATH_POLICY,
	mergePathPolicyInputs,
	OPERATOR_PATH_POLICY,
} from "./default-path-policy.js";
import {
	type CompiledPathPolicy,
	compilePathPolicy,
	evaluatePathPolicy,
	type PathPolicyDecision,
	type PathPolicyOperation,
} from "./path-policy.js";
import {
	type LoadedProjectSafetyPolicy,
	loadProjectSafetyPolicy,
	type ProjectCommandPolicy,
} from "./project-policy.js";
import {
	commandArgumentSegments,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	inlineShellScript,
	invokesClioSkillMutation,
	scanShellLike,
	scanShellLikeDeep,
} from "./protected-artifacts.js";
import { isReadScopeTool, readScopeEscape, readScopeExemptRoots, readScopeSpellings } from "./read-scope.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { getCachedDefaultRulePacks, type PackId, type RulePacks } from "./rule-pack-loader.js";
import { activeClioSkillRoots, mutationCandidates, skillMutationReason } from "./skill-authority.js";

import { gateProjectSafetyPolicy, workspaceTrustDirectory } from "./workspace-trust.js";

export type SafetyPolicySource =
	| "damage-control:base"
	| "project-policy"
	| "project-policy-invalid"
	| "builtin-command-allowlist"
	| "builtin-classifier"
	| "none";

export interface SafetyPolicyDecision {
	/**
	 * Net verdict (sd-01 §2.2): `block` is final at every autonomy level,
	 * `ask` is a net rail demanding operator confirmation at the current level,
	 * including damage-control asks that remain active in yolo. Ordinary asks
	 * are cleared by the yolo posture before this verdict is returned. An
	 * `allow` means the net passed; the autonomy mapping decides what happens
	 * next at the admission seam (tools/registry.ts, acp/tool-mediator.ts).
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
	 * Set on an allowed read, ls, grep, or find whose path resolves outside the
	 * workspace and outside Clio's own readable roots. The net passed; the
	 * autonomy mapping asks for it in default mode.
	 */
	readScope?: "outside-workspace";
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

export interface SafetyPolicyEngine {
	evaluate(call: ClassifierCall, posture?: string): SafetyPolicyDecision;
	/**
	 * False when a zero-access entry covers the path. The per-entry filter of a
	 * listing or a search asks this about every result, so it runs the path
	 * policy alone instead of a whole admission.
	 */
	readablePath(target: string): boolean;
	metadata(posture?: string): SafetyPolicyMetadata;
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
}

interface SourcedRule {
	rule: DamageControlRule;
	source: SafetyPolicySource;
}

const BUILTIN_ALLOWLIST: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "builtin:pwd", re: /^pwd$/ },
	{ id: "builtin:ls", re: /^ls(?:\s+(-[A-Za-z0-9]+|\.[/\w.-]*|[/\w.-]+))*$/ },
	{ id: "builtin:git-status", re: /^git\s+status(?:\s+--short|\s+--branch|\s+-sb)*$/ },
	{ id: "builtin:git-diff", re: /^git\s+diff(?:\s+--cached|\s+--stat|\s+--name-only|\s+--\s+[\w./-]+)*$/ },
	{ id: "builtin:git-log", re: /^git\s+log\s+--oneline(?:\s+-n\s+[1-9]\d{0,2})?(?:\s+--\s+[\w./-]+)?$/ },
];

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
 * same shape. A headless run still answers the resulting ask with its own
 * denial sentence, which does not carry these reasons.
 */
const BASH_RECOGNIZED_FORM_HINT =
	"Recognized forms run without asking: one command per bash call, or a && chain whose every step is recognized, with cwd passed as the cwd argument instead of a leading cd.";

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
function isWriteConfinementEscape(call: ClassifierCall, actionClass: string): boolean {
	if (WRITE_ROOT_REFUSED_TOOLS.has(call.tool)) return true;
	return actionClass === "execute" || actionClass === "dispatch";
}

/**
 * Lexical write-root containment. The target is resolved against the worker cwd
 * and must equal a root or sit beneath it (`root` + path separator). The check
 * is lexical and does not chase symlinks, so a symlink inside a root that points
 * outside is not detected here. Returns the block reason, or null when allowed.
 */
function evaluateWriteRoots(roots: ReadonlyArray<string>, writeRootCwd: string, call: ClassifierCall): string | null {
	if (roots.length === 0) return null;
	const target = writeRootTargetPath(call);
	if (target === null) return null;
	const resolved = path.resolve(writeRootCwd, target);
	if (pathBoundaryCovers(roots, resolved)) return null;
	return `write target '${target}' resolves to '${resolved}', which is outside the permitted write roots for this run: ${roots.join(", ")}`;
}

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = canonicalizeExistingPath(path.resolve(options.cwd ?? process.cwd()));
	// Write-root containment resolves lexically, so it keeps its own un-canonicalized
	// cwd and roots to compare like against like (the design mandates no symlink chasing).
	const writeRootCwd = path.resolve(options.cwd ?? process.cwd());
	const writeRoots = (options.writeRoots ?? []).map((root) => resolvePathBoundary(writeRootCwd, root));
	const skillRoots = activeClioSkillRoots(cwd);
	const readExemptRoots = readScopeExemptRoots();
	const packs = options.rulePacks ?? getCachedDefaultRulePacks();
	const projectPolicy = options.projectPolicy ?? gateProjectSafetyPolicy(cwd, loadProjectSafetyPolicy(cwd));
	const projectPolicyRoot =
		projectPolicy.path === null ? cwd : path.dirname(path.dirname(path.resolve(projectPolicy.path)));
	const pathPolicyInput = projectPolicy.disableDefaultPathPolicy
		? projectPolicy.pathPolicy
		: mergePathPolicyInputs(DEFAULT_DAMAGE_CONTROL_PATH_POLICY, projectPolicy.pathPolicy);
	// Clio's own secret store and user skills, by absolute path.
	// Config directory expansion has to happen here because
	// the list cannot call config helpers at module scope.
	const expandedDefaults = mergePathPolicyInputs(mergePathPolicyInputs(pathPolicyInput, OPERATOR_PATH_POLICY), {
		zeroAccessPaths: clioCredentialStorePaths(),
		readOnlyPaths: [...clioSkillsRootPaths(), path.join(clioConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
	});
	const pathPolicy = compilePathPolicy(expandedDefaults, projectPolicyRoot);
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

	return {
		evaluate(rawCall, posture) {
			const call = normalizeCallPaths(rawCall);
			const rawClassification = classify(call);
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
			const verifyExtraArgs = Array.isArray(verifyArgs?.args)
				? verifyArgs.args.filter((arg): arg is string => typeof arg === "string")
				: [];
			const verifyArgv =
				verifyResolution?.kind === "catalog"
					? verifyResolution.check.command
					: verifyResolution?.kind === "toolchain"
						? verifyResolution.argv
						: verifyResolution?.kind === "package"
							? ["npm", "run", verifyResolution.check.id, ...(verifyExtraArgs.length > 0 ? ["--", ...verifyExtraArgs] : [])]
							: null;
			const verifyCommand = verifyArgv?.join(" ") ?? null;
			const scans = (verifyCommand !== null ? [verifyCommand] : damageControlScans(call)).filter((scan) => scan !== "");
			const hit = scans.length > 0 ? matchSourcedRule(scans, sourcedRules) : null;
			const classification = effectiveClassification(rawClassification, hit?.match);

			const base = baseDecision(call, classification, callCwd, posture, command);

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
			if (writeRoots.length > 0 && isWriteConfinementEscape(call, classification.actionClass)) {
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
			const askRule = hit?.match.ask === true && hit.match.block !== true;
			if (
				!askRule &&
				(classification.actionClass === "git_destructive" ||
					hit?.match.actionClass === "git_destructive" ||
					hit?.match.block === true)
			) {
				const blockInput: Omit<
					SafetyPolicyDecision,
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
				> = {
					reasonCode: hit ? `damage-control:${hit.match.ruleId}` : "classification:git_destructive",
					reasons: [...classification.reasons, ...(hit ? [hit.match.reason] : [])],
					policySource: hit?.source ?? "damage-control:base",
				};
				if (hit?.match.ruleId !== undefined) blockInput.ruleId = hit.match.ruleId;
				if (hit?.match !== undefined) blockInput.match = hit.match;
				return blockDecision(base, blockInput);
			}

			if (!projectPolicy.valid && EXECUTION_TOOLS.has(call.tool)) {
				const blockInput: Omit<
					SafetyPolicyDecision,
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
				> = {
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
			if (mutationCommand !== null && invokesTrustMutation(mutationCommand)) {
				return blockDecision(base, {
					reasonCode: "trust-authority",
					ruleId: "trust-authority",
					reasons: ["workspace trust grants require the operator CLI"],
					policySource: "builtin-classifier",
				});
			}
			// Reuse the canonical authority boundary scan for parent deletions,
			// shell cwd changes and aliases that a literal path-policy lookup misses.
			// Both authority checks below judge the same targets, so they share one
			// resolution and one walk memo, both dropped when this call is decided.
			const walkMemo = createPathWalkMemo();
			const candidates = mutationCandidates(
				pathPolicyTargets(
					verifyCommand === null ? call : { tool: ToolNames.Bash, args: { command: verifyCommand } },
					callCwd,
				),
				callCwd,
				mutationCommand,
				walkMemo,
			);
			if (
				skillMutationReason(
					[path.join(clioConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
					candidates,
					walkMemo,
				) !== null
			) {
				return blockDecision(base, {
					reasonCode: "path-policy:readOnlyPaths",
					ruleId: "path-policy:readOnlyPaths",
					reasons: ["Clio settings and workspace trust records are operator-owned and cannot be mutated by tools"],
					policySource: "builtin-classifier",
				});
			}
			const skillReason =
				mutationCommand !== null && invokesClioSkillMutation(mutationCommand, true)
					? "resource installation and lifecycle changes require the operator CLI or an explicit operator install choice; draft outside installed resource roots"
					: skillMutationReason(skillRoots, candidates, walkMemo);
			if (skillReason !== null) {
				return blockDecision(base, {
					ruleId: "skill-authority",
					reasonCode: "skill-authority",
					reasons: [skillReason],
					policySource: "builtin-classifier",
				});
			}

			// The path policy runs regardless of project policy validity. When
			// `.clio-coder/safety.yaml` is invalid, the loader has already dropped every
			// project-authored path entry and forced `disableDefaultPathPolicy`
			// off, so the compiled policy here carries exactly the built-in
			// defaults. Evaluating it unconditionally keeps default credential
			// protection (`.env`, `~/.ssh/`, `credentials.yaml`, ...) active on a
			// broken config, which is the fail-closed intent; project-authored
			// additions and exemptions stay gated on validity inside the loader.
			const pathBlock = evaluateProjectPathPolicy(pathPolicy, call, callCwd, walkMemo);
			if (pathBlock !== null) {
				const blockInput: Omit<
					SafetyPolicyDecision,
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
				> = {
					ruleId: pathBlock.reasonCode,
					reasonCode: pathBlock.reasonCode,
					reasons: [pathBlock.reason],
					policySource: "project-policy",
				};
				if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
				if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
				return blockDecision(base, blockInput);
			}
			// Bash reads of zero-access paths. pathPolicyTargets extracts only
			// write/delete targets from bash, so `cat .env` used to run and its
			// output persisted into the transcript and evidence previews. Any
			// path-like argument token matching a zero-access entry blocks the
			// command; the one carve-out is the exit-code-only presence check
			// (`grep -q`/`grep -sq` with a ^NAME= pattern), which is the safe
			// protocol the credentials skill teaches.
			const scannedCommand = call.tool === ToolNames.Bash ? command : verifyCommand;
			if (scannedCommand !== null) {
				const secretRead = evaluateBashZeroAccessRead(zeroAccessPolicy, scannedCommand, callCwd);
				if (secretRead !== null) {
					const blockInput: Omit<
						SafetyPolicyDecision,
						"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
					> = {
						ruleId: "secret_path_bash",
						reasonCode: "secret_path_bash",
						reasons: [
							`bash read of zero-access path blocked: '${secretRead.token}' matches ${secretRead.entrySource}. Check presence with exit codes only (grep -sq "^NAME=" <file>); have the user supply values through their own terminal (read -s), never through chat or command output.`,
						],
						policySource: "project-policy",
					};
					if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
					if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
					return blockDecision(base, blockInput);
				}
			}

			// Managed library changes can be authorized by the operator. Direct
			// mutations and all hard path/trust blocks above remain non-overridable.
			if (mutationCommand !== null && invokesClioSkillMutation(mutationCommand) && !(posture === "yolo" && askRule)) {
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
				return posture === "confirmed" || posture === "yolo" ? allowDecision(base, input) : askDecision(base, input);
			}

			// The authored ask rail (sd-01 M3) decides only among calls that
			// survived every hard block above. A confirmed posture admits the
			// matched command; an unconfirmed one parks it for confirmation.
			if (askRule && hit !== null && posture !== "confirmed") {
				return askDecision(base, {
					ruleId: hit.match.ruleId,
					reasonCode: `damage-control:${hit.match.ruleId}`,
					reasons: [...classification.reasons, hit.match.reason, "damage-control rule requires confirmation"],
					policySource: hit.source,
					match: hit.match,
				});
			}
			if (askRule && hit !== null && posture === "confirmed") {
				return allowDecision(base, {
					ruleId: hit.match.ruleId,
					reasonCode: `damage-control:${hit.match.ruleId}`,
					reasons: [...classification.reasons, hit.match.reason, "damage-control rule confirmed by operator"],
					policySource: hit.source,
					match: hit.match,
				});
			}

			if (classification.actionClass === "system_modify") {
				const input: Omit<
					SafetyPolicyDecision,
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
				> = {
					ruleId: "system-modify-confirm",
					reasonCode: "system-modify-confirm",
					reasons: [
						...classification.reasons,
						posture === "confirmed"
							? "system-level change confirmed by operator"
							: posture === "yolo"
								? "system-level change admitted by yolo"
								: "system-level changes require one-shot confirmation in default",
					],
					policySource: "builtin-classifier",
				};
				return posture === "confirmed" || posture === "yolo" ? allowDecision(base, input) : askDecision(base, input);
			}

			const packageCommand =
				call.tool === ToolNames.Verify &&
				verifyArgv === null &&
				typeof call.args?.check === "string" &&
				call.args.check !== "frontend"
					? `npm run ${call.args.check}`
					: null;
			if (
				(call.tool === ToolNames.Bash || verifyArgv !== null || packageCommand !== null) &&
				classification.actionClass === "execute"
			) {
				const bash = evaluateBashPolicy(
					verifyArgv ?? packageCommand ?? command ?? "",
					callCwd,
					cwd,
					posture,
					projectPolicy,
				);
				// A typed verifier still runs through the same command safety scan.
				// Unrecognized checks are left to the autonomy mapping: default asks,
				// while yolo admits them headlessly.
				if (bash.kind === "block") return blockDecision(base, bash);
				if (bash.kind === "ask") return askDecision(base, bash);
				return allowDecision(base, bash);
			}

			const allowInput: Omit<
				SafetyPolicyDecision,
				"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
			> = {
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
			// it; the flag lets the autonomy mapping ask in default mode.
			if (isReadScopeTool(call.tool) && posture !== "confirmed") {
				const escaped = readScopeEscape(pathArg(call.args) ?? ".", callCwd, cwd, readExemptRoots, walkMemo);
				if (escaped !== null) {
					allowInput.readScope = "outside-workspace";
					allowInput.reasons = [...allowInput.reasons, `read-path-outside-workspace: ${escaped}`];
				}
			}
			return allowDecision(base, allowInput);
		},
		readablePath(target) {
			return evaluatePathPolicy(zeroAccessPolicy, "read", target, cwd).kind === "allow";
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
}

/** Absolute path of Clio's provider secret store, when resolvable. */
function clioCredentialStorePaths(): string[] {
	try {
		return [path.join(clioConfigDir(), "credentials.yaml")];
	} catch {
		return [];
	}
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
	for (const scanned of scanShellLikeDeep(command)) {
		if (scanned.operator) continue;
		const token = scanned.value;
		if (token.length === 0) continue;
		// A token containing whitespace came from a quoted string of prose, not
		// a path argument; and flags are not paths unless they embed one
		// (--file=~/.aws/credentials).
		if (/\s/.test(token)) continue;
		if (token.startsWith("-") && !token.includes("/") && !token.includes("=")) continue;
		candidates.push(token);
		const eq = token.indexOf("=");
		if (eq > 0 && eq < token.length - 1) candidates.push(token.slice(eq + 1));
	}
	return candidates;
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
	call: ClassifierCall,
	callCwd: string,
	memo: PathWalkMemo,
): Extract<PathPolicyDecision, { kind: "block" }> | null {
	if (policy.entries.length === 0) return null;
	for (const target of pathPolicyTargets(call, callCwd)) {
		const decision = evaluatePathPolicy(policy, target.operation, target.path, callCwd, memo);
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
			// before the reader opens it, exactly as a read of the same path.
			const target = pathArg(args);
			return target === null ? [] : [{ operation: "read", path: target }];
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
 * Bash net evaluation (sd-01 §2.2). Net blocks: empty commands and cwd
 * escapes. Net confirms: project policy `requireConfirmation` and command
 * substitution (the content-hiding channel). Everything else passes with an
 * `execRecognition` tag: project policy commands and the built-in no-prompt
 * allowlist are recognized; arbitrary bash, including commands with
 * sequencing operators, is unrecognized and the autonomy mapping at the
 * admission seam decides whether it runs, asks, or is denied.
 */
function evaluateBashPolicy(
	input: string | ReadonlyArray<string>,
	callCwd: string,
	workspaceRoot: string,
	posture: string | undefined,
	policy: LoadedProjectSafetyPolicy,
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
		(/\$(?:[A-Za-z_{0-9@*#?!-])/.test(command) ||
			/(?:^|[\s;&|])(?:python[\d.]*|node|ruby|perl|php|lua)\s+(?:[^\n]*?\s)?-[ce]\b/.test(command)) &&
		posture !== "confirmed" &&
		posture !== "yolo"
	) {
		return {
			kind: "ask",
			reasonCode: "bash-hidden-content",
			ruleId: "bash-hidden-content",
			reasons: ["shell variables or interpreter source hide paths from the safety scan and require one-shot confirmation"],
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
	if (!isUnderOrSame(callCwd, workspaceRoot)) {
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
	const recognitionCommand = inlineShellScript(command) ?? command;
	if (hasCommandSubstitution(recognitionCommand) && posture !== "confirmed" && posture !== "yolo") {
		return {
			kind: "ask",
			ruleId: "bash-command-substitution",
			reasonCode: "bash-command-substitution",
			reasons: ["command substitution hides the executed content from the safety net and requires one-shot confirmation"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const testRunner = TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(recognitionCommand));
	if (testRunner !== undefined) {
		return {
			kind: "allow",
			ruleId: testRunner.id,
			reasonCode: testRunner.id,
			reasons: [`matched built-in test runner '${testRunner.id}'`, projectScriptPreview(recognitionCommand, callCwd)],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
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
	const chain = recognizeCommandChain(recognitionCommand, callCwd, workspaceRoot, policy);
	if (chain !== null) {
		const chainReasons = [
			`every step of the && chain is recognized: ${chain.ruleIds.join(", ")}`,
			...chain.scriptPreviews,
		];
		if (chain.requiresConfirmation && posture !== "confirmed" && posture !== "yolo") {
			return {
				kind: "ask",
				ruleId: "bash-recognized-chain",
				reasonCode: "bash-recognized-chain",
				reasons: [...chainReasons, "project policy requires confirmation for one step"],
				policySource: "builtin-command-allowlist",
				execRecognition: "recognized",
			};
		}
		return {
			kind: "allow",
			ruleId: "bash-recognized-chain",
			reasonCode: "bash-recognized-chain",
			reasons: chainReasons,
			policySource: "builtin-command-allowlist",
			execRecognition: chain.requiresAutonomyApproval ? "unrecognized" : "recognized",
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
	return {
		kind: "allow",
		ruleId: "bash-unrecognized",
		reasonCode: "bash-unrecognized",
		reasons: [
			"bash command is outside the no-prompt set; the autonomy level decides admission",
			BASH_RECOGNIZED_FORM_HINT,
		],
		policySource: "builtin-command-allowlist",
		execRecognition: "unrecognized",
	};
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

/**
 * Rule order is precedence, so the outer loop stays over the rules and each one
 * is offered every scan candidate (BT-001). A rule fires on the first candidate
 * it matches, which can only add matches, never reorder or drop one.
 */
function matchSourcedRule(candidates: ReadonlyArray<string>, rules: ReadonlyArray<SourcedRule>) {
	for (const entry of rules) {
		if (!candidates.some((candidate) => entry.rule.pattern.test(candidate))) continue;
		const match: DamageControlMatch = {
			ruleId: entry.rule.id,
			reason: `matched ${entry.rule.id}: ${entry.rule.description}`,
			actionClass: entry.rule.class,
			block: entry.rule.block,
		};
		if (entry.rule.ask !== undefined) match.ask = entry.rule.ask;
		return { match, source: entry.source };
	}
	return null;
}

// Excludes "unknown" because damage control overrides must classify actions into concrete, actionable categories.
const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"system_modify",
	"git_destructive",
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

/** Chain length ceiling. Real compound calls are two or three steps. */
const CHAIN_MAX_SEGMENTS = 6;

interface ChainRecognition {
	ruleIds: ReadonlyArray<string>;
	/** Explicit project policy confirmation asks in default and is skipped in yolo. */
	requiresConfirmation: boolean;
	/** Built-in project scripts ask in default and run in yolo. */
	requiresAutonomyApproval: boolean;
	scriptPreviews: ReadonlyArray<string>;
}

/**
 * Recognition for `cd <workspace dir> && <recognized command>` and the longer
 * `&&` chains built from the same parts. Every member is checked on its own and
 * the chain takes its most restrictive member's verdict, so the chain can never
 * admit something its members would not.
 *
 * This exists because the compound form is what a model reaches for first and
 * the flat rule cost more than it bought: in a recorded live drive 34 of 75
 * calls were blocked, nearly all of them `cd x && y`, since an unrecognized
 * execute asks in default mode and a headless run answers every ask with a
 * denial (REPORT-dispatch-drive-1.md S2). Meanwhile `sh -c '<anything>'` sailed
 * past the same rail, so the rail was mostly taxing the honest spelling. The
 * `sh -c` half is closed at both ends now: this function recognizes such a
 * command by its inner script, and the shared write-target scanner reads inside
 * the script too.
 */
function recognizeCommandChain(
	command: string,
	callCwd: string,
	workspaceRoot: string,
	policy: LoadedProjectSafetyPolicy,
): ChainRecognition | null {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of scanShellLike(command)) {
		if (token.operator && token.value === "&&") {
			segments.push(current);
			current = [];
			continue;
		}
		// Only an actual && operator joins recognizable commands. Quoted words
		// remain argv and every other real operator makes this chain unrecognized.
		if (token.operator) return null;
		current.push(token.value);
	}
	segments.push(current);
	if (segments.length < 2 || segments.length > CHAIN_MAX_SEGMENTS) return null;
	const ruleIds: string[] = [];
	let requiresConfirmation = false;
	let requiresAutonomyApproval = false;
	let chainCwd = callCwd;
	const scriptPreviews: string[] = [];
	for (const segment of segments) {
		if (segment.length === 0) return null;
		if (segment[0] === "cd") {
			// Each later command runs in this directory, including project-policy
			// cwd matching and script previews. Keep both logical and physical
			// readings inside the workspace before recognizing the transition.
			if (segment.length !== 2) return null;
			const target = segment[1] ?? "";
			const nextCwd = path.resolve(chainCwd, target);
			if (target.startsWith("~") || !isUnderOrSame(nextCwd, workspaceRoot)) return null;
			// A shell `cd` is logical unless `-P` or `set -P` makes it physical;
			// recognize it only when both readings stay inside.
			const physical = canonicalizeRawPath(target, chainCwd);
			if (physical === null || !isUnderOrSame(physical, workspaceRoot)) return null;
			chainCwd = nextCwd;
			ruleIds.push("builtin:cd-workspace");
			continue;
		}
		// Re-rendered from tokens, so quoting is gone: a member that needed its
		// quotes fails the allowlist regex and the whole chain stays unrecognized.
		const rendered = segment.join(" ");
		const projectScript = PROJECT_SCRIPT_COMMANDS.find((entry) => entry.re.test(rendered));
		if (projectScript !== undefined) scriptPreviews.push(projectScriptPreview(rendered, chainCwd));
		const projectMatch = matchingProjectCommand(policy, rendered, chainCwd);
		if (projectMatch) {
			ruleIds.push(projectMatch.id);
			if (projectMatch.requireConfirmation) requiresConfirmation = true;
			continue;
		}
		const testRunner = TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(rendered));
		if (testRunner !== undefined) {
			ruleIds.push(testRunner.id);
			continue;
		}
		if (projectScript !== undefined) {
			ruleIds.push(projectScript.id);
			requiresAutonomyApproval = true;
			continue;
		}
		const builtin = BUILTIN_ALLOWLIST.find((entry) => entry.re.test(rendered));
		if (builtin === undefined) return null;
		ruleIds.push(builtin.id);
	}
	return { ruleIds, requiresConfirmation, requiresAutonomyApproval, scriptPreviews };
}

/**
 * Sequencing and redirection operators. These defeat per-command allowlist
 * matching but hide nothing from the rule pack, which scans the full string.
 */
function hasSequencingOperators(command: string): boolean {
	return /(\|\||&&|;|\||>>?|<|\n|\r)/.test(command);
}

/**
 * Content-hiding constructs: `$(...)` and backticks execute text the net
 * cannot see until runtime. Kept separate from sequencing (sd-01 M5) so they
 * can ask in default while yolo passes the ordinary confirmation.
 */
function hasCommandSubstitution(command: string): boolean {
	return /(`|\$\()/.test(command);
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

function pathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
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
/**
 * Strings a damage-control rule is tested against. Joining every argument into
 * one blob put the command in the middle of it, so a rule anchored with `$`
 * stopped matching the moment the model also supplied `cwd` or `timeout_ms`:
 * `git restore .` ran at both levels and the authored `git checkout -- .`
 * confirm rail fell through to the classifier's unconditional git_destructive
 * block (BT-001). The command is offered on its own as well. The blob stays a
 * candidate so no rule that matched before stops matching now.
 */
function damageControlScans(call: ClassifierCall): string[] {
	if (CONTENT_BEARING_TOOLS.has(call.tool)) {
		const pathArg = call.args?.path;
		return typeof pathArg === "string" ? [pathArg] : [];
	}
	// `bash` is the only tool with a `command` argument, and its others (`cwd`,
	// `timeout_ms`, `output_policy`) are not commands. Scanning the blob as well
	// would let a bare `cwd: "."` complete a pathspec the command did not write,
	// so a call that carries a command is scanned as a command. `cwd` keeps its
	// own path policy.
	const command = call.args?.command;
	if (typeof command === "string") return [command, ...shellCommandSegments(command)];
	return [serializeArgs(call.args)];
}

/**
 * Source text of each command a shell string would actually execute, including
 * the ones inside a `$(...)` substitution or an `sh -c` script.
 *
 * A damage-control pattern anchored with `$` matches only at the end of the
 * string it is tested against, so `git restore . && echo RESTORED` hid its
 * destructive segment and ran at yolo with no card, discarding a dirty tracked
 * file (BT-002). Every operator opened the same hole, and the audit blamed
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
