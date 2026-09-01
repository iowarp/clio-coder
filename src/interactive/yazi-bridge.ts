import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clioCacheDir } from "../core/xdg.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { YaziEvent } from "../domains/mux/yazi/event-stream.js";
import { ensureYaziProfile, yaziProfileDir } from "../domains/mux/yazi/profile.js";
import {
	createYaziSession,
	resolveYaziBinaries,
	type YaziProfileMode,
	type YaziResolvedBinaries,
	type YaziSession,
	type YaziSessionMode,
	type YaziSessionOpenResult,
	type YaziSessionOptions,
} from "../domains/mux/yazi/session.js";

export const YAZI_PICK_MAX_PATHS = 32;
export const YAZI_PICK_MAX_CHARS = 4096;
export const YAZI_LIVENESS_MS = 5000;

export interface YaziBridgeSettings {
	mode: YaziSessionMode;
	profile: YaziProfileMode;
	followCwd: boolean;
	/** Files-dock share of the height; absent leaves the dock spec's default. */
	ratio?: number;
}

export interface YaziMentionBatch {
	text: string;
	inserted: number;
	mentions: number;
	plainPaths: number;
	duplicates: number;
	truncated: number;
}

export interface YaziBridgeStatus {
	mode: YaziSessionMode | "closed";
	paneId: string | null;
	paneCwd: string | null;
	lastLineAt: number | null;
	droppedLines: number;
}

export type YaziBridgeOpenResult =
	| { status: "opened"; mode: YaziSessionMode; paneId: string | null; existing: boolean }
	| Exclude<YaziSessionOpenResult, { status: "opened" }>;

export interface YaziBridge {
	open(options?: { once?: boolean }): Promise<YaziBridgeOpenResult>;
	status(): Readonly<YaziBridgeStatus>;
	dispose(): void;
}

export interface YaziBridgeDeps {
	mux?: MuxContract;
	getDraft: () => string;
	setDraft: (text: string) => void;
	requestRender: () => void;
	notice: (level: "info" | "warning", text: string) => void;
	getCwd: () => string;
	getSettings?: () => Readonly<YaziBridgeSettings>;
	openSession?: (options: YaziSessionOptions) => Promise<YaziSessionOpenResult>;
	/** TUI lease used only by the no-mux, in-terminal chooser. */
	stopUi?: () => void;
	startUi?: () => void;
	runTerminalChooser?: (options: { cwd: string; profileMode: YaziProfileMode }) => Promise<YaziTerminalChooserResult>;
	statPath?: (path: string) => "file" | "directory" | "other";
	livenessMs?: number;
	pickToken?: () => string;
}

export type YaziTerminalChooserResult =
	| { status: "chosen"; choice: { paths: ReadonlyArray<string>; cwd: string } }
	| { status: "cancelled" }
	| { status: "missing-binary"; binary: "yazi" | "ya"; detail: string }
	| { status: "profile-error"; reason: string }
	| { status: "unavailable"; reason: string };

export interface YaziTerminalChooserOptions {
	cwd: string;
	profileMode: YaziProfileMode;
	stopUi: () => void;
	startUi: () => void;
	requestRender: () => void;
	cacheDir?: string;
	sessionId?: string;
	resolveBinaries?: () => YaziResolvedBinaries;
	ensureProfile?: typeof ensureYaziProfile;
	spawnYazi?: (
		file: string,
		args: ReadonlyArray<string>,
		options: { cwd: string; env: Readonly<NodeJS.ProcessEnv> },
	) => { error?: Error };
}

