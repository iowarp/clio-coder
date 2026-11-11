import { match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import { settingsPath } from "../../src/core/config.js";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { readLayeredSettings, updateProjectLocalSettings } from "../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { startConfigWatcher } from "../../src/domains/config/watcher.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function approve(workspace: string): void {
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
}

test("project save writes only the local layer and remains effective on the next read", async () => {
	const home = await isolateClioEnv("clio-project-save-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(workspace);
		const userFile = join(home.dir, "config", "settings.yaml");
		const teamFile = join(workspace, ".clio-coder", "settings.yaml");
		const localFile = join(workspace, ".clio-coder", "settings.local.yaml");
		const saved = updateProjectLocalSettings(workspace, (settings) => {
			settings.chat.retry.streamStallMs = 45000;
		});
		strictEqual(saved.chat.retry.streamStallMs, 45000);
		strictEqual(existsSync(teamFile), false);
		strictEqual(existsSync(userFile), false);
		strictEqual(
			(parseYaml(readFileSync(localFile, "utf8")) as { chat: { retry: { streamStallMs: number } } }).chat.retry
				.streamStallMs,
			45000,
		);
		strictEqual(readLayeredSettings(workspace).settings.chat.retry.streamStallMs, 45000);
	} finally {
		home.restore();
	}
});

test("project save preserves trusted team bytes and unrelated local keys", async () => {
	const home = await isolateClioEnv("clio-project-save-trusted-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		const teamFile = join(config, "settings.yaml");
		const localFile = join(config, "settings.local.yaml");
		const teamBytes = "chat:\n  retry:\n    streamStallMs: 30000\n";
		writeFileSync(teamFile, teamBytes);
		writeFileSync(localFile, "interface:\n  demo: false\n");
		approve(workspace);
		updateProjectLocalSettings(workspace, (settings) => {
			settings.chat.retry.streamStallMs = 45000;
		});
		strictEqual(readFileSync(teamFile, "utf8"), teamBytes);
		match(readFileSync(localFile, "utf8"), /demo: false/);
		strictEqual(readLayeredSettings(workspace).settings.chat.retry.streamStallMs, 45000);
	} finally {
		home.restore();
	}
});

test("project save refuses an untrusted or changed project settings surface", async () => {
	const home = await isolateClioEnv("clio-project-save-untrusted-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		const teamFile = join(config, "settings.yaml");
		const localFile = join(config, "settings.local.yaml");
		writeFileSync(teamFile, "chat:\n  retry:\n    streamStallMs: 30000\n");
		const mutate = () =>
			updateProjectLocalSettings(workspace, (settings) => {
				settings.chat.retry.streamStallMs = 45000;
			});
		throws(mutate, /untrusted|review|trust/);
		strictEqual(existsSync(localFile), false);
		approve(workspace);
		writeFileSync(teamFile, "chat:\n  retry:\n    streamStallMs: 35000\n");
		throws(mutate, /changed|review|trust/);
		strictEqual(existsSync(localFile), false);
	} finally {
		home.restore();
	}
});

test("a project save notifies other sessions even when the project settings directory is new", async () => {
	const home = await isolateClioEnv("clio-project-save-watch-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(workspace);
		let fires = 0;
		const watcher = startConfigWatcher(() => {
			fires += 1;
		}, workspace);
		try {
			updateProjectLocalSettings(workspace, (settings) => {
				settings.chat.retry.streamStallMs = 45000;
			});
			for (let attempt = 0; fires === 0 && attempt < 30; attempt += 1) await delay(20);
			ok(fires > 0, "another session's watcher should see the project save");
		} finally {
			watcher.stop();
		}
	} finally {
		home.restore();
	}
});

test("a watcher that cannot start reports one line once per process, never a stack", async () => {
	const home = await isolateClioEnv("clio-config-watch-emfile-");
	const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
	const realWatch = fs.watch;
	const configDir = existsSync(dirname(settingsPath()))
		? realpathSync(dirname(settingsPath()))
		: dirname(settingsPath());
	const watchMock = mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
		if (String(args[0]) === configDir) {
			throw Object.assign(new Error(`EMFILE: too many open files, watch '${String(args[0])}'`), { code: "EMFILE" });
		}
		return realWatch(...args);
	});
	syncBuiltinESMExports();
	const lines: string[] = [];
	const removeSink = installDiagnosticSink((text) => lines.push(text));
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(workspace);
		startConfigWatcher(() => {}, workspace).stop();
		startConfigWatcher(() => {}, workspace).stop();
		strictEqual(lines.length, 1);
		strictEqual(
			lines[0],
			"[clio-coder:config] settings hot reload unavailable: too many open files (EMFILE); restart to apply settings changes",
		);
	} finally {
		removeSink();
		watchMock.mock.restore();
		syncBuiltinESMExports();
		home.restore();
	}
});

