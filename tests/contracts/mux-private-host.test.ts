import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { workspaceEligibility } from "../../src/cli/workspace-launch.js";
import {
	renderWorkspaceConfig,
	rerenderWorkspaceConfig,
	writeWorkspaceConfig,
} from "../../src/domains/mux/workspace/config.js";
import { clioHostSessionOf, exitMarkerPath, hostedInWorkspace } from "../../src/domains/mux/workspace/exit-marker.js";
import {
	createPosixHostPlatform,
	posixRuntimeDirCandidates,
	renderPosixShellShim,
} from "../../src/domains/mux/workspace/platform-posix.js";
import { mirroredSource } from "../../src/domains/toolchain/install.js";

const SESSION = "clio-coder-0123456789ab";
const shell = { defaultShell: "/state/mux/0123456789ab/pane-shell", shellMode: "non_login" } as const;

describe("private pane host layout (POSIX)", () => {
	it("prefers the runtime dir and falls back to /tmp when the socket path would be too long", () => {
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" }, SESSION, "linux", 1000), [
			"/run/user/1000/clio-coder",
			"/tmp/clio-coder-1000",
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: "/var/folders/x/T/" }, SESSION, "darwin", 501), [
			"/var/folders/x/T/clio-coder",
			"/tmp/clio-coder-501",
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: `/${"d".repeat(90)}` }, SESSION, "linux", 7), [
			"/tmp/clio-coder-7",
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "relative" }, SESSION, "linux", 7), [
			"/tmp/clio-coder-7",
		]);
	});

	it("lays out a private root, socket and shim, and hands the operator's XDG roots to the shim", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-private-host-"));
		// A real runtime dir is short and exists; the test tmp root may be too long for a socket.
		const runtime = mkdtempSync("/tmp/cph-");
		t.after(() => {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(runtime, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const layout = platform.hostLayout({
			session: SESSION,
			env: { XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: "/home/me/.cfg" },
		});
		const root = join(scratch, "state", "mux", "0123456789ab");
		equal(layout.socketPath, join(runtime, "clio-coder", `${SESSION}.sock`));
		equal(statSync(join(runtime, "clio-coder")).mode & 0o777, 0o700);
		equal(layout.configPath, join(root, "config", "herdr", "config.toml"));
		deepStrictEqual(layout.hostEnv, {
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			HERDR_SOCKET_PATH: layout.socketPath,
			CLIO_CODER_PANE_XDG_CONFIG_HOME: "/home/me/.cfg",
		});
		deepStrictEqual(layout.shell, { defaultShell: join(root, "pane-shell"), shellMode: "non_login" });
		deepStrictEqual(layout.disposableDirs, [root]);
		equal(layout.sessionFile, join(root, "config", "herdr", "session.json"));
		equal(layout.cleanupArgs, null);
		deepStrictEqual(layout.herdrArgs, []);
		equal(statSync(join(root, "pane-shell")).mode & 0o777, 0o755);
	});

	it("keeps one socket per root while it is live, whatever runtime dir a later launch sees", async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-private-host-"));
		const first = mkdtempSync("/tmp/cph-");
		const second = mkdtempSync("/tmp/cph-");
		const server = createServer();
		t.after(() => {
			server.close();
			for (const dir of [scratch, first, second]) rmSync(dir, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const live = platform.hostLayout({ session: SESSION, env: { XDG_RUNTIME_DIR: first } }).socketPath;
		await new Promise<void>((resolve) => server.listen(live, resolve));
		equal(platform.hostLayout({ session: SESSION, env: { XDG_RUNTIME_DIR: second } }).socketPath, live);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		equal(
			platform.hostLayout({ session: SESSION, env: { XDG_RUNTIME_DIR: second } }).socketPath,
			join(second, "clio-coder", `${SESSION}.sock`),
		);
	});

	it("the shim restores set XDG roots, unsets unset ones, and execs the operator's shell", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-shim-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const shim = join(scratch, "pane-shell");
		const fake = join(scratch, "fake-shell");
		writeFileSync(shim, renderPosixShellShim("linux"), { mode: 0o755 });
		writeFileSync(
			fake,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
			'#!/bin/sh\necho "cfg=${XDG_CONFIG_HOME-unset} state=${XDG_STATE_HOME-unset} saved=${CLIO_CODER_PANE_XDG_CONFIG_HOME-unset} args=$*"\n',
			{ mode: 0o755 },
		);
		const run = spawnSync("/bin/sh", [shim], {
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				SHELL: fake,
				XDG_CONFIG_HOME: "/private/config",
				XDG_STATE_HOME: "/private/state",
				CLIO_CODER_PANE_XDG_CONFIG_HOME: "/home/me/.cfg",
			},
		});
		equal(run.stdout.trim(), "cfg=/home/me/.cfg state=unset saved=unset args=");
		match(renderPosixShellShim("darwin"), /bash\|zsh[^)]*\) exec "\$shell" -l ;;/u);
		ok(!renderPosixShellShim("linux").includes(" -l"));
	});

	it("types the Clio command with a leading space so the operator's shell history skips it", () => {
		deepStrictEqual(createPosixHostPlatform().paneLaunch(["/usr/bin/node", "/opt/clio coder/index.js", "it's"]), {
			env: {},
			line: " /usr/bin/node '/opt/clio coder/index.js' 'it'\\''s'",
		});
	});
});

