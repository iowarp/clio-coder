import { basename } from "node:path";
import type { ClioDirs } from "../../core/xdg.js";
import { clioCacheDir, clioConfigDir, clioDataDir } from "../../core/xdg.js";
import type { ExtensionDockFrame } from "../../domains/extensions/dock-frame.js";
import {
	decodeDockTap,
	extensionDockPaths,
	readExtensionDockFrame,
	writeExtensionDockFrame,
} from "../../domains/extensions/dock-frame.js";
import type { View } from "../../domains/extensions/view.js";
import type { MuxContract } from "../../domains/mux/contract.js";
import type { TapFileWatcher } from "../../domains/mux/tap-file.js";
import { watchTapFile } from "../../domains/mux/tap-file.js";
import { extensionViewerCommand } from "../../domains/mux/viewer-command.js";
import { renderView } from "./view-renderer.js";

export interface ExtensionDockHost {
	available(): boolean;
	/** Only an operator command or action calls open; background updates never create a pane. */
	open(extensionId: string, title: string, view: View): Promise<boolean>;
	update(extensionId: string, view: View | null): void;
	refresh(): void;
	close(): Promise<void>;
	onPress(listener: (extensionId: string, press: { action: string; key?: string }) => void): () => void;
	dispose(): Promise<void>;
}

export function createExtensionDockHost(deps: {
	mux: MuxContract | null;
	stateDir: string;
	sessionId: () => string | null;
	dirs?: ClioDirs;
	log?: (message: string) => void;
}): ExtensionDockHost {
	const dirs = deps.dirs ?? {
		config: clioConfigDir(),
		data: clioDataDir(),
		state: deps.stateDir,
		cache: clioCacheDir(),
	};
	let disposed = false;
	let owner: { id: string; title: string; view: View | null } | null = null;
	let frame: ExtensionDockFrame | null = null;
	let paths = extensionDockPaths(deps.stateDir, deps.sessionId());
	let seq = 0;
	let width = 48;
	let sized = false;
	let taps: TapFileWatcher | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	let adoption: Promise<void> | null = null;
	const listeners = new Set<(id: string, press: { action: string; key?: string }) => void>();
	const log = (error: unknown): void =>
		deps.log?.(`extension dock: ${error instanceof Error ? error.message : String(error)}`);
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.catch(log);
		return run;
	};
	// Query the registry each time: parking a pane can change its id.
	const record = () => deps.mux?.list().find((entry) => entry.purpose === "extension") ?? null;
	const dockKey = (): string => basename(paths.frameFile, ".json");
	const available = (): boolean => !disposed && (deps.mux?.available() ?? false);
	const draw = (): boolean => {
		if (disposed || !owner) return false;
		try {
			const output = owner.view === null ? { lines: [], targets: [] } : renderView(owner.view, width, { maxRows: 400 });
			const next: ExtensionDockFrame = {
				version: 1,
				seq: seq + 1,
				extensionId: owner.id,
				title: owner.title,
				width,
				lines: output.lines,
				targets: output.targets,
			};
			writeExtensionDockFrame(paths.frameFile, next);
			seq = next.seq;
			frame = next;
			return true;
		} catch (error) {
			log(error);
			return false;
		}
	};
	const bind = (): void => {
		taps?.stop();
		taps = null;
		const previous = readExtensionDockFrame(paths.frameFile);
		seq = previous.ok ? previous.frame.seq : 0;
		try {
			taps = watchTapFile(
				paths.tapFile,
				(line) => {
					if (disposed) return;
					const tap = decodeDockTap(line);
					if (!tap) return;
					if (tap.kind === "size") {
						sized = true;
						if (width !== tap.width) {
							width = tap.width;
							draw();
						}
					} else if (tap.kind === "hide") {
						void serial(async () => {
							if (!disposed && record()) {
								const pane = record();
								if (deps.mux?.dockVisibility("extension") === "closed" && pane) await deps.mux.closePane(pane.ref.paneId);
								else await deps.mux?.hideDock("extension");
							}
						});
					} else if (
						owner &&
						frame &&
						frame.extensionId === owner.id &&
						tap.seq === frame.seq &&
						frame.targets.some((target) => target.action === tap.action && target.key === tap.key)
					) {
						for (const listener of listeners) {
							try {
								listener(owner.id, { action: tap.action, ...(tap.key === undefined ? {} : { key: tap.key }) });
							} catch (error) {
								log(error);
							}
						}
					}
				},
				512,
			);
		} catch (error) {
			log(error);
		}
	};
	const adopt = async (): Promise<void> => {
		if (disposed || !available() || record()) return;
		if (adoption) return adoption;
		adoption = Promise.resolve()
			.then(async () => {
				await deps.mux?.adoptPane({ purpose: "extension", label: "extension", dock: "extension" });
			})
			.catch(log)
			.finally(() => {
				adoption = null;
			});
		return adoption;
	};
	bind();
	// Reclaim inventory only; never open, show or focus during startup.
	void adopt();
	return {
		available,
		open(extensionId, title, view): Promise<boolean> {
			return serial(async () => {
				if (!available() || !deps.mux) return false;
				const nextPaths = extensionDockPaths(deps.stateDir, deps.sessionId());
				if (nextPaths.frameFile !== paths.frameFile) {
					// A surviving viewer follows the old file. Close our old pane before switching sessions.
					const pane = record();
					if (pane && !(await deps.mux.closePane(pane.ref.paneId))) return false;
					paths = nextPaths;
					frame = null;
					width = 48;
					sized = false;
					bind();
				}
				await adopt();
				// A new session cannot reuse a process watching another session's file.
				// Matching survivors keep their process; legacy or foreign-file survivors are replaced only here.
				const survivor = record();
				if (survivor?.adopted && survivor.dockKey !== dockKey()) {
					if (!(await deps.mux.closePane(survivor.ref.paneId))) return false;
				}
				owner = { id: extensionId, title, view };
				if (!draw()) return false;
				let pane = record();
				if (pane && deps.mux.dockVisibility("extension") === "hidden") {
					if (!(await deps.mux.showDock("extension"))) return false;
				} else if (!pane) {
					const opened = await deps.mux.openUtilityPane({
						argv: extensionViewerCommand(paths.frameFile, {
							dirs,
							tapPath: paths.tapFile,
						}),
						cwd: process.cwd(),
						label: "extension",
						title: "clio-coder extension",
						purpose: "extension",
						dockKey: dockKey(),
						direction: "down",
						dock: { slot: "extension" },
					});
					if (!opened) return false;
				}
				pane = record();
				if (!sized && pane) {
					const geometryWidth = await deps.mux.paneWidth(pane.ref.paneId);
					// A size tap may have arrived while the socket request was pending.
					if (!sized && geometryWidth !== null && geometryWidth > 0) {
						width = Math.min(4096, Math.floor(geometryWidth));
						draw();
					}
				}
				return true;
			}).catch((error) => {
				log(error);
				return false;
			});
		},
		update(extensionId, view): void {
			if (disposed || owner?.id !== extensionId) return;
			owner.view = view;
			draw();
		},
		refresh(): void {
			draw();
		},
		close(): Promise<void> {
			return serial(async () => {
				const pane = record();
				if (pane && deps.mux && !(await deps.mux.closePane(pane.ref.paneId))) return;
				owner = null;
				frame = null;
				sized = false;
				width = 48;
			});
		},
		onPress(listener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async dispose(): Promise<void> {
			disposed = true;
			taps?.stop();
			taps = null;
			listeners.clear();
			await queue;
			await adoption;
			// Leave the pane for mux parking and restart adoption, as watch-pane does.
		},
	};
}
