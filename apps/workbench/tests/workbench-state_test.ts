/**
 * The refuse-to-open guards, the recent-project file, and the host-side
 * directory browser.
 *
 * Deno's read and write grants are broad at launch, so these guards are the only
 * boundary between the operator and `/`, `$HOME`, dot-config directories, and
 * system trees. They are tested against real directories, never mocks.
 */

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { dirname, join } from "node:path";
import {
	CANONICAL_STATE_DIRECTORY_NAME,
	LEGACY_MIGRATION_MARKER,
	LEGACY_STATE_DIRECTORY_NAME,
	MAX_BROWSE_ENTRIES,
	MAX_RECENT_PROJECTS,
	resolveStateDir,
	WorkbenchState,
	WorkbenchStateError,
} from "../workbench-state.ts";

interface Fixture {
	readonly root: string;
	readonly home: string;
	readonly stateDir: string;
	readonly logs: string[];
	readonly state: WorkbenchState;
	dispose(): Promise<void>;
}

async function fixture(options: Readonly<{ now?: () => number }> = {}): Promise<Fixture> {
	const root = await Deno.makeTempDir({ prefix: "workbench-state-" });
	const home = join(root, "home");
	const stateDir = join(root, "state");
	await Deno.mkdir(home, { recursive: true });
	const logs: string[] = [];
	const state = await WorkbenchState.open({
		homePath: home,
		stateDir,
		log: (message) => logs.push(message),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	return {
		root,
		home,
		stateDir,
		logs,
		state,
		dispose: () => Deno.remove(root, { recursive: true }).catch(() => undefined).then(() => undefined),
	};
}

function assertStateError(code: WorkbenchStateError["code"]): (error: unknown) => boolean {
	return (error: unknown): boolean => {
		ok(error instanceof WorkbenchStateError, `expected WorkbenchStateError, received ${String(error)}`);
		equal(error.code, code);
		ok(error.message.length > 0);
		return true;
	};
}

function recentFile(projects: readonly unknown[]): string {
	return `${JSON.stringify({ version: 1, projects }, null, "\t")}\n`;
}

Deno.test("canonical state resolution wins and the legacy override warns once", () => {
	const home = "/home/researcher";
	const logs: string[] = [];
	equal(
		resolveStateDir(home, (name) => ({ XDG_STATE_HOME: "/srv/xdg-state" })[name]),
		"/srv/xdg-state/clio-coder-gui",
	);
	equal(
		resolveStateDir(
			home,
			(name) => ({ CLIO_CODER_GUI_STATE_DIR: "/srv/canonical", CLIO_WORKBENCH_STATE_DIR: "/srv/legacy" })[name],
			(message) => logs.push(message),
		),
		"/srv/canonical",
	);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		equal(
			resolveStateDir(
				home,
				(name) => ({ CLIO_WORKBENCH_STATE_DIR: "/srv/legacy" })[name],
				(message) => logs.push(message),
			),
			"/srv/legacy",
		);
	}
	equal(logs.length, 1);
	ok(logs[0]?.includes("CLIO_CODER_GUI_STATE_DIR"));
});

Deno.test("first start atomically renames a lone legacy state root", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-state-move-" });
	try {
		const home = join(root, "home");
		const xdgState = join(root, "xdg-state");
		const legacy = join(xdgState, LEGACY_STATE_DIRECTORY_NAME);
		const canonical = join(xdgState, CANONICAL_STATE_DIRECTORY_NAME);
		await Deno.mkdir(legacy, { recursive: true });
		await Deno.mkdir(home, { recursive: true });
		await Deno.writeTextFile(
			join(legacy, "projects.json"),
			recentFile([{
				id: "project-moved-1",
				canonicalPath: "/tmp/moved-project",
				displayName: "Moved",
				lastOpenedAt: "2026-08-30T12:00:00.000Z",
			}]),
		);
		const legacyInode = (await Deno.stat(legacy)).ino;
		const logs: string[] = [];
		const state = await WorkbenchState.open({
			homePath: home,
			env: (name) => name === "XDG_STATE_HOME" ? xdgState : undefined,
			log: (message) => logs.push(message),
		});
		equal(state.stateDir, canonical);
		equal(state.recent()[0]?.id, "project-moved-1");
		equal(await Deno.lstat(legacy).then(() => true, () => false), false);
		equal((await Deno.stat(canonical)).ino, legacyInode);
		ok(logs.some((message) => message.includes("Moved legacy GUI state atomically")));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("first start backs up and merges split state roots, then retires the marker on the next launch", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-state-merge-" });
	try {
		const home = join(root, "home");
		const xdgState = join(root, "xdg-state");
		const legacy = join(xdgState, LEGACY_STATE_DIRECTORY_NAME);
		const canonical = join(xdgState, CANONICAL_STATE_DIRECTORY_NAME);
		await Deno.mkdir(home, { recursive: true });
		await Deno.mkdir(legacy, { recursive: true });
		await Deno.mkdir(canonical, { recursive: true });
		const canonicalInput = recentFile([
			{
				id: "project-shared-canonical",
				canonicalPath: "/tmp/shared-project/../shared-project",
				displayName: "Canonical Older",
				lastOpenedAt: "2026-08-28T12:00:00.000Z",
			},
			{
				id: "project-canonical-only",
				canonicalPath: "/tmp/canonical-only",
				displayName: "Canonical Only",
				lastOpenedAt: "2026-08-29T12:00:00.000Z",
			},
			{
				id: "project-tie-canonical",
				canonicalPath: "/tmp/tied-project",
				displayName: "Canonical Tie",
				lastOpenedAt: "2026-08-27T12:00:00.000Z",
			},
			{ id: "bad", canonicalPath: "relative", displayName: "Invalid", lastOpenedAt: "never" },
		]);
		const legacyInput = recentFile([
			{
				id: "project-shared-legacy",
				canonicalPath: "/tmp/shared-project",
				displayName: "Legacy Newest",
				lastOpenedAt: "2026-08-31T12:00:00.000Z",
			},
			{
				id: "project-legacy-only",
				canonicalPath: "/tmp/legacy-only",
				displayName: "Legacy Only",
				lastOpenedAt: "2026-08-30T12:00:00.000Z",
			},
			{
				id: "project-tie-legacy",
				canonicalPath: "/tmp/tied-project",
				displayName: "Legacy Tie",
				lastOpenedAt: "2026-08-27T12:00:00.000Z",
			},
			{ id: "project-invalid-legacy", canonicalPath: "/tmp/invalid", displayName: " padded ", lastOpenedAt: "never" },
		]);
		await Deno.writeTextFile(join(canonical, "projects.json"), canonicalInput);
		await Deno.writeTextFile(join(legacy, "projects.json"), legacyInput);
		const logs: string[] = [];
		const env = (name: string): string | undefined => name === "XDG_STATE_HOME" ? xdgState : undefined;
		const state = await WorkbenchState.open({
			homePath: home,
			env,
			now: () => Date.UTC(2026, 8, 1, 12, 0, 0),
			log: (message) => logs.push(message),
		});
		deepStrictEqual(state.recent().map((project) => project.displayName), [
			"Legacy Newest",
			"Legacy Only",
			"Canonical Only",
			"Canonical Tie",
		]);
		equal(state.recentByPath("/tmp/shared-project")?.id, "project-shared-legacy");
		equal(await Deno.lstat(join(legacy, "projects.json")).then(() => true, () => false), false);
		equal(await Deno.lstat(join(legacy, LEGACY_MIGRATION_MARKER)).then(() => true, () => false), true);
		const canonicalFiles = [...await Array.fromAsync(Deno.readDir(canonical))].map((entry) => entry.name);
		const legacyFiles = [...await Array.fromAsync(Deno.readDir(legacy))].map((entry) => entry.name);
		const canonicalBackup = canonicalFiles.find((name) => name.endsWith(".bak"));
		const legacyBackup = legacyFiles.find((name) => name.endsWith(".bak"));
		ok(canonicalBackup !== undefined);
		ok(legacyBackup !== undefined);
		equal(await Deno.readTextFile(join(canonical, canonicalBackup)), canonicalInput);
		equal(await Deno.readTextFile(join(legacy, legacyBackup)), legacyInput);
		ok(logs.some((message) => message.includes("Merged legacy GUI state")));

		const reopened = await WorkbenchState.open({ homePath: home, env, log: (message) => logs.push(message) });
		deepStrictEqual(reopened.recent(), state.recent());
		equal(await Deno.lstat(join(legacy, LEGACY_MIGRATION_MARKER)).then(() => true, () => false), false);
		equal(await Deno.readTextFile(join(canonical, canonicalBackup)), canonicalInput);
		equal(await Deno.readTextFile(join(legacy, legacyBackup)), legacyInput);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("every guarded location is refused with a sentence the operator can act on", async () => {
	const test = await fixture();
	try {
		const refused = [
			"/",
			test.home,
			dirname(test.home),
			join(test.home, ".ssh"),
			join(test.home, ".ssh", "keys"),
			join(test.home, ".gnupg"),
			join(test.home, ".aws", "cli"),
			join(test.home, ".config", "clio-coder"),
			join(test.home, ".local", "state"),
			join(test.home, ".cache", "deno"),
			test.stateDir,
			join(test.stateDir, "projects"),
			dirname(test.stateDir),
			"/etc",
			"/etc/ssh",
			"/usr/local/src",
			"/bin",
			"/sbin/init",
			"/boot",
			"/dev/shm",
			"/proc/1",
			"/sys/class",
			"/run/user",
			"/var/log",
			"/root",
			"/opt/tools",
			"/snap/core",
			"/lib",
			"/lib64/security",
			"/libexec-not-a-library/project",
		];
		for (const path of refused) {
			const reason = test.state.guardReason(path);
			ok(reason !== null, `expected ${path} to be guarded`);
			ok(reason.endsWith("."), `expected a full sentence for ${path}, received ${reason}`);
		}
	} finally {
		await test.dispose();
	}
});

Deno.test("ordinary project locations are not guarded", async () => {
	const test = await fixture();
	try {
		for (
			const path of [
				"/tmp/workbench-project",
				"/mnt/c/Users/operator/code",
				join(test.home, "code", "clio-coder"),
				join(test.home, ".localish", "project"),
				"/home/other/project",
			]
		) {
			equal(test.state.guardReason(path), null, `expected ${path} to be openable`);
		}
	} finally {
		await test.dispose();
	}
});

Deno.test("a real directory resolves to a canonical trusted root", async () => {
	const test = await fixture();
	try {
		const project = join(test.home, "code", "atlas");
		await Deno.mkdir(project, { recursive: true });
		const openable = await test.state.resolveOpenable(project);
		equal(openable.canonicalPath, await Deno.realPath(project));
		equal(openable.displayName, "atlas");
		equal(await test.state.available(project), true);
	} finally {
		await test.dispose();
	}
});

Deno.test("symlinks, files, missing paths, and relative paths are all refused", async () => {
	const test = await fixture();
	try {
		const project = join(test.home, "code", "atlas");
		await Deno.mkdir(project, { recursive: true });
		const link = join(test.home, "atlas-link");
		await Deno.symlink(project, link);
		const file = join(test.home, "notes.txt");
		await Deno.writeTextFile(file, "not a directory");

		await rejects(test.state.resolveOpenable(link), assertStateError("refused"));
		await rejects(test.state.resolveOpenable(file), assertStateError("refused"));
		await rejects(test.state.resolveOpenable(join(test.home, "absent")), assertStateError("refused"));
		await rejects(test.state.resolveOpenable("code/atlas"), assertStateError("invalid"));
		await rejects(test.state.resolveOpenable(` ${project}`), assertStateError("invalid"));
		equal(await test.state.available(link), false);
		equal(await test.state.available(join(test.home, "absent")), false);
	} finally {
		await test.dispose();
	}
});

Deno.test("a guarded directory that exists is refused by the canonical guard, not by chance", async () => {
	const test = await fixture();
	try {
		const guarded = join(test.home, ".config", "clio-coder");
		await Deno.mkdir(guarded, { recursive: true });
		await rejects(test.state.resolveOpenable(guarded), assertStateError("refused"));
		equal(await test.state.available(guarded), false);
	} finally {
		await test.dispose();
	}
});

Deno.test("the recent list is newest first, deduplicated, and capped", async () => {
	let clock = Date.UTC(2026, 7, 18, 12, 0, 0);
	const test = await fixture({ now: () => (clock += 1_000) });
	try {
		for (let index = 0; index < MAX_RECENT_PROJECTS + 4; index += 1) {
			await test.state.remember({
				id: `project-${String(index).padStart(4, "0")}`,
				canonicalPath: `/tmp/workbench-recent-${index}`,
				displayName: `Project ${index}`,
			});
		}
		const recent = test.state.recent();
		equal(recent.length, MAX_RECENT_PROJECTS);
		equal(recent[0]?.canonicalPath, `/tmp/workbench-recent-${MAX_RECENT_PROJECTS + 3}`);
		ok(recent.every((entry, index) => index === 0 || entry.lastOpenedAt <= (recent[index - 1]?.lastOpenedAt ?? "")));

		// Reopening the same path moves it to the head instead of duplicating it.
		await test.state.remember({
			id: "project-0035",
			canonicalPath: `/tmp/workbench-recent-${MAX_RECENT_PROJECTS}`,
			displayName: "Renamed",
		});
		const afterReopen = test.state.recent();
		equal(
			afterReopen.filter((entry) => entry.canonicalPath === `/tmp/workbench-recent-${MAX_RECENT_PROJECTS}`).length,
			1,
		);
		equal(afterReopen[0]?.displayName, "Renamed");
		equal(test.state.recentByPath(`/tmp/workbench-recent-${MAX_RECENT_PROJECTS}`)?.id, "project-0035");
		equal(test.state.recentById("project-0035")?.displayName, "Renamed");

		equal(await test.state.forget("project-0035"), true);
		equal(await test.state.forget("project-0035"), false);
		equal(test.state.recentById("project-0035"), null);
	} finally {
		await test.dispose();
	}
});

Deno.test("an invalid recent entry is rejected before it reaches the file", async () => {
	const test = await fixture();
	try {
		for (
			const entry of [
				{ id: "no", canonicalPath: "/tmp/workbench-invalid", displayName: "Fine" },
				{ id: "project-valid-1", canonicalPath: "relative/path", displayName: "Fine" },
				{ id: "project-valid-1", canonicalPath: "/tmp/workbench-invalid", displayName: " padded " },
			]
		) {
			await rejects(test.state.remember(entry), assertStateError("invalid"));
		}
		equal(test.state.recent().length, 0);
	} finally {
		await test.dispose();
	}
});

Deno.test("the recent list survives a runtime restart on the same state directory", async () => {
	const test = await fixture();
	try {
		await test.state.remember({
			id: "project-persisted-1",
			canonicalPath: "/tmp/workbench-persisted",
			displayName: "Persisted",
		});
		const reopened = await WorkbenchState.open({ homePath: test.home, stateDir: test.stateDir });
		deepStrictEqual(reopened.recent().map((entry) => entry.id), ["project-persisted-1"]);
		equal(reopened.recentByPath("/tmp/workbench-persisted")?.displayName, "Persisted");
	} finally {
		await test.dispose();
	}
});

Deno.test("a corrupt recent file starts empty and logs exactly one line", async () => {
	const test = await fixture();
	try {
		await Deno.mkdir(test.stateDir, { recursive: true });
		for (
			const corrupt of [
				"{not json",
				JSON.stringify({ version: 2, projects: [] }),
				JSON.stringify({ version: 1, projects: [{ id: "x", canonicalPath: "/tmp/a", displayName: "A" }] }),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "project-dup-1",
							canonicalPath: "/tmp/a",
							displayName: "A",
							lastOpenedAt: "2026-08-18T12:00:00.000Z",
						},
						{
							id: "project-dup-1",
							canonicalPath: "/tmp/b",
							displayName: "B",
							lastOpenedAt: "2026-08-18T12:00:00.000Z",
						},
					],
				}),
			]
		) {
			await Deno.writeTextFile(join(test.stateDir, "projects.json"), corrupt);
			const logs: string[] = [];
			const state = await WorkbenchState.open({
				homePath: test.home,
				stateDir: test.stateDir,
				log: (message) => logs.push(message),
			});
			equal(state.recent().length, 0);
			equal(logs.length, 1);
			ok(logs[0]?.includes("recent-project list"));
		}
	} finally {
		await test.dispose();
	}
});

Deno.test("browse lists directories only, flags hidden and guarded entries, and never follows symlinks", async () => {
	const test = await fixture();
	try {
		for (const name of ["Zebra", "alpha", ".hidden", ".config", "beta"]) {
			await Deno.mkdir(join(test.home, name), { recursive: true });
		}
		await Deno.writeTextFile(join(test.home, "notes.txt"), "never listed");
		await Deno.symlink(join(test.home, "alpha"), join(test.home, "alpha-link"));
		await Deno.symlink(join(test.home, "notes.txt"), join(test.home, "notes-link"));

		const listing = await test.state.browse();
		deepStrictEqual(listing.entries.map((entry) => entry.name), [
			".config",
			".hidden",
			"alpha",
			"alpha-link",
			"beta",
			"Zebra",
		]);
		ok(!listing.entries.some((entry) => entry.name === "notes.txt" || entry.name === "notes-link"));
		deepStrictEqual(
			listing.entries.filter((entry) => entry.hidden).map((entry) => entry.name),
			[".config", ".hidden"],
		);
		deepStrictEqual(
			listing.entries.filter((entry) => entry.guarded).map((entry) => entry.name),
			[".config", "alpha-link"],
		);
		equal(listing.path, await Deno.realPath(test.home));
		equal(listing.parent, dirname(await Deno.realPath(test.home)));
		equal(listing.truncated, false);
		equal(listing.openable, false);
		ok(listing.reason?.includes("home directory"));
	} finally {
		await test.dispose();
	}
});

Deno.test("browse reports an openable directory and a missing one distinctly", async () => {
	const test = await fixture();
	try {
		const project = join(test.home, "code");
		await Deno.mkdir(join(project, "src"), { recursive: true });
		await Deno.writeTextFile(join(project, "src", "notes.txt"), "not a directory");
		const listing = await test.state.browse(project);
		equal(listing.openable, true);
		equal(listing.reason, null);
		deepStrictEqual(listing.entries.map((entry) => entry.name), ["src"]);
		await rejects(test.state.browse(join(test.home, "absent")), assertStateError("not-found"));
		await rejects(test.state.browse(join(test.home, "code", "src", "notes.txt")), assertStateError("not-found"));
		await rejects(test.state.browse("code"), assertStateError("invalid"));
	} finally {
		await test.dispose();
	}
});

Deno.test("browse bounds its listing and reports the truncation", async () => {
	const test = await fixture();
	try {
		const parent = join(test.home, "many");
		await Deno.mkdir(parent, { recursive: true });
		for (let index = 0; index <= MAX_BROWSE_ENTRIES; index += 1) {
			await Deno.mkdir(join(parent, `entry-${String(index).padStart(4, "0")}`));
		}
		const listing = await test.state.browse(parent);
		equal(listing.entries.length, MAX_BROWSE_ENTRIES);
		equal(listing.truncated, true);
	} finally {
		await test.dispose();
	}
});
