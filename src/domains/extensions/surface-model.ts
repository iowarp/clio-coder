import type { ExtensionWorkspaceDeclaration } from "./manifest-v2.js";
import type { ExtensionStatus } from "./public-api.js";
import type {
	ExtensionIsland,
	ExtensionOutputV2,
	ExtensionPanelV2,
	ExtensionToast,
	Interview,
	WorkspaceRegion,
} from "./public-api-v2.js";
import type { OutputOrigin } from "./runtime-output-v2.js";
import type { View } from "./view.js";

/** What one api 2 extension last asked the host to keep on screen. */
export interface ExtensionSurfaceEntry {
	/** Bumps on every change to this entry; renderers key their caches on it. */
	readonly version: number;
	readonly status?: ExtensionStatus;
	readonly band?: View;
	readonly dock?: View;
	/** Present while the operator has this extension's panel open. */
	readonly panel?: ExtensionPanelV2;
	/** Kept while the workspace is inactive, so entering shows the latest. */
	readonly regions: Readonly<Partial<Record<WorkspaceRegion, View>>>;
	readonly islands: readonly ExtensionIsland[];
}

export interface ActiveExtensionWorkspace {
	extensionId: string;
	workspaceId: string;
	title: string;
}

/** One-shot requests a renderer acts on once. Persistent content is read from the entries. */
export type ExtensionSurfaceEvent =
	| { kind: "card"; extensionId: string; view: View }
	| { kind: "toast"; extensionId: string; toast: ExtensionToast }
	| { kind: "panel"; extensionId: string; panel: ExtensionPanelV2 }
	| { kind: "dock"; extensionId: string; view: View }
	| { kind: "interview"; extensionId: string; interview: Interview }
	| { kind: "prompt"; extensionId: string; prompt: { fill: string } | { submit: string } }
	| { kind: "workspace"; previous: ActiveExtensionWorkspace | null; active: ActiveExtensionWorkspace | null };

/** `null` means only persistent state changed. */
export type ExtensionSurfaceListener = (event: ExtensionSurfaceEvent | null) => void;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const REGIONS: ReadonlyArray<WorkspaceRegion> = ["header", "board", "rail", "footer"];

/**
 * The host's copy of everything api 2 extensions asked to show, as data. The
 * manager applies validated outputs; terminal, GUI and ACP renderers read it
 * and never call a runtime, so a reload is a process swap behind a stable
 * picture. Opening anything is the operator's: a background origin may update
 * a panel or dock that is already open, and never opens one, takes the screen
 * or touches the prompt.
 */
export class ExtensionSurfaceModel {
	private entries = new Map<string, ExtensionSurfaceEntry>();
	private workspace: ActiveExtensionWorkspace | null = null;
	private listeners = new Set<ExtensionSurfaceListener>();
	private counter = 0;

	/** Bumps on every change anywhere in the model. */
	get version(): number {
		return this.counter;
	}
	get activeWorkspace(): ActiveExtensionWorkspace | null {
		return this.workspace;
	}
	entry(extensionId: string): ExtensionSurfaceEntry | undefined {
		return this.entries.get(extensionId);
	}
	ids(): string[] {
		return [...this.entries.keys()];
	}
	subscribe(listener: ExtensionSurfaceListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	apply(
		extensionId: string,
		output: Omit<ExtensionOutputV2, "text">,
		origin: OutputOrigin,
		workspaces: readonly ExtensionWorkspaceDeclaration[],
	): void {
		const operator = origin === "command" || origin === "action";
		const previous = this.entries.get(extensionId);
		const regions: Partial<Record<WorkspaceRegion, View>> = { ...previous?.regions };
		const next: Mutable<ExtensionSurfaceEntry> = { ...(previous ?? { version: 0, islands: [] }), regions };
		let changed = false;
		const events: Array<ExtensionSurfaceEvent | null> = [];
		const assign = <K extends "status" | "band" | "dock">(key: K, value: ExtensionSurfaceEntry[K] | null | undefined) => {
			if (value === undefined) return;
			changed = true;
			if (value === null) delete next[key];
			else next[key] = value;
		};
		assign("status", output.status);
		assign("band", output.band);
		if (output.dock !== undefined) {
			// A dock is a pane the operator opens; until then a dock view is only kept.
			assign("dock", output.dock);
			if (output.dock !== null && operator) events.push({ kind: "dock", extensionId, view: output.dock });
		}
		for (const region of REGIONS) {
			const value = output.regions?.[region];
			if (value === undefined) continue;
			changed = true;
			if (value === null) delete regions[region];
			else regions[region] = value;
		}
		if (output.islands !== undefined) {
			changed = true;
			next.islands = output.islands ?? [];
		}
		if (output.panel && (operator || previous?.panel)) {
			changed = true;
			next.panel = output.panel;
			if (operator) events.push({ kind: "panel", extensionId, panel: output.panel });
		}
		if (output.card) events.push({ kind: "card", extensionId, view: output.card });
		if (output.toast) events.push({ kind: "toast", extensionId, toast: output.toast });
		if (operator && output.interview) events.push({ kind: "interview", extensionId, interview: output.interview });
		if (operator && output.prompt) events.push({ kind: "prompt", extensionId, prompt: output.prompt });
		if (changed) {
			this.counter++;
			next.version = this.counter;
			this.entries.set(extensionId, next);
		}
		if (operator && output.workspace) {
			if ("enter" in output.workspace) {
				const id = output.workspace.enter;
				const declared = workspaces.find((workspace) => workspace.id === id);
				if (declared) this.setWorkspace({ extensionId, workspaceId: declared.id, title: declared.title }, events);
			} else if (this.workspace?.extensionId === extensionId) this.setWorkspace(null, events);
		}
		if (changed && events.length === 0) events.push(null);
		for (const event of events) this.emit(event);
	}

	/** The operator left the workspace, or an owner can no longer hold it. */
	leaveWorkspace(): ActiveExtensionWorkspace | null {
		const previous = this.workspace;
		if (!previous) return null;
		const events: Array<ExtensionSurfaceEvent | null> = [];
		this.setWorkspace(null, events);
		for (const event of events) this.emit(event);
		return previous;
	}

	closePanel(extensionId: string): void {
		const entry = this.entries.get(extensionId);
		if (!entry?.panel) return;
		const { panel: _closed, ...rest } = entry;
		this.counter++;
		this.entries.set(extensionId, { ...rest, version: this.counter });
		this.emit(null);
	}

	/**
	 * Drop every entry, as a reload or session change does before runtimes
	 * repaint. The workspace survives only when `keepWorkspace` says its owner
	 * can still hold it.
	 */
	reset(keepWorkspace: (active: ActiveExtensionWorkspace) => boolean): void {
		const events: Array<ExtensionSurfaceEvent | null> = [];
		const hadEntries = this.entries.size > 0;
		this.entries.clear();
		if (this.workspace && !keepWorkspace(this.workspace)) this.setWorkspace(null, events);
		if (hadEntries || events.length > 0) this.counter++;
		for (const event of events) this.emit(event);
		if (hadEntries && events.length === 0) this.emit(null);
	}

	private setWorkspace(active: ActiveExtensionWorkspace | null, events: Array<ExtensionSurfaceEvent | null>): void {
		const previous = this.workspace;
		if (previous?.extensionId === active?.extensionId && previous?.workspaceId === active?.workspaceId) return;
		this.workspace = active;
		this.counter++;
		events.push({ kind: "workspace", previous, active });
	}

	private emit(event: ExtensionSurfaceEvent | null): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				/* A renderer cannot change what extensions asked for. */
			}
		}
	}
}
