import { ToolNames } from "../../core/tool-names.js";
import type { ActionClass, ClassifierCall } from "../safety/action-classifier.js";
import type { SafetyDecision } from "../safety/contract.js";
import { normalizedGitCommands } from "../safety/git-command-normalization.js";
import { extractCommandPathWalks } from "../safety/protected-artifacts.js";
import type { RefsAtRisk } from "./pins.js";

/**
 * When an admitted call needs a workspace snapshot before its body runs. Pure:
 * it reads the call's effect (a trusted `safetyCall` projection when the tool
 * has one) and the admitted decision, never the workspace.
 *
 * `turn` means the call mutates and is covered by the turn's first snapshot;
 * `always` means a snapshot is taken right before this call whatever the turn
 * already holds, because the call can discard work that nothing else keeps.
 * `refs` names the refs the call destroys or moves, which that snapshot pins.
 */
export type WorkspaceSnapshotTrigger =
	| { kind: "none" }
	| { kind: "turn" }
	| {
			kind: "always";
			reason: "destructive" | "delete" | "git-discard" | "git-ref-delete" | "git-ref-move";
			refs?: RefsAtRisk;
	  };

const MUTATING_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>([
	"write",
	"execute",
	"system_modify",
	"git_destructive",
	"destructive",
]);

/** Write-class tools whose effect never lands in the workspace. */
const OUTSIDE_WORKSPACE_TOOLS: ReadonlySet<string> = new Set<string>([ToolNames.WebFetch, ToolNames.ConfigureClio]);

/** Damage-control rules (damage-control-rules.yaml) whose command throws away work in the worktree or a stash. */
const GIT_DISCARD_RULE_IDS: ReadonlySet<string> = new Set([
	"git-checkout-force",
	"git-checkout-dot",
	"git-checkout-discard-all",
	"git-restore-discard-all",
	"git-clean-force-directory",
	"git-reset-hard",
	"git-reset-hard-head",
	"git-stash-drop",
	"git-stash-clear",
]);

/**
 * The same family read from the command itself, so a project policy or a
 * confirmed rail that admitted the call under another rule id still snapshots.
 * Deliberately wider than the rules: any checkout or restore with a pathspec
 * overwrites worktree files, and a snapshot that turns out unneeded is reused.
 */
const GIT_DISCARD_COMMANDS: ReadonlyArray<RegExp> = [
	/^git checkout\b.*\s(?:--\s|\.|:\/|-f\b|--force\b)/u,
	/^git restore\b/u,
	/^git clean\b/u,
	/^git reset\b.*\s--(?:hard|merge|keep)\b/u,
	/^git stash\s+(?:drop|clear|pop)\b/u,
];

/**
 * Bash recognized as read-only by the policy engine: the read-only inspection
 * rules, the fixed read allowlist, and chains built only from them.
 */
const READ_ONLY_RULE_IDS: ReadonlySet<string> = new Set([
	"builtin:pwd",
	"builtin:git-status",
	"builtin:git-diff",
	"builtin:git-log",
	"builtin:git-inspect",
	"builtin:version-probe",
	"builtin:cd-workspace",
]);
const READ_ONLY_RULE_PREFIX = "builtin:read-only:";
const CHAIN_REASON_PREFIX = "every step of the command is recognized: ";

function readOnlyRule(ruleId: string): boolean {
	return READ_ONLY_RULE_IDS.has(ruleId) || ruleId.startsWith(READ_ONLY_RULE_PREFIX);
}

function recognizedReadOnly(decision: SafetyDecision): boolean {
	const policy = decision.policy;
	if (policy?.ruleId === undefined) return false;
	if (readOnlyRule(policy.ruleId)) return true;
	if (policy.ruleId !== "bash-recognized-chain") return false;
	const steps = policy.reasons.find((reason) => reason.startsWith(CHAIN_REASON_PREFIX));
	if (steps === undefined) return false;
	const ids = steps
		.slice(CHAIN_REASON_PREFIX.length)
		.split(",")
		.map((id) => id.trim());
	return ids.length > 0 && ids.every(readOnlyRule);
}

