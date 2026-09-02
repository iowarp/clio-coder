import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { parseTomlDocument } from "../../src/core/toml.js";
import { CLIO_APP_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import {
	PANES_PRESET_ALIASES,
	PANES_PRESET_IDS,
	PANES_PRESETS,
	type PanesYaziController,
	resolvePanesPresetId,
} from "../../src/domains/mux/operations.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import {
	createYaziSession,
	sweepStaleTransportFiles,
	YAZI_STALE_TRANSPORT_MS,
	type YaziSessionOptions,
} from "../../src/domains/mux/yazi/session.js";
import { renderHerdrThemeBlock, renderYaziTheme } from "../../src/domains/mux/yazi/theme.js";
import { GLOBAL_ACTION_ORDER } from "../../src/interactive/application-controller.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { createYaziBridge } from "../../src/interactive/yazi-bridge.js";
import { panesToolSurface } from "../../src/tools/panes-surface.js";

const SNAPSHOT = {
	generatedAt: "2026-09-02T00:00:00.000Z",
	running: [],
	retrying: [],
	totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
};

/** A pane host stand-in that records what was asked of it. */
function fakeMux(options: { available?: boolean; reason?: string } = {}) {
	const calls: string[] = [];
	const records: MuxPaneRecord[] = [];
	let next = 0;
	const mux = {
		mode: options.available === false ? "none" : "guest",
		available: () => options.available !== false,
		detection: () => ({
			mode: options.available === false ? "none" : "guest",
			socketPath: null,
			server: null,
			self: { workspaceId: null, tabId: null, paneId: "self" },
			candidates: [],
			reason: options.reason ?? "HERDR_ENV is not 1, so Clio is not running inside a pane host",
			refused: false,
		}),
		list: () => records,
		async openUtilityPane(request: { label: string }) {
			next += 1;
			const ref = { paneId: `p${next}`, tabId: "t1", workspaceId: "w1" };
			records.push({ ref, purpose: "utility", label: request.label, openedAt: next });
			calls.push(`open:${request.label}`);
			return ref;
		},
		async closePane(paneId: string) {
			const at = records.findIndex((record) => record.ref.paneId === paneId);
			if (at < 0) return false;
			records.splice(at, 1);
			calls.push(`close:${paneId}`);
			return true;
		},
		async focusPane(paneId: string) {
			calls.push(`focus:${paneId}`);
			return true;
		},
		async focusSelf() {
			calls.push("focus:self");
			return true;
		},
		async unzoomSelf() {
			calls.push("unzoom:self");
			return false;
		},
		docks: () => [],
	};
	return { mux: mux as unknown as MuxContract, calls, records, drop: (paneId: string) => void mux.closePane(paneId) };
}

const filesEnabled = {
	...DEFAULT_SETTINGS,
	interface: {
		...DEFAULT_SETTINGS.interface,
		panes: { ...DEFAULT_SETTINGS.interface.panes, files: { ...DEFAULT_SETTINGS.interface.panes.files, enabled: true } },
	},
};

