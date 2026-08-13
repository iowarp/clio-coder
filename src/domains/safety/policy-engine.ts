import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { clioConfigDir } from "../../core/xdg.js";
import { type ActionClass, type Classification, type ClassifierCall, classify } from "./action-classifier.js";
import type { DamageControlMatch, DamageControlRule } from "./damage-control.js";
import { DEFAULT_DAMAGE_CONTROL_PATH_POLICY, mergePathPolicyInputs } from "./default-path-policy.js";
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
import { extractCommandDeleteTargets, extractCommandWriteTargets, tokenizeShellLike } from "./protected-artifacts.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { getCachedDefaultRulePacks, type PackId, type RulePacks } from "./rule-pack-loader.js";

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
	 * `ask` is a net rail demanding operator confirmation at every level, and
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
	 * autonomy mapping asks for unrecognized execution below full-auto.
	 */
	execRecognition?: "recognized" | "unrecognized";
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
	cwd: string;
}

export interface SafetyPolicyEngine {
	evaluate(call: ClassifierCall, posture?: string): SafetyPolicyDecision;
	metadata(posture?: string): SafetyPolicyMetadata;
}

export interface SafetyPolicyEngineOptions {
	cwd?: string;
	rulePacks?: RulePacks;
	projectPolicy?: LoadedProjectSafetyPolicy;
	/**
	 * Absolute directories a write-class tool call is confined to for this run.
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
	{ id: "builtin:npm-test", re: /^npm\s+(?:test|run\s+test)(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-lint", re: /^npm\s+run\s+lint(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-build", re: /^npm\s+run\s+build(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-typecheck", re: /^npm\s+run\s+typecheck(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:npm-ci-script", re: /^npm\s+run\s+ci(?:\s+--\s+[\w=./:-]+(?:\s+[\w=./:-]+)*)?$/ },
	{ id: "builtin:pytest", re: /^pytest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:python-pytest", re: /^python(?:3(?:\.\d+)?)?\s+-m\s+pytest(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:cargo-test", re: /^cargo\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:go-test", re: /^go\s+test(?:\s+[\w=./:-]+)*$/ },
	{ id: "builtin:make-test", re: /^make\s+test(?:\s+[\w=./:-]+)*$/ },
];

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
	ToolNames.Dispatch,
]);

// Write-class tools (action class "write"). bash is execute class and runs its
// own loop, so it is not covered by the lexical write-root containment below.
const WRITE_ROOT_TOOLS = new Set<string>([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

function writeRootTargetPath(call: ClassifierCall): string | null {
	if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
	const target = pathArg(call.args);
	if (target !== null) return target;
	if (call.tool === ToolNames.Artifact) {
		const kind = call.args?.kind;
		return kind === "review" ? "REVIEW.md" : kind === "report" ? "REPORT.md" : "PLAN.md";
	}
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
	for (const root of roots) {
		if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return null;
	}
	return `write target '${target}' resolves to '${resolved}', which is outside the permitted write roots for this run: ${roots.join(", ")}`;
}

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = canonicalizeExistingPath(path.resolve(options.cwd ?? process.cwd()));
	// Write-root containment resolves lexically, so it keeps its own un-canonicalized
	// cwd and roots to compare like against like (the design mandates no symlink chasing).
	const writeRootCwd = path.resolve(options.cwd ?? process.cwd());
	const writeRoots = (options.writeRoots ?? []).map((root) => path.resolve(root));
	const packs = options.rulePacks ?? getCachedDefaultRulePacks();
	const projectPolicy = options.projectPolicy ?? loadProjectSafetyPolicy(cwd);
	const projectPolicyRoot =
		projectPolicy.path === null ? cwd : path.dirname(path.dirname(canonicalizeExistingPath(projectPolicy.path)));
	const pathPolicyInput = projectPolicy.disableDefaultPathPolicy
		? projectPolicy.pathPolicy
		: mergePathPolicyInputs(DEFAULT_DAMAGE_CONTROL_PATH_POLICY, projectPolicy.pathPolicy);
	// Clio's own secret store, by absolute path. The static default list carries
	// the `credentials.yaml` literal; the expansion has to happen here because
	// the list cannot call config helpers at module scope.
	const expandedDefaults = projectPolicy.disableDefaultPathPolicy
		? pathPolicyInput
		: mergePathPolicyInputs(pathPolicyInput, { zeroAccessPaths: clioCredentialStorePaths() });
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
		evaluate(call, posture) {
			const rawClassification = classify(call);
			const command = commandArg(call.args);
			const callCwd = cwdArg(call.args, cwd);
			const scan = damageControlScan(call);
			const hit = scan ? matchSourcedRule(scan, sourcedRules) : null;
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

			// The path policy runs regardless of project policy validity. When
			// `.clio/safety.yaml` is invalid, the loader has already dropped every
			// project-authored path entry and forced `disableDefaultPathPolicy`
			// off, so the compiled policy here carries exactly the built-in
			// defaults. Evaluating it unconditionally keeps default credential
			// protection (`.env`, `~/.ssh/`, `credentials.yaml`, ...) active on a
			// broken config, which is the fail-closed intent; project-authored
			// additions and exemptions stay gated on validity inside the loader.
			const pathBlock = evaluateProjectPathPolicy(pathPolicy, call, callCwd);
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
			if (call.tool === ToolNames.Bash && command !== null) {
				const secretRead = evaluateBashZeroAccessRead(zeroAccessPolicy, command, callCwd);
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
					reasons: [...classification.reasons, "system-level changes require one-shot confirmation at every autonomy level"],
					policySource: "builtin-classifier",
				};
				return posture === "confirmed" ? allowDecision(base, input) : askDecision(base, input);
			}

			if (call.tool === ToolNames.Bash && classification.actionClass === "execute") {
				const bash = evaluateBashPolicy(command ?? "", callCwd, cwd, posture, projectPolicy);
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
			// The typed execution tool (verify) is bounded by its own check
			// allowlist, so it sits in the no-prompt set.
			if (classification.actionClass === "execute") allowInput.execRecognition = "recognized";
			return allowDecision(base, allowInput);
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
	for (const token of tokenizeShellLike(command)) {
		if (token.length === 0) continue;
		if (token === ";" || token === "&&" || token === "||" || token === "|" || token === ">" || token === ">>") continue;
		if (token === "<" || token === "<<") continue;
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
): Extract<PathPolicyDecision, { kind: "block" }> | null {
	if (policy.entries.length === 0) return null;
	for (const target of pathPolicyTargets(call)) {
		const decision = evaluatePathPolicy(policy, target.operation, target.path, callCwd);
		if (decision.kind === "block") return decision;
	}
	return null;
}

function pathPolicyTargets(call: ClassifierCall): Array<{ operation: PathPolicyOperation; path: string }> {
	const args = call.args;
	switch (call.tool) {
		case ToolNames.Read:
		case ToolNames.Ls:
		case ToolNames.Grep:
		case ToolNames.Find: {
			const target = pathArg(args) ?? ".";
			return [{ operation: "read", path: target }];
		}
		case ToolNames.Write:
		case ToolNames.Edit: {
			const target = pathArg(args);
			return target === null ? [] : [{ operation: "write", path: target }];
		}
		case ToolNames.Artifact: {
			const fallback = args?.kind === "review" ? "REVIEW.md" : args?.kind === "report" ? "REPORT.md" : "PLAN.md";
			return [{ operation: "write", path: pathArg(args) ?? fallback }];
		}
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
	command: string,
	callCwd: string,
	workspaceRoot: string,
	posture: string | undefined,
	policy: LoadedProjectSafetyPolicy,
): Omit<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> {
	if (command.trim().length === 0) {
		return {
			kind: "block",
			ruleId: "bash-empty-command",
			reasonCode: "bash-empty-command",
			reasons: ["bash command must not be empty"],
			policySource: "builtin-command-allowlist",
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
		if (projectMatch.requireConfirmation && posture !== "confirmed") {
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
	// what `$(...)` or backticks produce at runtime, so it stays an ask rail at
	// every level, including full-auto (sd-01 M5). A confirmed posture (one-shot
	// grant) admits it like any other confirm rail.
	if (hasCommandSubstitution(command) && posture !== "confirmed") {
		return {
			kind: "ask",
			ruleId: "bash-command-substitution",
			reasonCode: "bash-command-substitution",
			reasons: ["command substitution hides the executed content from the safety net and requires one-shot confirmation"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	// Sequencing operators (pipes, &&, ;, redirects) defeat per-command
	// recognition, so the command is unrecognized by definition: the autonomy
	// mapping asks at suggest/auto-edit, runs at full-auto, denies at
	// read-only. The rule pack has already scanned the full string, so a
	// destructive verb behind an operator was caught before this point.
	if (hasSequencingOperators(command)) {
		return {
			kind: "allow",
			ruleId: "bash-shell-operators",
			reasonCode: "bash-shell-operators",
			reasons: ["shell operators defeat per-command recognition; the autonomy level decides admission"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	for (const entry of BUILTIN_ALLOWLIST) {
		if (entry.re.test(command)) {
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
		reasons: ["bash command is outside the no-prompt set; the autonomy level decides admission"],
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

function matchSourcedRule(commandString: string, rules: ReadonlyArray<SourcedRule>) {
	for (const entry of rules) {
		if (entry.rule.pattern.test(commandString)) {
			const match: DamageControlMatch = {
				ruleId: entry.rule.id,
				reason: `matched ${entry.rule.id}: ${entry.rule.description}`,
				actionClass: entry.rule.class,
				block: entry.rule.block,
			};
			if (entry.rule.ask !== undefined) match.ask = entry.rule.ask;
			return { match, source: entry.source };
		}
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
 * can stay ask-gated at full-auto.
 */
function hasCommandSubstitution(command: string): boolean {
	return /(`|\$\()/.test(command);
}

/** Any shell operator at all; project policy entries with `shellOperators: deny` reject both kinds. */
function hasShellOperators(command: string): boolean {
	return hasSequencingOperators(command) || hasCommandSubstitution(command);
}

function isUnderOrSame(child: string, parent: string): boolean {
	const rel = path.relative(
		canonicalizeExistingPath(path.resolve(parent)),
		canonicalizeExistingPath(path.resolve(child)),
	);
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
 * Tools whose arguments are a file's contents rather than a command line.
 * Their damage-control scan is the destination path alone.
 */
const CONTENT_BEARING_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

/**
 * The text damage-control rules are matched against.
 *
 * Every rule in the pack is a command pattern: shell (`rm -rf /`, `chmod -R
 * 777`), cloud CLI (`aws s3 rm --recursive`), or SQL (`DROP TABLE`). Matching
 * them against a file's contents asks whether the file *mentions* a dangerous
 * command, which is a different question from whether the call *runs* one, and
 * the two are indistinguishable once the text is in the haystack.
 *
 * That cost a real feature. `clio context wiki` could not write its own
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
 */
function damageControlScan(call: ClassifierCall): string {
	if (!CONTENT_BEARING_TOOLS.has(call.tool)) return serializeArgs(call.args);
	const pathArg = call.args?.path;
	return typeof pathArg === "string" ? pathArg : "";
}

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
