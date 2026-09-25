import { INTEROP_AGENT_KINDS } from "./registry.js";
import type { InteropAgentKind, InteropAgentRecord } from "./types.js";

export type PeerModeStatus = "ready" | "experimental" | "unavailable";

export interface PeerModeCapability {
	mode: "acp" | "headless" | "pane";
	status: PeerModeStatus;
	reason: string;
	setupAction: string;
	/** The existing Clio command that reaches the mode when configured. */
	command: string | null;
	/** Configured target IDs are explicit: a runtime ID is not automatically a target ID. */
	targetIds?: ReadonlyArray<string>;
}

export interface PeerModeContext {
	configuredAcp: boolean;
	configuredTargets: ReadonlyArray<{ id: string; runtime: string }>;
	/** null means a static inspector cannot observe the current interactive pane host. */
	paneAvailable: boolean | null;
}

export function isInteropHeadlessRuntime(runtimeId: string): boolean {
	return INTEROP_AGENT_KINDS.some((kind) => kind.headlessRuntimeId === runtimeId);
}

/** Project installed peer facts into honest launch choices without starting a peer session. */
export function peerModeCapabilities(
	kind: InteropAgentKind,
	record: InteropAgentRecord,
	context: PeerModeContext,
): PeerModeCapability[] {
	const binaryPresent = record.binary !== undefined;
	const modes: PeerModeCapability[] = [];
	if (kind.acp || context.configuredAcp) {
		const adapterMissing = kind.acp ? record.adapter === "absent" : false;
		const status: PeerModeStatus =
			!binaryPresent || !context.configuredAcp || adapterMissing ? "unavailable" : "experimental";
		const reason = !binaryPresent
			? `${kind.binaryNames[0] ?? kind.label} CLI is missing`
			: !context.configuredAcp
				? "ACP delegation agent is not configured"
				: record.adapter !== "present"
					? "pinned ACP bridge is not verified locally; npx may fetch it on launch"
					: "launch is configured; authentication and permission behavior need a live task probe";
		const setupAction = !binaryPresent
			? `Install ${kind.label} CLI`
			: !context.configuredAcp
				? "Run clio-coder configure --interop"
				: record.adapter !== "present"
					? `Install the pinned ${kind.acp?.npmPackage ?? "ACP adapter"} package or review its launch recipe`
					: `Try /delegate ${kind.id} <task> and verify its receipt`;
		modes.push({
			mode: "acp",
			status,
			reason,
			setupAction,
			command: context.configuredAcp ? `/delegate ${kind.id} <task>` : null,
		});
	}
	if (kind.headlessRuntimeId) {
		const targetIds = context.configuredTargets
			.filter((target) => target.runtime === kind.headlessRuntimeId)
			.map((target) => target.id);
		const status: PeerModeStatus = !binaryPresent || targetIds.length === 0 ? "unavailable" : "experimental";
		const reason = !binaryPresent
			? `${kind.binaryNames[0] ?? kind.label} CLI is missing`
			: targetIds.length === 0
				? `No target uses the ${kind.headlessRuntimeId} runtime`
				: kind.id === "opencode"
					? "target configured; OpenCode headless supports writable runs but refuses read-only runs; authentication is checked at launch"
					: "target configured; CLI authentication and the selected model are checked when a run starts";
		const setupAction = !binaryPresent
			? `Install ${kind.label} CLI`
			: targetIds.length === 0
				? `Configure a target with runtime ${kind.headlessRuntimeId}`
				: `Try /run --target ${targetIds[0]} <agent> <task> and verify its receipt`;
		modes.push({
			mode: "headless",
			status,
			reason,
			setupAction,
			command: targetIds.length > 0 ? `/run --target ${targetIds[0]} <agent> <task>` : null,
			targetIds,
		});
	}
	if (kind.binaryNames.length > 0 && kind.headlessRuntimeId) {
		const status: PeerModeStatus =
			!binaryPresent || context.paneAvailable === false
				? "unavailable"
				: context.paneAvailable === true
					? "ready"
					: "experimental";
		modes.push({
			mode: "pane",
			status,
			reason: !binaryPresent
				? `${kind.binaryNames[0]} CLI is missing`
				: context.paneAvailable === false
					? "Herdr pane host is unavailable in this session"
					: context.paneAvailable === null
						? "installed CLI; static inspection cannot verify a live Herdr pane host"
						: "installed CLI and Herdr pane host are available; this is an interactive handoff",
			setupAction: !binaryPresent
				? `Install ${kind.label} CLI`
				: context.paneAvailable === true
					? `Run /peer ${kind.id} <brief>`
					: "Start Clio inside Herdr with clio-coder --with-panes",
			command: binaryPresent ? `/peer ${kind.id} <brief>` : null,
		});
	}
	return modes;
}
