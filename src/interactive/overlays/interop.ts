import type { InteropAgentId, InteropProposal, InteropReport } from "../../domains/interop/index.js";
import { INHERITED_PROJECT_CONTEXT, renderProposalEntry } from "../../domains/interop/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { clioTheme } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const INTEROP_EMPTY =
	"no other coding agents detected on this machine. install one, then `/interop` proposes it as a delegation peer.";

const GROUP_DETECTED = "Detected";
const GROUP_CONFIGURED = "Configured";
const GROUP_DECLINED = "Declined";

export interface InteropOverlayDeps {
	report: () => InteropReport | null;
	proposals: () => ReadonlyArray<InteropProposal>;
	configured: () => ReadonlyArray<{ id: string; command: string; args: ReadonlyArray<string> }>;
	accept: (kind: InteropAgentId) => void;
	decline: (kind: InteropAgentId) => void;
	onClose: () => void;
}

function planLines(proposal: InteropProposal): string[] {
	const lines = [
		`# Connect ${proposal.label}`,
		"This appends one entry to `delegation.agents`:",
		"```yaml",
		...renderProposalEntry(proposal).split("\n"),
		"```",
		`**projectContext:** ${INHERITED_PROJECT_CONTEXT} (inherited; the peer receives your task text, never the project projection)`,
		"**toolGovernance:** clio-policy (its tool calls are gated by Clio safety)",
	];
	if (proposal.needsNetworkInstall) {
		lines.push("**Adapter:** not installed locally; npx fetches it the first time you delegate");
	}
	lines.push("Press `a` to connect it, `d` to decline.");
	return lines;
}

function buildItems(deps: InteropOverlayDeps): ListOverlayItem[] {
	const theme = clioTheme();
	const report = deps.report();
	const items: ListOverlayItem[] = deps.proposals().map((proposal) => ({
		id: proposal.kind,
		label: `${proposal.entry.id.padEnd(16)}${[proposal.entry.command, ...proposal.entry.args].join(" ")}`,
		meta: theme.fg("warning", "not configured"),
		group: GROUP_DETECTED,
		detail: () => planLines(proposal),
	}));
	for (const agent of deps.configured()) {
		const command = [agent.command, ...agent.args].join(" ");
		items.push({
			id: `configured:${agent.id}`,
			label: `${agent.id.padEnd(16)}${command}`,
			meta: theme.fg("success", "connected"),
			group: GROUP_CONFIGURED,
			detail: () => [`# ${agent.id}`, `**Command:** \`${command}\``, `Delegate with \`/delegate ${agent.id} <task>\`.`],
		});
	}
	for (const agent of report?.agents ?? []) {
		if (agent.decision !== "declined" || agent.decidedFingerprint !== agent.fingerprint) continue;
		items.push({
			id: `declined:${agent.kind}`,
			label: `${agent.kind.padEnd(16)}${agent.binary ?? agent.installDir ?? ""}`,
			meta: theme.fg("dim", `declined ${agent.decidedAt ?? ""}`.trim()),
			group: GROUP_DECLINED,
			detail: () => [`# ${agent.kind}`, "Declined. Clio proposes it again when its binary version or path changes."],
		});
	}
	return items;
}

export function openInteropOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const surface = ctx.interop;
	const deps: InteropOverlayDeps = surface
		? { ...surface, onClose }
		: { report: () => null, proposals: () => [], configured: () => [], accept: () => {}, decline: () => {}, onClose };
	const items: ListOverlayItem[] = [];
	const rebuild = (): void => {
		items.splice(0, items.length, ...buildItems(deps));
	};
	rebuild();

	const decide = (item: ListOverlayItem, action: (kind: InteropAgentId) => void): void => {
		if (item.group !== GROUP_DETECTED) return;
		action(item.id as InteropAgentId);
		rebuild();
		tui.requestRender();
	};

	return openListOverlay(tui, {
		title: "Interop",
		items,
		filterable: true,
		layout: "split",
		emptyMessage: INTEROP_EMPTY,
		hints: [
			{ key: "a", verb: "connect" },
			{ key: "d", verb: "decline" },
		],
		actions: {
			a: (item) => decide(item, deps.accept),
			d: (item) => decide(item, deps.decline),
		},
		onClose,
	});
}
