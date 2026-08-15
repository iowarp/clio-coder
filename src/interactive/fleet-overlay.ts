import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { DispatchContract, DispatchSnapshot } from "../domains/dispatch/contract.js";
import {
	COST_NOT_MEASURED,
	costAggregateForAmount,
	formatCostAggregate,
	type ObservabilitySnapshot,
} from "../domains/observability/index.js";
import { isDispatchEligibleRuntime, type ProvidersContract } from "../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { deriveRunEvidenceState, evidenceMarker } from "./dispatch-board.js";
import { clockLocal } from "./format-time.js";
import { buildHint, DEFAULT_SELECT_THEME, showClioOverlayFrame } from "./overlay-frame.js";
import {
	type SettingSubmenuBuilder,
	SubmenuWrapper,
	selectModelSubmenu,
	selectTargetSubmenu,
	textInputSubmenu,
} from "./overlays/settings.js";
import { type ClioToken, clioTheme, formatCompactMs, GLYPH, listGroupHeader, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1000;

export const FLEET_OVERLAY_WIDTH = "100%";

type FleetMode = "status" | "nodes" | "profiles" | "bindings";
type FleetNoticeLevel = "info" | "success" | "warning" | "error";

interface ProfileRow {
	name: string;
	profile: ClioSettings["workers"]["default"];
	target: string;
	model: string;
	warning: string | null;
}

interface BindingRow {
	agentId: string;
	audience: string;
	profileName: string | null;
	target: string;
	model: string;
	warning: string | null;
}

function fitLeft(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function fitRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${clipped}`;
}

function shortId(runId: string): string {
	return runId.length <= 10 ? runId : runId.slice(0, 10);
}

// Token columns in this overlay are a detail table, so they keep full
// grouped integers via toLocaleString rather than the compact footer form.
function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

// A timestamp always renders as HH:MM:SS in local time so a row never carries a
// raw ISO string. An unparseable value falls back to itself rather than an
// empty cell.
function formatClock(value: string): string {
	return Number.isFinite(Date.parse(value)) ? clockLocal(value) : value;
}

function dim(text: string): string {
	return clioTheme().fg("dim", text);
}

function muted(text: string): string {
	return clioTheme().fg("muted", text);
}

// Status-ish cells read their token from the value itself: stale is a warning,
// failed or dead is an error, and everything alive or running is neutral muted.
function statusToken(value: string): ClioToken {
	const normalized = value.trim().toLowerCase();
	if (normalized === "stale") return "warning";
	if (normalized === "failed" || normalized === "dead") return "error";
	return "muted";
}

function statusCell(value: string, width: number): string {
	return clioTheme().fg(statusToken(value), fitLeft(value, width));
}

// A key-value row with a dim padded key and a muted value.
function kvRow(key: string, value: string, keyWidth: number): string {
	return `${dim(key.padEnd(keyWidth))} ${muted(value)}`;
}

function divider(width: number): string {
	return rule(clioTheme(), width);
}

function fitContentLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "", true);
}

function runningHeader(width: number): string {
	return dim(
		fitContentLine(
			[
				fitLeft("run", 10),
				fitLeft("agent", 10),
				fitLeft("node", 6),
				fitLeft("rt", 5),
				fitLeft("hb", 6),
				fitLeft("phase", 11),
				fitRight("try", 3),
				fitRight("dep", 3),
				fitRight("age", 7),
				fitRight("tokens", 8),
				fitRight("cost", 9),
			].join(" "),
			width,
		),
	);
}

function retryHeader(width: number): string {
	return dim(
		fitContentLine(
			[fitLeft("source", 10), fitLeft("agent", 12), fitRight("try", 3), fitLeft("due", 20), fitLeft("reason", 32)].join(
				" ",
			),
			width,
		),
	);
}

function runningRow(row: DispatchSnapshot["running"][number], width: number, proofMarker: string | null): string {
	const fields = [
		muted(fitLeft(shortId(row.runId), 10)),
		muted(fitLeft(row.agentId, 10)),
		muted(fitLeft(row.node?.id ?? "local", 6)),
		muted(fitLeft(row.runtimeKind, 5)),
		statusCell(row.heartbeat, 6),
		statusCell(row.outcomePhase, 11),
		muted(fitRight(String(row.lineage.attempt), 3)),
		muted(fitRight(String(row.lineage.depth), 3)),
		muted(fitRight(formatCompactMs(row.elapsedMs), 7)),
		muted(fitRight(formatTokens(row.tokens.total), 8)),
	];
	const cost = formatCostAggregate(costAggregateForAmount(row.costUsd, row.costProvenance)) ?? COST_NOT_MEASURED;
	const line = [...fields, muted(fitRight(cost, 12))].join(" ");
	// The proof marker is a compact trailing evidence chip; truncateToWidth clips
	// it ANSI-aware on tight widths, so it never overflows the existing columns.
	const full = proofMarker ? `${line} ${proofMarker}` : line;
	if (visibleWidth(full) <= width) return full;
	// Cost provenance labels are semantic units (not decorative suffixes). If a
	// narrow overlay cannot fit the whole unit, omit it rather than displaying a
	// misleading fragment such as "cost unk" or "~$0.01" without "est".
	const withoutCost = fields.join(" ");
	const fallback = proofMarker ? `${withoutCost} ${proofMarker}` : withoutCost;
	return truncateToWidth(fallback, width, "", true);
}

function retryRow(row: DispatchSnapshot["retrying"][number], width: number): string {
	// A retrying row is a warning-level state, so the reason cell that explains
	// the retry carries the warning token; its timestamp renders as a clock.
	const line = [
		muted(fitLeft(shortId(row.runId), 10)),
		muted(fitLeft(row.agentId, 12)),
		muted(fitRight(String(row.attempt), 3)),
		muted(fitLeft(formatClock(row.dueAt), 20)),
		clioTheme().fg("warning", fitLeft(row.reason, 32)),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

function totalsRows(totals: DispatchSnapshot["totals"]): string[] {
	const keyWidth = "runtime".length;
	return [
		kvRow("input", formatTokens(totals.inputTokens), keyWidth),
		kvRow("output", formatTokens(totals.outputTokens), keyWidth),
		kvRow("total", formatTokens(totals.totalTokens), keyWidth),
		kvRow(
			"cost",
			formatCostAggregate(totals.cost ?? costAggregateForAmount(totals.costUsd, undefined)) ?? COST_NOT_MEASURED,
			keyWidth,
		),
		kvRow("runtime", formatCompactMs(totals.runtimeSeconds * 1000), keyWidth),
	];
}

export function formatFleetOverlayBodyLines(
	snapshot: DispatchSnapshot,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	observability?: ObservabilitySnapshot,
): string[] {
	const width = Math.max(1, Math.floor(contentWidth));
	const lines: string[] = [];
	lines.push(dim(`generated ${formatClock(snapshot.generatedAt)}`));
	lines.push(divider(width));
	lines.push(listGroupHeader(clioTheme(), `running (${snapshot.running.length})`));
	if (snapshot.running.length === 0) {
		lines.push(dim("  none in this TUI process"));
	} else {
		lines.push(runningHeader(width));
		// Evidence state is derived purely from the observability snapshot; when it
		// is absent the marker resolves to null and rows render exactly as before.
		for (const row of snapshot.running) {
			lines.push(runningRow(row, width, evidenceMarker(deriveRunEvidenceState(observability, row.runId))));
		}
	}
	lines.push("");
	lines.push(listGroupHeader(clioTheme(), `retrying (${snapshot.retrying.length})`));
	if (snapshot.retrying.length === 0) {
		lines.push(dim("  none in this TUI process"));
	} else {
		lines.push(retryHeader(width));
		for (const row of snapshot.retrying) lines.push(retryRow(row, width));
	}
	lines.push("");
	lines.push(listGroupHeader(clioTheme(), "totals"));
	for (const totalRow of totalsRows(snapshot.totals)) lines.push(totalRow);
	if (snapshot.running.length === 0 && snapshot.retrying.length === 0) {
		lines.push("");
		lines.push(dim("No in-process dispatches are active."));
		lines.push(dim("Cross-process live retry state is not attached to the TUI."));
		lines.push(dim("Use `clio-coder fleet status` for durable ledger-backed running rows."));
		lines.push(dim("Rows from other Clio processes are not shown here."));
	}
	return lines;
}

function renderSnapshot(
	dispatch: DispatchContract,
	width = DEFAULT_CONTENT_WIDTH,
	observability?: ObservabilitySnapshot,
): string[] {
	try {
		return formatFleetOverlayBodyLines(dispatch.snapshot(), width, observability);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [clioTheme().fg("error", "fleet snapshot unavailable"), "", muted(fitContentLine(message, width))];
	}
}

function footerForMode(mode: FleetMode): string {
	if (mode === "profiles") {
		return buildHint([
			{ key: "Tab", verb: "mode" },
			{ key: "n", verb: "new" },
			{ key: "t/m/l/o", verb: "edit" },
			{ key: "r", verb: "rename" },
			{ key: "d", verb: "delete" },
		]);
	}
	if (mode === "bindings") {
		return buildHint([
			{ key: "Tab", verb: "mode" },
			{ key: "b", verb: "bind" },
			{ key: "p", verb: "profile" },
			{ key: "m", verb: "model" },
			{ key: "u", verb: "unbind" },
		]);
	}
	return buildHint([{ key: "Tab", verb: "mode" }]);
}

function nextMode(mode: FleetMode): FleetMode {
	if (mode === "status") return "nodes";
	if (mode === "nodes") return "profiles";
	if (mode === "profiles") return "bindings";
	return "status";
}

function nodeStateToken(state: FleetNodeSnapshot["state"]): ClioToken {
	if (state === "offline") return "error";
	return "success";
}

function nodesHeader(width: number): string {
	return dim(
		fitContentLine(
			[
				fitLeft("node", 10),
				fitLeft("kind", 6),
				fitLeft("host", 22),
				fitLeft("state", 9),
				fitRight("busy", 4),
				fitRight("max", 4),
				fitLeft("seen", 10),
				fitLeft("reason", 24),
			].join(" "),
			width,
		),
	);
}

function nodeRow(node: FleetNodeSnapshot, width: number): string {
	const line = [
		muted(fitLeft(node.id, 10)),
		muted(fitLeft(node.kind, 6)),
		muted(fitLeft(node.host, 22)),
		clioTheme().fg(nodeStateToken(node.state), fitLeft(node.state, 9)),
		muted(fitRight(String(node.activeWorkers), 4)),
		muted(fitRight(node.maxWorkers > 0 ? String(node.maxWorkers) : "-", 4)),
		muted(fitLeft(node.lastSeenAt !== null ? formatClock(node.lastSeenAt) : "-", 10)),
		node.stateReason !== null ? clioTheme().fg("warning", fitLeft(node.stateReason, 24)) : muted(fitLeft("-", 24)),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

/** Pure body renderer for the `/fleet` nodes view, shared with tests. */
export function formatFleetNodesBodyLines(
	nodes: ReadonlyArray<FleetNodeSnapshot>,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	const width = Math.max(1, Math.floor(contentWidth));
	const lines: string[] = [listGroupHeader(clioTheme(), `nodes (${nodes.length})`), divider(width)];
	if (nodes.length === 0) {
		lines.push(dim("no fleet nodes configured; every dispatch runs on the local node"));
		lines.push(dim("declare fleet.nodes in settings.yaml and run `clio-coder doctor` to preflight them"));
		return lines;
	}
	lines.push(nodesHeader(width));
	for (const node of nodes) lines.push(nodeRow(node, width));
	return lines;
}

function normalizeSettingValue(value: string | null | undefined): string {
	return value && value.length > 0 ? value : "(unset)";
}

function selectionMarker(selected: boolean): string {
	return selected ? clioTheme().fg("accent", `${GLYPH.cursor} `) : "  ";
}

// A row warning takes the inline warning mark in the warning token.
function rowWarning(warning: string | null): string {
	return warning ? clioTheme().fg("warning", `${GLYPH.warnInline} ${warning}`) : "";
}

function profileHeader(width: number): string {
	return dim(
		fitContentLine(
			[
				fitLeft("profile", 20),
				fitLeft("target", 18),
				fitLeft("model", 26),
				fitLeft("thinking", 8),
				fitLeft("node", 8),
				"warning",
			].join(" "),
			width,
		),
	);
}

function profileLine(row: ProfileRow, selected: boolean, width: number): string {
	return truncateToWidth(
		`${selectionMarker(selected)}${[
			muted(fitLeft(row.name, 20)),
			muted(fitLeft(row.target, 18)),
			muted(fitLeft(row.model, 26)),
			muted(fitLeft(row.profile.thinkingLevel, 8)),
			muted(fitLeft(row.profile.node ?? "-", 8)),
			rowWarning(row.warning),
		].join(" ")}`,
		Math.max(1, width),
		"",
		true,
	);
}

function bindingHeader(width: number): string {
	return dim(
		fitContentLine(
			[
				fitLeft("agent", 16),
				fitLeft("audience", 8),
				fitLeft("profile", 18),
				fitLeft("target", 18),
				fitLeft("model", 26),
				"warning",
			].join(" "),
			width,
		),
	);
}

function bindingLine(row: BindingRow, selected: boolean, width: number): string {
	return truncateToWidth(
		`${selectionMarker(selected)}${[
			muted(fitLeft(row.agentId, 16)),
			muted(fitLeft(row.audience, 8)),
			muted(fitLeft(row.profileName ?? "(unbound)", 18)),
			muted(fitLeft(row.target, 18)),
			muted(fitLeft(row.model, 26)),
			rowWarning(row.warning),
		].join(" ")}`,
		Math.max(1, width),
		"",
		true,
	);
}

export interface OpenFleetOverlayOptions {
	bus?: SafeEventBus;
	providers?: ProvidersContract;
	agents?: AgentsContract;
	/**
	 * Narrow getter for the cached observability projection. When present, running
	 * rows show a compact proof marker derived from the snapshot; no file reads and
	 * no extra subscription are performed here.
	 */
	getObservability?: () => ObservabilitySnapshot | undefined;
	getSettings?: () => Readonly<ClioSettings> | undefined;
	writeSettings?: (next: ClioSettings) => void;
	/** Live fleet node snapshots (scheduling.fleet.list()); absent renders the local-only hint. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	notice?: (level: FleetNoticeLevel, text: string, key?: string) => void;
	onClose?: () => void;
}

class FleetOverlayBody implements Component {
	private mode: FleetMode = "status";
	private readonly selectedByMode: Record<FleetMode, number> = { status: 0, nodes: 0, profiles: 0, bindings: 0 };
	private submenuComponent: Component | null = null;
	private confirmDeleteProfileName: string | null = null;

	constructor(
		private readonly dispatch: DispatchContract,
		private readonly options: OpenFleetOverlayOptions,
		private readonly requestRender: () => void,
	) {}

	titleText(): string {
		if (this.mode === "nodes") return "Fleet · Nodes";
		if (this.mode === "profiles") return "Fleet · Profiles";
		if (this.mode === "bindings") return "Fleet · Bindings";
		return "Fleet · Status";
	}

	footerText(): string {
		if (this.submenuComponent) return "";
		if (this.confirmDeleteProfileName) return buildHint([{ key: "y", verb: "confirm" }]);
		return footerForMode(this.mode);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, Math.floor(width));
		if (this.submenuComponent) return this.submenuComponent.render(contentWidth);
		if (this.mode === "status") return renderSnapshot(this.dispatch, contentWidth, this.options.getObservability?.());
		if (this.mode === "nodes") {
			return formatFleetNodesBodyLines(this.options.getFleetNodes?.() ?? [], contentWidth);
		}
		if (!this.canEditSettings()) return [muted("settings writer unavailable")];
		return this.mode === "profiles" ? this.renderProfiles(contentWidth) : this.renderBindings(contentWidth);
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}
		if (this.confirmDeleteProfileName) {
			const name = this.confirmDeleteProfileName;
			this.confirmDeleteProfileName = null;
			if (data.toLowerCase() === "y") this.deleteProfile(name);
			else this.requestRender();
			return;
		}
		if (matchesKey(data, "esc")) {
			this.options.onClose?.();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.mode = nextMode(this.mode);
			this.requestRender();
			return;
		}
		if (data === "j" || matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}
		if (data === "k" || matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}
		if (!this.canEditSettings() || this.mode === "status" || this.mode === "nodes") return;
		if (this.mode === "profiles") {
			if (data === "n") {
				this.createProfile();
				return;
			}
			if (data === "t") {
				this.editSelectedProfileTarget();
				return;
			}
			if (data === "m") {
				this.editSelectedProfileModel();
				return;
			}
			if (data === "l") {
				this.editSelectedProfileThinking();
				return;
			}
			if (data === "o") {
				this.editSelectedProfileNodePin();
				return;
			}
			if (data === "r") {
				this.renameSelectedProfile();
				return;
			}
			if (data === "d") {
				this.deleteSelectedProfile();
				return;
			}
		}
		if (this.mode === "bindings") {
			if (data === "b") {
				this.bindAgent();
				return;
			}
			if (data === "p") {
				this.editSelectedBindingProfile();
				return;
			}
			if (data === "m") {
				this.editSelectedBindingModel();
				return;
			}
			if (data === "u") {
				this.unbindSelectedAgent();
				return;
			}
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	private canEditSettings(): boolean {
		return Boolean(this.options.getSettings && this.options.writeSettings);
	}

	private currentSettings(): Readonly<ClioSettings> | null {
		return this.options.getSettings?.() ?? null;
	}

	private notice(level: FleetNoticeLevel, text: string, key?: string): void {
		this.options.notice?.(level, text, key);
	}

	private mutateSettings(mutator: (settings: ClioSettings) => void): ClioSettings | null {
		const current = this.currentSettings();
		if (!current || !this.options.writeSettings) return null;
		const next = structuredClone(current) as ClioSettings;
		mutator(next);
		this.options.writeSettings(next);
		this.normalizeSelection();
		this.requestRender();
		return next;
	}

	private profileRows(settings = this.currentSettings()): ProfileRow[] {
		if (!settings) return [];
		return Object.entries(settings.workers.profiles)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, profile]) => ({
				name,
				profile,
				target: normalizeSettingValue(profile.target),
				model: normalizeSettingValue(profile.model),
				warning: this.profileWarning(settings, profile),
			}));
	}

	private bindingRows(settings = this.currentSettings()): BindingRow[] {
		if (!settings) return [];
		const acpAgentIds = new Set(settings.delegation.agents.map((agent) => agent.id));
		const rows = new Map<string, BindingRow>();
		for (const spec of this.options.agents?.listSpecs() ?? []) {
			if (spec.audience === "internal" || acpAgentIds.has(spec.id)) continue;
			const profileName = settings.workers.agentBindings[spec.id] ?? null;
			const profile = profileName ? settings.workers.profiles[profileName] : null;
			rows.set(spec.id, {
				agentId: spec.id,
				audience: spec.audience,
				profileName,
				target: normalizeSettingValue(profileName ? profile?.target : settings.workers.default.target),
				model: normalizeSettingValue(profileName ? profile?.model : settings.workers.default.model),
				warning: profileName && !profile ? "missing profile" : null,
			});
		}
		for (const [agentId, profileName] of Object.entries(settings.workers.agentBindings)) {
			if (rows.has(agentId)) continue;
			const profile = settings.workers.profiles[profileName];
			const spec = this.options.agents?.getSpec(agentId) ?? null;
			rows.set(agentId, {
				agentId,
				audience: spec?.audience ?? "(unknown)",
				profileName,
				target: normalizeSettingValue(profile?.target),
				model: normalizeSettingValue(profile?.model),
				warning: profile ? (this.options.agents && !spec ? "unknown agent" : null) : "missing profile",
			});
		}
		return [...rows.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
	}

	private profileWarning(settings: Readonly<ClioSettings>, profile: ClioSettings["workers"]["default"]): string | null {
		if (!profile.target) return "target unset";
		const target = settings.targets.find((entry) => entry.id === profile.target);
		if (!target) return "missing target";
		const runtime = this.options.providers?.getRuntime(target.runtime) ?? null;
		if (!runtime) return "runtime not registered";
		if (!isDispatchEligibleRuntime(runtime)) return "not dispatch-eligible";
		return null;
	}

	private selectedProfileRow(): ProfileRow | null {
		const rows = this.profileRows();
		if (rows.length === 0) return null;
		const index = Math.min(this.selectedByMode.profiles, rows.length - 1);
		return rows[index] ?? null;
	}

	private selectedBindingRow(): BindingRow | null {
		const rows = this.bindingRows();
		if (rows.length === 0) return null;
		const index = Math.min(this.selectedByMode.bindings, rows.length - 1);
		return rows[index] ?? null;
	}

	private renderProfiles(width: number): string[] {
		const rows = this.profileRows();
		const lines = [listGroupHeader(clioTheme(), `profiles (${rows.length})`), divider(width), profileHeader(width)];
		if (rows.length === 0) {
			lines.push(muted("no fleet profiles configured. press n to create one"));
		} else {
			const selected = Math.min(this.selectedByMode.profiles, rows.length - 1);
			rows.forEach((row, index) => {
				lines.push(profileLine(row, index === selected, width));
			});
		}
		if (this.confirmDeleteProfileName) {
			const settings = this.currentSettings();
			const bindingCount = settings
				? Object.values(settings.workers.agentBindings).filter(
						(profileName) => profileName === this.confirmDeleteProfileName,
					).length
				: 0;
			const prompt =
				bindingCount > 0
					? `Delete profile ${this.confirmDeleteProfileName} and ${bindingCount} binding(s)? press y to confirm, any other key cancels`
					: `Delete profile ${this.confirmDeleteProfileName}? press y to confirm, any other key cancels`;
			lines.push("");
			lines.push(clioTheme().fg("warning", fitContentLine(prompt, width)));
		}
		return lines;
	}

	private renderBindings(width: number): string[] {
		const rows = this.bindingRows();
		const lines = [listGroupHeader(clioTheme(), `agent routes (${rows.length})`), divider(width), bindingHeader(width)];
		if (rows.length === 0) {
			lines.push(muted("no bindable native agents found"));
		} else {
			const selected = Math.min(this.selectedByMode.bindings, rows.length - 1);
			rows.forEach((row, index) => {
				lines.push(bindingLine(row, index === selected, width));
			});
		}
		return lines;
	}

	private moveSelection(delta: number): void {
		const count =
			this.mode === "profiles" ? this.profileRows().length : this.mode === "bindings" ? this.bindingRows().length : 0;
		if (count === 0) return;
		const current = this.selectedByMode[this.mode];
		this.selectedByMode[this.mode] = (current + delta + count) % count;
		this.confirmDeleteProfileName = null;
		this.requestRender();
	}

	private normalizeSelection(): void {
		const profileCount = this.profileRows().length;
		const bindingCount = this.bindingRows().length;
		this.selectedByMode.profiles = Math.min(this.selectedByMode.profiles, Math.max(0, profileCount - 1));
		this.selectedByMode.bindings = Math.min(this.selectedByMode.bindings, Math.max(0, bindingCount - 1));
	}

	private selectProfileByName(name: string): void {
		const index = this.profileRows().findIndex((row) => row.name === name);
		if (index >= 0) this.selectedByMode.profiles = index;
		this.requestRender();
	}

	private selectBindingByAgent(agentId: string): void {
		const index = this.bindingRows().findIndex((row) => row.agentId === agentId);
		if (index >= 0) this.selectedByMode.bindings = index;
		this.requestRender();
	}

	private openSubmenu(builder: SettingSubmenuBuilder, currentValue: string, onValue: (value: string) => void): void {
		this.submenuComponent = builder(currentValue, (value) => {
			this.submenuComponent = null;
			if (value !== undefined) onValue(value);
			else this.requestRender();
		});
		this.requestRender();
	}

	private createProfile(): void {
		this.openSubmenu(textInputSubmenu("New profile name"), "", (value) => {
			const name = value.trim();
			const settings = this.currentSettings();
			if (!settings || !name) {
				this.requestRender();
				return;
			}
			if (settings.workers.profiles[name]) {
				this.notice("warning", `profile ${name} already exists`, `fleet:profile:${name}`);
				this.requestRender();
				return;
			}
			const providers = this.options.providers;
			if (!providers) {
				this.notice("warning", "target picker unavailable", `fleet:profile:${name}`);
				this.requestRender();
				return;
			}
			this.openSubmenu(selectTargetSubmenu(providers), "", (targetValue) => {
				const target = targetValue.trim();
				if (!target) {
					this.requestRender();
					return;
				}
				const defaultModel = this.currentSettings()?.targets.find((entry) => entry.id === target)?.defaultModel ?? null;
				const next = this.mutateSettings((nextSettings) => {
					nextSettings.workers.profiles[name] = { target, model: defaultModel, thinkingLevel: "off" };
				});
				if (next?.workers.profiles[name]) {
					this.selectProfileByName(name);
					this.notice("success", `profile ${name} created -> ${target}`, `fleet:profile:${name}`);
				}
			});
		});
	}

	private editSelectedProfileTarget(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		this.openTargetPicker(row.name);
	}

	private openTargetPicker(name: string): void {
		if (!this.options.providers) {
			this.notice("warning", "target picker unavailable", `fleet:profile:${name}`);
			this.requestRender();
			return;
		}
		const current = this.currentSettings()?.workers.profiles[name]?.target ?? "";
		this.openSubmenu(selectTargetSubmenu(this.options.providers), current, (value) => {
			const target = value.trim();
			const next = this.mutateSettings((settings) => {
				const profile = settings.workers.profiles[name];
				if (!profile) return;
				profile.target = target.length > 0 ? target : null;
			});
			if (next?.workers.profiles[name]) {
				this.selectProfileByName(name);
				this.notice("success", `profile ${name} target ${normalizeSettingValue(target)}`, `fleet:profile:${name}`);
			}
		});
	}

	private editSelectedProfileModel(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		this.openModelPickerForProfile(row.name);
	}

	private openModelPickerForProfile(name: string, agentId?: string): void {
		if (!this.options.providers) {
			this.notice("warning", "model picker unavailable", `fleet:profile:${name}`);
			return;
		}
		this.openSubmenu(
			selectModelSubmenu(
				this.options.providers,
				() => this.currentSettings()?.workers.profiles[name]?.target ?? undefined,
			),
			this.currentSettings()?.workers.profiles[name]?.model ?? "",
			(value) => {
				const model = value.trim();
				const next = this.mutateSettings((settings) => {
					const profile = settings.workers.profiles[name];
					if (!profile) return;
					profile.model = model.length > 0 ? model : null;
				});
				if (next?.workers.profiles[name]) {
					this.selectProfileByName(name);
					if (agentId) this.selectBindingByAgent(agentId);
					const subject = agentId ? `agent ${agentId} profile ${name}` : `profile ${name}`;
					this.notice("success", `${subject} model ${normalizeSettingValue(model)}`, `fleet:profile:${name}`);
				}
			},
		);
	}

	private editSelectedProfileThinking(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		const items = THINKING_LEVELS.map((level) => ({ value: level, label: level }));
		const list = new SelectList(items, items.length, DEFAULT_SELECT_THEME);
		const current = THINKING_LEVELS.indexOf(row.profile.thinkingLevel);
		if (current >= 0) list.setSelectedIndex(current);
		const finish = (level?: (typeof THINKING_LEVELS)[number]): void => {
			this.submenuComponent = null;
			if (level) {
				const next = this.mutateSettings((settings) => {
					const profile = settings.workers.profiles[row.name];
					if (!profile) return;
					profile.thinkingLevel = level;
				});
				if (next?.workers.profiles[row.name]) {
					this.selectProfileByName(row.name);
					this.notice("success", `profile ${row.name} thinking ${level}`, `fleet:profile:${row.name}`);
				}
				return;
			}
			this.requestRender();
		};
		list.onSelect = (item) => finish(THINKING_LEVELS.find((level) => level === item.value));
		list.onCancel = () => finish();
		this.submenuComponent = new SubmenuWrapper("Select thinking level", list);
		this.requestRender();
	}

	/**
	 * Node-pin editor (deferred here from the WS1 fleet work): pin a worker
	 * profile to a fleet node, route it back to automatic placement, or pin it
	 * local. The pick list is the live registry view plus the two idioms.
	 */
	private editSelectedProfileNodePin(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		const nodes = this.options.getFleetNodes?.() ?? [];
		const items = [
			{ value: "", label: "(auto placement)" },
			{ value: "local", label: "local (never remote)" },
			...nodes
				.filter((node) => node.kind === "ssh")
				.map((node) => ({ value: node.id, label: `${node.id} (${node.host}, ${node.state})` })),
		];
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		const currentIndex = items.findIndex((item) => item.value === (row.profile.node ?? ""));
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => {
			this.submenuComponent = null;
			const pin = item.value;
			const next = this.mutateSettings((settings) => {
				const profile = settings.workers.profiles[row.name];
				if (!profile) return;
				if (pin.length === 0) delete profile.node;
				else profile.node = pin;
			});
			if (next?.workers.profiles[row.name]) {
				this.selectProfileByName(row.name);
				this.notice(
					"success",
					`profile ${row.name} node ${pin.length === 0 ? "(auto placement)" : pin}`,
					`fleet:profile:${row.name}`,
				);
			}
		};
		list.onCancel = () => {
			this.submenuComponent = null;
			this.requestRender();
		};
		this.submenuComponent = new SubmenuWrapper("Pin profile to node", list);
		this.requestRender();
	}

	private renameSelectedProfile(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		this.openSubmenu(textInputSubmenu("Rename profile"), row.name, (value) => {
			const nextName = value.trim();
			const current = this.currentSettings();
			if (!current || !nextName || nextName === row.name) {
				this.requestRender();
				return;
			}
			if (current.workers.profiles[nextName]) {
				this.notice("warning", `profile ${nextName} already exists`, `fleet:profile:${nextName}`);
				this.requestRender();
				return;
			}
			this.mutateSettings((settings) => {
				const profile = settings.workers.profiles[row.name];
				if (!profile) return;
				settings.workers.profiles[nextName] = profile;
				delete settings.workers.profiles[row.name];
				for (const [agentId, profileName] of Object.entries(settings.workers.agentBindings)) {
					if (profileName === row.name) settings.workers.agentBindings[agentId] = nextName;
				}
			});
			this.selectProfileByName(nextName);
			this.notice("success", `profile ${row.name} renamed to ${nextName}`, `fleet:profile:${nextName}`);
		});
	}

	private deleteSelectedProfile(): void {
		const row = this.selectedProfileRow();
		if (!row) return;
		this.confirmDeleteProfileName = row.name;
		this.requestRender();
	}

	private deleteProfile(name: string): void {
		let removedBindings = 0;
		const next = this.mutateSettings((settings) => {
			if (!settings.workers.profiles[name]) return;
			delete settings.workers.profiles[name];
			for (const [agentId, profileName] of Object.entries(settings.workers.agentBindings)) {
				if (profileName === name) {
					delete settings.workers.agentBindings[agentId];
					removedBindings += 1;
				}
			}
		});
		if (next) {
			this.notice("success", `profile ${name} deleted (${removedBindings} bindings removed)`, `fleet:profile:${name}`);
		}
	}

	private bindAgent(): void {
		const settings = this.currentSettings();
		if (!settings) return;
		if (Object.keys(settings.workers.profiles).length === 0) {
			this.notice("warning", "create a profile first", "fleet:bindings");
			return;
		}
		if (!this.options.agents) {
			this.notice("warning", "agent catalog unavailable", "fleet:bindings");
			return;
		}
		const acpAgentIds = new Set(settings.delegation.agents.map((agent) => agent.id));
		const specs = this.options.agents
			.listSpecs()
			.filter((spec) => spec.audience !== "internal" && !acpAgentIds.has(spec.id))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (specs.length === 0) {
			this.notice("warning", "no bindable agents", "fleet:bindings");
			return;
		}
		const items = specs.map((spec) => ({
			value: spec.id,
			label: `${spec.id} (${spec.audience})`,
			description: spec.description,
		}));
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => {
			this.submenuComponent = null;
			this.openProfilePickerForAgent(item.value);
		};
		list.onCancel = () => {
			this.submenuComponent = null;
			this.requestRender();
		};
		this.submenuComponent = new SubmenuWrapper("Select agent", list);
		this.requestRender();
	}

	private openProfilePickerForAgent(agentId: string): void {
		const settings = this.currentSettings();
		if (!settings) return;
		if (settings.delegation.agents.some((agent) => agent.id === agentId)) {
			this.notice(
				"error",
				`cannot bind ACP delegation agent ${agentId}; ACP agents use their own runner and ignore native target routing`,
				`fleet:bind:${agentId}`,
			);
			this.requestRender();
			return;
		}
		const names = Object.keys(settings.workers.profiles).sort((a, b) => a.localeCompare(b));
		if (names.length === 0) {
			this.notice("warning", "create a profile first", "fleet:bindings");
			this.requestRender();
			return;
		}
		const items = names.map((name) => {
			const profile = settings.workers.profiles[name];
			return {
				value: name,
				label: `${name} (${normalizeSettingValue(profile?.target)} / ${normalizeSettingValue(profile?.model)})`,
			};
		});
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => {
			this.submenuComponent = null;
			const next = this.mutateSettings((nextSettings) => {
				nextSettings.workers.agentBindings[agentId] = item.value;
			});
			if (next) {
				this.selectBindingByAgent(agentId);
				this.notice("success", `agent ${agentId} bound to ${item.value}`, `fleet:bind:${agentId}`);
			}
		};
		list.onCancel = () => {
			this.submenuComponent = null;
			this.requestRender();
		};
		this.submenuComponent = new SubmenuWrapper("Select profile", list);
		this.requestRender();
	}

	private editSelectedBindingProfile(): void {
		const row = this.selectedBindingRow();
		if (!row) return;
		this.openProfilePickerForAgent(row.agentId);
	}

	private editSelectedBindingModel(): void {
		const row = this.selectedBindingRow();
		if (!row) return;
		if (!row.profileName) {
			this.notice("warning", `bind agent ${row.agentId} to a profile first`, `fleet:bind:${row.agentId}`);
			this.requestRender();
			return;
		}
		const settings = this.currentSettings();
		if (!settings?.workers.profiles[row.profileName]) {
			this.notice("warning", `profile ${row.profileName} is missing`, `fleet:profile:${row.profileName}`);
			this.requestRender();
			return;
		}
		this.openModelPickerForProfile(row.profileName, row.agentId);
	}

	private unbindSelectedAgent(): void {
		const row = this.selectedBindingRow();
		if (!row) return;
		if (!row.profileName) {
			this.notice("warning", `agent ${row.agentId} is not bound`, `fleet:unbind:${row.agentId}`);
			this.requestRender();
			return;
		}
		const next = this.mutateSettings((settings) => {
			delete settings.workers.agentBindings[row.agentId];
		});
		if (next) this.notice("success", `agent ${row.agentId} unbound`, `fleet:unbind:${row.agentId}`);
	}
}

/** Mount the `/fleet` overlay backed by in-process DispatchContract.snapshot() and settings edits. */
export function openFleetOverlay(
	tui: TUI,
	dispatch: DispatchContract,
	options?: OpenFleetOverlayOptions,
): OverlayHandle {
	const body = new FleetOverlayBody(dispatch, options ?? {}, () => tui.requestRender());
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: FLEET_OVERLAY_WIDTH,
		title: () => body.titleText(),
		footerHint: () => body.footerText(),
	});

	const refresh = (): void => {
		body.invalidate();
		tui.requestRender();
	};

	const timer = setInterval(refresh, REFRESH_MS);
	timer.unref?.();
	const unsubscribes: Array<() => void> = [];
	if (options?.bus) {
		unsubscribes.push(options.bus.on(BusChannels.DispatchStarted, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchProgress, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchCompleted, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchFailed, refresh));
	}

	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			for (const off of unsubscribes) off();
			handle.hide();
		},
	};
}
