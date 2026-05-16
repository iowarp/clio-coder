import { createHash } from "node:crypto";
import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { ModeName } from "../modes/matrix.js";
import { type ActionClass, type Classification, type ClassifierCall, classify } from "./action-classifier.js";
import type { DamageControlMatch, DamageControlRule } from "./damage-control.js";
import {
	type LoadedProjectSafetyPolicy,
	loadProjectSafetyPolicy,
	type ProjectCommandPolicy,
} from "./project-policy.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { applicablePacks, getCachedDefaultRulePacks, type PackId, type RulePacks } from "./rule-pack-loader.js";

export type SafetyPolicySource =
	| "damage-control:base"
	| "damage-control:dev"
	| "damage-control:super"
	| "project-policy"
	| "project-policy-invalid"
	| "builtin-command-allowlist"
	| "mode-elevation"
	| "none";

export interface SafetyPolicyDecision {
	kind: "allow" | "ask" | "block";
	classification: Classification;
	tool: string;
	actionClass: ActionClass;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
	reasonCode: string;
	command?: string;
	cwd: string;
	mode?: string;
	policySource: SafetyPolicySource;
	policyHash?: string;
	projectPolicyPath?: string;
	elevationMode?: ModeName;
	match?: DamageControlMatch;
	rejection?: RejectionMessage;
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
	selfDev: boolean;
	cwd: string;
}

export interface SafetyPolicyEngine {
	evaluate(call: ClassifierCall, mode?: string): SafetyPolicyDecision;
	metadata(mode?: string): SafetyPolicyMetadata;
}

export interface SafetyPolicyEngineOptions {
	cwd?: string;
	selfDev?: boolean;
	rulePacks?: RulePacks;
	projectPolicy?: LoadedProjectSafetyPolicy;
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

const EXECUTION_TOOLS = new Set<string>([ToolNames.Bash, "run_tests", "run_lint", "run_build", "package_script"]);

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const selfDev = options.selfDev ?? process.env.CLIO_SELF_DEV === "1";
	const packs = options.rulePacks ?? getCachedDefaultRulePacks();
	const projectPolicy = options.projectPolicy ?? loadProjectSafetyPolicy(cwd);

	function rulesFor(mode: string | undefined): SourcedRule[] {
		const safetyMode = mode ?? "default";
		const base: SourcedRule[] = packs.base.rules.map((rule) => ({ rule, source: "damage-control:base" }));
		const dev: SourcedRule[] = selfDev ? packs.dev.rules.map((rule) => ({ rule, source: "damage-control:dev" })) : [];
		const superRules: SourcedRule[] =
			safetyMode === "super" ? packs.super.rules.map((rule) => ({ rule, source: "damage-control:super" })) : [];
		return [...base, ...dev, ...superRules];
	}