function readOptional(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Run Yazi as a full-screen chooser when no pane host is usable.
 *
 * Resolution, profile generation, and chooser-file truncation all happen
 * before the TUI lease is released. A missing or below-floor binary therefore
 * leaves the screen intact and returns the shared doctor sentence verbatim.
 */
async function runYaziTerminalChooser(options: YaziTerminalChooserOptions): Promise<YaziTerminalChooserResult> {
	const binaries = (options.resolveBinaries ?? resolveYaziBinaries)();
	if (!binaries.yaziPath) {
		return { status: "missing-binary", binary: "yazi", detail: binaries.missingYaziDetail };
	}
	if (options.profileMode === "managed" && !binaries.yaPath) {
		return {
			status: "missing-binary",
			binary: "ya",
			detail: "the Yazi helper `ya` is not available; install the complete pinned Yazi tool",
		};
	}

	const cacheDir = options.cacheDir ?? clioCacheDir();
	const sessionsDir = join(cacheDir, "yazi", "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const sessionId = options.sessionId ?? randomUUID();
	const chooserPath = join(sessionsDir, `${sessionId}.chooser`);
	const cwdPath = join(sessionsDir, `${sessionId}.cwd`);
	const profile =
		options.profileMode === "managed"
			? (options.ensureProfile ?? ensureYaziProfile)({
					yaPath: binaries.yaPath as string,
					yaziPath: binaries.yaziPath,
					profileDir: yaziProfileDir(cacheDir),
				})
			: null;
	if (options.profileMode === "managed" && !profile) {
		return { status: "profile-error", reason: "Clio could not generate a valid managed Yazi profile" };
	}
	writeFileSync(chooserPath, "");
	writeFileSync(cwdPath, "");

	const args = [options.cwd, "--chooser-file", chooserPath, "--cwd-file", cwdPath] as const;
	const env = { ...process.env, ...(profile ? { YAZI_CONFIG_HOME: profile.dir } : {}) };
	let processError: Error | undefined;
	options.stopUi();
	try {
		const result = options.spawnYazi
			? options.spawnYazi(binaries.yaziPath, args, { cwd: options.cwd, env })
			: spawnSync(binaries.yaziPath, args, { cwd: options.cwd, env, stdio: "inherit" });
		processError = result.error;
	} catch (error) {
		processError = error instanceof Error ? error : new Error(String(error));
	} finally {
		options.startUi();
		options.requestRender();
	}
	if (processError) return { status: "unavailable", reason: `yazi chooser failed: ${processError.message}` };

	const paths = readOptional(chooserPath)
		.split("\n")
		.filter((path) => path.length > 0);
	if (paths.length === 0) return { status: "cancelled" };
	return {
		status: "chosen",
		choice: { paths, cwd: readOptional(cwdPath).trim() || options.cwd },
	};
}

function containsAsciiWhitespace(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code === 32 || (code >= 9 && code <= 13)) return true;
	}
	return false;
}

function relativeWhenInside(path: string, cwd: string): string {
	const candidate = relative(cwd, path);
	if (
		candidate.length > 0 &&
		candidate !== ".." &&
		!candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(candidate)
	) {
		return candidate;
	}
	return path;
}

function draftContains(draft: string, item: string): boolean {
	let from = 0;
	while (from <= draft.length) {
		const at = draft.indexOf(item, from);
		if (at < 0) return false;
		const before = at === 0 ? "" : (draft[at - 1] ?? "");
		const after = draft[at + item.length] ?? "";
		if ((before === "" || /\s/u.test(before)) && (after === "" || /\s/u.test(after))) return true;
		from = at + item.length;
	}
	return false;
}

function pathKind(path: string): "file" | "directory" | "other" {
	try {
		const stat = statSync(path);
		if (stat.isFile()) return "file";
		if (stat.isDirectory()) return "directory";
		return "other";
	} catch {
		return "other";
	}
}

