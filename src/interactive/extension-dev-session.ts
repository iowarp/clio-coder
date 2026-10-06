import { existsSync, type FSWatcher, readdirSync, watch } from "node:fs";
import path from "node:path";
import type { ExtensionsContract } from "../domains/extensions/contract.js";
import { DEV_EXTENSIONS_DIR, type DevConsentRequest, ExtensionDevScope } from "../domains/extensions/dev-scope.js";
import type { ExtensionCapabilityEnvelope } from "../domains/extensions/manifest-v2.js";
import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { AskUserHandler } from "../tools/ask-user.js";

/** A save settles for this long before the dev folder is copied again. */
const DEV_SAVE_DEBOUNCE_MS = 250;
/** How often a pending reload looks for the idle boundary. */
const DEV_IDLE_RETRY_MS = 500;
/** Directories watched per session; a dev package is a handful. */
const DEV_WATCH_DIRECTORY_CAP = 256;
const DEV_WATCH_SKIP = new Set(["node_modules", ".git"]);
const APPROVE = "Load it for this session";
const DECLINE = "Not now";

export type ExtensionDevAction = "dev" | "mute" | "unmute";

export interface ExtensionDevSessionDeps {
	extensions: Pick<ExtensionsContract, "setSessionOverlay">;
	operator: Pick<OperatorExtensions, "reload" | "busy">;
	cwd: () => string;
	/** No turn, overlay, or operator command in flight. */
	isIdle: () => boolean;
	/** A Clio-drawn question for the operator; the model never sees or answers it. */
	ask: AskUserHandler;
	notify: (level: "info" | "warning" | "error", text: string) => void;
}

export interface ExtensionDevSession {
	/** Discover and copy dev folders and publish the overlay. Call before the first runtime reload. */
	start(): void;
	/** An idle boundary may have arrived: a turn ended or an overlay closed. */
	poke(): void;
	command(action: ExtensionDevAction, argument: string | undefined): void;
	/** Whether the operator muted this extension for the session. */
	isMuted(extensionId: string): boolean;
	dispose(): void;
}

function envelopeLines(envelope: ExtensionCapabilityEnvelope): string[] {
	const list = (items: readonly string[]): string => (items.length > 0 ? items.join(", ") : "none");
	const hooks = envelope.hooks.map((hook) => {
		const tools = hook.tools ? ` on ${hook.tools.join(", ")}` : "";
		const gate = hook.onTimeout === "block" || hook.onError === "block" ? ", can refuse" : "";
		return `${hook.on}${tools} (${hook.timeoutMs} ms${gate})`;
	});
	const lines = [
		`Commands: ${list(envelope.commands)}`,
		`Events: ${list([...envelope.events, ...(envelope.tickMs !== undefined ? [`tick ${envelope.tickMs / 1000}s`] : [])])}`,
		`Hooks: ${list(hooks)}`,
		`Tools: ${list(envelope.tools.map((tool) => `${tool.name} (${tool.actionClass})`))}`,
		`Interface: ${list(envelope.ui)}`,
	];
	if (envelope.workspaces.length > 0)
		lines.push(
			`Workspaces: ${envelope.workspaces.map((workspace) => `${workspace.id} (${workspace.regions.join(", ")})`).join("; ")}`,
		);
	if (envelope.watch.length > 0) lines.push(`Watches: ${envelope.watch.join(", ")}`);
	lines.push(
		`Content it may read: ${list(envelope.access)}`,
		`Files: read ${list(envelope.permissions.fs.read)}; write ${list(envelope.permissions.fs.write)}`,
		`Programs: ${envelope.permissions.exec ? "may run programs" : "none"}; network: ${envelope.permissions.net ? "may use the network" : "none"}`,
	);
	return lines;
}

function consentQuestion(request: DevConsentRequest): string {
	const intro =
		request.growth === null
			? `Dev extension ${request.id} wants to run its code in this session.`
			: `Dev extension ${request.id} changed and now reaches further than you approved:\n${request.growth.map((line) => `  ${line}`).join("\n")}`;
	return [
		intro,
		`Folder: ${request.source}`,
		...envelopeLines(request.envelope).map((line) => `  ${line}`),
		"Approval lasts for this session. A later save that stays within it reloads without asking.",
		"Node's permission flags are a seat belt against mistakes, not a boundary against hostile code.",
	].join("\n");
}

/**
 * The terminal's dev scope: folders it watches, the private copies it loads,
 * and the operator's consent for each. A save is debounced and reloads at the
 * next idle boundary, so a save made during a turn takes effect when the turn
 * ends; a failed copy or an invalid manifest keeps the previous generation.
 */
