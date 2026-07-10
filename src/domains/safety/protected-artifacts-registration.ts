/**
 * Protected-artifacts guard, packaged as a middleware hook registration.
 *
 * Replaces the registry's former inline checks and registry-owned state: this
 * registration owns the runtime protection state, blocks mutations of
 * protected paths on before_tool, classifies destructive bash commands, and
 * absorbs `protect_path` effects emitted by earlier rules in the same hook
 * run (the `priorEffects` context), reporting each absorption through the
 * `onProtect` sink so the composition root can persist it. Register it after
 * rules and after the loop guard so absorption sees every protect_path of the
 * evaluation, preserving the registry's former post-hooks recheck semantics.
 */

import type {
	MiddlewareEffect,
	MiddlewareHookEvaluationContext,
	MiddlewareHookInput,
	MiddlewareHookRegistration,
} from "../middleware/index.js";
import { classify } from "./action-classifier.js";
import {
	type ProtectedArtifact,
	type ProtectedArtifactState,
	protectArtifact,
	protectedArtifactMutationBlockReason,
} from "./protected-artifacts.js";

export const PROTECTED_ARTIFACTS_REGISTRATION_ID = "guard.protected-artifacts";

/** Persistence notification for one newly protected artifact. */
export interface ProtectedArtifactProtectEvent {
	kind: "protect";
	artifact: ProtectedArtifact;
	toolName: string;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
}

export interface ProtectedArtifactsRegistration extends MiddlewareHookRegistration {
	/** Current protection state, cloned for callers. */
	state(): ProtectedArtifactState;
	/** Durability/reload health for the hard-block boundary. */
	health(): ProtectedArtifactsHealth;
	/** Replace the state wholesale, typically after a session switch. */
	replaceState(state: ProtectedArtifactState): void;
	/** Preserve last-known state and fail closed after a persistence/reload fault. */
	markDegraded(reason: string): void;
}

export type ProtectedArtifactsHealth = { kind: "healthy" } | { kind: "degraded"; reason: string; since: string };

export interface CreateProtectedArtifactsRegistrationOptions {
	initialState?: ProtectedArtifactState;
	/**
	 * Persistence sink. A thrown error keeps protection live, marks durability
	 * degraded, and makes later non-read calls fail closed until a trustworthy
	 * state replacement succeeds.
	 */
	onProtect?: (event: ProtectedArtifactProtectEvent) => void;
	/** Operator-visible diagnostic seam for a newly degraded boundary. */
	onDurabilityFailure?: (health: Extract<ProtectedArtifactsHealth, { kind: "degraded" }>) => void;
}

export function createProtectedArtifactsRegistration(
	options: CreateProtectedArtifactsRegistrationOptions = {},
): ProtectedArtifactsRegistration {
	let state = cloneState(options.initialState ?? { artifacts: [] });
	let health: ProtectedArtifactsHealth = { kind: "healthy" };

	const markDegraded = (reason: string): void => {
		if (health.kind === "degraded") return;
		const degraded: Extract<ProtectedArtifactsHealth, { kind: "degraded" }> = {
			kind: "degraded",
			reason,
			since: new Date().toISOString(),
		};
		health = degraded;
		try {
			options.onDurabilityFailure?.({ ...degraded });
		} catch {
			// Diagnostics must not weaken or destabilize the hard-block boundary.
		}
	};

	const absorb = (input: MiddlewareHookInput, context: MiddlewareHookEvaluationContext | undefined): void => {
		for (const effect of context?.priorEffects ?? []) {
			if (effect.kind !== "protect_path") continue;
			const artifact = artifactFromEffect(effect, input);
			state = protectArtifact(state, artifact);
			try {
				emitProtect(options.onProtect, artifact, input);
			} catch (error) {
				markDegraded(`protected artifact persistence failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

	const blockReason = (input: MiddlewareHookInput): string | null => {
		const toolName = input.toolName ?? "";
		const args = input.toolArgs !== undefined ? { ...input.toolArgs } : undefined;
		if (health.kind === "degraded") {
			const actionClass = classify({ tool: toolName, ...(args !== undefined ? { args } : {}) }).actionClass;
			if (actionClass !== "read") {
				return `protected artifact durability degraded: ${health.reason}; non-read tool '${toolName}' is blocked until protection state is trustworthy`;
			}
		}
		return protectedArtifactMutationBlockReason(state, toolName, args);
	};

	return {
		id: PROTECTED_ARTIFACTS_REGISTRATION_ID,
		description: "blocks mutations of protected paths and absorbs protect_path effects",
		hooks: ["before_tool", "after_tool"],
		state: () => cloneState(state),
		health: () => ({ ...health }),
		replaceState(next) {
			state = cloneState(next);
			health = { kind: "healthy" };
		},
		markDegraded,
		evaluate(input, context): ReadonlyArray<MiddlewareEffect> {
			absorb(input, context);
			if (input.hook !== "before_tool") return [];
			const reason = blockReason(input);
			if (reason === null) return [];
			return [{ kind: "block_tool", reason, severity: "hard-block" }];
		},
	};
}

function artifactFromEffect(
	effect: Extract<MiddlewareEffect, { kind: "protect_path" }>,
	input: MiddlewareHookInput,
): ProtectedArtifact {
	const artifact: ProtectedArtifact = {
		path: effect.path,
		protectedAt: new Date().toISOString(),
		reason: effect.reason,
		source: "middleware",
	};
	const validationCommand = input.metadata?.validationCommand;
	if (typeof validationCommand === "string" && validationCommand.length > 0) {
		artifact.validationCommand = validationCommand;
		if (input.metadata?.validationExitCode === 0) artifact.validationExitCode = 0;
	}
	return artifact;
}

function emitProtect(
	sink: ((event: ProtectedArtifactProtectEvent) => void) | undefined,
	artifact: ProtectedArtifact,
	input: MiddlewareHookInput,
): void {
	if (!sink) return;
	const event: ProtectedArtifactProtectEvent = {
		kind: "protect",
		artifact: cloneArtifact(artifact),
		toolName: input.toolName ?? "",
	};
	if (input.runId !== undefined) event.runId = input.runId;
	if (input.sessionId !== undefined) event.sessionId = input.sessionId;
	if (input.turnId !== undefined) event.turnId = input.turnId;
	if (input.toolCallId !== undefined) event.toolCallId = input.toolCallId;
	if (input.correlationId !== undefined) event.correlationId = input.correlationId;
	sink(event);
}

function cloneState(state: ProtectedArtifactState): ProtectedArtifactState {
	let next: ProtectedArtifactState = { artifacts: [] };
	for (const artifact of state.artifacts) {
		next = protectArtifact(next, artifact);
	}
	return next;
}

function cloneArtifact(artifact: ProtectedArtifact): ProtectedArtifact {
	const clone: ProtectedArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) clone.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) clone.validationExitCode = artifact.validationExitCode;
	return clone;
}