/** Format one DDS or chooser batch for the composer without ever submitting it. */
function formatYaziMentions(
	paths: ReadonlyArray<string>,
	options: {
		cwd: string;
		draft: string;
		statPath?: (path: string) => "file" | "directory" | "other";
		maxPaths?: number;
		maxChars?: number;
	},
): YaziMentionBatch {
	const maxPaths = options.maxPaths ?? YAZI_PICK_MAX_PATHS;
	const maxChars = options.maxChars ?? YAZI_PICK_MAX_CHARS;
	const inspect = options.statPath ?? pathKind;
	const rendered: string[] = [];
	const seen = new Set<string>();
	let mentions = 0;
	let plainPaths = 0;
	let duplicates = 0;
	let truncated = Math.max(0, paths.length - maxPaths);

	const candidates = paths.slice(0, maxPaths);
	for (const [index, rawPath] of candidates.entries()) {
		const absolute = isAbsolute(rawPath) ? rawPath : resolve(options.cwd, rawPath);
		if (seen.has(absolute)) {
			duplicates += 1;
			continue;
		}
		seen.add(absolute);
		const kind = inspect(absolute);
		let display = relativeWhenInside(absolute, options.cwd);
		if (kind === "directory" && display !== "/" && !display.endsWith("/")) display = `${display}/`;
		const mention = kind === "file" && !containsAsciiWhitespace(display);
		const item = mention ? `@${display}` : `\`${display.replaceAll("`", "\\`")}\``;
		if (draftContains(options.draft, item)) {
			duplicates += 1;
			continue;
		}
		const nextLength = rendered.length === 0 ? item.length : rendered.join(" ").length + 1 + item.length;
		if (nextLength > maxChars) {
			truncated += candidates.length - index;
			break;
		}
		rendered.push(item);
		if (mention) mentions += 1;
		else plainPaths += 1;
	}

	return {
		text: rendered.join(" "),
		inserted: rendered.length,
		mentions,
		plainPaths,
		duplicates,
		truncated,
	};
}

function appendDraft(draft: string, addition: string): string {
	if (addition.length === 0) return draft;
	if (draft.length === 0) return addition;
	return `${draft.replace(/\s+$/u, "")} ${addition}`;
}