export function createExtensionDevSession(deps: ExtensionDevSessionDeps): ExtensionDevSession {
	const scope = new ExtensionDevScope(deps.cwd);
	const watchers = new Map<string, FSWatcher>();
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let running = false;
	let disposed = false;

	const changed = (): void => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			ensureWatchers();
			dirty = true;
			poke();
		}, DEV_SAVE_DEBOUNCE_MS);
		debounce.unref();
	};

	/**
	 * One non-recursive watch per directory. Node's recursive watch on Linux
	 * stops reporting a file once a save replaces it by rename, which is how
	 * editors and Clio's own writes save; a directory watch sees the rename.
	 * Each change rescans, so a new subdirectory is watched from then on. Until
	 * the dev directory exists, its nearest existing ancestor is watched alone,
	 * so creating it later is noticed without watching the whole workspace.
	 */
	const ensureWatchers = (): void => {
		const cwd = deps.cwd();
		const base = path.join(cwd, DEV_EXTENSIONS_DIR);
		const pending = [
			...(existsSync(base) ? [base] : []),
			...scope.sources().filter((source) => path.relative(base, source).startsWith("..")),
		];
		const wanted = new Set<string>();
		if (!existsSync(base)) {
			let anchor = path.dirname(base);
			while (!existsSync(anchor) && anchor !== cwd && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
			if (existsSync(anchor)) wanted.add(anchor);
		}
		while (pending.length > 0 && wanted.size < DEV_WATCH_DIRECTORY_CAP) {
			const directory = pending.shift() as string;
			if (wanted.has(directory)) continue;
			wanted.add(directory);
			try {
				for (const entry of readdirSync(directory, { withFileTypes: true }))
					if (entry.isDirectory() && !DEV_WATCH_SKIP.has(entry.name)) pending.push(path.join(directory, entry.name));
			} catch {
				// Removed while scanning; its watcher, if any, is closed below.
			}
		}
		for (const [directory, watcher] of watchers) {
			if (wanted.has(directory)) continue;
			watcher.close();
			watchers.delete(directory);
		}
		for (const directory of wanted) {
			if (watchers.has(directory)) continue;
			try {
				const watcher = watch(directory, () => {
					changed();
				});
				watcher.on("error", () => {
					// A removed directory ends its watcher; the next rescan drops it.
					watcher.close();
					watchers.delete(directory);
					changed();
				});
				watchers.set(directory, watcher);
			} catch {
				// An unwatchable folder still reloads on /extensions dev and /extensions reload.
			}
		}
	};

	const askConsent = async (): Promise<boolean> => {
		let approved = false;
		for (const request of scope.pendingConsent()) {
			if (disposed) return approved;
			const result = await deps.ask([
				{
					header: "Dev extension",
					question: consentQuestion(request),
					options: [
						{ label: APPROVE, description: "Run its code now and reload it on each save that stays within this envelope." },
						{ label: DECLINE, description: "Keep it unloaded; /extensions dev asks again." },
					],
					defaultOption: 1,
				},
			]);
			if (
				result.cancelled !== true &&
				result.answers[0]?.options?.[0] === APPROVE &&
				scope.approve(request.id, request.digest)
			) {
				approved = true;
				continue;
			}
			scope.decline(request.id, request.digest);
			deps.notify("info", `Dev extension ${request.id} stays unloaded. /extensions dev asks again.`);
		}
		return approved;
	};

	const poke = (): void => {
		if (disposed || !dirty || running) return;
		if (!deps.isIdle() || deps.operator.busy) {
			clearTimeout(retry);
			retry = setTimeout(poke, DEV_IDLE_RETRY_MS);
			retry.unref();
			return;
		}
		dirty = false;
		running = true;
		void (async () => {
			try {
				scope.discover();
				ensureWatchers();
				const refreshed = scope.refresh();
				for (const failure of refreshed.failed)
					deps.notify(
						"warning",
						`Dev extension ${failure.id}: the last save was not loaded (${failure.message}); the previous version keeps running.`,
					);
				const approved = await askConsent();
				if (!disposed && (refreshed.changed.length > 0 || approved)) await deps.operator.reload("reload");
			} catch (error) {
				deps.notify("error", `Dev extensions: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				running = false;
				if (dirty) poke();
			}
		})();
	};

	const reloadNow = (): void => {
		dirty = true;
		poke();
	};

	return {
		start() {
			scope.discover();
			scope.refresh();
			deps.extensions.setSessionOverlay(scope);
			ensureWatchers();
			// Consent is asked at the first idle boundary after the startup reload,
			// never while it stages: an open question makes the session busy.
			if (scope.pendingConsent().length > 0) {
				dirty = true;
				retry = setTimeout(poke, DEV_IDLE_RETRY_MS);
				retry.unref();
			}
		},
		poke,
		isMuted: (extensionId) => scope.isMuted(extensionId),
		command(action, argument) {
			const id = argument?.trim();
			if (action === "dev") {
				if (id) {
					const problem = scope.add(id);
					if (problem) {
						deps.notify("error", `Dev extensions: ${problem}`);
						return;
					}
					deps.notify("info", `Dev folder added for this session: ${path.resolve(deps.cwd(), id)}`);
				} else {
					scope.reconsider();
					const rows = scope.status();
					deps.notify(
						"info",
						rows.length === 0
							? `No dev extensions. Put a package under ${DEV_EXTENSIONS_DIR}/<id>/ or run /extensions dev <folder>.`
							: rows
									.map(
										(row) =>
											`${row.id}: ${row.state}${row.muted ? ", muted" : ""} (${row.source})${row.failure ? `; last save not loaded: ${row.failure}` : row.diagnostics.length > 0 ? `; ${row.diagnostics[0]}` : ""}`,
									)
									.join("\n"),
					);
				}
				reloadNow();
				return;
			}
			if (!id) {
				deps.notify("error", `Usage: /extensions ${action} <id>`);
				return;
			}
			if (action === "mute") {
				scope.mute(id);
				deps.notify(
					"info",
					`${id} is muted for this session; install state is unchanged. /extensions unmute ${id} restores it.`,
				);
			} else if (!scope.unmute(id)) {
				deps.notify("info", `${id} is not muted.`);
				return;
			} else deps.notify("info", `${id} is unmuted.`);
			void deps.operator.reload("reload");
		},
		dispose() {
			disposed = true;
			clearTimeout(debounce);
			clearTimeout(retry);
			for (const watcher of watchers.values()) watcher.close();
			watchers.clear();
			deps.extensions.setSessionOverlay(null);
			scope.dispose();
		},
	};
}