test("a __proto__ key in a settings layer never reaches Object.prototype", async () => {
	const home = await isolateClioEnv("clio-settings-proto-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(workspace);
		mkdirSync(dirname(settingsPath()), { recursive: true });
		writeFileSync(settingsPath(), "__proto__:\n  clioPolluted: true\n");
		try {
			readLayeredSettings(workspace);
		} catch {
			// Rejecting the layer is fine; only the prototype matters here.
		}
		strictEqual(({} as Record<string, unknown>).clioPolluted, undefined);
	} finally {
		delete (Object.prototype as Record<string, unknown>).clioPolluted;
		home.restore();
	}
});

test("Edit settings file keeps a trusted project layer trusted and refuses an untrusted one", async () => {
	const { editSettingsFile } = await import("../../src/interactive/settings-file-edit.js");
	const home = await isolateClioEnv("clio-project-edit-file-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		const teamFile = join(config, "settings.yaml");
		writeFileSync(teamFile, "interface:\n  outputDetail: compact\n");
		const notices: string[] = [];
		const edit = (text: string): void =>
			editSettingsFile("project", {
				cwd: workspace,
				suspendTerminal: (run) => run(),
				notice: (level, line) => notices.push(`${level}: ${line}`),
				resolveEditor: () => "editor",
				editExternally: () => ({ ok: true, text }),
			});
		edit("interface:\n  outputDetail: compact\n  smoothStreaming: off");
		match(notices.at(-1) ?? "", /^warning: Project settings are untrusted/);
		strictEqual(readFileSync(teamFile, "utf8"), "interface:\n  outputDetail: compact\n");
		approve(workspace);
		edit("interface:\n  outputDetail: compact\n  smoothStreaming: off");
		match(notices.at(-1) ?? "", /^success: Saved/);
		strictEqual(captureProjectSurface(workspace, "settings").verdict, "trusted");
		const effective = readLayeredSettings(workspace).settings;
		strictEqual(effective.interface.outputDetail, "compact");
		strictEqual(effective.interface.smoothStreaming, "off");
	} finally {
		home.restore();
	}
});

test("a trusted project layer cannot turn the census on or choose its endpoint", async () => {
	const home = await isolateClioEnv("clio-project-census-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		writeFileSync(
			join(config, "settings.yaml"),
			"report:\n  census: on\n  censusEndpoint: https://repo.example/census\n",
		);
		writeFileSync(join(config, "settings.local.yaml"), "report:\n  census: on\n");
		approve(workspace);
		const layered = readLayeredSettings(workspace);
		strictEqual(layered.settings.report.census, "off");
		strictEqual(layered.settings.report.censusEndpoint, "");
		ok(layered.issues.some((issue) => issue.path === "report.censusEndpoint" && issue.origin === "project"));
		ok(layered.issues.some((issue) => issue.path === "report.census" && issue.origin === "project.local"));
	} finally {
		home.restore();
	}
});

test("Edit settings file creates the project settings file when the project has none", async () => {
	const { editSettingsFile } = await import("../../src/interactive/settings-file-edit.js");
	const home = await isolateClioEnv("clio-project-edit-new-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(workspace, { recursive: true });
		const notices: string[] = [];
		editSettingsFile("project", {
			cwd: workspace,
			suspendTerminal: (run) => run(),
			notice: (level, line) => notices.push(`${level}: ${line}`),
			resolveEditor: () => "editor",
			editExternally: () => ({ ok: true, text: "interface:\n  smoothStreaming: off" }),
		});
		match(notices.at(-1) ?? "", /^success: Saved/);
		strictEqual(captureProjectSurface(workspace, "settings").verdict, "trusted");
		strictEqual(readLayeredSettings(workspace).settings.interface.smoothStreaming, "off");
	} finally {
		home.restore();
	}
});
