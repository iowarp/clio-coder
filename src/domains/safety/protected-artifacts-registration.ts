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

import { ToolNames } from "../../core/tool-names.js";
import type {
	MiddlewareEffect,
	MiddlewareHookEvaluationContext,
	MiddlewareHookInput,
	MiddlewareHookRegistration,
} from "../middleware/index.js";
import {
	classifyDestructiveCommand,
	isProtectedPath,
	type ProtectedArtifact,
	type ProtectedArtifactState,
	protectArtifact,
	toolMutationPaths,
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
	/** Replace the state wholesale, typically after a session switch. */
	replaceState(state: ProtectedArtifactState): void;
}

export interface CreateProtectedArtifactsRegistrationOptions {
	initialState?: ProtectedArtifactState;
	/**
	 * Best-effort persistence sink. Errors are swallowed: protection state is
	 * already live in memory and persistence must not change tool execution.
	 */
	onProtect?: (event: ProtectedArtifactProtectEvent) => void;
}

export function createProtectedArtifactsRegistration(
	options: CreateProtectedArtifactsRegistrationOptions = {},
): ProtectedArtifactsRegistration {
	let state = cloneState(options.initialState ?? { artifacts: [] });

	const absorb = (input: MiddlewareHookInput, context: MiddlewareHookEvaluationContext | undefined): void => {
		for (const effect of context?.priorEffects ?? []) {
			if (effect.kind !== "protect_path") continue;
			const artifact = artifactFromEffect(effect, input);
			state = protectArtifact(state, artifact);
			emitProtect(options.onProtect, artifact, input);
		}
	};

	const blockReason = (input: MiddlewareHookInput): string | null => {
		if (state.artifacts.length === 0) return null;
		const toolName = input.toolName ?? "";
		const args = input.toolArgs !== undefined ? { ...input.toolArgs } : undefined;
		for (const candidate of toolMutationPaths(toolName, args)) {
			if (isProtectedPath(state, candidate)) {
				return `protected artifact blocked: ${toolName} would modify protected path ${candidate}`;
			}
		}
		if (toolName !== ToolNames.Bash) return null;
		const command = commandArg(args);
		if (command === null) return null;
		const classification = classifyDestructiveCommand(command, state.artifacts);
		if (classification.kind === "benign") return null;
		const affected = classification.matches.map((match) => match.artifactPath).join(", ");
		return `protected artifact blocked: ${classification.operation} would affect ${affected}`;
	};

	return {
		id: PROTECTED_ARTIFACTS_REGISTRATION_ID,
		description: "blocks mutations of protected paths and absorbs protect_path effects",
		hooks: ["before_tool", "after_tool"],
		state: () => cloneState(state),
		replaceState(next) {
			state = cloneState(next);
		},
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
	try {
		sink(event);
	} catch {
		// Persistence is best-effort and must not change tool execution.
	}
}

function commandArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	return typeof args.command === "string" && args.command.length > 0 ? args.command : null;
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
