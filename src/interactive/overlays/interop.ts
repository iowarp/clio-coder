/**
 * `/interop`: the other coding agents on this machine, and what Clio may do
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
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../../session-control/slash-commands.js";
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
	keyCap,
	type StatusKind,
	statusChip,
	type TableCell,
	tableRows,
	titleRow,
} from "../theme/index.js";
import { type ListOverlayHandle, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const INTEROP_EMPTY =
	"no other coding agents detected on this machine. install one, then `/interop` proposes it as a delegation peer.";

const GROUP_PROPOSED = "Proposed";
const GROUP_DETECTED = "Detected";
const GROUP_CONNECTED = "Connected";
const GROUP_DECLINED = "Declined";
const GROUP_INVENTORY = "Inventory";
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
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The exact argv a peer is launched with, as one line. */
function commandLine(command: string, args: ReadonlyArray<string>): string {
	return sanitizeCallTargetText([command, ...args].join(" "));
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
	return peerModeCapabilities(kind, record, {
		configuredAcp: configuredIds.has(id),
		configuredTargets: readSettings().targets,
		paneAvailable,
	}).map((mode) => ({
		label: mode.mode,
		value: `${statusChip(theme, MODE_STATUS[mode.status], mode.status)} ${theme.fg("body", sanitizeCallTargetText(mode.reason))}. ${theme.fg("annotation", `Next: ${sanitizeCallTargetText(mode.setupAction)}`)}`,
	}));
}

/** Counts per resource kind, in inventory order, as `3 skills`. */
function kindCounts(items: ReadonlyArray<{ kind: string }>): string[] {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
	return [...counts.entries()].map(([kind, count]) => plural(count, kind));
}

