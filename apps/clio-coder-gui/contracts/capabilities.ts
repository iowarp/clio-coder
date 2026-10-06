import {
	ACP_SESSION_TRUST_METHOD,
	AcpSettingsCapability,
	AcpTargetsCapability,
	AcpCommandsCapability as CommandsCapability,
	AcpDecisionCapability as DecisionCapability,
	AcpEventsCapability as EventsCapability,
	AcpQueueCapability as QueueCapability,
	AcpShellCapability as ShellCapability,
	AcpSteeringCapability as SteeringCapability,
	AcpToolProgressCapability as ToolProgressCapability,
} from "./wire.js";

export {
	CommandsCapability,
	DecisionCapability,
	EventsCapability,
	QueueCapability,
	ShellCapability,
	SteeringCapability,
	ToolProgressCapability,
};

import { type Static, Type } from "typebox";
import { ArtifactsCapability } from "./artifacts.js";
import { AsideCapability } from "./aside.js";
import { BoardCapability } from "./board.js";
import { BranchesCapability } from "./branches.js";
import { ContextCapability } from "./context-ledger.js";
import { ExtensionsCapability, LibraryCapability } from "./extensions.js";
import { FleetCapability } from "./fleet-run.js";
import { HandoffCapability } from "./handoff.js";
import { InterviewCapability } from "./interviews.js";
import { UsageCapability } from "./usage.js";

const closed = { additionalProperties: false };

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
		trustRefresh: Type.Optional(Type.Literal(ACP_SESSION_TRUST_METHOD)),
		session: Type.Optional(SessionCapability),
		settings: Type.Optional(AcpSettingsCapability),
		targets: Type.Optional(AcpTargetsCapability),
		steering: Type.Optional(SteeringCapability),
		/** Edit, reorder and send one waiting message. */
		queue: Type.Optional(QueueCapability),
		/** Run a shell line as the operator, between turns. */
		shell: Type.Optional(ShellCapability),
		commands: Type.Optional(CommandsCapability),
		toolProgress: Type.Optional(ToolProgressCapability),
		decision: Type.Optional(DecisionCapability),
		events: Type.Optional(EventsCapability),
		board: Type.Optional(BoardCapability),
		/** Session tree, branch switch and fork. */
		branches: Type.Optional(BranchesCapability),
		/** Draw up, review and commit a handoff to a new session. */
		handoff: Type.Optional(HandoffCapability),
		/** Preview a playbook and start only the approved plan. */
		fleet: Type.Optional(FleetCapability),
		/** The context window accounting, read for the Context view. */
		context: Type.Optional(ContextCapability),
		artifacts: Type.Optional(ArtifactsCapability),
		/** The session's extensions and their reload. */
		extensions: Type.Optional(ExtensionsCapability),
		/** A side question and parallel drafts, answered beside the conversation. */
		aside: Type.Optional(AsideCapability),
		/** The conversation's spend and each provider's quota, read for the Usage view. */
		usage: Type.Optional(UsageCapability),
		interviews: Type.Optional(InterviewCapability),
		/** Plugin reload, so a library change reaches an open session. */
		library: Type.Optional(LibraryCapability),
		/** ACP promptCapabilities.image: the agent accepts image blocks with a request. */
		images: Type.Optional(Type.Boolean()),
		/** ACP promptCapabilities.embeddedContext: the agent accepts text files as embedded resources. */
		embeddedContext: Type.Optional(Type.Boolean()),
		/** True when the agent mediates every tool through its own safety policy. */
		mediatedTools: Type.Boolean(),
	},
	closed,
);
export type AgentCapabilities = Static<typeof AgentCapabilities>;
export const EMPTY_CAPABILITIES: AgentCapabilities = { loadSession: false, mediatedTools: false };
