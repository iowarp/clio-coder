import {
	AcpSnapshotListSchema,
	AcpSnapshotOutcomeSchema,
	AcpSnapshotPlanSchema,
	AcpSnapshotsCapability as SnapshotsCapability,
} from "./wire.js";

export { SnapshotsCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/session/snapshots`, `snapshot_preview` and `snapshot_restore`: the terminal's /rewind.
// The agent caps each path list at 500 and the list at the newest 100 snapshots; these schemas restate that.
const closed = { additionalProperties: false };

/** A snapshot number in a route path. */
export const SnapshotNumber = Type.String({ pattern: "^[1-9][0-9]{0,8}$" });

export const SnapshotList = AcpSnapshotListSchema;
export type SnapshotList = Static<typeof SnapshotList>;
export type SnapshotRow = SnapshotList["snapshots"][number];
export const SnapshotPlan = AcpSnapshotPlanSchema;
export type SnapshotPlan = Static<typeof SnapshotPlan>;
export const SnapshotOutcome = AcpSnapshotOutcomeSchema;
export type SnapshotOutcome = Static<typeof SnapshotOutcome>;

export const TranscriptFormat = Type.Union([Type.Literal("html"), Type.Literal("markdown")]);
export type TranscriptFormat = Static<typeof TranscriptFormat>;
/** The terminal's /export, carried back to the browser instead of left in the project. */
export const TranscriptDownload = Type.Object(
	{
		filename: Type.String({ minLength: 1, maxLength: 160 }),
		mediaType: Type.Union([Type.Literal("text/html"), Type.Literal("text/markdown")]),
		text: Type.String({ maxLength: 16 * 1024 * 1024 }),
	},
	closed,
);
export type TranscriptDownload = Static<typeof TranscriptDownload>;
