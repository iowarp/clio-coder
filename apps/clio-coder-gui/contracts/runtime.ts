import type { SessionDelta } from "./sessions.js";

export { ACP_MAX_JOBS } from "../server/clio/wire-runtime.js";

export const API_VERSION = 1;

export const APP_VERSION = "0.0.0";

/** Every window title ends with this. The launcher finds an open app window by it, so a title never drops it. */
export const APP_TITLE = "Clio Coder";

/**
 * The engine bounds steer text at 16 KiB and a queue at 64 entries; these are
 * the same numbers, restated so a request that would be refused over ACP is
 * refused at this app's edge instead of costing a round trip.
 */
export const STEER_TEXT_MAX_BYTES = 16384;

export const QUEUE_MAX_ENTRIES = 64;

// Images that ride a request. The agent reads them from ACP image blocks on one stdio line of 1 MiB,
// which the request text shares, so their base64 is bounded together rather than each alone. The
// agent judges each by its bytes; the declared type here only has to be one it could accept.
export const TURN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const TURN_IMAGE_MAX = 4;

export const TURN_IMAGES_MAX_BASE64 = 900_000;

// Text files that ride a request as ACP embedded resources, sharing the images' line budget. JSON
// escaping can at most double a file's bytes once C0 controls other than tab, newline and carriage
// return are refused, so a file weighs twice its UTF-8 size against that budget.
export const TURN_FILE_MAX = 4;

export const TURN_FILE_MAX_BYTES = 128 * 1024;

export const TURN_FILE_WEIGHT = 2;

/** What files and images weigh together against one agent line. */
export function attachmentWeight(images: ReadonlyArray<{ data: string }>, files: ReadonlyArray<{ text: string }>) {
	let weight = 0;
	for (const image of images) weight += image.data.length;
	for (const file of files) weight += TURN_FILE_WEIGHT * new TextEncoder().encode(file.text).length;
	return weight;
}

// Subscription names, not validators: the event stream already carries the typed payload.
export const SessionDeltaKinds = {
	"context.activity": true,
	"context.status": true,
	"session.telemetry": true,
	"turn.started": true,
	"turn.admitted": true,
	"turn.text": true,
	"turn.thought": true,
	"turn.user": true,
	"turn.tool": true,
	"turn.finished": true,
	"permission.requested": true,
	"permission.escalated": true,
	"permission.resolved": true,
	"permission.expired": true,
	"fleet.loopBlocked": true,
	"fleet.enqueued": true,
	"fleet.started": true,
	"fleet.progress": true,
	"fleet.completed": true,
	"fleet.failed": true,
	"evidence.ready": true,
	"health.compacted": true,
	"health.contextWarning": true,
	"health.toolBudget": true,
	"health.provider": true,
	"health.scopeNotice": true,
	"job.changed": true,
	"job.listed": true,
	"session.labelled": true,
	"session.configured": true,
	"session.changed": true,
	"session.reset": true,
} satisfies Record<SessionDelta["type"], true>;
