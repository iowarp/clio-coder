import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { DispatchContract, DispatchSnapshot } from "../domains/dispatch/contract.js";
import { isDispatchEligibleRuntime, type ProvidersContract } from "../domains/providers/index.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, showClioOverlayFrame } from "./overlay-frame.js";
import {
	selectModelSubmenu,
	selectTargetSubmenu,
	type SettingSubmenuBuilder,
	SubmenuWrapper,
	textInputSubmenu,
} from "./overlays/settings.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const FLEET_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

type FleetMode = "status" | "profiles" | "bindings";
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
	profileName: string;
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

function formatSeconds(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatRuntimeSeconds(seconds: number): string {
	return formatSeconds(seconds * 1000);
}

function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatUsd(value: number): string {
	return `$${Math.max(0, value).toFixed(4)}`;
}

function divider(width: number): string {
	return "─".repeat(width);
}

function fitContentLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "", true);
}

function runningHeader(width: number): string {
	return fitContentLine(
		[
			fitLeft("run", 10),
			fitLeft("agent", 12),
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
	);
}

function retryHeader(width: number): string {
	return fitContentLine(
		[fitLeft("source", 10), fitLeft("agent", 12), fitRight("try", 3), fitLeft("due", 20), fitLeft("reason", 32)].join(
			" ",
		),
		width,
	);
}

function runningRow(row: DispatchSnapshot["running"][number], width: number): string {
	const line = [
		fitLeft(shortId(row.runId), 10),
		fitLeft(row.agentId, 12),
		fitLeft(row.runtimeKind, 5),
		fitLeft(row.heartbeat, 6),
		fitLeft(row.outcomePhase, 11),
		fitRight(String(row.lineage.attempt), 3),
		fitRight(String(row.lineage.depth), 3),
		fitRight(formatSeconds(row.elapsedMs), 7),
		fitRight(formatTokens(row.tokens.total), 8),
		fitRight(formatUsd(row.costUsd), 9),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

function retryRow(row: DispatchSnapshot["retrying"][number], width: number): string {
	const line = [
		fitLeft(shortId(row.runId), 10),
		fitLeft(row.agentId, 12),
		fitRight(String(row.attempt), 3),
		fitLeft(row.dueAt, 20),
		fitLeft(row.reason, 32),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

function totalsLine(totals: DispatchSnapshot["totals"]): string {
	return `input=${formatTokens(totals.inputTokens)} output=${formatTokens(totals.outputTokens)} total=${formatTokens(
		totals.totalTokens,
	)} cost=${formatUsd(totals.costUsd)} runtime=${formatRuntimeSeconds(totals.runtimeSeconds)}`;
}

export function formatFleetOverlayBodyLines(
	snapshot: DispatchSnapshot,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	const width = Math.max(1, Math.floor(contentWidth));
	const lines: string[] = [];
	const push = (line: string): void => {
		lines.push(fitContentLine(line, width));
	};
	push(`generated ${snapshot.generatedAt}`);
	lines.push(divider(width));
	push(`running (${snapshot.running.length})`);
	if (snapshot.running.length === 0) {
		push("  none in this TUI process");
	} else {
		lines.push(runningHeader(width));
		for (const row of snapshot.running) lines.push(runningRow(row, width));
	}
	lines.push("");
	push(`retrying (${snapshot.retrying.length})`);
	if (snapshot.retrying.length === 0) {
		push("  none in this TUI process");
	} else {
		lines.push(retryHeader(width));
		for (const row of snapshot.retrying) lines.push(retryRow(row, width));
	}
	lines.push("");
	push("totals");
	push(`  ${totalsLine(snapshot.totals)}`);
	if (snapshot.running.length === 0 && snapshot.retrying.length === 0) {
		lines.push("");
		push("No in-process dispatches are active.");
		push("Cross-process live retry state is not attached to the TUI.");
		push("Use `clio fleet status` for durable ledger-backed running rows.");
		push("Rows from other Clio processes are not shown here.");
	}
	return lines;
}

function renderSnapshot(dispatch: DispatchContract, width = DEFAULT_CONTENT_WIDTH): string[] {
	try {
		return formatFleetOverlayBodyLines(dispatch.snapshot(), width);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`fleet snapshot unavailable`, "", fitContentLine(message, width)];
	}
}

function footerForMode(mode: FleetMode): string {
	if (mode === "profiles") {
		return buildHint("browse", [
			{ key: "Tab", verb: "mode" },
			{ key: "n", verb: "new" },
			{ key: "t/m/l", verb: "edit" },
			{ key: "r", verb: "rename" },
			{ key: "d", verb: "delete" },
		]);
	}
	if (mode === "bindings") {
		return buildHint("browse", [
			{ key: "Tab", verb: "mode" },
			{ key: "b", verb: "bind" },
			{ key: "u", verb: "unbind" },
		]);
	}
	return buildHint("browse", [{ key: "Tab", verb: "mode" }]);
}

function nextMode(mode: FleetMode): FleetMode {
	if (mode === "status") return "profiles";
	if (mode === "profiles") return "bindings";
	return "status";
}

function normalizeSettingValue(value: string | null | undefined): string {
	return value && value.length > 0 ? value : "(unset)";
}

function profileHeader(width: number): string {
	return fitContentLine(
		[
			fitLeft("profile", 20),
			fitLeft("target", 18),
			fitLeft("model", 26),
			fitLeft("thinking", 8),
			"warning",
		].join(" "),
		width,
	);
}

function profileLine(row: ProfileRow, selected: boolean, width: number): string {
	const marker = selected ? "▸ " : "  ";
	const warning = row.warning ? `! ${row.warning}` : "";
	return fitContentLine(
		`${marker}${[
			fitLeft(row.name, 20),
			fitLeft(row.target, 18),
			fitLeft(row.model, 26),
			fitLeft(row.profile.thinkingLevel, 8),
			warning,
		].join(" ")}`,
		width,
	);
}

function bindingHeader(width: number): string {
	return fitContentLine(
		[fitLeft("agent", 20), fitLeft("profile", 20), fitLeft("target", 18), fitLeft("model", 26), "warning"].join(
			" ",
		),
		width,
	);
}

function bindingLine(row: BindingRow, selected: boolean, width: number): string {
	const marker = selected ? "▸ " : "  ";
	const warning = row.warning ? `! ${row.warning}` : "";
	return fitContentLine(
		`${marker}${[
			fitLeft(row.agentId, 20),
			fitLeft(row.profileName, 20),
			fitLeft(row.target, 18),
			fitLeft(row.model, 26),
			warning,
		].join(" ")}`,
		width,
	);
}

export interface OpenFleetOverlayOptions {
	bus?: SafeEventBus;
	providers?: ProvidersContract;
	agents?: AgentsContract;
	getSettings?: () => Readonly<ClioSettings> | undefined;
	writeSettings?: (next: ClioSettings) => void;
	notice?: (level: FleetNoticeLevel, text: string, key?: string) => void;
	onClose?: () => void;
}

class FleetOverlayBody implements Component {
	private mode: FleetMode = "status";
	private readonly selectedByMode: Record<FleetMode, number> = { status: 0, profiles: 0, bindings: 0 };
	private submenuComponent: Component | null = null;
	private confirmDeleteProfileName: string | null = null;

	constructor(
		private readonly dispatch: DispatchContract,
		private readonly options: OpenFleetOverlayOptions,
		private readonly requestRender: () => void,
	) {}

	titleText(): string {
		if (this.mode === "profiles") return "Fleet · Profiles";
		if (this.mode === "bindings") return "Fleet · Bindings";
		return "Fleet · Status";
	}

	footerText(): string {
		if (this.submenuComponent) return "";
		if (this.confirmDeleteProfileName) return buildHint("commit", [{ key: "y", verb: "confirm" }]);
		return footerForMode(this.mode);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, Math.floor(width));
		if (this.submenuComponent) return this.submenuComponent.render(contentWidth);
		if (this.mode === "status") return renderSnapshot(this.dispatch, contentWidth);
		if (!this.canEditSettings()) return ["settings writer unavailable"];
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
		if (!this.canEditSettings() || this.mode === "status") return;
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
		return Object.entries(settings.workers.agentBindings)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([agentId, profileName]) => {
				const profile = settings.workers.profiles[profileName];
				return {
					agentId,
					profileName,
					target: normalizeSettingValue(profile?.target),
					model: normalizeSettingValue(profile?.model),
					warning: profile ? null : "missing profile",
				};
			});
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
		const lines = [fitContentLine("profiles", width), divider(width), profileHeader(width)];
		if (rows.length === 0) {
			lines.push(fitContentLine("no fleet profiles configured. press n to create one", width));
		} else {
			const selected = Math.min(this.selectedByMode.profiles, rows.length - 1);
			rows.forEach((row, index) => lines.push(profileLine(row, index === selected, width)));
		}
		if (this.confirmDeleteProfileName) {
			const settings = this.currentSettings();
			const bindingCount = settings
				? Object.values(settings.workers.agentBindings).filter((profileName) => profileName === this.confirmDeleteProfileName)
						.length
				: 0;
			const prompt =
				bindingCount > 0
					? `Delete profile ${this.confirmDeleteProfileName} and ${bindingCount} binding(s)? press y to confirm, any other key cancels`
					: `Delete profile ${this.confirmDeleteProfileName}? press y to confirm, any other key cancels`;
			lines.push("");
			lines.push(fitContentLine(prompt, width));
		}
		return lines;
	}

	private renderBindings(width: number): string[] {
		const rows = this.bindingRows();
		const lines = [fitContentLine("agent bindings", width), divider(width), bindingHeader(width)];
		if (rows.length === 0) {
			lines.push(fitContentLine("no agent bindings configured. press b to bind one", width));
		} else {
			const selected = Math.min(this.selectedByMode.bindings, rows.length - 1);
			rows.forEach((row, index) => lines.push(bindingLine(row, index === selected, width)));
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
		if (!this.options.providers) {
			this.notice("warning", "model picker unavailable", `fleet:profile:${row.name}`);
			return;
		}
		this.openSubmenu(
			selectModelSubmenu(this.options.providers, () => this.currentSettings()?.workers.profiles[row.name]?.target ?? undefined),
			this.currentSettings()?.workers.profiles[row.name]?.model ?? "",
			(value) => {
				const model = value.trim();
				const next = this.mutateSettings((settings) => {
					const profile = settings.workers.profiles[row.name];
					if (!profile) return;
					profile.model = model.length > 0 ? model : null;
				});
				if (next?.workers.profiles[row.name]) {
					this.selectProfileByName(row.name);
					this.notice("success", `profile ${row.name} model ${normalizeSettingValue(model)}`, `fleet:profile:${row.name}`);
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
			label: `${spec.id} (${spec.name})`,
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

	private unbindSelectedAgent(): void {
		const row = this.selectedBindingRow();
		if (!row) return;
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