/** Own the only path from a Yazi decision into the interactive composer. */
export function createYaziBridge(deps: YaziBridgeDeps): YaziBridge {
	const openSession = deps.openSession ?? createYaziSession;
	let active: YaziSession | null = null;
	let paneCwd: string | null = null;
	let droppedLines = 0;
	let disposed = false;
	let generation = 0;
	let livenessTimer: NodeJS.Timeout | null = null;
	let sawLine = false;

	const clearLiveness = (): void => {
		if (livenessTimer) clearTimeout(livenessTimer);
		livenessTimer = null;
	};

	const insert = (paths: ReadonlyArray<string>, cwd: string): void => {
		const draft = deps.getDraft();
		const batch = formatYaziMentions(paths, { cwd, draft, ...(deps.statPath ? { statPath: deps.statPath } : {}) });
		if (batch.inserted === 0) {
			if (batch.truncated > 0) {
				deps.notice(
					"warning",
					`${batch.truncated} file-pane path${batch.truncated === 1 ? " was" : "s were"} omitted by the pick limits`,
				);
			}
			return;
		}
		deps.setDraft(appendDraft(draft, batch.text));
		deps.requestRender();
		deps.notice(
			"info",
			`${batch.inserted} ${batch.inserted === 1 ? "path" : "paths"} from the file pane added to the draft`,
		);
		if (batch.plainPaths > 0) {
			deps.notice(
				"info",
				`${batch.plainPaths} ${batch.plainPaths === 1 ? "path was" : "paths were"} inserted as plain text because directories and spaced paths cannot be file mentions`,
			);
		}
		if (batch.truncated > 0) {
			deps.notice(
				"warning",
				`${batch.truncated} file-pane path${batch.truncated === 1 ? " was" : "s were"} omitted by the pick limits`,
			);
		}
	};

	const start = async (
		mode: YaziSessionMode,
		profileMode: YaziProfileMode,
		dockShare?: number,
	): Promise<YaziBridgeOpenResult> => {
		const mux = deps.mux;
		if (!mux?.available()) return { status: "unavailable", reason: "the pane layer is not available" };
		generation += 1;
		const ownGeneration = generation;
		const token = (deps.pickToken ?? randomUUID)();
		sawLine = false;
		paneCwd = deps.getCwd();
		const result = await openSession({
			mux,
			mode,
			profileMode,
			cwd: deps.getCwd(),
			...(dockShare === undefined ? {} : { dockShare }),
			pickToken: token,
			onEvent: (event: YaziEvent) => {
				if (disposed || ownGeneration !== generation) return;
				sawLine = true;
				if (event.kind === "cd") {
					paneCwd = event.cwd;
					return;
				}
				if (event.values[0] !== token) {
					droppedLines += 1;
					return;
				}
				insert(event.values.slice(1), paneCwd ?? deps.getCwd());
			},
			onChooser: (choice) => {
				if (disposed || ownGeneration !== generation) return;
				paneCwd = choice.cwd;
				if (choice.paths.length > 0) insert(choice.paths, choice.cwd);
			},
			onStopped: () => {
				if (ownGeneration !== generation) return;
				clearLiveness();
				active = null;
			},
		});
		if (result.status !== "opened") return result;
		if (disposed || ownGeneration !== generation) {
			await result.session.close();
			return { status: "unavailable", reason: "the file pane was closed while it was opening" };
		}
		active = result.session;
		if (mode === "companion") {
			livenessTimer = setTimeout(() => {
				if (disposed || ownGeneration !== generation || sawLine || active === null) return;
				const stale = active;
				active = null;
				deps.notice("warning", "the file-pane event stream did not start; reopening yazi in chooser mode");
				void stale.close().finally(() => {
					if (!disposed && ownGeneration === generation) void start("chooser", profileMode, dockShare);
				});
			}, deps.livenessMs ?? YAZI_LIVENESS_MS);
			livenessTimer.unref();
		}
		return { status: "opened", mode, paneId: result.session.pane.paneId, existing: false };
	};

	return {
		async open(options = {}): Promise<YaziBridgeOpenResult> {
			if (disposed) return { status: "unavailable", reason: "the file-pane bridge is closed" };
			const settings = deps.getSettings?.() ?? { mode: "companion", profile: "managed", followCwd: true };
			if (active) {
				if (settings.followCwd) {
					const cwd = deps.getCwd();
					if (await active.pushCwd(cwd)) paneCwd = cwd;
				}
				return { status: "opened", mode: active.mode, paneId: active.pane.paneId, existing: true };
			}
			const mode = options.once || settings.profile === "user" ? "chooser" : settings.mode;
			if (!deps.mux?.available()) {
				const result = await (
					deps.runTerminalChooser ??
					((choiceOptions) =>
						runYaziTerminalChooser({
							...choiceOptions,
							stopUi: deps.stopUi ?? (() => {}),
							startUi: deps.startUi ?? (() => {}),
							requestRender: deps.requestRender,
						}))
				)({ cwd: deps.getCwd(), profileMode: settings.profile });
				if (result.status === "chosen") {
					paneCwd = result.choice.cwd;
					insert(result.choice.paths, result.choice.cwd);
				}
				if (result.status === "chosen" || result.status === "cancelled") {
					return { status: "opened", mode: "chooser", paneId: null, existing: false };
				}
				return result;
			}
			return await start(mode, settings.profile, settings.ratio);
		},
		status(): Readonly<YaziBridgeStatus> {
			const snapshot = active?.snapshot();
			return {
				mode: active?.mode ?? "closed",
				paneId: active?.pane.paneId ?? null,
				paneCwd: paneCwd ?? snapshot?.paneCwd ?? null,
				lastLineAt: snapshot?.lastLineAt ?? null,
				droppedLines,
			};
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			generation += 1;
			clearLiveness();
			const closing = active;
			active = null;
			if (closing) void closing.close();
		},
	};
}
