import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import {
	createReadOnlyExplorationNudgeRegistration,
	isReadOnlyExplorationCall,
	workspaceRelativeTarget,
} from "./dispatch-nudge.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { type MiddlewareEffect, type MiddlewareHookInput, metadataString } from "./types.js";

/**
 * Broad-survey scout nudge (XR-1).
 *
 * A survey that spans several areas of the workspace is what a parallel scout
 * dispatch is for, yet the main agent reads its way through it alone and its
 * context grows with every result. Once per user turn, when the main agent has
 * made {@link SCOUT_NUDGE_READ_THRESHOLD} succeeded read-class calls inside the
 * workspace that between them touch {@link SCOUT_NUDGE_AREA_THRESHOLD} or more
 * distinct top-level directories, and no dispatch call ran this turn, one
 * host-framed note on the read that crossed the line suggests one parallel
 * scout dispatch with one task per area.
 *
 * Typed signals only: the tool's read class and its path arguments. Bash is
 * never counted, because its scope lives in command text (#431). The turn must
 * be able to dispatch, read from the host's turn_start capability list; a
 * worker or a session that never reports a turn_start here is never nudged.
 */

export const SCOUT_NUDGE_REGISTRATION_ID = "nudge.scout-survey";
export const SCOUT_NUDGE_READ_THRESHOLD = 10;
export const SCOUT_NUDGE_AREA_THRESHOLD = 3;

const SCOUT_NUDGE_TURN_LIMIT = 32;
const AREAS_NAMED = 6;
const NONE: ReadonlyArray<MiddlewareEffect> = [];

interface ScoutSurveyTurn {
	canDispatch: boolean;
	reads: number;
	areas: Set<string>;
	dispatched: boolean;
	advised: boolean;
}

function buildScoutNudgeMessage(areas: ReadonlyArray<string>): string {
	const named = areas.slice(0, AREAS_NAMED).map((area) => `${area}/`);
	const rest = areas.length - named.length;
	return (
		`[CLIO Coder] This turn made ${SCOUT_NUDGE_READ_THRESHOLD}+ reads across ${areas.length} areas ` +
		`(${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}) without a dispatch. ` +
		`For the rest of this survey, one parallel dispatch with agent "scout" and one task per area keeps this context small; ` +
		"synthesize from the run records."
	);
}

/** The top-level directory a workspace-relative target sits in, or null for the root or a root-level file. */
function topLevelArea(within: string, workspaceRoot: string): string | null {
	if (within === "") return null;
	const segments = within.split(sep);
	const first = segments[0];
	if (first === undefined || first.length === 0) return null;
	if (segments.length > 1) return first;
	try {
		return statSync(join(workspaceRoot, first)).isDirectory() ? first : null;
	} catch {
		return null;
	}
}

/** Strict: a host that did not report the turn's capabilities gets no nudge. */
function turnReportsDispatch(input: MiddlewareHookInput): boolean {
	const names = metadataString(input, "activeCapabilityNames") ?? metadataString(input, "activeToolNames");
	return names?.split(",").some((name) => name.trim() === ToolNames.Dispatch) === true;
}

export function createScoutNudgeRegistration(deps: { workspaceRoot?: () => string } = {}): MiddlewareHookRegistration {
	const byTurn = new Map<string, ScoutSurveyTurn>();
	return {
		id: SCOUT_NUDGE_REGISTRATION_ID,
		description: "suggest one parallel scout dispatch when a turn's reads span several top-level directories",
		hooks: ["turn_start", "before_tool", "after_tool"],
		evidence: "count:read-class-calls+top-level-areas@user-turn",
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start") {
				const key = metadataString(input, "userTurnId");
				if (key === null || key.length === 0) return NONE;
				const existing = byTurn.get(key);
				// An in-run continuation of the same user turn refreshes the surface and keeps the counts.
				if (existing !== undefined) {
					existing.canDispatch = turnReportsDispatch(input);
					return NONE;
				}
				if (byTurn.size >= SCOUT_NUDGE_TURN_LIMIT) {
					const oldest = byTurn.keys().next().value;
					if (oldest !== undefined) byTurn.delete(oldest);
				}
				byTurn.set(key, {
					canDispatch: turnReportsDispatch(input),
					reads: 0,
					areas: new Set(),
					dispatched: false,
					advised: false,
				});
				return NONE;
			}
			if (input.hook !== "before_tool" && input.hook !== "after_tool") return NONE;
			if (input.metadata?.origin === "harness" || input.turnId === undefined) return NONE;
			const turn = byTurn.get(input.turnId);
			if (turn === undefined || turn.advised) return NONE;
			if (input.toolName === ToolNames.Dispatch) {
				turn.dispatched = true;
				return NONE;
			}
			if (input.hook !== "after_tool" || input.metadata?.resultKind !== "ok") return NONE;
			if (!turn.canDispatch || turn.dispatched) return NONE;
			const root = deps.workspaceRoot?.() ?? process.cwd();
			if (!isReadOnlyExplorationCall(input, root)) return NONE;
			const within = workspaceRelativeTarget(input, root);
			if (within === null) return NONE;
			turn.reads += 1;
			const area = topLevelArea(within, root);
			if (area !== null) turn.areas.add(area);
			if (turn.reads < SCOUT_NUDGE_READ_THRESHOLD || turn.areas.size < SCOUT_NUDGE_AREA_THRESHOLD) return NONE;
			turn.advised = true;
			return [{ kind: "annotate_tool_result", message: buildScoutNudgeMessage([...turn.areas]), severity: "info" }];
		},
	};
}

/** The exploration advisories the main session registers together: the follow-up Scout advisory and the in-turn scout nudge. */
export function createExplorationNudgeRegistrations(
	deps: { workspaceRoot?: () => string } = {},
): ReadonlyArray<MiddlewareHookRegistration> {
	return [createReadOnlyExplorationNudgeRegistration(deps).registration, createScoutNudgeRegistration(deps)];
}
