import { match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
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
