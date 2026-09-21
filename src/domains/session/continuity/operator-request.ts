/**
 * The durable operator control request behind `operatorRequestEntryId`
 * (CONTRACTS.md §3.1).
 *
 * Clio's existing control commands are display-only echoes: `/context compact
 * [instructions]` runs a compaction and `/resume` opens session navigation, and
 * neither leaves a durable record that means "resume this handoff". So the
 * authority a `resumed` event cites cannot be a conversation turn. It is a
 * reserved `CustomEntry` subtype, written by an operator surface, carrying the
 * exact binding the fold checks: which handoff, which action, which paused or
 * failed head, which session and which branch.
 *
 * This module owns the wire shape and its strict validation. It deliberately
 * owns nothing else: the `/context recover <handoffId> <reduce|deliver>` command
 * that writes one is packet 03/05, and nothing here or in 02B executes a
 * recovery. An opaque `custom` entry is not authority, which is why
 * `isSessionEntry` routes this `customType` through the strict check below
 * rather than accepting any data under the reserved name.
 */

import type { CustomEntry } from "../entries.js";

/** Reserved `customType`. A record under this name must satisfy the strict shape. */
export const HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE = "contextHandoffRecoveryRequest";

export interface HandoffRecoveryRequestData {
	version: 1;
	requestKind: "handoff_recovery";
	handoffId: string;
	action: "reduce" | "deliver";
	/** The session the operator made the request in. */
	sessionId: string;
	/** The handoff's immutable branch anchor, as the request understood it. */
	branchAnchorTurnId: string | null;
	/** The live selected leaf when the request was made. */
	selectedLeafTurnId: string | null;
	/** The exact head this request answers. */
	pausedOrFailedEntryId: string;
}

export type HandoffRecoveryRequestEntry = CustomEntry<HandoffRecoveryRequestData> & {
	customType: typeof HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || isNonEmptyString(value);
}

/**
 * Strict validation of the reserved subtype's data.
 *
 * Every field is required, including the two nullable ones: an absent
 * `branchAnchorTurnId` and an explicit `null` are different claims, and a
 * request that simply omits the binding must not read as a request that
 * asserted "no anchor". A request missing any part of its binding is not a
 * weaker request, it is not a request at all.
 */
export function isHandoffRecoveryRequestData(value: unknown): value is HandoffRecoveryRequestData {
	if (!isRecord(value)) return false;
	return (
		value.version === 1 &&
		value.requestKind === "handoff_recovery" &&
		isNonEmptyString(value.handoffId) &&
		(value.action === "reduce" || value.action === "deliver") &&
		isNonEmptyString(value.sessionId) &&
		Object.hasOwn(value, "branchAnchorTurnId") &&
		isNullableString(value.branchAnchorTurnId) &&
		Object.hasOwn(value, "selectedLeafTurnId") &&
		isNullableString(value.selectedLeafTurnId) &&
		isNonEmptyString(value.pausedOrFailedEntryId)
	);
}

/**
 * Whether a ledger entry is a valid operator recovery request.
 *
 * Takes the entry rather than the data so a caller cannot reach authority by
 * validating loose data it assembled itself: the record must really be a
 * `custom` entry under the reserved `customType`.
 */
export function isHandoffRecoveryRequestEntry(value: unknown): value is HandoffRecoveryRequestEntry {
	if (!isRecord(value)) return false;
	return (
		value.kind === "custom" &&
		value.customType === HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE &&
		isNonEmptyString(value.turnId) &&
		isNullableString(value.parentTurnId) &&
		isNonEmptyString(value.timestamp) &&
		// §3.1 specifies `display: false`. A control record that renders is a
		// different thing from the one the contract adopted, and the flag is part
		// of the adopted envelope rather than a presentation preference: an
		// authority carrier must not also be transcript text.
		value.display === false &&
		isHandoffRecoveryRequestData(value.data)
	);
}