function buildItems(deps: InteropOverlayDeps, settings: AdoptionSettings): ListOverlayItem[] {
	const theme = clioTheme();
	const report = deps.report();
	const configuredAgents = deps.configured();
	const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
	const paneAvailable = deps.paneAvailable ?? null;
	const proposals = deps.proposals();
	const modes = (id: InteropAgentId): Fact[] => modeFacts(id, report, configuredIds, paneAvailable);
	const declined = (agent: { decision?: string; decidedFingerprint?: string; fingerprint: string }): boolean =>
		agent.decision === "declined" && agent.decidedFingerprint === agent.fingerprint;

	const items: ListOverlayItem[] = proposals.map((proposal) => {
		const command = commandLine(proposal.entry.command, proposal.entry.args);
		return {
			id: `proposal:${proposal.kind}`,
			label: `${proposal.label} ${proposal.entry.id} ${command}`,
			cells: { lead: proposal.label, text: command },
			get meta() {
				return chipRow(
					clioTheme(),
					[
						proposal.version ? chip(clioTheme(), sanitizeCallTargetText(proposal.version), "muted") : null,
						statusChip(clioTheme(), "pending", "not configured"),
					],
					60,
				);
			},
			group: GROUP_PROPOSED,
			detailFormat: "rows",
			detail: (width) => [
				titleRow(theme, `Connect ${proposal.label}`, width, { meta: "proposal" }),
				...chipRows(
					theme,
					[
						statusChip(theme, "pending", "not configured"),
						proposal.version ? chip(theme, `version ${sanitizeCallTargetText(proposal.version)}`, "muted") : null,
						proposal.binary ? chip(theme, sanitizeCallTargetText(proposal.binary), "muted") : null,
					],
					width,
				),
				...choiceRows(
					theme,
					[
						{ key: "a", verb: "connect", consequence: "appends exactly this entry to delegation.agents", tone: "action" },
						{
							key: "d",
							verb: "decline",
							consequence: "records the decision; Clio proposes it again when its binary version or path changes",
						},
					],
					width,
				),
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
		};
	});

	// A present peer with no pending proposal and no standing decision: it has
	// no ACP recipe, or Clio reaches it another way. A configured or declined
	// agent is listed once, under its own group, never here as well.
	for (const record of report?.agents ?? []) {
		const kind = interopAgentKind(record.kind);
		if (!kind || kind.binaryNames.length === 0) continue;
		if (proposals.some((proposal) => proposal.kind === record.kind)) continue;
		if (configuredIds.has(record.kind) || declined(record)) continue;
		if (record.presence === "absent") continue;
		const text = sanitizeCallTargetText(record.version ?? record.binary ?? "version unknown");
		items.push({
			id: `peer:${record.kind}`,
			label: `${kind.label} ${text}`,
			cells: { lead: kind.label, text },
			get meta() {
				return statusChip(clioTheme(), PRESENCE_STATUS[record.presence], record.presence);
			},
			group: GROUP_DETECTED,
			detailFormat: "rows",
			detail: (width) => [
				titleRow(theme, kind.label, width, { meta: "detected" }),
				...chipRows(
					theme,
					[
						statusChip(theme, PRESENCE_STATUS[record.presence], record.presence),
						record.version ? chip(theme, `version ${sanitizeCallTargetText(record.version)}`, "muted") : null,
						record.binary ? chip(theme, sanitizeCallTargetText(record.binary), "muted") : null,
					],
					width,
				),
				...(kind.acp
					? []
					: [
							theme.fg(
								"annotation",
								"No ACP recipe for this agent, so there is nothing to connect; the modes below are how Clio reaches it.",
							),
						]),
				...factRows(theme, modes(record.kind), width, FACT_OPTIONS),
			],
		});
	}

	for (const agent of configuredAgents) {
		const command = commandLine(agent.command, agent.args);
		items.push({
			id: `configured:${agent.id}`,
			label: `${agent.id} ${command}`,
			cells: { lead: sanitizeCallTargetText(agent.id), text: command },
			get meta() {
				return statusChip(clioTheme(), "ok", "connected");
			},
			group: GROUP_CONNECTED,
			detailFormat: "rows",
			detail: (width) => [
				titleRow(theme, sanitizeCallTargetText(agent.id), width, { meta: "delegation agent" }),
				chipRow(theme, [statusChip(theme, "ok", "connected"), chip(theme, `/delegate ${agent.id} <task>`, "muted")], width),
				...commandBlock(theme, command, width),
				...factRows(theme, modes(agent.id as InteropAgentId), width, FACT_OPTIONS),
			],
		});
	}

	for (const agent of report?.agents ?? []) {
		if (!declined(agent)) continue;
		const when = agent.decidedAt ? dateLocal(agent.decidedAt) : "";
		const text = sanitizeCallTargetText(agent.binary ?? agent.installDir ?? "");
		items.push({
			id: `declined:${agent.kind}`,
			label: `${agent.kind} ${text}`,
			cells: { lead: agent.kind, text },
			get meta() {
				return statusChip(clioTheme(), "cancelled", `declined ${when}`.trim());
			},
			group: GROUP_DECLINED,
			detailFormat: "rows",
			detail: (width) => [
				titleRow(theme, interopAgentKind(agent.kind)?.label ?? agent.kind, width, { meta: "declined" }),
				chipRow(theme, [statusChip(theme, "cancelled", `declined ${when}`.trim())], width),
				theme.fg("annotation", "Clio proposes it again when its binary version or path changes."),
			],
		});
	}

	for (const agent of report?.agents ?? []) {
		const inventory = agent.inventory;
		if (!inventory) continue;
		const counts = kindCounts(inventory.items);
		items.push({
			id: `inventory:${agent.kind}`,
			label: `${agent.kind} ${counts.join(" ")}`,
			cells: { lead: agent.kind, text: counts.join(", ") || "nothing adoptable" },
			get meta() {
				return chipRow(
					clioTheme(),
					[chip(clioTheme(), plural(inventory.items.length, "resource"), "muted"), keyCap(clioTheme(), "i")],
					40,
				);
			},
			group: GROUP_INVENTORY,
			detailFormat: "rows",
			detail: (width) => {
				const rows = inventory.items.map((item): TableCell[] => [
					{ text: item.scope, tone: "muted" },
					{ text: item.kind, tone: "muted" },
					{ text: sanitizeCallTargetText(item.name) },
				]);
				return [
					titleRow(theme, `Adopt from ${agent.kind}`, width, { meta: `inventory ${inventory.status}` }),
					...chipRows(
						theme,
						[
							statusChip(theme, PRESENCE_STATUS[agent.presence], agent.presence),
							agent.version ? chip(theme, `version ${sanitizeCallTargetText(agent.version)}`, "muted") : null,
							...counts.map((count) => chip(theme, count, "neutral")),
						],
						width,
					),
					...choiceRows(
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
					),
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
					...inventory.diagnostics.map((diagnostic) => statusChip(theme, "warning", sanitizeCallTargetText(diagnostic))),
				];
			},
		});
	}
	return items;
}

/** The reviewed plan as rows: the approval first, then every entry with its verdict. */
function planItems(plan: InteropAdoptionPlan): ListOverlayItem[] {
	const theme = clioTheme();
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
		detailFormat: "rows",
		detail: (width) => [
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
	};
	return [
		approval,
		...plan.entries.map(
			(entry, index): ListOverlayItem => ({
				id: `plan:${index}`,
				label: `${entry.action} ${entry.item.name} ${entry.item.kind}`,
				cells: { lead: sanitizeCallTargetText(entry.item.name), text: sanitizeCallTargetText(entry.reason) },
				get meta() {
					return chipRow(
						clioTheme(),
						[
							chip(clioTheme(), entry.item.kind, "muted"),
							entry.action === "install"
								? statusChip(clioTheme(), "ok", "install")
								: statusChip(clioTheme(), "cancelled", "skip"),
						],
						40,
					);
				},
				group: GROUP_PLAN,
				detailFormat: "rows",
				detail: (width) => [
					titleRow(theme, sanitizeCallTargetText(entry.item.name), width, { meta: entry.item.kind }),
					chipRow(
						theme,
						[
							entry.action === "install" ? statusChip(theme, "ok", "install") : statusChip(theme, "cancelled", "skip"),
							chip(theme, `${entry.item.scope} scope at the host`, "muted"),
						],
						width,
					),
					...factRows(
						theme,
						[
							{ label: "Why", value: sanitizeCallTargetText(entry.reason) },
							{ label: "Source", value: sanitizeCallTargetText(entry.item.path) },
							...(entry.destination ? [{ label: "Destination", value: sanitizeCallTargetText(entry.destination) }] : []),
							...(entry.digest ? [{ label: "SHA-256", value: entry.digest }] : []),
							...(entry.requirements?.length
								? [{ label: "Requires", value: entry.requirements.join(", "), tone: "warning" as const }]
								: []),
							...(entry.omitted ?? []).map((file) => ({
								label: "Skipped file",
								value: `${sanitizeCallTargetText(file)}: executable, host-specific, or non-text data`,
								tone: "warning" as const,
							})),
						],
						width,
						FACT_OPTIONS,
					),
				],
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
	if (pending) {
		const installs = pending.entries.filter((entry) => entry.action === "install").length;
		return chipRow(
			theme,
			[
				chip(theme, `plan from ${pending.host}`, "accent"),
				chip(theme, `${installs} to install`, installs > 0 ? "action" : "muted"),
				chip(theme, `${pending.entries.length - installs} skipped`, "muted"),
				chip(theme, `${pending.scope} scope`, "muted"),
				`${keyCap(theme, "y")} ${theme.fg("annotation", "approve")}`,
				`${keyCap(theme, "b")} ${theme.fg("annotation", "back")}`,
			],
			width,
		);
	}
	const wide = width >= 72;
	return chipRow(
		theme,
		[
			`${keyCap(theme, "u")}${keyCap(theme, "p")} ${theme.fg("fieldValue", wide ? `adopt into ${settings.scope}` : settings.scope)}`,
			`${keyCap(theme, "c")} ${theme.fg("fieldValue", settings.filter ? `${settings.filter}s only` : "all kinds")}`,
			...(wide
				? [
						chip(theme, `${counts.proposed} proposed`, counts.proposed > 0 ? "action" : "muted"),
						chip(theme, `${counts.connected} connected`, counts.connected > 0 ? "success" : "muted"),
						counts.declined > 0 ? chip(theme, `${counts.declined} declined`, "muted") : null,
						counts.inventories > 0 ? chip(theme, plural(counts.inventories, "inventory"), "muted") : null,
					]
				: [chip(theme, `${counts.proposed} proposed`, counts.proposed > 0 ? "action" : "muted")]),
		],
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
	const reset = (): void => {
		pending = undefined;
		items = buildItems(deps, settings);
		handle.setItems(items);
	};
	const preview = (item: ListOverlayItem): void => {
		if (!item.id.startsWith("inventory:")) return;
		const host = item.id.slice("inventory:".length) as InteropAgentId;
		const inventory = deps.report()?.agents.find((agent) => agent.kind === host)?.inventory;
		if (!inventory) return;
		pending = planInteropAdoption({
			host,
			inventory,
			scope: settings.scope,
			...(settings.filter ? { kind: settings.filter } : {}),
		});
		handle.setItems(planItems(pending));
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
				{ key: "d", verb: "decline", critical: true },
			];
		}
		if (selected?.id.startsWith("inventory:"))
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
			{ key: "u/p", verb: "adopt into user/project", short: "scope" },
			{ key: "c", verb: "kinds" },
		],
		globalActions: {
			p: () => {
				settings.scope = "project";
				reset();
				ctx.notice("info", "Adoption destination: project.");
			},
			u: () => {
				settings.scope = "user";
				reset();
				ctx.notice("info", "Adoption destination: user.");
			},
			c: () => {
				settings.filter = KIND_CYCLE[(KIND_CYCLE.indexOf(settings.filter) + 1) % KIND_CYCLE.length];
				reset();
				ctx.notice("info", `Adoption kind: ${settings.filter ?? "all"}.`);
			},
		},
		hints,
		actions: {
			i: preview,
			b: () => {
				if (pending) reset();
			},
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
