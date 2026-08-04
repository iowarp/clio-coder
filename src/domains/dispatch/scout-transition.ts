/** Pure coordinator-owned compilation of strict Scout phase-transition data. */

import type { ScoutResult } from "../agents/result-contract.js";
import type { AgentAutomationAuthority, AgentSpec } from "../agents/spec.js";
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { deriveExecutionRole } from "./execution-role.js";

export type TrustedTransitionAuthorityBasis = "existing-plan" | "operator-plan-approval" | "full-auto-policy";

export interface TrustedTransitionAuthority {
	basis: TrustedTransitionAuthorityBasis;
	approvedAuthorities: ReadonlyArray<AgentAutomationAuthority>;
}

export interface ScoutAgentBinding {
	subtaskId: string;
	spec: AgentSpec;
}

export type ScoutTransition =
	| {
			kind: "settled";
			sourceReceiptDigest: string;
			findings: ScoutResult["findings"];
	  }
	| {
			kind: "approval-required";
			sourceReceiptDigest: string;
			plan: ExecutionPlan;
			requiredAuthorities: ReadonlyArray<AgentAutomationAuthority>;
	  }
	| {
			kind: "ready";
			sourceReceiptDigest: string;
			plan: ExecutionPlan;
			authority: TrustedTransitionAuthority;
	  };

function scopeFor(authority: AgentAutomationAuthority): "readonly" | "workspace" {
	return authority === "read-only" || authority === "verification" ? "readonly" : "workspace";
}

function assertReceiptDigest(value: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("scout transition: source receipt digest is invalid");
}

/**
 * Scout fields are copied individually and never spread. Agent, role, scope,
 * and grants come only from coordinator-owned bindings and authority state.
 */
export function compileScoutTransition(input: {
	scout: ScoutResult;
	sourceReceiptDigest: string;
	rootTask: string;
	bindings: ReadonlyArray<ScoutAgentBinding>;
	authority: TrustedTransitionAuthority;
	maxWorkers: number;
}): ScoutTransition {
	assertReceiptDigest(input.sourceReceiptDigest);
	if (!input.scout.needsSplit) {
		return {
			kind: "settled",
			sourceReceiptDigest: input.sourceReceiptDigest,
			findings: input.scout.findings.map((finding) => ({ ...finding })),
		};
	}
	const subtasks = input.scout.proposedSubtasks;
	const byId = new Map(input.bindings.map((binding) => [binding.subtaskId, binding]));
	if (byId.size !== input.bindings.length || byId.size !== subtasks.length) {
		throw new Error("scout transition: coordinator bindings must match subtasks exactly");
	}
	for (const binding of input.bindings) {
		if (!subtasks.some((subtask) => subtask.id === binding.subtaskId)) {
			throw new Error(`scout transition: undeclared binding '${binding.subtaskId}'`);
		}
	}
	const approved = new Set(input.authority.approvedAuthorities);
	const missing = new Set<AgentAutomationAuthority>();
	const steps = subtasks.map((subtask) => {
		const binding = byId.get(subtask.id);
		if (binding === undefined) throw new Error(`scout transition: subtask '${subtask.id}' has no agent binding`);
		if (binding.spec.resultContract.kind !== subtask.expectedResultContract) {
			throw new Error(`scout transition: subtask '${subtask.id}' result contract does not match its bound agent`);
		}
		if (binding.spec.capabilityClass !== subtask.requestedAuthority) {
			throw new Error(`scout transition: subtask '${subtask.id}' authority does not match its bound agent`);
		}
		const granted = approved.has(subtask.requestedAuthority);
		if (!granted) missing.add(subtask.requestedAuthority);
		return {
			id: subtask.id,
			agentId: binding.spec.id,
			executionRole: deriveExecutionRole({
				attempt: 0,
				capabilityClass: binding.spec.capabilityClass,
				resultContractKind: binding.spec.resultContract.kind,
			}),
			scope: scopeFor(subtask.requestedAuthority),
			expectedResultContract: subtask.expectedResultContract,
			requestedAuthority: subtask.requestedAuthority,
			approvedAuthority: granted ? subtask.requestedAuthority : null,
			dependencies: [...subtask.dependencies],
			task: subtask.task,
		};
	});
	const plan = compileExecutionPlan({
		topology: "fleet",
		rootTask: input.rootTask,
		maxWorkers: Math.max(1, Math.min(4, input.maxWorkers, steps.length)),
		onFailure: "stop",
		steps,
	});
	if (missing.size > 0) {
		return {
			kind: "approval-required",
			sourceReceiptDigest: input.sourceReceiptDigest,
			plan,
			requiredAuthorities: [...missing],
		};
	}
	return {
		kind: "ready",
		sourceReceiptDigest: input.sourceReceiptDigest,
		plan,
		authority: {
			basis: input.authority.basis,
			approvedAuthorities: [...input.authority.approvedAuthorities],
		},
	};
}
