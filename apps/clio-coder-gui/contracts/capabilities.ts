import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
const method = Type.String({ maxLength: 128 });

/**
 * What the agent announced at `initialize`, projected to the parts this app
 * acts on. It is read once per session and kept, because every field here is a
 * property of the child process rather than of a request: re-asking over
 * separate control calls costs a round trip per answer and can disagree with
 * the peer that is actually serving the session.
 *
 * Every member is optional and defaults to off. An older engine announces
 * nothing under `_meta`, and the UI must degrade to the v1 surface rather than
 * refuse to open a session.
 */
export const SteeringCapability = Type.Object(
	{
		version: Type.Literal(1),
		main: Type.Boolean(),
		dispatch: Type.Boolean(),
		modes: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }),
		interrupt: Type.Boolean(),
		methods: Type.Object({ steer: method, queue: method, clear: method, interrupt: method, dispatch: method }, closed),
	},
	closed,
);
export type SteeringCapability = Static<typeof SteeringCapability>;
export const CommandsCapability = Type.Object(
	{ version: Type.Literal(1), list: method, invoke: method, count: Type.Integer({ minimum: 0 }) },
	closed,
);
export type CommandsCapability = Static<typeof CommandsCapability>;
export const ToolProgressCapability = Type.Object(
	{
		version: Type.Literal(1),
		minIntervalMs: Type.Integer({ minimum: 0 }),
		maxFramesPerCall: Type.Integer({ minimum: 0 }),
		maxContentBytes: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type ToolProgressCapability = Static<typeof ToolProgressCapability>;
export const DecisionCapability = Type.Object(
	{
		version: Type.Literal(1),
		meta: Type.String({ maxLength: 64 }),
		options: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 }),
	},
	closed,
);
export type DecisionCapability = Static<typeof DecisionCapability>;
export const EventsCapability = Type.Object(
	{
		version: Type.Literal(1),
		notification: Type.String({ maxLength: 64 }),
		kinds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
		workspaceInstanceId: Type.String({ maxLength: 128 }),
	},
	closed,
);
export const SessionCapability = Type.Object(
	{
		close: Type.Boolean(),
		list: Type.Boolean(),
		label: Type.Boolean(),
		delete: Type.Boolean(),
		autonomy: Type.Boolean(),
	},
	closed,
);
export const AgentCapabilities = Type.Object(
	{
		loadSession: Type.Boolean(),
		session: Type.Optional(SessionCapability),
		settings: Type.Optional(Type.Object({ get_safe: Type.Boolean(), patch_safe: Type.Boolean() }, closed)),
		targets: Type.Optional(Type.Object({ list: Type.Boolean(), probe: Type.Boolean() }, closed)),
		steering: Type.Optional(SteeringCapability),
		commands: Type.Optional(CommandsCapability),
		toolProgress: Type.Optional(ToolProgressCapability),
		decision: Type.Optional(DecisionCapability),
		events: Type.Optional(EventsCapability),
		/** True when the agent mediates every tool through its own safety policy. */
		mediatedTools: Type.Boolean(),
	},
	closed,
);
export type AgentCapabilities = Static<typeof AgentCapabilities>;
export const EMPTY_CAPABILITIES: AgentCapabilities = { loadSession: false, mediatedTools: false };
