/**
 * The Yazi bridge is the only return path into the composer. Contract fakes
 * drive DDS and chooser callbacks directly, while the session tests pin the
 * argv, environment, stdout redirect, cwd push, and chooser-file behavior.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type {
	MuxAdoptableRun,
	MuxContract,
	MuxOpenUtilityPaneRequest,
	MuxPaneRecord,
	MuxPaneRef,
} from "../../src/domains/mux/index.js";
import type { YaziEvent } from "../../src/domains/mux/yazi/event-stream.js";
import {
	createYaziSession,
	type YaziChooserResult,
	type YaziSession,
	type YaziSessionOpenResult,
	type YaziSessionOptions,
} from "../../src/domains/mux/yazi/session.js";
import {
	createYaziBridge,
	formatYaziMentions,
	runYaziTerminalChooser,
	type YaziBridge,
	type YaziBridgeSettings,
} from "../../src/interactive/yazi-bridge.js";

interface FakeMux {
	contract: MuxContract;
	opened: MuxOpenUtilityPaneRequest[];
	records: MuxPaneRecord[];
}

function fakeMux(): FakeMux {
	const opened: MuxOpenUtilityPaneRequest[] = [];
	const records: MuxPaneRecord[] = [];
	let next = 0;
	const contract: MuxContract = {
		mode: "guest",
		available: () => true,
		detection: () => ({
			mode: "guest",
			socketPath: "/tmp/herdr.sock",
			server: { version: "0.8.2", protocol: 17 },
			self: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p0" },
			candidates: ["/tmp/herdr.sock"],
			reason: "fake",
		}),
		async openRunPane(): Promise<MuxPaneRef | null> {
			return null;
		},
		async focusRunPane(): Promise<boolean> {
			return false;
		},
		async closeRunPane(): Promise<void> {},
		async openUtilityPane(request): Promise<MuxPaneRef | null> {
			opened.push(request);
			next += 1;
			const ref = { paneId: `w1:p${next}`, tabId: "w1:t1", workspaceId: "w1" };
			records.push({
				ref,
				purpose: "utility",
				label: request.label,
				openedAt: 0,
				runId: null,
				agentId: null,
				outcome: null,
			});
			return ref;
		},
		async closePane(paneId): Promise<boolean> {
			const index = records.findIndex((record) => record.ref.paneId === paneId);
			if (index < 0) return false;
			records.splice(index, 1);
			return true;
		},
		async reportRunState(): Promise<void> {},
		async notify(): Promise<void> {},
		async worktreeCreate(): Promise<null> {
			return null;
		},
		async worktreeRemove(): Promise<boolean> {
			return false;
		},
		async adoptRunPanes(_runs: ReadonlyArray<MuxAdoptableRun>): Promise<ReadonlyArray<string>> {
			return [];
		},
		onPaneGone: () => () => {},
		list: () => [...records],
		async reportSelf(): Promise<boolean> {
			return false;
		},
		async shutdown(): Promise<void> {},
	};
	return { contract, opened, records };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface ScriptedSessions {
	open(options: YaziSessionOptions): Promise<YaziSessionOpenResult>;
	options: YaziSessionOptions[];
	sessions: YaziSession[];
}

function scriptedSessions(): ScriptedSessions {
	const optionsSeen: YaziSessionOptions[] = [];
	const sessions: YaziSession[] = [];
	return {
		options: optionsSeen,
		sessions,
		async open(options): Promise<YaziSessionOpenResult> {
			optionsSeen.push(options);
			const pane = { paneId: `w1:p${optionsSeen.length}`, tabId: "w1:t1", workspaceId: "w1" };
			let cwd = options.cwd;
			const session: YaziSession = {
				mode: options.mode,
				pane,
				token: options.pickToken ?? null,
				profile: null,
				snapshot: () => ({
					mode: options.mode,
					paneId: pane.paneId,
					paneCwd: cwd,
					instanceId: "42",
					lastLineAt: null,
					streamPath: options.mode === "companion" ? "/tmp/fake.stream" : null,
					chooserPath: options.mode === "chooser" ? "/tmp/fake.chooser" : null,
				}),
				async pushCwd(next): Promise<boolean> {
					cwd = next;
					return true;
				},
				async close(): Promise<void> {
					options.onStopped?.("stopped");
				},
			};
			sessions.push(session);
			return { status: "opened", session };
		},
	};
}

function bridgeHarness(settings: YaziBridgeSettings = { mode: "companion", profile: "managed", followCwd: true }): {
	bridge: YaziBridge;
	script: ScriptedSessions;
	draft: { value: string };
	notices: Array<{ level: string; text: string }>;
	renders: { count: number };
} {
	const mux = fakeMux();
	const script = scriptedSessions();
	const draft = { value: "review @already.ts" };
	const notices: Array<{ level: string; text: string }> = [];
	const renders = { count: 0 };
	const bridge = createYaziBridge({
		mux: mux.contract,
		getDraft: () => draft.value,
		setDraft: (text) => {
			draft.value = text;
		},
		requestRender: () => {
			renders.count += 1;
		},
		notice: (level, text) => notices.push({ level, text }),
		getCwd: () => "/work",
		getSettings: () => settings,
		openSession: (options) => script.open(options),
		pickToken: () => "session-token",
		statPath: (path) => (path.endsWith("folder") ? "directory" : "file"),
		livenessMs: 30,
	});
	return { bridge, script, draft, notices, renders };
}

describe("contracts/yazi mention formatter", () => {
	it("formats files, spaced paths, directories, draft duplicates, and outside paths", () => {
		const batch = formatYaziMentions(
			["/work/already.ts", "/work/src/a.ts", "/work/my notes.md", "/work/src", "/outside/file.rs", "/work/src/a.ts"],
			{
				cwd: "/work",
				draft: "inspect @already.ts",
				statPath: (path) => (path === "/work/src" ? "directory" : "file"),
			},
		);
		deepStrictEqual(batch, {
			text: "@src/a.ts `my notes.md` `src/` @/outside/file.rs",
			inserted: 4,
			mentions: 2,
			plainPaths: 2,
			duplicates: 2,
			truncated: 0,
		});
	});

	it("caps one batch at 32 paths and 4096 inserted characters", () => {
		const paths = Array.from({ length: 35 }, (_, index) => `/work/file-${index}.ts`);
		const countCap = formatYaziMentions(paths, { cwd: "/work", draft: "", statPath: () => "file" });
		strictEqual(countCap.inserted, 32);
		strictEqual(countCap.truncated, 3);

		const charCap = formatYaziMentions([`/work/${"a".repeat(4096)}.ts`, "/work/second.ts"], {
			cwd: "/work",
			draft: "",
			statPath: () => "file",
		});
		strictEqual(charCap.inserted, 0);
		strictEqual(charCap.truncated, 2);
	});
});

describe("contracts/yazi interactive bridge", () => {
	it("drops a foreign token, tracks cwd, and appends valid picks without submitting", async () => {
		const harness = bridgeHarness();
		const opened = await harness.bridge.open();
		strictEqual(opened.status, "opened");
		const callbacks = harness.script.options[0];
		ok(callbacks);
		callbacks.onEvent({ kind: "cd", receiver: "42", sender: "42", tab: "1", cwd: "/work/sub" });
		callbacks.onEvent({
			kind: "clio-pick",
			receiver: "42",
			sender: "99",
			values: ["foreign-token", "/etc/passwd"],
		});
		strictEqual(harness.draft.value, "review @already.ts");
		callbacks.onEvent({
			kind: "clio-pick",
			receiver: "42",
			sender: "100",
			values: ["session-token", "/work/sub/new.ts", "/work/sub/my note.md", "/work/sub/folder"],
		});
		strictEqual(harness.draft.value, "review @already.ts @new.ts `my note.md` `folder/`");
		strictEqual(harness.renders.count, 1);
		strictEqual(harness.bridge.status().droppedLines, 1);
		strictEqual(harness.bridge.status().paneCwd, "/work/sub");
		match(harness.notices.map((notice) => notice.text).join("\n"), /3 paths from the file pane added to the draft/u);
		match(harness.notices.map((notice) => notice.text).join("\n"), /2 paths were inserted as plain text/u);
		harness.bridge.dispose();
	});

	it("closes a companion with no parsed line and reopens once in chooser mode", async () => {
		const harness = bridgeHarness();
		await harness.bridge.open();
		await waitFor(() => harness.script.options.length === 2, "chooser fallback");
		deepStrictEqual(
			harness.script.options.map((options) => options.mode),
			["companion", "chooser"],
		);
		strictEqual(harness.bridge.status().mode, "chooser");
		match(harness.notices[0]?.text ?? "", /event stream did not start/u);
		harness.bridge.dispose();
	});

	it("treats an empty chooser file as cancellation with no insertion or notice", async () => {
		const harness = bridgeHarness({ mode: "chooser", profile: "managed", followCwd: true });
		await harness.bridge.open();
		const callbacks = harness.script.options[0];
		ok(callbacks);
		callbacks.onChooser({ paths: [], cwd: "/work" });
		strictEqual(harness.draft.value, "review @already.ts");
		strictEqual(harness.renders.count, 0);
		deepStrictEqual(harness.notices, []);
		harness.bridge.dispose();
	});

	it("borrows and restores the TUI for the no-mux chooser, then inserts its chooser file", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-yazi-terminal-"));
		try {
			const lifecycle: string[] = [];
			const draft = { value: "review" };
			const seen: {
				file?: string;
				args?: ReadonlyArray<string>;
				profile: string | undefined;
			} = { profile: undefined };
			const bridge = createYaziBridge({
				getDraft: () => draft.value,
				setDraft: (text) => {
					draft.value = text;
				},
				requestRender: () => lifecycle.push("render"),
				notice: () => {},
				getCwd: () => "/work",
				getSettings: () => ({ mode: "companion", profile: "managed", followCwd: true }),
				stopUi: () => lifecycle.push("stop"),
				startUi: () => lifecycle.push("start"),
				statPath: () => "file",
				runTerminalChooser: (options) =>
					runYaziTerminalChooser({
						...options,
						stopUi: () => lifecycle.push("stop"),
						startUi: () => lifecycle.push("start"),
						requestRender: () => lifecycle.push("render"),
						cacheDir: scratch,
						sessionId: "terminal",
						resolveBinaries: () => ({
							yaziPath: "/tools/yazi",
							yaPath: "/tools/ya",
							missingYaziDetail: "not found",
						}),
						ensureProfile: () => ({
							dir: "/cache/yazi/profile",
							stamp: {
								yaziVersion: "26.8.15",
								clioVersion: "0.4.0",
								yaPath: "/tools/ya",
								assetSha256: "a",
								themeSha256: "b",
							},
						}),
						spawnYazi: (file, args, spawnOptions) => {
							seen.file = file;
							seen.args = args;
							seen.profile = spawnOptions.env.YAZI_CONFIG_HOME;
							writeFileSync(join(scratch, "yazi", "sessions", "terminal.chooser"), "/work/src/a.ts\n");
							writeFileSync(join(scratch, "yazi", "sessions", "terminal.cwd"), "/work/src");
							return {};
						},
					}),
			});

			const opened = await bridge.open();
			deepStrictEqual(opened, { status: "opened", mode: "chooser", paneId: null, existing: false });
			deepStrictEqual(lifecycle.slice(0, 3), ["stop", "start", "render"]);
			strictEqual(seen.file, "/tools/yazi");
			deepStrictEqual(seen.args, [
				"/work",
				"--chooser-file",
				join(scratch, "yazi", "sessions", "terminal.chooser"),
				"--cwd-file",
				join(scratch, "yazi", "sessions", "terminal.cwd"),
			]);
			strictEqual(seen.profile, "/cache/yazi/profile");
			strictEqual(draft.value, "review @a.ts");
			bridge.dispose();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("returns the shared missing-binary sentence before releasing the TUI", async () => {
		const lifecycle: string[] = [];
		const result = await runYaziTerminalChooser({
			cwd: "/work",
			profileMode: "managed",
			stopUi: () => lifecycle.push("stop"),
			startUi: () => lifecycle.push("start"),
			requestRender: () => lifecycle.push("render"),
			resolveBinaries: () => ({
				yaziPath: null,
				yaPath: null,
				missingYaziDetail: "not found (install with `clio-coder tools install yazi`)",
			}),
		});
		deepStrictEqual(result, {
			status: "missing-binary",
			binary: "yazi",
			detail: "not found (install with `clio-coder tools install yazi`)",
		});
		deepStrictEqual(lifecycle, []);
	});
});

describe("contracts/yazi mux session", () => {
	let scratch: string;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-yazi-session-"));
	});

	after(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("opens companion mode with both DDS grants, a token, managed profile, and stdout redirect", async () => {
		const mux = fakeMux();
		const events: YaziEvent[] = [];
		const yaCalls: Array<{ file: string; args: ReadonlyArray<string>; env: Readonly<NodeJS.ProcessEnv> }> = [];
		const result = await createYaziSession({
			mux: mux.contract,
			mode: "companion",
			profileMode: "managed",
			cwd: "/work",
			cacheDir: scratch,
			sessionId: "companion",
			pickToken: "pick-token",
			pollMs: 5,
			resolveBinaries: () => ({ yaziPath: "/tools/yazi", yaPath: "/tools/ya", missingYaziDetail: "missing" }),
			ensureProfile: () => ({
				dir: "/cache/yazi/profile",
				stamp: {
					yaziVersion: "26.8.15",
					clioVersion: "0.4.0",
					yaPath: "/tools/ya",
					assetSha256: "a",
					themeSha256: "b",
				},
			}),
			onEvent: (event) => events.push(event),
			onChooser: () => {},
			runYa: async (file, args, env) => {
				yaCalls.push({ file, args, env });
				return true;
			},
		});
		strictEqual(result.status, "opened");
		if (result.status !== "opened") return;
		deepStrictEqual(mux.opened[0], {
			argv: ["/tools/yazi", "--local-events", "cd,clio-pick", "--remote-events", "clio-pick"],
			cwd: "/work",
			label: "yazi",
			env: { YAZI_CONFIG_HOME: "/cache/yazi/profile", CLIO_YAZI_PICK_TOKEN: "pick-token" },
			stdoutPath: join(scratch, "yazi", "sessions", "companion.stream"),
		});
		const streamPath = result.session.snapshot().streamPath;
		ok(streamPath);
		appendFileSync(streamPath, 'cd,42,42,{"tab":1,"url":"/work/sub"}\n');
		await waitFor(() => result.session.snapshot().instanceId === "42", "startup cd");
		strictEqual(events[0]?.kind, "cd");
		strictEqual(await result.session.pushCwd("/work/next"), true);
		deepStrictEqual(yaCalls[0]?.file, "/tools/ya");
		deepStrictEqual(yaCalls[0]?.args, ["emit-to", "42", "cd", "/work/next"]);
		strictEqual(yaCalls[0]?.env.YAZI_CONFIG_HOME, "/cache/yazi/profile");
		await result.session.close();
	});

	it("opens user-profile chooser mode without Clio env and consumes newline-joined paths after pane exit", async () => {
		const mux = fakeMux();
		const choices: YaziChooserResult[] = [];
		const result = await createYaziSession({
			mux: mux.contract,
			mode: "chooser",
			profileMode: "user",
			cwd: "/work",
			cacheDir: scratch,
			sessionId: "chooser",
			pollMs: 5,
			resolveBinaries: () => ({ yaziPath: "/tools/yazi", yaPath: null, missingYaziDetail: "missing" }),
			onEvent: () => {},
			onChooser: (choice) => choices.push(choice),
		});
		strictEqual(result.status, "opened");
		if (result.status !== "opened") return;
		const chooserPath = join(scratch, "yazi", "sessions", "chooser.chooser");
		const cwdPath = join(scratch, "yazi", "sessions", "chooser.cwd");
		deepStrictEqual(mux.opened[0], {
			argv: ["/tools/yazi", "/work", "--chooser-file", chooserPath, "--cwd-file", cwdPath],
			cwd: "/work",
			label: "yazi",
		});
		writeFileSync(chooserPath, "/work/a.rs\n/work/b.rs");
		writeFileSync(cwdPath, "/work/sub");
		mux.records.splice(0);
		await waitFor(() => choices.length === 1, "chooser exit read");
		deepStrictEqual(choices[0], { paths: ["/work/a.rs", "/work/b.rs"], cwd: "/work/sub" });
		await result.session.close();
	});
});