	return {
		evaluate(call, mode) {
			const classification = classify(call);
			const command = commandArg(call.args);
			const callCwd = cwdArg(call.args, cwd);
			const scan = serializeArgs(call.args);
			const hit = scan ? matchSourcedRule(scan, rulesFor(mode)) : null;

			const base = baseDecision(call, classification, callCwd, mode, command);
			if (hit?.match.ask === true && mode !== "super") {
				return askDecision(base, {
					ruleId: hit.match.ruleId,
					reasonCode: `damage-control:${hit.match.ruleId}`,
					reasons: [...classification.reasons, hit.match.reason, "damage-control rule requires confirmation"],
					policySource: hit.source,
					elevationMode: "super",
					match: hit.match,
				});
			}
			if (hit?.match.ask === true && mode === "super") {
				return allowDecision(base, {
					ruleId: hit.match.ruleId,
					reasonCode: `damage-control:${hit.match.ruleId}`,
					reasons: [...classification.reasons, hit.match.reason, "damage-control rule confirmed by super mode"],
					policySource: hit.source,
					match: hit.match,
				});
			}
			if ((classification.actionClass === "git_destructive" && hit?.match.ask !== true) || hit?.match.block === true) {
				const blockInput: Omit<
					SafetyPolicyDecision,
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"
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
					"kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"
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

			if (call.tool === ToolNames.Bash && classification.actionClass === "execute") {
				const bash = evaluateDefaultDenyBash(command ?? "", callCwd, cwd, mode, projectPolicy);
				if (bash.kind === "block") return blockDecision(base, bash);
				if (bash.kind === "ask") return askDecision(base, bash);
				return allowDecision(base, bash);
			}

			const allowInput: Omit<
				SafetyPolicyDecision,
				"kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"
			> = {
				reasonCode: "allowed",
				reasons: classification.reasons,
				policySource: hit?.source ?? "none",
			};
			if (hit?.match.ruleId !== undefined) allowInput.ruleId = hit.match.ruleId;
			if (hit?.match !== undefined) allowInput.match = hit.match;
			return allowDecision(base, allowInput);
		},
		metadata(mode) {
			const rules = rulesFor(mode);
			return {
				version: 1,
				rulePackHash: rulePackHash(packs),
				rulePackVersion: packs.base.version,
				activeRuleIds: rules.map((entry) => entry.rule.id),
				projectPolicyPath: projectPolicy.path,
				projectPolicyHash: projectPolicy.hash,
				projectPolicyValid: projectPolicy.valid,
				projectPolicyErrors: projectPolicy.errors,
				selfDev,
				cwd,
			};
		},
	};
}

function evaluateDefaultDenyBash(
	command: string,
	callCwd: string,
	workspaceRoot: string,
	mode: string | undefined,
	policy: LoadedProjectSafetyPolicy,
): Omit<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"> {
	if (mode === "super") {
		return { kind: "allow", reasonCode: "super-allows-bash", reasons: [], policySource: "mode-elevation" };
	}
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
			"kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"
		> = {
			ruleId: projectMatch.id,
			reasonCode: `project-policy:${projectMatch.id}`,
			reasons: [`allowed by project safety policy command '${projectMatch.id}'`],
			policySource: "project-policy" as const,
		};
		if (policy.hash !== null) base.policyHash = policy.hash;
		if (policy.path !== null) base.projectPolicyPath = policy.path;
		if (projectMatch.requireConfirmation && mode !== "super") {
			return {
				...base,
				kind: "ask",
				elevationMode: "super",
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
	if (hasShellOperators(command)) {
		return {
			kind: "block",
			ruleId: "bash-shell-operators-denied",
			reasonCode: "bash-shell-operators-denied",
			reasons: ["default mode denies shell operators; use typed tools or an explicit project policy command"],
			policySource: "builtin-command-allowlist",
		};
	}
	for (const entry of BUILTIN_ALLOWLIST) {
		if (entry.re.test(command)) {
			return {
				kind: "allow",
				ruleId: entry.id,
				reasonCode: entry.id,
				reasons: [`matched built-in default-deny command allowlist '${entry.id}'`],
				policySource: "builtin-command-allowlist",
			};
		}
	}
	return {
		kind: "block",
		ruleId: "bash-default-deny",
		reasonCode: "bash-default-deny",
		reasons: ["default mode denies arbitrary bash; use typed tools, project safety policy, or super elevation"],
		policySource: "builtin-command-allowlist",
	};
}

function baseDecision(
	call: ClassifierCall,
	classification: Classification,
	cwd: string,
	mode: string | undefined,
	command: string | null,
): Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"> {
	const out: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command"> = {
		classification,
		tool: call.tool,
		actionClass: classification.actionClass,
		cwd,
	};
	if (mode !== undefined) out.mode = mode;
	if (command !== null) out.command = command;
	return out;
}

function allowDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
): SafetyPolicyDecision {
	return { ...base, ...input, kind: "allow" };
}

function askDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
): SafetyPolicyDecision {
	const rejectionInput: Parameters<typeof formatRejection>[0] = {
		tool: base.tool,
		actionClass: base.classification.actionClass,
		reasons: input.reasons,
	};
	if (base.mode !== undefined) rejectionInput.mode = base.mode;
	if (input.ruleId !== undefined) rejectionInput.ruleId = input.ruleId;
	const rejection = formatRejection(rejectionInput);
	return { ...base, ...input, kind: "ask", rejection };
}

function blockDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "mode" | "command">,
): SafetyPolicyDecision {
	const rejectionInput: Parameters<typeof formatRejection>[0] = {
		tool: base.tool,
		actionClass: base.classification.actionClass,
		reasons: input.reasons,
	};
	if (base.mode !== undefined) rejectionInput.mode = base.mode;
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

function hasShellOperators(command: string): boolean {
	return /(\|\||&&|;|\||>>?|<|`|\$\(|\n|\r)/.test(command);
}

function isUnderOrSame(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function commandArg(args: Record<string, unknown> | undefined): string | null {
	return typeof args?.command === "string" ? args.command : null;
}

function cwdArg(args: Record<string, unknown> | undefined, fallback: string): string {
	return typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(args.cwd) : fallback;
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
		dev: packPayload(packs.dev.rules),
		super: packPayload(packs.super.rules),
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

export function activeDamageControlRulesForMetadata(
	packs: RulePacks,
	options: { selfDev: boolean; safetyMode: string },
): ReadonlyArray<DamageControlRule> {
	return applicablePacks(packs, options);
}
