import type { InteropAgentId, InteropContract, InteropProposal, InteropReport } from "../../domains/interop/index.js";
import {
	type AdoptionKind,
	applyInteropAdoption,
	detectInteropAgents,
	INHERITED_PROJECT_CONTEXT,
	type InteropAdoptionPlan,
	planInteropAdoption,
	renderProposalEntry,
} from "../../domains/interop/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { clioTheme } from "../theme/index.js";
import { type ListOverlayHandle, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const INTEROP_EMPTY =
	"no other coding agents detected on this machine. install one, then `/interop` proposes it as a delegation peer.";

const GROUP_INVENTORY = "Inventory";
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

/**
 * The overlay's view of the interop domain, built from the contract alone.
 *
 * Detected and Configured partition the same agents, and the frame that follows
 * a keystroke draws both. Reading the wired peers from the TUI's hot settings
 * snapshot put them a config-watcher tick behind the proposals, which read the
 * file: an accepted agent left Detected immediately and reached Configured only
 * on the next time the overlay was opened. Taking one source is what keeps the
 * two lists describing one moment.
 */
export function interopOverlaySurface(
	interop: InteropContract,
	notify: (level: "success" | "warning", text: string) => void,
): Omit<InteropOverlayDeps, "onClose"> {
	return {
		report: () => interop.lastReport(),
		proposals: () => {
			const report = interop.lastReport();
			return report === null ? [] : interop.proposals(report);
		},
		configured: () => interop.configured(),
		accept: (kind) => {
			const result = interop.accept([kind]);
			for (const id of result.wired) notify("success", `delegation agent ${id} added`);
			for (const diagnostic of result.diagnostics) notify("warning", diagnostic);
		},
		decline: (kind) => {
			interop.decline([kind]);
		},
	};
}

function planLines(proposal: InteropProposal): string[] {
	const lines = [
		`# Connect ${proposal.label}`,
		"This appends one entry to `delegation.agents`:",
		"```yaml",
		...renderProposalEntry(proposal).split("\n"),
		"```",
		`**projectContext:** ${INHERITED_PROJECT_CONTEXT} (inherited; the peer receives your task text, never the project projection)`,
		"**toolGovernance:** clio-coder-policy (its tool calls are gated by Clio safety)",
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
	for (const agent of report?.agents ?? []) {
		if (!agent.inventory) continue;
		const counts = agent.inventory.items.reduce<Record<string, number>>((out, item) => {
			out[item.kind] = (out[item.kind] ?? 0) + 1;
			return out;
		}, {});
		items.push({
			id: `inventory:${agent.kind}`,
			label: agent.kind,
			group: GROUP_INVENTORY,
			meta: `${agent.inventory.items.length} resources`,
			detail: () => [
				`# What would you like to adopt from ${agent.kind}?`,
				`Presence: ${agent.presence}. Version: ${agent.version ?? "unknown"}. Inventory: ${agent.inventory?.status}.`,
				...Object.entries(counts).map(([kind, count]) => `${count} ${kind}`),
				"Press i to review an adoption plan. Press p for project destination, u for user, k to change the kind filter.",
				...(agent.inventory?.items.map((item) => `${item.scope} ${item.kind}: ${item.name}`) ?? []),
				...(agent.inventory?.diagnostics ?? []),
			],
		});
	}
	return items;
}

export function openInteropOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	let closed = false;
	let fresh: InteropReport | undefined;
	let pending: InteropAdoptionPlan | undefined;
	let scope: "user" | "project" = "user";
	let filter: AdoptionKind | undefined;
	const surface = ctx.interop;
	const deps: InteropOverlayDeps = surface
		? { ...surface, onClose }
		: { report: () => null, proposals: () => [], configured: () => [], accept: () => {}, decline: () => {}, onClose };
	const originalReport = deps.report;
	deps.report = () => fresh ?? originalReport();
	const close = (): void => {
		closed = true;
		pending = undefined;
		onClose();
	};
	const reset = (): void => {
		pending = undefined;
		handle.setItems(buildItems(deps));
	};
	const preview = (item: ListOverlayItem): void => {
		const host = item.id.replace(/^inventory:/, "") as InteropAgentId;
		const inventory = deps.report()?.agents.find((agent) => agent.kind === host)?.inventory;
		if (!inventory) return;
		pending = planInteropAdoption({ host, inventory, scope, ...(filter ? { kind: filter } : {}) });
		handle.setItems([
			{
				id: "approval",
				label: `Adopt ${pending.entries.filter((entry) => entry.action === "install").length} resources?`,
				meta: scope,
				detail: () => [
					"# Install this reviewed plan?",
					"Press y to approve. Press b to return without installing.",
					"Host files are unchanged. Foreign resources keep the project-import trust gate.",
				],
			},
			...pending.entries.map((entry, index) => ({
				id: `plan:${index}`,
				label: `${entry.action}: ${entry.item.name}`,
				meta: entry.item.kind,
				detail: () => [
					`# ${entry.action} ${entry.item.name}`,
					`Source: ${entry.item.path}`,
					...(entry.destination ? [`Destination: ${entry.destination}`, `SHA-256: ${entry.digest}`] : []),
					entry.reason,
					...(entry.omitted ?? []).map((file) => `Skip ${file}: executable, host-specific, or non-text data.`),
				],
			})),
		]);
	};
	const decide = (item: ListOverlayItem, action: (kind: InteropAgentId) => void): void => {
		if (item.group !== GROUP_DETECTED) return;
		action(item.id as InteropAgentId);
		// The decision is already on disk; the rows are its projection. They are
		// replaced rather than mutated in place, because the view memoizes the
		// frame on the row set and a mutated array left the accepted or declined
		// agent sitting under Detected until the next keystroke repainted it.
		handle.setItems(buildItems(deps));
	};

	const handle: ListOverlayHandle = openListOverlay(tui, {
		markerId: "interop",
		title: "What would you like to adopt or connect?",
		items: buildItems(deps),
		filterable: true,
		layout: "split",
		emptyMessage: INTEROP_EMPTY,
		hints: [
			{ key: "i", verb: "plan adoption" },
			{ key: "y", verb: "approve plan" },
			{ key: "b", verb: "back" },
			{ key: "a", verb: "connect" },
			{ key: "d", verb: "decline" },
		],
		actions: {
			i: preview,
			p: () => {
				scope = "project";
				reset();
				ctx.notice("info", "Adoption destination: project.");
			},
			u: () => {
				scope = "user";
				reset();
				ctx.notice("info", "Adoption destination: user.");
			},
			k: () => {
				const kinds: Array<AdoptionKind | undefined> = [undefined, "skill", "agent", "prompt", "plugin"];
				filter = kinds[(kinds.indexOf(filter) + 1) % kinds.length];
				reset();
				ctx.notice("info", `Adoption kind: ${filter ?? "all"}.`);
			},
			b: reset,
			y: () => {
				if (!pending) return;
				const plan = pending;
				pending = undefined;
				const result = applyInteropAdoption(plan, true);
				for (const id of result.installed) ctx.notice("info", `Installed ${id}.`);
				for (const diagnostic of result.diagnostics) ctx.notice("warn", diagnostic);
				reset();
			},
			a: (item) => decide(item, deps.accept),
			d: (item) => decide(item, deps.decline),
		},
		onClose: close,
	});
	void detectInteropAgents({ inventory: true, probeVersion: true })
		.then((report) => {
			if (closed) return;
			fresh = report;
			if (!pending) handle.setItems(buildItems(deps));
		})
		.catch((error) => {
			if (!closed) ctx.notice("warn", `Inventory unavailable: ${String(error)}`);
		});
	return handle;
}
