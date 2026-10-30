import type { Static } from "typebox";
import { Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const nullableText = Type.Union([Type.String(), Type.Null()]);
export const MachineId = Type.String({ pattern: "^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" });
export const MachineAdd = Type.Object(
	{
		id: MachineId,
		host: Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9:][A-Za-z0-9._:-]*$" }),
		user: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" })),
		port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		maxWorkers: Type.Integer({ minimum: 1, maximum: 1024 }),
		labels: Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" }), {
			maxItems: 32,
			uniqueItems: true,
		}),
	},
	closed,
);
export type MachineAdd = Static<typeof MachineAdd>;
export const MachineMutation = Type.Union([
	Type.Object({ action: Type.Literal("add"), machine: MachineAdd }, closed),
	Type.Object({ action: Type.Literal("remove"), id: MachineId, confirmed: Type.Literal(true) }, closed),
	Type.Object({ action: Type.Literal("check"), id: MachineId, confirmed: Type.Literal(true) }, closed),
]);
export type MachineMutation = Static<typeof MachineMutation>;
export const MachineChecks = Type.Object(
	{
		reachable: Type.Boolean(),
		clioPresent: Type.Boolean(),
		versionMatch: Type.Boolean(),
		pathParity: Type.Boolean(),
		stateDirWritable: Type.Boolean(),
	},
	closed,
);
export const Machine = Type.Object(
	{
		id: MachineId,
		host: Type.String(),
		user: nullableText,
		port: Type.Union([Type.Integer(), Type.Null()]),
		maxWorkers: Type.Integer(),
		labels: Type.Array(Type.String()),
		// The current fleet registry has no enable/disable switch.
		enabled: Type.Null(),
		readiness: Type.Union([
			Type.Literal("not checked"),
			Type.Literal("ready for this project"),
			Type.Literal("needs attention"),
			Type.Literal("offline"),
		]),
		reason: nullableText,
		checkedAt: nullableText,
		ageMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		checks: Type.Union([MachineChecks, Type.Null()]),
		localVersion: nullableText,
		remoteVersion: nullableText,
		note: nullableText,
		project: Type.Union([
			Type.Null(),
			Type.Object(
				{
					kind: Type.Union([Type.Literal("shared"), Type.Literal("independent"), Type.Literal("unverified")]),
					head: nullableText,
					reason: nullableText,
				},
				closed,
			),
		]),
	},
	closed,
);
export type Machine = Static<typeof Machine>;
export const Machines = Type.Object(
	{ workspaceId: Id, projectRoot: Type.String(), observedAt: Type.String(), machines: Type.Array(Machine) },
	closed,
);
export type Machines = Static<typeof Machines>;

/** How far this app has come in reaching a node's own GUI over SSH. */
export const MachineAttachmentState = Type.Union([
	Type.Literal("detached"),
	Type.Literal("connecting"),
	Type.Literal("ready"),
	Type.Literal("failed"),
	Type.Literal("version-mismatch"),
]);
export type MachineAttachmentState = Static<typeof MachineAttachmentState>;
export const MachineAttachment = Type.Object(
	{
		id: MachineId,
		host: Type.String(),
		state: MachineAttachmentState,
		/** When the state was entered. */
		since: Type.String(),
		/** Why the attachment failed or was refused; null in every other state. */
		detail: nullableText,
		/** Reconnects made since the last explicit open. */
		attempt: Type.Integer({ minimum: 0 }),
		/** When the next reconnect is due, while one is scheduled. */
		retryAt: nullableText,
		/** What the node's own GUI reported about itself once it answered. */
		remote: Type.Union([
			Type.Null(),
			Type.Object({ clio: Type.String(), build: nullableText, host: Type.String() }, closed),
		]),
	},
	closed,
);
export type MachineAttachment = Static<typeof MachineAttachment>;
export const MachineAttachments = Type.Object({ attachments: Type.Array(MachineAttachment) }, closed);
export type MachineAttachments = Static<typeof MachineAttachments>;
