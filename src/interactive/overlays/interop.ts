/**
 * `/library interop`: the other coding agents on this machine, and what Clio may do
 * with each. The operator's two questions are "which of these are connected as
 * delegation peers?" and "what can I adopt from them?", so every row leads
 * with its answer as a status chip and the status row keeps the two facts the
 * adoption keys depend on, the destination scope and the kind filter.
 *
 * Nothing here writes until a key says so: `a` appends one delegation entry,
 * `d` records a decline, and `y` installs exactly the reviewed plan.
 */

import { readSettings } from "../../core/config.js";
import type { InteropAgentId, InteropContract, InteropProposal, InteropReport } from "../../domains/interop/index.js";
import {
	type AdoptionKind,
	applyInteropAdoption,
	detectInteropAgents,
	INHERITED_PROJECT_CONTEXT,
	type InteropAdoptionPlan,
	interopAgentKind,
	peerModeCapabilities,
	planInteropAdoption,
	renderProposalEntry,
} from "../../domains/interop/index.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../../session-control/slash-commands.js";
import { displaySafe } from "../display-safe.js";
import { dateLocal } from "../format-time.js";
import type { HintEntry } from "../overlay-frame.js";
import {
	chip,
	chipRow,
	chipRows,
	choiceRows,
	clioTheme,
	commandBlock,
	type Fact,
	factRows,
	fitUnits,
	keyCap,
	type StatusKind,
	statusChip,
	type TableCell,
	tableRows,
	titleRow,
} from "../theme/index.js";
import { movedKeyNotice } from "./confirm-once.js";
import { detailWithHead, type ListOverlayHandle, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const INTEROP_EMPTY =
	"no other coding agents detected on this machine. install one, then `/library interop` proposes it as a delegation peer.";

const GROUP_PROPOSED = "Proposed";
const GROUP_DETECTED = "Detected";
const GROUP_CONNECTED = "Connected";
const GROUP_DECLINED = "Declined";
const GROUP_INVENTORY = "Inventory";
const GROUP_ABSENT = "Not installed";
const GROUP_PLAN = "Adoption plan";

const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

export interface InteropOverlayDeps {
	report: () => InteropReport | null;
	proposals: () => ReadonlyArray<InteropProposal>;
	configured: () => ReadonlyArray<{ id: string; command: string; args: ReadonlyArray<string> }>;
	paneAvailable?: boolean | null;
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

/** The adoption settings every `i` reads; the status row states them because they decide what the plan contains. */
interface AdoptionSettings {
	scope: "user" | "project";
	filter: AdoptionKind | undefined;
}

const KIND_CYCLE: ReadonlyArray<AdoptionKind | undefined> = [undefined, "skill", "agent", "prompt", "plugin"];

const PRESENCE_STATUS: Readonly<Record<"present" | "absent" | "unknown", StatusKind>> = {
	present: "ok",
	absent: "error",
	unknown: "pending",
};

const MODE_STATUS: Readonly<Record<"ready" | "experimental" | "unavailable", StatusKind>> = {
	ready: "ok",
	experimental: "warning",
	unavailable: "error",
};

function plural(count: number, unit: string): string {
	if (count === 1) return `${count} ${unit}`;
	return `${count} ${unit.endsWith("y") ? `${unit.slice(0, -1)}ies` : `${unit}s`}`;
}

/** The exact argv a peer is launched with, as one line. */
function commandLine(command: string, args: ReadonlyArray<string>): string {
	return [command, ...args].join(" ");
}

/**
 * The launch modes a peer offers, one fact per mode: its status as a chip,
 * the reason, and the next step. Pure projection of the domain's answer.
 */
function modeFacts(
	id: InteropAgentId,
	report: InteropReport | null,
	configuredIds: ReadonlySet<string>,
	paneAvailable: boolean | null,
): Fact[] {
	const kind = interopAgentKind(id);
	const record = report?.agents.find((agent) => agent.kind === id);
	if (!kind || !record) return [];
	const theme = clioTheme();
	// The reasons and next steps quote configured target ids, which are
	// operator text; they pass the same seam as the records.
	return displaySafe(
		peerModeCapabilities(kind, record, {
			configuredAcp: configuredIds.has(id),
			configuredTargets: readSettings().targets,
			paneAvailable,
		}),
	).map((mode) => ({
		label: mode.mode,
		value: `${statusChip(theme, MODE_STATUS[mode.status], mode.status)} ${theme.fg("body", mode.reason)}. ${theme.fg("annotation", `Next: ${mode.setupAction}`)}`,
	}));
}

/** Counts per resource kind, in inventory order, as `3 skills`. */
function kindCounts(items: ReadonlyArray<{ kind: string }>): string[] {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
	return [...counts.entries()].map(([kind, count]) => plural(count, kind));
}

const NOTHING_ADOPTABLE = "nothing adoptable";

function buildItems(deps: InteropOverlayDeps, settings: AdoptionSettings): ListOverlayItem[] {
	const theme = clioTheme();
	// Every record is neutralized for display once, here, so no field a row or
	// a pane picks up can carry a terminal control past this seam.
	const report = displaySafe(deps.report());
	const configuredAgents = displaySafe(deps.configured());
	const proposals = displaySafe(deps.proposals());
	const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
	const paneAvailable = deps.paneAvailable ?? null;
	const modes = (id: InteropAgentId): Fact[] => modeFacts(id, report, configuredIds, paneAvailable);
	// The domain re-proposes a declined agent whose binary moved or changed
	// version, so an agent that stands declined and is not proposed again is
	// declined, whatever fingerprint the version probe computed this time.
	const declined = (agent: { kind: InteropAgentId; decision?: string }): boolean =>
		agent.decision === "declined" && !proposals.some((proposal) => proposal.kind === agent.kind);

	const items: ListOverlayItem[] = proposals.map((proposal) => {
		const command = commandLine(proposal.entry.command, proposal.entry.args);
		return {
			id: `proposal:${proposal.kind}`,
			label: `${proposal.label} ${proposal.entry.id} ${command}`,
			cells: { lead: proposal.label, text: command },
			// The status leads, as every row grammar does; the version is the chip a narrow row gives up.
			get meta() {
				return chipRow(
					clioTheme(),
					[
						statusChip(clioTheme(), "pending", "not configured"),
						proposal.version ? chip(clioTheme(), proposal.version, "muted") : null,
					],
					80,
				);
			},
			group: GROUP_PROPOSED,
			...detailWithHead((width) => ({
				head: [
					titleRow(theme, `Connect ${proposal.label}`, width, { meta: "proposal" }),
					...chipRows(
						theme,
						[
							statusChip(theme, "pending", "not configured"),
							proposal.version ? chip(theme, `version ${proposal.version}`, "muted") : null,
							proposal.binary ? chip(theme, proposal.binary, "muted") : null,
						],
						width,
					),
					...choiceRows(
						theme,
						[
							{ key: "a", verb: "connect", consequence: "appends exactly this entry to delegation.agents", tone: "action" },
							{
								key: "x",
								verb: "decline",
								consequence: "records the decision; Clio proposes it again when its binary version or path changes",
							},
						],
						width,
					),
				],
				rest: [
					"",
					// The YAML is several lines; the block folds each on its own so a long
					// argument wraps under its gutter instead of carrying a newline into a row.
					...renderProposalEntry(proposal)
						.split("\n")
						.flatMap((line) => commandBlock(theme, line, width, { role: "inlineCode" })),
					...factRows(
						theme,
						[
							{
								label: "projectContext",
								value: `${INHERITED_PROJECT_CONTEXT} (inherited; the peer receives your task text, never the project projection)`,
							},
							{
								label: "toolGovernance",
								value:
									"clio-coder-policy (Clio mediates permission requests the ACP peer reports; its own tools may not be fully visible)",
							},
							...(proposal.needsNetworkInstall
								? [
										{
											label: "Adapter",
											value: "pinned bridge not verified locally; npx may fetch it on first use",
											tone: "warning" as const,
										},
									]
								: []),
							...modes(proposal.kind),
						],
						width,
						FACT_OPTIONS,
					),
				],
			})),
		};
	});

	// A present peer with no pending proposal and no standing decision: it has
	// no ACP recipe, or Clio reaches it another way. A configured or declined
	// agent is listed once, under its own group, never here as well; an absent
	// one is listed last, with the modes that would open once it is installed.
	const peerRow = (record: InteropReport["agents"][number], group: string): ListOverlayItem | null => {
		const kind = interopAgentKind(record.kind);
		if (!kind || kind.binaryNames.length === 0) return null;
		const text = record.version ?? record.binary ?? (record.presence === "absent" ? "not on PATH" : "version unknown");
		return {
			id: `peer:${record.kind}`,
			label: `${kind.label} ${text}`,
			cells: { lead: kind.label, text },
			get meta() {
				return statusChip(clioTheme(), PRESENCE_STATUS[record.presence], record.presence);
			},
			group,
			...detailWithHead((width) => ({
				head: [
					titleRow(theme, kind.label, width, { meta: group === GROUP_ABSENT ? "not installed" : "detected" }),
					...chipRows(
						theme,
						[
							statusChip(theme, PRESENCE_STATUS[record.presence], record.presence),
							record.version ? chip(theme, `version ${record.version}`, "muted") : null,
							record.binary ? chip(theme, record.binary, "muted") : null,
						],
						width,
					),
				],
				rest: [
					...(record.presence === "absent"
						? [
								theme.fg(
									"annotation",
									`No ${kind.binaryNames.join(" or ")} binary is on PATH; the modes below say what each would need.`,
								),
							]
						: kind.acp
							? []
							: [
									theme.fg(
										"annotation",
										"No ACP recipe for this agent, so there is nothing to connect; the modes below are how Clio reaches it.",
									),
								]),
					...factRows(theme, modes(record.kind), width, FACT_OPTIONS),
				],
			})),
		};
	};
	for (const record of report?.agents ?? []) {
		if (proposals.some((proposal) => proposal.kind === record.kind)) continue;
		if (configuredIds.has(record.kind) || declined(record)) continue;
		if (record.presence === "absent") continue;
		const row = peerRow(record, GROUP_DETECTED);
		if (row) items.push(row);
	}

	for (const agent of configuredAgents) {
		const command = commandLine(agent.command, agent.args);
		items.push({
			id: `configured:${agent.id}`,
			label: `${agent.id} ${command}`,
			cells: { lead: agent.id, text: command },
			get meta() {
				return statusChip(clioTheme(), "ok", "connected");
			},
			group: GROUP_CONNECTED,
			...detailWithHead((width) => ({
				head: [
					titleRow(theme, agent.id, width, { meta: "delegation agent" }),
					...chipRows(theme, [statusChip(theme, "ok", "connected"), chip(theme, `/run ${agent.id} <task>`, "muted")], width),
				],
				rest: [
					...commandBlock(theme, command, width),
					...factRows(theme, modes(agent.id as InteropAgentId), width, FACT_OPTIONS),
				],
			})),
		});
	}

	for (const agent of report?.agents ?? []) {
		if (!declined(agent)) continue;
		const when = agent.decidedAt ? dateLocal(agent.decidedAt) : "";
		const text = agent.binary ?? agent.installDir ?? "";
		items.push({
			id: `declined:${agent.kind}`,
			label: `${interopAgentKind(agent.kind)?.label ?? agent.kind} ${text}`,
			cells: { lead: interopAgentKind(agent.kind)?.label ?? agent.kind, text },
			get meta() {
				return statusChip(clioTheme(), "cancelled", `declined ${when}`.trim());
			},
			group: GROUP_DECLINED,
			...detailWithHead((width) => ({
				head: [
					titleRow(theme, interopAgentKind(agent.kind)?.label ?? agent.kind, width, { meta: "declined" }),
					chipRow(theme, [statusChip(theme, "cancelled", `declined ${when}`.trim())], width),
				],
				rest: [theme.fg("annotation", "Clio proposes it again when its binary version or path changes.")],
			})),
		});
	}

	for (const agent of report?.agents ?? []) {
		const inventory = agent.inventory;
		if (!inventory) continue;
		const counts = kindCounts(inventory.items);
		const adoptable = inventory.items.length > 0;
		items.push({
			id: `inventory:${agent.kind}`,
			label: `${interopAgentKind(agent.kind)?.label ?? agent.kind} ${counts.join(" ")}`,
			cells: { lead: interopAgentKind(agent.kind)?.label ?? agent.kind, text: counts.join(", ") || NOTHING_ADOPTABLE },
			get meta() {
				// An empty inventory has nothing to plan, so it carries no key cap.
				return chipRow(
					clioTheme(),
					[
						chip(clioTheme(), plural(inventory.items.length, "resource"), "muted"),
						adoptable ? keyCap(clioTheme(), "i") : null,
					],
					40,
				);
			},
			group: GROUP_INVENTORY,
			...detailWithHead((width) => {
				const rows = inventory.items.map((item): TableCell[] => [
					{ text: item.scope, tone: "muted" },
					{ text: item.kind, tone: "muted" },
					{ text: item.name },
				]);
				return {
					head: [
						titleRow(theme, `Adopt from ${interopAgentKind(agent.kind)?.label ?? agent.kind}`, width, {
							meta: `inventory ${inventory.status}`,
						}),
						...chipRows(
							theme,
							[
								statusChip(theme, PRESENCE_STATUS[agent.presence], agent.presence),
								agent.version ? chip(theme, `version ${agent.version}`, "muted") : null,
								...counts.map((count) => chip(theme, count, "neutral")),
							],
							width,
						),
						...(adoptable
							? choiceRows(
									theme,
									[
										{
											key: "i",
											verb: "plan adoption",
											consequence: `reviews a plan for ${settings.filter ?? "every kind"} into ${settings.scope} scope; nothing is written`,
											tone: "action",
										},
									],
									width,
								)
							: [theme.fg("annotation", "Nothing adoptable was found, so there is no plan to review.")]),
					],
					rest: [
						...(rows.length > 0
							? [
									"",
									...tableRows(
										theme,
										{
											columns: [
												{ label: "scope", min: 4, priority: 1 },
												{ label: "kind", min: 4, priority: 2 },
												{ label: "name", min: 8, priority: 3, wrap: true },
											],
											rows,
											header: true,
										},
										width,
									),
								]
							: []),
						...inventory.diagnostics.map((diagnostic) => statusChip(theme, "warning", diagnostic)),
					],
				};
			}),
		});
	}

	for (const record of report?.agents ?? []) {
		if (record.presence !== "absent") continue;
		if (configuredIds.has(record.kind) || declined(record)) continue;
		const row = peerRow(record, GROUP_ABSENT);
		if (row) items.push(row);
	}
	return items;
}

/** The reviewed plan as rows: the approval first, then every entry with its verdict. */
function planItems(raw: InteropAdoptionPlan): ListOverlayItem[] {
	const theme = clioTheme();
	const plan = displaySafe(raw);
	const installs = plan.entries.filter((entry) => entry.action === "install").length;
	const skips = plan.entries.length - installs;
	const approval: ListOverlayItem = {
		id: "approval",
		label: `Adopt ${plural(installs, "resource")}?`,
		cells: { lead: `Adopt ${plural(installs, "resource")}?`, text: `from ${plan.host} into ${plan.scope} scope` },
		get meta() {
			return chipRow(clioTheme(), [keyCap(clioTheme(), "y"), keyCap(clioTheme(), "b")], 20);
		},
		group: GROUP_PLAN,
		...detailWithHead((width) => ({
			head: [
				titleRow(theme, "Install this reviewed plan?", width, { meta: plan.host }),
				...chipRows(
					theme,
					[
						statusChip(theme, installs > 0 ? "pending" : "cancelled", `${installs} to install`),
						chip(theme, `${skips} skipped`, "muted"),
						chip(theme, `${plan.scope} scope`, "muted"),
					],
					width,
				),
				...choiceRows(
					theme,
					[
						{
							key: "y",
							verb: "approve",
							consequence:
								installs > 0
									? "installs exactly these entries; host files are unchanged and foreign resources keep the project-import trust gate"
									: "installs nothing, because every entry is skipped",
							tone: "action",
						},
						{ key: "b", verb: "back", consequence: "returns to the agents without installing" },
					],
					width,
				),
			],
			rest: [],
		})),
	};
	return [
		approval,
		...plan.entries.map(
			(entry, index): ListOverlayItem => ({
				id: `plan:${index}`,
				label: `${entry.action} ${entry.item.name} ${entry.item.kind}`,
				cells: { lead: entry.item.name, text: entry.reason },
				get meta() {
					return chipRow(
						clioTheme(),
						[
							entry.action === "install"
								? statusChip(clioTheme(), "ok", "install")
								: statusChip(clioTheme(), "cancelled", "skip"),
							chip(clioTheme(), entry.item.kind, "muted"),
						],
						40,
					);
				},
				group: GROUP_PLAN,
				...detailWithHead((width) => ({
					head: [
						titleRow(theme, entry.item.name, width, { meta: entry.item.kind }),
						chipRow(
							theme,
							[
								entry.action === "install" ? statusChip(theme, "ok", "install") : statusChip(theme, "cancelled", "skip"),
								chip(theme, `${entry.item.scope} scope at the host`, "muted"),
							],
							width,
						),
					],
					rest: factRows(
						theme,
						[
							{ label: "Why", value: entry.reason },
							{ label: "Source", value: entry.item.path },
							...(entry.destination ? [{ label: "Destination", value: entry.destination }] : []),
							...(entry.digest ? [{ label: "SHA-256", value: entry.digest }] : []),
							...(entry.requirements?.length
								? [{ label: "Requires", value: entry.requirements.join(", "), tone: "warning" as const }]
								: []),
							...(entry.omitted ?? []).map((file) => ({
								label: "Skipped file",
								value: `${file}: executable, host-specific, or non-text data`,
								tone: "warning" as const,
							})),
						],
						width,
						FACT_OPTIONS,
					),
				})),
			}),
		),
	];
}

/**
 * The persistent row above the list: where adoption writes and which kinds it
 * takes, each with the key that changes it, then the counts. Mode and scope
 * survive every width because they decide what `i` plans.
 */
function statusLine(
	settings: AdoptionSettings,
	counts: { proposed: number; connected: number; declined: number; inventories: number },
	pending: InteropAdoptionPlan | undefined,
	width: number,
): string {
	const theme = clioTheme();
	// Whole chips drop from the right with the dim ellipsis, never a cut word.
	const units = (parts: ReadonlyArray<string | null>): string[] =>
		parts.filter((part): part is string => part !== null && part.length > 0);
	if (pending) {
		const installs = pending.entries.filter((entry) => entry.action === "install").length;
		return fitUnits(
			theme,
			"",
			units([
				chip(theme, `plan from ${pending.host}`, "accent"),
				chip(theme, `${installs} to install`, installs > 0 ? "action" : "muted"),
				`${keyCap(theme, "y")} ${theme.fg("annotation", "approve")}`,
				`${keyCap(theme, "b")} ${theme.fg("annotation", "back")}`,
				chip(theme, `${pending.entries.length - installs} skipped`, "muted"),
				chip(theme, `${pending.scope} scope`, "muted"),
			]),
			width,
		);
	}
	const wide = width >= 72;
	return fitUnits(
		theme,
		"",
		units([
			// The scope in effect, then the key that picks the other one.
			`${theme.fg("annotation", wide ? "Adopts into" : "Scope")} ${theme.fg("fieldValue", settings.scope)} ${keyCap(theme, settings.scope === "user" ? "p" : "u")} ${theme.fg("annotation", settings.scope === "user" ? "project" : "user")}`,
			`${keyCap(theme, "c")} ${theme.fg("fieldValue", settings.filter ? `${settings.filter}s only` : "all kinds")}`,
			chip(theme, `${counts.proposed} proposed`, counts.proposed > 0 ? "action" : "muted"),
			chip(theme, `${counts.connected} connected`, counts.connected > 0 ? "success" : "muted"),
			counts.declined > 0 ? chip(theme, `${counts.declined} declined`, "muted") : null,
			counts.inventories > 0 ? chip(theme, plural(counts.inventories, "inventory"), "muted") : null,
		]),
		width,
	);
}

export function openInteropOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	let closed = false;
	let fresh: InteropReport | undefined;
	let pending: InteropAdoptionPlan | undefined;
	const settings: AdoptionSettings = { scope: "user", filter: undefined };
	const surface = ctx.interop;
	const deps: InteropOverlayDeps = surface
		? { ...surface, paneAvailable: ctx.panes?.status().available ?? false, onClose }
		: {
				report: () => null,
				proposals: () => [],
				configured: () => [],
				accept: () => {},
				decline: () => {},
				paneAvailable: false,
				onClose,
			};
	const originalReport = deps.report;
	deps.report = () => fresh ?? originalReport();
	let items = buildItems(deps, settings);
	const counts = (): { proposed: number; connected: number; declined: number; inventories: number } => ({
		proposed: items.filter((item) => item.group === GROUP_PROPOSED).length,
		connected: items.filter((item) => item.group === GROUP_CONNECTED).length,
		declined: items.filter((item) => item.group === GROUP_DECLINED).length,
		inventories: items.filter((item) => item.group === GROUP_INVENTORY).length,
	});
	const close = (): void => {
		closed = true;
		pending = undefined;
		onClose();
	};
	// The decision is already on disk; the rows are its projection. They are
	// replaced rather than mutated in place, because the view memoizes the
	// frame on the row set and a mutated array left the accepted or declined
	// agent sitting under its old group until the next keystroke repainted it.
	// Leaving a plan puts the cursor back on the inventory it came from.
	const reset = (returnTo?: string): void => {
		pending = undefined;
		items = buildItems(deps, settings);
		handle.setItems(items);
		if (returnTo !== undefined) handle.selectById(returnTo);
	};
	const preview = (item: ListOverlayItem): void => {
		if (!item.id.startsWith("inventory:") || item.cells?.text === NOTHING_ADOPTABLE) return;
		const host = item.id.slice("inventory:".length) as InteropAgentId;
		const inventory = deps.report()?.agents.find((agent) => agent.kind === host)?.inventory;
		if (!inventory) return;
		pending = planInteropAdoption({
			host,
			inventory,
			scope: settings.scope,
			...(settings.filter ? { kind: settings.filter } : {}),
		});
		// The plan replaces the agents; a filter typed to reach the inventory
		// would hide every one of its rows, and the cursor belongs on the
		// approval, where y and b are answered.
		handle.clearFilter();
		handle.setItems(planItems(pending));
		handle.selectById("approval");
	};
	// Only a proposal row carries a decision. A detected peer without a
	// proposal used to reach here too, and its row id was recorded as a
	// declined agent kind.
	const decide = (item: ListOverlayItem, action: (kind: InteropAgentId) => void): void => {
		if (!item.id.startsWith("proposal:")) return;
		action(item.id.slice("proposal:".length) as InteropAgentId);
		reset();
	};

	const hints = (selected: ListOverlayItem | undefined): HintEntry[] => {
		if (pending) {
			return [
				...(selected?.id === "approval" ? [{ key: "y", verb: "approve plan", short: "approve" }] : []),
				{ key: "b", verb: "back to agents", short: "back", critical: true },
			];
		}
		if (selected?.id.startsWith("proposal:")) {
			return [
				{ key: "a", verb: "connect", critical: true },
				{ key: "x", verb: "decline", critical: true },
			];
		}
		if (selected?.id.startsWith("inventory:") && selected.cells?.text !== NOTHING_ADOPTABLE)
			return [{ key: "i", verb: "plan adoption", short: "plan", critical: true }];
		return [];
	};

	const handle: ListOverlayHandle = openListOverlay(tui, {
		markerId: "interop",
		title: "Local coding agents",
		items,
		filterable: true,
		explicitSearch: true,
		layout: "split",
		unit: "rows",
		emptyMessage: INTEROP_EMPTY,
		status: (width) => statusLine(settings, counts(), pending, width),
		globalHints: [
			{ key: "s", verb: "adopt into user/project", short: "scope" },
			{ key: "c", verb: "kinds" },
		],
		globalActions: {
			s: () => {
				settings.scope = settings.scope === "user" ? "project" : "user";
				reset();
				ctx.notice("info", `Adoption destination: ${settings.scope}.`);
			},
			p: () => ctx.notice("info", movedKeyNotice("p", "s")),
			u: () => ctx.notice("info", movedKeyNotice("u", "s")),
			c: () => {
				settings.filter = KIND_CYCLE[(KIND_CYCLE.indexOf(settings.filter) + 1) % KIND_CYCLE.length];
				reset();
				ctx.notice("info", `Adoption kind: ${settings.filter ?? "all"}.`);
			},
		},
		// E-13: Esc leaves a pending plan for the agent list before it closes; b stays as a second way.
		onBack: {
			active: () => pending !== undefined,
			back: () => {
				if (pending) reset(`inventory:${pending.host}`);
			},
		},
		hints,
		actions: {
			i: preview,
			b: () => {
				if (pending) reset(`inventory:${pending.host}`);
			},
			y: () => {
				if (!pending) return;
				const plan = pending;
				pending = undefined;
				const result = applyInteropAdoption(plan, true);
				for (const id of result.installed) ctx.notice("info", `Installed ${id}.`);
				for (const diagnostic of result.diagnostics) ctx.notice("warn", diagnostic);
				reset(`inventory:${plan.host}`);
			},
			a: (item) => decide(item, deps.accept),
			x: (item) => decide(item, deps.decline),
			d: () => ctx.notice("info", movedKeyNotice("d", "x")),
		},
		onClose: close,
	});
	void detectInteropAgents({ inventory: true, probeVersion: true })
		.then((report) => {
			if (closed) return;
			fresh = report;
			if (!pending) {
				items = buildItems(deps, settings);
				handle.setItems(items);
			}
		})
		.catch((error) => {
			if (!closed) ctx.notice("warn", `Inventory unavailable: ${String(error)}`);
		});
	return handle;
}