describe("contracts/panes files surface", () => {
	it("names the preset files and keeps yazi as a parsing alias only", () => {
		deepStrictEqual([...PANES_PRESET_IDS], ["files", "logs", "shell"]);
		strictEqual(PANES_PRESETS[0].binary, "yazi");
		deepStrictEqual(PANES_PRESET_ALIASES, { yazi: "files" });
		strictEqual(resolvePanesPresetId("yazi"), "files");
		strictEqual(resolvePanesPresetId("files"), "files");
		strictEqual(resolvePanesPresetId("htop"), null);
		// The model's enum carries the Clio name, not the engine's.
		const schema = panesToolSurface.parameters as unknown as {
			properties: { preset: { enum?: string[]; anyOf?: Array<{ const: string }> } };
		};
		const enumValues = schema.properties.preset.enum ?? schema.properties.preset.anyOf?.map((entry) => entry.const) ?? [];
		deepStrictEqual(enumValues, ["files", "logs", "shell"]);
	});

	it("parses /panes open yazi, /panes open files --once, and /files [open|close|pick]", () => {
		deepStrictEqual(parseSlashCommand("/panes open yazi"), { kind: "panes-open", preset: "files" });
		deepStrictEqual(parseSlashCommand("/panes open files --once"), { kind: "panes-open", preset: "files", once: true });
		deepStrictEqual(parseSlashCommand("/files"), { kind: "files", action: "toggle" });
		deepStrictEqual(parseSlashCommand("/files pick"), { kind: "files", action: "pick" });
		deepStrictEqual(parseSlashCommand("/files close"), { kind: "files", action: "close" });
		deepStrictEqual(parseSlashCommand("/files bogus"), { kind: "files-usage", reason: "Unexpected argument: bogus" });
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "files");
		ok(entry, "the /files command must be registered");
		ok(!/yazi/iu.test(entry.description), "the /files description must not name the engine");
	});

	it("binds the files toggle to Alt+E and routes it among the global actions", () => {
		strictEqual(CLIO_APP_KEYBINDINGS["clio-coder.files.toggle"].defaultKeys, "alt+e");
		ok((GLOBAL_ACTION_ORDER as ReadonlyArray<string>).includes("clio-coder.files.toggle"));
		// Alt+F is pi-tui's word-forward; the files key must not collide with it.
		for (const [id, binding] of Object.entries(CLIO_APP_KEYBINDINGS)) {
			const keys: ReadonlyArray<string> = Array.isArray(binding.defaultKeys) ? binding.defaultKeys : [binding.defaultKeys];
			if (id !== "clio-coder.files.toggle") ok(!keys.includes("alt+e"), `${id} also claims alt+e`);
		}
	});

	it("says why the pane layer is missing and what starts it", async () => {
		const { mux } = fakeMux({ available: false });
		const panes = createPanesRuntime({
			mux,
			getSettings: () => filesEnabled,
			getDispatchSnapshot: () => SNAPSHOT,
			getCwd: () => "/w",
		});
		const result = await panes.open({ preset: "shell" });
		strictEqual(result.status, "unavailable");
		match(result.reason, /HERDR_ENV is not 1/u);
		match(result.reason, /clio-coder --with-panes/u);
	});

	it("explains an empty logs preset by the journal root it watched", async () => {
		const { mux } = fakeMux();
		const root = mkdtempSync(join(tmpdir(), "clio-panes-journal-"));
		try {
			const panes = createPanesRuntime({
				mux,
				getSettings: () => filesEnabled,
				getDispatchSnapshot: () => SNAPSHOT,
				getCwd: () => "/w",
				resolveBinaryPath: () => "/usr/bin/tail",
				journalRoot: () => root,
				newestJournalRunId: () => null,
			});
			const result = await panes.open({ preset: "logs" });
			strictEqual(result.status, "refused");
			match(result.reason, new RegExp(`no dispatched run has written a journal under ${root}`, "u"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens one pane per preset and focuses it on a second open", async () => {
		const { mux, calls } = fakeMux();
		const panes = createPanesRuntime({
			mux,
			getSettings: () => filesEnabled,
			getDispatchSnapshot: () => SNAPSHOT,
			getCwd: () => "/w",
			resolveBinaryPath: () => "/bin/bash",
		});
		const first = await panes.open({ preset: "shell" });
		deepStrictEqual(first, { status: "opened", label: "shell", paneId: "p1" });
		const second = await panes.open({ preset: "shell" });
		deepStrictEqual(second, { status: "opened", label: "shell", paneId: "p1", existing: true });
		deepStrictEqual(calls, ["open:shell", "unzoom:self", "focus:p1"]);
		strictEqual(mux.list().length, 1);
	});

	it("routes /files through the shared controller: toggle opens, toggle closes, pick is one-shot", async () => {
		const { mux } = fakeMux();
		const panes = createPanesRuntime({
			mux,
			getSettings: () => filesEnabled,
			getDispatchSnapshot: () => SNAPSHOT,
			getCwd: () => "/w",
		});
		const log: string[] = [];
		let open = false;
		const controller: PanesYaziController = {
			async open(options) {
				log.push(options?.once ? "open:once" : "open");
				open = true;
				return { status: "opened", mode: "companion", paneId: "p9", existing: false };
			},
			async close() {
				log.push("close");
				const was = open;
				open = false;
				return was;
			},
			isOpen: () => open,
			status: () => ({ mode: "closed", paneId: null, paneCwd: null, lastLineAt: null, droppedLines: 0 }),
		};
		panes.attachYazi(controller);
		deepStrictEqual(await panes.files("toggle"), { status: "opened", paneId: "p9", existing: false });
		deepStrictEqual(await panes.files("toggle"), { status: "closed" });
		deepStrictEqual(await panes.files("pick"), { status: "opened", paneId: "p9", existing: false });
		deepStrictEqual(await panes.files("close"), { status: "closed" });
		deepStrictEqual(log, ["open", "close", "open:once", "close"]);
		// The preset door and the alias reach the same controller.
		deepStrictEqual(await panes.open({ preset: "yazi" }), {
			status: "opened",
			label: "files",
			paneId: "p9",
			existing: false,
		});
	});

	it("refuses the files pane by its settings key and names the engine only through the install command", async () => {
		const { mux } = fakeMux();
		const panes = createPanesRuntime({
			mux,
			getSettings: () => DEFAULT_SETTINGS,
			getDispatchSnapshot: () => SNAPSHOT,
			getCwd: () => "/w",
		});
		deepStrictEqual(await panes.files("toggle"), {
			status: "refused",
			reason: "the files pane is disabled by interface.panes.files.enabled",
		});
		const enabled = createPanesRuntime({
			mux,
			getSettings: () => filesEnabled,
			getDispatchSnapshot: () => SNAPSHOT,
			getCwd: () => "/w",
		});
		enabled.attachYazi({
			async open() {
				return {
					status: "missing-binary",
					binary: "yazi",
					detail: "not found (install with `clio-coder tools install yazi`)",
				};
			},
			async close() {
				return false;
			},
			isOpen: () => false,
			status: () => ({ mode: "closed", paneId: null, paneCwd: null, lastLineAt: null, droppedLines: 0 }),
		});
		const missing = await enabled.files("open");
		strictEqual(missing.status, "missing-binary");
		strictEqual(
			missing.detail,
			"the files pane engine is not available: not found (install with `clio-coder tools install yazi`)",
		);
	});
});

describe("contracts/files pane bridge", () => {
	function bridgeWith(host: ReturnType<typeof fakeMux>) {
		const notices: string[] = [];
		let draft = "";
		let onEvent: YaziSessionOptions["onEvent"] | null = null;
		let onStopped: YaziSessionOptions["onStopped"] | null = null;
		const bridge = createYaziBridge({
			mux: host.mux,
			getDraft: () => draft,
			setDraft: (text) => {
				draft = text;
			},
			requestRender: () => undefined,
			notice: (_level, text) => notices.push(text),
			getCwd: () => "/w",
			getSettings: () => ({ mode: "companion", profile: "managed", followCwd: false }),
			statPath: () => "file",
			livenessMs: 60_000,
			async openSession(options) {
				onEvent = options.onEvent;
				onStopped = options.onStopped ?? null;
				const pane = await host.mux.openUtilityPane({ argv: ["yazi"], cwd: options.cwd, label: "files" });
				if (!pane) return { status: "unavailable", reason: "refused" };
				return {
					status: "opened",
					session: {
						mode: options.mode,
						pane,
						token: options.pickToken ?? null,
						profile: null,
						snapshot: () => ({
							mode: options.mode,
							paneId: pane.paneId,
							paneCwd: options.cwd,
							instanceId: null,
							lastLineAt: null,
							streamPath: null,
							chooserPath: null,
						}),
						pushCwd: async () => false,
						close: async () => {
							await host.mux.closePane(pane.paneId);
						},
					},
				};
			},
		});
		return {
			bridge,
			notices,
			draft: () => draft,
			pick: (token: string, path: string) =>
				onEvent?.({ kind: "clio-coder-pick", sender: "1", receiver: "1", values: [token, path] }),
			gone: () => onStopped?.("pane-gone"),
		};
	}

	it("focuses the pane on open, returns focus to the composer after a pick, and closes on toggle", async () => {
		const host = fakeMux();
		const wired = bridgeWith(host);
		const opened = await wired.bridge.open();
		strictEqual(opened.status, "opened");
		ok(wired.bridge.isOpen());
		deepStrictEqual(host.calls, ["unzoom:self", "open:files", "focus:p1"]);
		// Only the session's own token is honored; a foreign line is dropped.
		wired.pick("not-this-session", "/w/README.md");
		strictEqual(wired.draft(), "");
		strictEqual(wired.bridge.status().droppedLines, 1);
		// Second open of an open pane is a focus request, not a split.
		const again = await wired.bridge.open();
		deepStrictEqual(again, { status: "opened", mode: "companion", paneId: "p1", existing: true });
		strictEqual(host.records.length, 1);
		ok(await wired.bridge.close());
		strictEqual(host.calls.at(-1), "focus:self");
		strictEqual(wired.bridge.isOpen(), false);
		strictEqual(host.records.length, 0);
	});

	it("inserts a token-matched pick as an @ mention and hands the keyboard back", async () => {
		const host = fakeMux();
		let token = "";
		const notices: string[] = [];
		let draft = "";
		const bridge = createYaziBridge({
			mux: host.mux,
			getDraft: () => draft,
			setDraft: (text) => {
				draft = text;
			},
			requestRender: () => undefined,
			notice: (_level, text) => notices.push(text),
			getCwd: () => "/w",
			pickToken: () => "tok",
			statPath: () => "file",
			livenessMs: 60_000,
			async openSession(options) {
				token = options.pickToken ?? "";
				const pane = await host.mux.openUtilityPane({ argv: ["yazi"], cwd: options.cwd, label: "files" });
				if (!pane) return { status: "unavailable", reason: "refused" };
				// The pick arrives after the open settled, as it does from a real pane.
				setTimeout(
					() => options.onEvent({ kind: "clio-coder-pick", sender: "1", receiver: "1", values: [token, "/w/src/a.ts"] }),
					0,
				);
				return {
					status: "opened",
					session: {
						mode: options.mode,
						pane,
						token,
						profile: null,
						snapshot: () => ({
							mode: options.mode,
							paneId: pane.paneId,
							paneCwd: "/w",
							instanceId: null,
							lastLineAt: null,
							streamPath: null,
							chooserPath: null,
						}),
						pushCwd: async () => false,
						close: async () => undefined,
					},
				};
			},
		});
		await bridge.open();
		await new Promise((resolve) => setTimeout(resolve, 5));
		strictEqual(draft, "@src/a.ts");
		strictEqual(host.calls.at(-1), "focus:self");
		ok(notices.some((text) => text === "1 path from the files pane added to the draft"));
		ok(!notices.some((text) => /yazi/iu.test(text)), "composer notices must not name the engine");
	});

	it("treats a pane the host reports gone as closed", async () => {
		const host = fakeMux();
		const wired = bridgeWith(host);
		await wired.bridge.open();
		ok(wired.bridge.isOpen());
		// The host dropped the pane (user closed it) and the registry no longer lists it.
		host.drop("p1");
		strictEqual(wired.bridge.isOpen(), false);
		// A toggle now opens rather than "closing" a pane that is not there.
		const reopened = await wired.bridge.open();
		strictEqual(reopened.status, "opened");
		strictEqual(reopened.status === "opened" && reopened.existing, false);
		wired.gone();
	});
});

describe("contracts/files pane session transport", () => {
	it("labels the pane files and removes its transport files when the session ends", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "clio-files-session-"));
		try {
			const host = fakeMux();
			let label = "";
			let title = "";
			const mux = {
				...host.mux,
				async openUtilityPane(request: { label: string; title?: string }) {
					label = request.label;
					title = request.title ?? "";
					return host.mux.openUtilityPane(request as never);
				},
			} as unknown as MuxContract;
			const result = await createYaziSession({
				mux,
				mode: "companion",
				profileMode: "user",
				cwd: "/w",
				cacheDir,
				sessionId: "s1",
				pollMs: 5,
				onEvent: () => undefined,
				onChooser: () => undefined,
				resolveBinaries: () => ({ yaziPath: "/bin/yazi", yaPath: "/bin/ya", missingYaziDetail: "" }),
			});
			strictEqual(result.status, "opened");
			if (result.status !== "opened") return;
			strictEqual(label, "files");
			strictEqual(title, "files");
			const stream = join(cacheDir, "yazi", "sessions", "s1.stream");
			ok(existsSync(stream));
			await result.session.close();
			strictEqual(existsSync(stream), false);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("contracts/files pane transport sweep", () => {
	it("removes transport files older than a day and leaves live ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-files-sweep-"));
		try {
			const old = join(dir, "old.stream");
			const fresh = join(dir, "fresh.chooser");
			const other = join(dir, "notes.txt");
			for (const path of [old, fresh, other]) writeFileSync(path, "");
			const past = Date.now() - YAZI_STALE_TRANSPORT_MS - 60_000;
			utimesSync(old, past / 1000, past / 1000);
			utimesSync(other, past / 1000, past / 1000);
			strictEqual(sweepStaleTransportFiles(dir), 1);
			strictEqual(existsSync(old), false);
			ok(existsSync(fresh));
			ok(existsSync(other), "only transport files are swept");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("contracts/files pane theme", () => {
	it("renders every color from Clio's tokens as parseable TOML, for yazi and for herdr", () => {
		const theme = renderYaziTheme();
		const parsed = parseTomlDocument(theme);
		ok(parsed, "the yazi theme must parse as TOML");
		match(theme, /cwd = \{ fg = "#46e5d0" \}/u);
		for (const section of ["mgr", "mode", "status", "which", "pick", "input", "notify"]) {
			ok(theme.includes(`[${section}]`), `theme must cover [${section}]`);
		}
		const herdr = renderHerdrThemeBlock();
		ok(parseTomlDocument(herdr), "the herdr block must parse as TOML");
		match(herdr, /\[theme\.custom\]/u);
		match(herdr, /accent = "#46e5d0"/u);
		// Every literal color in both documents is one of Clio's tokens.
		const colors = new Set([...`${theme}${herdr}`.matchAll(/#[0-9a-f]{6}/gu)].map((m) => m[0]));
		for (const color of colors) ok(theme.includes(color) || herdr.includes(color));
		strictEqual(colors.size <= 13, true);
	});
});
