import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

export function openAgentsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const clioAgents = ctx.listAgents();
	const fleetItems: ListOverlayItem[] = clioAgents.map((agent) => {
		const label = `${agent.id.padEnd(16)}${agent.description}`;
		const meta = `${agent.audience}/${agent.category}/${agent.capabilityClass}`;
		return {
			id: agent.id,
			label,
			meta,
			group: "Fleet agents",
			detail: () => {
				const lines = [
					`# Fleet Agent: ${agent.id}`,
					`**Description:** ${agent.description}`,
					`**Audience:** ${agent.audience}`,
					`**Category:** ${agent.category}`,
					`**Capability Class:** ${agent.capabilityClass}`,
				];
				if (agent.skills.length > 0) {
					lines.push(`**Skills:** ${agent.skills.join(", ")}`);
				}
				return lines;
			},
		};
	});

	const delegationAgents = ctx.listDelegationAgents();
	const delegationItems: ListOverlayItem[] = delegationAgents.map((agent) => {
		const fullCmd = [agent.command, ...agent.args].join(" ");
		const label = `${agent.id.padEnd(18)}${fullCmd}`;
		const meta = `governance=${agent.toolGovernance ?? "clio-policy"}`;
		return {
			id: agent.id,
			label,
			meta,
			group: "ACP delegation agents",
			detail: () => {
				const lines = [
					`# ACP Delegation Agent: ${agent.id}`,
					`**Command:** \`${fullCmd}\``,
					`**Governance:** ${agent.toolGovernance ?? "clio-policy"}`,
				];
				if (agent.labels && Object.keys(agent.labels).length > 0) {
					lines.push(`**Labels:**`);
					for (const [key, value] of Object.entries(agent.labels)) {
						lines.push(`- ${key}: ${value}`);
					}
				}
				return lines;
			},
		};
	});

	const items = [...fleetItems, ...delegationItems];

	return openListOverlay(tui, {
		title: "Agents Reference",
		mode: "browse",
		items,
		filterable: true,
		emptyMessage: "No agents found",
		onClose,
	});
}