function gitDiscards(decision: SafetyDecision, command: string | null): boolean {
	const ruleIds = [
		decision.policy?.ruleId,
		decision.policy?.match?.ruleId,
		decision.kind === "allow" ? undefined : decision.match?.ruleId,
	];
	if (ruleIds.some((id) => id !== undefined && GIT_DISCARD_RULE_IDS.has(id))) return true;
	if (command === null) return false;
	return normalizedGitCommands(command).some((candidate) => GIT_DISCARD_COMMANDS.some((re) => re.test(candidate)));
}

/**
 * Local branches a `git branch` delete names (`-d`, `-D`, `--delete`, alone or
 * in a flag cluster), or null when no segment deletes a branch. A deleted
 * branch takes its reflog with it, so nothing but a pin keeps its commits. A
 * remote-tracking delete (`-r`) is still a ref delete but pins nothing: the
 * next fetch brings those refs back.
 */
function deletedBranches(candidates: ReadonlyArray<string>): string[] | null {
	let found: string[] | null = null;
	for (const candidate of candidates) {
		const words = candidate.split(/\s+/u);
		if (words[1] !== "branch") continue;
		let deletes = false;
		let remote = false;
		let operands = false;
		const names: string[] = [];
		for (const word of words.slice(2)) {
			if (operands || !word.startsWith("-") || word === "-") {
				names.push(word);
			} else if (word === "--") {
				operands = true;
			} else if (word.startsWith("--")) {
				// Git takes any unique prefix: `--d` is already --delete, while `--r`
				// and `--re` could still be --recurse-submodules.
				const option = word.split("=")[0] ?? word;
				if (option.length >= 3 && "--delete".startsWith(option)) deletes = true;
				if (option.length >= 5 && "--remotes".startsWith(option)) remote = true;
			} else {
				if (/[dD]/u.test(word)) deletes = true;
				if (word.includes("r")) remote = true;
			}
		}
		if (deletes) found = [...(found ?? []), ...(remote ? [] : names)];
	}
	return found;
}

/** Rules whose command loses stash entries, read when a policy matched the call under its rule id. */
const STASH_LOSS_RULE_IDS: ReadonlySet<string> = new Set(["git-stash-drop", "git-stash-clear"]);

/**
 * A reset whose first operand is not HEAD moves the branch tip. A path
 * operand reads as a commit here; the only cost of that is a pin.
 */
function movesBranchTip(candidate: string): boolean {
	const words = candidate.split(/\s+/u);
	if (words[1] !== "reset") return false;
	for (const word of words.slice(2)) {
		if (word === "--") return false;
		if (word.startsWith("-")) continue;
		return word !== "HEAD" && word !== "@";
	}
	return false;
}

function deletes(command: string): boolean {
	return extractCommandPathWalks(command).some((walk) => walk.some((event) => event.kind === "delete"));
}

export function workspaceSnapshotTrigger(effect: ClassifierCall, decision: SafetyDecision): WorkspaceSnapshotTrigger {
	const actionClass = decision.classification.actionClass;
	if (!MUTATING_CLASSES.has(actionClass) || OUTSIDE_WORKSPACE_TOOLS.has(effect.tool)) return { kind: "none" };
	const command =
		effect.tool === ToolNames.Bash && typeof effect.args?.command === "string" ? effect.args.command : null;
	const candidates = command === null ? [] : normalizedGitCommands(command);
	const deleted = deletedBranches(candidates);
	const stash =
		candidates.some((candidate) => /^git stash\s+(?:drop|clear|pop)\b/u.test(candidate)) ||
		[decision.policy?.ruleId, decision.policy?.match?.ruleId].some(
			(id) => id !== undefined && STASH_LOSS_RULE_IDS.has(id),
		);
	const head = candidates.some(movesBranchTip);
	const refs = deleted !== null || stash || head ? { refs: { head, stash, branches: deleted ?? [] } } : {};
	if (gitDiscards(decision, command)) return { kind: "always", reason: "git-discard", ...refs };
	if (deleted !== null) return { kind: "always", reason: "git-ref-delete", ...refs };
	if (head) return { kind: "always", reason: "git-ref-move", ...refs };
	if (actionClass === "destructive" || actionClass === "git_destructive")
		return { kind: "always", reason: "destructive" };
	if (command !== null && deletes(command)) return { kind: "always", reason: "delete" };
	if (recognizedReadOnly(decision)) return { kind: "none" };
	return { kind: "turn" };
}