describe("managed herdr config", () => {
	it("uses ctrl+b, or the nested prefix inside another herdr, and unbinds herdr's own screens", () => {
		const plain = renderWorkspaceConfig({ shell, nested: false, outputStyle: "standard" });
		match(plain, /^prefix = "ctrl\+b"$/mu);
		const nested = renderWorkspaceConfig({ shell, nested: true, outputStyle: "standard" });
		match(nested, /^prefix = \["ctrl\+shift\+b", "ctrl\+\]"\]$/mu);
		for (const key of ["help", "settings", "new_workspace", "workspace_picker", "goto", "reload_config"]) {
			match(plain, new RegExp(`^${key} = ""$`, "mu"));
		}
		match(plain, /^default_shell = ".*pane-shell"$/mu);
		match(plain, /^shell_mode = "non_login"$/mu);
		match(plain, /^version_check = false$/mu);
		match(plain, /^onboarding = false$/mu);
		match(plain, /^hide_tab_bar_when_single_tab = true$/mu);
	});

	it("follows the output style with its pane chrome", () => {
		const compact = renderWorkspaceConfig({ shell, nested: false, outputStyle: "compact" });
		match(compact, /^pane_gaps = false$/mu);
		match(compact, /^pane_scrollbars = false$/mu);
		const detailed = renderWorkspaceConfig({ shell, nested: false, outputStyle: "detailed" });
		match(detailed, /^pane_borders = "always"$/mu);
		match(detailed, /^pane_outer_borders = true$/mu);
	});

	it("re-renders for a new style keeping the launch's nesting, and refuses to guess without it", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-host-config-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const configPath = join(scratch, "herdr", "config.toml");
		equal(rerenderWorkspaceConfig(configPath, shell, "detailed"), false);
		writeWorkspaceConfig(configPath, { shell, nested: true, outputStyle: "compact" });
		equal(rerenderWorkspaceConfig(configPath, shell, "detailed"), true);
		const text = readFileSync(configPath, "utf8");
		match(text, /^pane_borders = "always"$/mu);
		match(text, /^prefix = \["ctrl\+shift\+b"/mu);
	});
});

describe("host identity and exit markers", () => {
	it("recognises only Clio's host sockets, in either layout", () => {
		equal(clioHostSessionOf(`/run/user/1/clio-coder/${SESSION}.sock`), SESSION);
		equal(clioHostSessionOf(`C:\\Users\\me\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\herdr.sock`), SESSION);
		equal(clioHostSessionOf("/home/me/.config/herdr/herdr.sock"), null);
		equal(clioHostSessionOf("/tmp/clio-coder.sock"), null);
		equal(hostedInWorkspace({ HERDR_ENV: "1", HERDR_SOCKET_PATH: `/x/${SESSION}.sock` }), true);
		equal(hostedInWorkspace({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock" }), false);
	});

	it("names markers after the socket and sanitizes the pane id", () => {
		equal(exitMarkerPath(`/run/x/${SESSION}.sock`, "w1:p2"), `/run/x/${SESSION}.exit-w1_p2`);
	});
});

describe("launcher eligibility", () => {
	const base = {
		options: {},
		env: { TERM: "xterm-256color" },
		stdinIsTTY: true,
		stdoutIsTTY: true,
		insideClioHost: false,
	};
	it("opens by default, nested inside the operator's herdr, and never inside its own host", () => {
		deepStrictEqual(workspaceEligibility(base), { kind: "open", nested: false });
		deepStrictEqual(workspaceEligibility({ ...base, env: { HERDR_ENV: "1" } }), { kind: "open", nested: true });
		equal(workspaceEligibility({ ...base, env: { HERDR_ENV: "1" }, insideClioHost: true }).kind, "plain");
	});
	it("stays plain for non-interactive runs, pipes, dumb terminals, other multiplexers and --with-panes", () => {
		equal(workspaceEligibility({ ...base, options: { headless: { task: "x" } as never } }).kind, "plain");
		equal(workspaceEligibility({ ...base, stdoutIsTTY: false }).kind, "plain");
		equal(workspaceEligibility({ ...base, env: { TERM: "dumb" } }).kind, "plain");
		equal(workspaceEligibility({ ...base, env: { TMUX: "/tmp/tmux" } }).kind, "plain");
		equal(workspaceEligibility({ ...base, options: { panes: "with" } }).kind, "plain");
	});
});

describe("toolchain mirror", () => {
	it("maps a pinned URL onto a mirror directory, file URL or HTTP mirror by asset name", () => {
		const url = "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64";
		equal(mirroredSource(url, "/srv/mirror"), "/srv/mirror/herdr-linux-x86_64");
		equal(mirroredSource(url, "file:///srv/mirror"), "/srv/mirror/herdr-linux-x86_64");
		equal(mirroredSource(url, "https://cache.example/herdr/"), "https://cache.example/herdr/herdr-linux-x86_64");
		equal(
			mirroredSource("https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/LICENSE", "/srv/mirror"),
			"/srv/mirror/LICENSE",
		);
	});
});
