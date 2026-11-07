import { deepStrictEqual, equal, match, notEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { panesFindings, panesModeFinding } from "../../src/cli/doctor-panes.js";
import { workspaceEligibility } from "../../src/cli/workspace-launch.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	renderWorkspaceConfig,
	rerenderWorkspaceConfig,
	writeWorkspaceConfig,
} from "../../src/domains/mux/workspace/config.js";
import {
	clioHostSessionOf,
	exitMarkerPath,
	hostedInWorkspace,
	markWorkspaceExit,
	readWorkspaceExitResult,
	workspaceSessionFor,
} from "../../src/domains/mux/workspace/exit-marker.js";
import { holdExitSummaryForLauncher } from "../../src/domains/mux/workspace/exit-summary-handoff.js";
import { launchWorkspace } from "../../src/domains/mux/workspace/launch.js";
import {
	createPosixHostPlatform,
	posixRuntimeDirCandidates,
	renderPosixShellShim,
} from "../../src/domains/mux/workspace/platform-posix.js";
import { installPinnedTool, mirroredSources } from "../../src/domains/toolchain/install.js";
import { findPinnedTool } from "../../src/domains/toolchain/registry.js";

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

	it("tries the operator's TMPDIR before the system temp root when XDG_RUNTIME_DIR is unusable", () => {
		const systemRoot = posixRuntimeDirCandidates({}, SESSION, "linux", 7);
		const longXdg = `/${"d".repeat(90)}`;
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: longXdg, TMPDIR: "/home/me/t" }, SESSION, "linux", 7), [
			"/home/me/t/clio-coder-7",
			...systemRoot,
		]);
		// A runtime dir that fits but cannot be made private falls through to TMPDIR, not straight to the system root.
		deepStrictEqual(
			posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/7", TMPDIR: "/home/me/t" }, SESSION, "linux", 7),
			["/run/user/7/clio-coder", "/home/me/t/clio-coder-7", ...systemRoot],
		);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: `/${"t".repeat(60)}` }, SESSION, "linux", 7), systemRoot);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: "relative" }, SESSION, "linux", 7), systemRoot);
	});

	it("lays the socket out in TMPDIR when the runtime dir is too long for one", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "h"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const tmp = tmpdir();
		const candidates = posixRuntimeDirCandidates({ TMPDIR: tmp }, SESSION, "linux", process.getuid?.() ?? 0);
		// The harness tmp root may itself be too long for a socket; then only the fallback case applies.
		if (candidates[0] !== join(tmp, `clio-coder-${process.getuid?.() ?? 0}`)) {
			t.skip("tmp root too long for a socket path");
			return;
		}
		const layout = platform.hostLayout({
			session: SESSION,
			env: { XDG_RUNTIME_DIR: `/${"d".repeat(90)}`, TMPDIR: tmp },
		});
		equal(layout.socketPath, join(candidates[0], `${SESSION}.sock`));
		equal(statSync(candidates[0]).mode & 0o777, 0o700);
	});

	it("lays out a private root, socket and shim, and hands the operator's XDG roots to the shim", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-private-host-"));
		// A short fixture session keeps Unix sockets inside the harness root.
		const session = "clio-coder-a";
		const runtime = tmpdir();
		t.after(() => {
			rmSync(scratch, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const layout = platform.hostLayout({
			session,
			env: { XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: "/home/me/.cfg" },
		});
		const root = join(scratch, "state", "mux", "a");
		equal(layout.socketPath, join(runtime, "clio-coder", `${session}.sock`));
		equal(statSync(join(runtime, "clio-coder")).mode & 0o777, 0o700);
		equal(layout.configPath, join(root, "config", "herdr", "config.toml"));
		deepStrictEqual(layout.hostEnv, {
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			HERDR_SOCKET_PATH: layout.socketPath,
			CLIO_CODER_PANE_XDG_CONFIG_HOME: "/home/me/.cfg",
		});
		deepStrictEqual(layout.shell, { defaultShell: join(root, "pane-shell"), shellMode: "non_login" });
		deepStrictEqual(layout.disposableDirs, [root, join(runtime, "clio-coder", "a")]);
		equal(layout.sessionFile, join(root, "config", "herdr", "session.json"));
		equal(layout.cleanupArgs, null);
		deepStrictEqual(layout.herdrArgs, []);
		equal(statSync(join(root, "pane-shell")).mode & 0o777, 0o755);
	});

	it("keeps one socket per root while it is live, whatever runtime dir a later launch sees", async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-private-host-"));
		const session = "clio-coder-b";
		const first = tmpdir();
		const second = join(first, "r");
		mkdirSync(second);
		const server = createServer();
		t.after(() => {
			server.close();
			for (const dir of [scratch, second]) rmSync(dir, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const live = platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: first } }).socketPath;
		await new Promise<void>((resolve) => server.listen(live, resolve));
		equal(platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: second } }).socketPath, live);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		equal(
			platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: second } }).socketPath,
			join(second, "clio-coder", `${session}.sock`),
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

	it("preserves the operator's runtime directory or its absence in user shells and inner Clio", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-runtime-env-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const fake = join(scratch, "fake-shell");
		const preload = join(scratch, "runtime.mjs");
		writeFileSync(
			fake,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
			'#!/bin/sh\nprintf "pane-runtime=%s\\n" "${XDG_RUNTIME_DIR-unset}"\nexec /bin/sh\n',
			{ mode: 0o755 },
		);
		writeFileSync(preload, 'console.log("clio-runtime=" + (process.env.XDG_RUNTIME_DIR ?? "unset"));\n');
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		for (const runtime of [tmpdir(), undefined]) {
			const env: NodeJS.ProcessEnv = { HOME: scratch, PATH: "/usr/bin:/bin", SHELL: fake, TMPDIR: tmpdir() };
			if (runtime !== undefined) env.XDG_RUNTIME_DIR = runtime;
			const layout = platform.hostLayout({ session: "r", env });
			ok(layout.shell.defaultShell);
			const command = platform.paneLaunch([
				process.execPath,
				"--import",
				"tsx",
				"--import",
				preload,
				"src/cli/index.ts",
				"--version",
			]);
			const run = spawnSync("/bin/sh", [layout.shell.defaultShell], {
				encoding: "utf8",
				env: { ...env, ...layout.hostEnv },
				input: `${command.line}\n`,
			});
			equal(run.status, 0, run.stderr);
			const lines = run.stdout.split("\n");
			equal(lines[0], `pane-runtime=${runtime ?? "unset"}`);
			equal(lines[1], `clio-runtime=${runtime ?? "unset"}`);
		}
	});

	it("types the Clio command with a leading space so the operator's shell history skips it", () => {
		deepStrictEqual(createPosixHostPlatform().paneLaunch(["/usr/bin/node", "/opt/clio coder/index.js", "it's"]), {
			env: {},
			line: " /usr/bin/node '/opt/clio coder/index.js' 'it'\\''s'",
		});
	});

	it("replaces a changed shell shim without truncating an existing reader's inode", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-atomic-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const input = { session: "clio-coder-atomic", env: { XDG_RUNTIME_DIR: tmpdir() } };
		const layout = platform.hostLayout(input);
		const shim = layout.shell.defaultShell!;
		writeFileSync(shim, "previous complete shim\n");
		const reader = openSync(shim, "r");
		try {
			platform.hostLayout(input);
			equal(readFileSync(reader, "utf8"), "previous complete shim\n");
			equal(readFileSync(shim, "utf8"), renderPosixShellShim("linux"));
			equal(statSync(shim).mode & 0o777, 0o755);
		} finally {
			closeSync(reader);
		}
	});
});

describe("private host startup cleanup", () => {
	it("reaps a spawned server that never becomes ready before falling back", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-start-"));
		const binary = join(scratch, "host");
		const pidFile = join(scratch, "server.pid");
		const layoutRoot = join(scratch, "layout");
		const socketPath = join(tmpdir(), "start.sock");
		const program = join(scratch, "host.mjs");
		writeFileSync(
			program,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nwriteFileSync(${JSON.stringify(socketPath)}, "");\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
		);
		writeFileSync(
			binary,
			`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program.replaceAll("'", "'\\''")}' "$@"\n`,
			{ mode: 0o755 },
		);
		t.after(() => {
			if (existsSync(pidFile)) {
				try {
					const pid = Number(readFileSync(pidFile, "utf8"));
					if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
				} catch {}
			}
			rmSync(scratch, { recursive: true, force: true });
			rmSync(socketPath, { force: true });
		});
		const result = await launchWorkspace({
			herdrPath: binary,
			herdrVersion: null,
			nested: false,
			outputStyle: "standard",
			cwd: scratch,
			clioArgv: ["unused"],
			platform: {
				hostLayout: () => ({
					socketPath,
					herdrArgs: [],
					hostEnv: {},
					configPath: join(layoutRoot, "config.toml"),
					shell: { defaultShell: null, shellMode: "non_login" },
					sessionFile: join(layoutRoot, "session.json"),
					disposableDirs: [layoutRoot],
					cleanupArgs: null,
				}),
				paneLaunch: () => ({ env: {}, line: "" }),
				detach: () => undefined,
				afterClientExit: () => undefined,
			},
		});
		equal(result.status, "fallback");
		const pid = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		equal(alive, false, "the failed server must be reaped before fallback");
		equal(existsSync(layoutRoot), false);
		equal(existsSync(socketPath), false);
	});
});

describe("private host attached-client shutdown", () => {
	for (const scenario of ["last workspace", "another workspace", "reused workspace", "reattached launcher"] as const) {
		it(`handles launcher termination with a delayed co-attached client (${scenario})`, {
			skip: process.platform === "win32",
		}, async (t) => {
			const scratch = mkdtempSync(join(tmpdir(), "host-clients-"));
			const socketPath = join(tmpdir(), `${SESSION}.sock`);
			const binary = join(scratch, "client");
			const program = join(scratch, "client.mjs");
			writeFileSync(
				program,
				[
					'import { createConnection } from "node:net";',
					'if (process.argv[2] === "pane") process.exit(0);',
					"const socket = createConnection(process.env.HERDR_SOCKET_PATH);",
					'socket.on("connect", () => socket.write(JSON.stringify({ method: "test.attach", params: { pid: process.pid } }) + "\\n"));',
					'socket.on("end", () => process.exit(0));',
					'socket.on("error", () => process.exit(1));',
					'process.on("SIGHUP", () => setTimeout(() => { socket.end(); process.exit(0); }, Number(process.env.DETACH_DELAY ?? 0)));',
				].join("\n"),
			);
			writeFileSync(
				binary,
				`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program.replaceAll("'", "'\\''")}' "$@"\n`,
				{ mode: 0o755 },
			);
			const connections = new Set<Socket>();
			const attached = new Set<Socket>();
			const pids = new Set<number>();
			const methods: string[] = [];
			const detaches: Array<{ delay: number; marked: boolean }> = [];
			let replacements = 0;
			let stopped = false;
			let workspace = false;
			const other = scenario === "another workspace";
			let nonce = "";
			const pane = () => ({
				pane_id: "w1:p1",
				tab_id: "t1",
				workspace_id: "w1",
				cwd: scratch,
				tokens: { clio_coder_workspace: nonce },
			});
			const server = createServer((socket) => {
				connections.add(socket);
				socket.on("close", () => {
					connections.delete(socket);
					attached.delete(socket);
				});
				let pending = "";
				socket.on("data", (chunk) => {
					pending += chunk.toString();
					if (!pending.includes("\n")) return;
					const request = JSON.parse(pending.trim());
					if (request.method === "test.attach") {
						attached.add(socket);
						pids.add(request.params.pid);
						return;
					}
					methods.push(request.method);
					let result: unknown = {};
					if (request.method === "ping") result = { version: "fixture", protocol: 21 };
					if (request.method === "workspace.list") {
						result = {
							workspaces: [...(workspace ? [{ workspace_id: "w1" }] : []), ...(other ? [{ workspace_id: "other" }] : [])],
						};
					}
					if (request.method === "pane.list") result = { panes: request.params.workspace_id === "w1" ? [pane()] : [] };
					if (request.method === "workspace.create") {
						workspace = true;
						result = { workspace: { workspace_id: "w1" }, root_pane: pane() };
					}
					if (request.method === "pane.report_metadata") nonce = request.params.tokens.clio_coder_workspace;
					if (request.method === "workspace.close") {
						workspace = false;
						if (!other && attached.size > 0) {
							replacements += 1;
							workspace = true;
							nonce = "replacement";
						}
					}
					socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
					if (request.method === "server.stop") {
						stopped = true;
						workspace = false;
						server.close();
						for (const connection of attached) connection.end();
					}
				});
			});
			const launches: Array<ReturnType<typeof launchWorkspace>> = [];
			t.after(async () => {
				for (const pid of pids) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				for (const socket of connections) socket.destroy();
				if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
				await Promise.allSettled(launches);
				rmSync(socketPath, { force: true });
				rmSync(scratch, { recursive: true, force: true });
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const base = {
				herdrPath: binary,
				herdrVersion: "fixture",
				nested: false,
				outputStyle: "standard" as const,
				cwd: scratch,
				clioArgv: ["unused"],
			};
			const host = (delay: number) => ({
				...base,
				platform: {
					hostLayout: () => ({
						socketPath,
						herdrArgs: [],
						hostEnv: { HERDR_SOCKET_PATH: socketPath, DETACH_DELAY: String(delay) },
						configPath: join(scratch, "config.toml"),
						shell: { defaultShell: null, shellMode: "non_login" as const },
						sessionFile: join(scratch, "session.json"),
						disposableDirs: [],
						cleanupArgs: null,
					}),
					paneLaunch: () => ({ env: {}, line: "" }),
					detach: (child: import("node:child_process").ChildProcess) => {
						detaches.push({ delay, marked: existsSync(exitMarkerPath(socketPath, "w1:p1")) });
						child.kill("SIGHUP");
					},
					afterClientExit: () => undefined,
				},
			});
			const waitForClients = async (count: number): Promise<void> => {
				for (let attempt = 0; attempt < 400 && attached.size !== count; attempt++) await sleep(25);
				equal(attached.size, count, "fixture clients did not attach");
			};
			const before = new Set(process.listeners("SIGTERM"));
			const creator = launchWorkspace(host(0));
			launches.push(creator);
			await waitForClients(1);
			const terminate = process.listeners("SIGTERM").find((handler) => !before.has(handler));
			ok(terminate);
			const beforeFollower = new Set(process.listeners("SIGTERM"));
			const follower = launchWorkspace(host(1_200));
			launches.push(follower);
			await waitForClients(2);
			if (scenario === "reused workspace") nonce = "00000000-0000-0000-0000-000000000000";
			const terminateFollower = process.listeners("SIGTERM").find((handler) => !beforeFollower.has(handler));
			ok(terminateFollower);
			const reattached = scenario === "reattached launcher";
			(reattached ? terminateFollower : terminate)("SIGTERM");
			const first = await (reattached ? follower : creator);
			equal(first.status, "closed");
			if (first.status === "closed") equal(first.exitCode, 143);
			if (scenario === "reused workspace" || reattached) {
				equal(stopped, false);
				equal(methods.includes("workspace.close"), false);
				equal(
					detaches.some((request) => request.marked),
					false,
				);
			} else {
				ok(detaches.some((request) => request.delay === 0 && request.marked));
				equal(replacements, 0, "closing the last workspace under an attached client must not create a replacement");
				equal(stopped, !other);
				equal(methods.includes("workspace.close"), other);
			}
			if (!reattached) await follower;
		});
	}
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
	it("does not reuse another Clio state root's host for the same project", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-identity-"));
		const saved = process.env.CLIO_CODER_STATE_DIR;
		t.after(() => {
			if (saved === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = saved;
			resetXdgCache();
			rmSync(scratch, { recursive: true, force: true });
		});
		const state = join(scratch, "state-a");
		mkdirSync(state);
		process.env.CLIO_CODER_STATE_DIR = state;
		resetXdgCache();
		const first = workspaceSessionFor(scratch);
		notEqual(first.session, `clio-coder-${createHash("sha256").update(first.cwd).digest("hex").slice(0, 12)}`);
		process.env.CLIO_CODER_STATE_DIR = join(scratch, "state-b");
		mkdirSync(process.env.CLIO_CODER_STATE_DIR);
		resetXdgCache();
		const second = workspaceSessionFor(scratch);
		notEqual(first.session, second.session);
		process.env.CLIO_CODER_STATE_DIR = state;
		resetXdgCache();
		deepStrictEqual(workspaceSessionFor(scratch), first);
		symlinkSync(state, join(scratch, "state-link"), "junction");
		symlinkSync(scratch, join(scratch, "project-link"), "junction");
		process.env.CLIO_CODER_STATE_DIR = join(scratch, "state-link");
		resetXdgCache();
		deepStrictEqual(workspaceSessionFor(join(scratch, "project-link")), first);
	});

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

	it("carries the clean-exit summary to the launcher in the marker", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-exit-marker-"));
		t.after(() => {
			holdExitSummaryForLauncher("");
			rmSync(scratch, { recursive: true, force: true });
		});
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(scratch, `${SESSION}.sock`), HERDR_PANE_ID: "w1:p2" };
		const marker = exitMarkerPath(env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID);
		const summary = "Clio Coder · Session summary\n/resume 0123\n";
		holdExitSummaryForLauncher(summary);
		markWorkspaceExit(env);
		deepStrictEqual(readWorkspaceExitResult(marker), { exitCode: 0, summary });
		equal(statSync(marker).mode & 0o777, 0o600);
		deepStrictEqual(readdirSync(scratch), [basename(marker)]);
		// A quit with nothing to report still marks the exit, with no summary to print.
		holdExitSummaryForLauncher("");
		markWorkspaceExit(env);
		deepStrictEqual(readWorkspaceExitResult(marker), { exitCode: 0, summary: null });
		writeFileSync(marker, "x".repeat(256 * 1024 + 1));
		equal(readWorkspaceExitResult(marker), null);
		equal(readWorkspaceExitResult(join(scratch, "missing")), null);
		equal(readWorkspaceExitResult(scratch), null);
	});

	it("carries crash and signal exit status so the launcher can dispose the private host without masking failure", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-exit-status-"));
		t.after(() => {
			holdExitSummaryForLauncher("");
			rmSync(scratch, { recursive: true, force: true });
		});
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(scratch, `${SESSION}.sock`), HERDR_PANE_ID: "w1:p2" };
		const marker = exitMarkerPath(env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID);
		holdExitSummaryForLauncher("session ended\n");
		for (const exitCode of [1, 143]) {
			markWorkspaceExit(env, exitCode);
			deepStrictEqual(readWorkspaceExitResult(marker), { exitCode, summary: "session ended\n" });
		}
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
	it("doctor reports what a bare launch does, nested inside the operator's herdr", () => {
		const operatorHerdr = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock" };
		const guest = { mode: "guest", reason: "guest mode on /home/me/.config/herdr/herdr.sock" };
		const nested = panesModeFinding(operatorHerdr, guest);
		equal(nested.level, "ok");
		match(nested.detail, /^nested; bare `clio-coder` opens Clio's private pane host inside this herdr pane/);
		match(nested.detail, /`clio-coder --with-panes` joins this herdr as a guest/);
		// An unreachable outside herdr does not stop the nested host, so it is not a warning.
		equal(panesModeFinding(operatorHerdr, { mode: "none", reason: "no socket answered" }).level, "ok");
		const own = panesModeFinding({ HERDR_ENV: "1", HERDR_SOCKET_PATH: `/run/u/clio-coder/${SESSION}.sock` }, guest);
		match(own.detail, /^guest; bare `clio-coder` stays in this pane \(already inside Clio's pane host\)/);
		const outside = panesModeFinding({ TERM: "xterm-256color" }, null);
		match(outside.detail, /^Clio's private pane host opens with bare `clio-coder`/);
		match(
			panesModeFinding({ TMUX: "/x/tmux" }, null).detail,
			/^plain; bare `clio-coder` stays in this terminal \(already inside a terminal multiplexer \(TMUX\)\)/,
		);
	});
});

describe("doctor's panes binary row", () => {
	it("names the pinned herdr the launcher runs, not a herdr on PATH", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-panes-binary-"));
		const saved = { PATH: process.env.PATH, CLIO_CODER_DATA_DIR: process.env.CLIO_CODER_DATA_DIR };
		t.after(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(scratch, { recursive: true, force: true });
		});
		const pin = findPinnedTool("herdr");
		ok(pin);
		// A PATH herdr that meets the floor, which the private host still never runs.
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "herdr ${pin.version}"\n`);
		chmodSync(join(bin, "herdr"), 0o755);
		process.env.PATH = bin;
		process.env.CLIO_CODER_DATA_DIR = join(scratch, "data");
		const env = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: join(scratch, "operator.sock"),
			XDG_CONFIG_HOME: join(scratch, "cfg"),
			HOME: scratch,
		};
		const row = async (): Promise<{ level?: string; detail: string } | undefined> =>
			(await panesFindings(env)).find((finding) => finding.name === "panes binary");

		const missing = await row();
		equal(missing?.level, "warn");
		match(missing?.detail ?? "", /is not installed; the next `clio-coder` installs it/);
		equal(missing?.detail.includes(bin), false);

		const vendored = join(scratch, "data", "tools", "herdr", pin.version, "herdr");
		mkdirSync(join(vendored, ".."), { recursive: true });
		writeFileSync(vendored, "");
		const present = await row();
		equal(present?.level, "ok");
		equal(present?.detail, `pane host ${pin.version} (Clio's pinned copy) at ${vendored}`);
	});
});

describe("toolchain mirror", () => {
	it("maps a pinned URL onto a mirror directory, file URL or HTTP mirror, namespaced first and flat second", () => {
		const url = "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64";
		deepStrictEqual(mirroredSources(url, "/srv/mirror", "herdr", "0.9.5"), [
			"/srv/mirror/herdr/0.9.5/herdr-linux-x86_64",
			"/srv/mirror/herdr-linux-x86_64",
		]);
		deepStrictEqual(mirroredSources(url, "file:///srv/mirror", "herdr", "0.9.5"), [
			"/srv/mirror/herdr/0.9.5/herdr-linux-x86_64",
			"/srv/mirror/herdr-linux-x86_64",
		]);
		deepStrictEqual(mirroredSources(url, "https://cache.example/herdr/", "herdr", "0.9.5"), [
			"https://cache.example/herdr/herdr/0.9.5/herdr-linux-x86_64",
			"https://cache.example/herdr/herdr-linux-x86_64",
		]);
		deepStrictEqual(
			mirroredSources("https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/LICENSE", "/srv/mirror", "herdr", "0.9.5"),
			["/srv/mirror/herdr/0.9.5/LICENSE", "/srv/mirror/LICENSE"],
		);
	});

	it("installs tools whose same-named LICENSE files differ from one mirror, and still reads a legacy flat mirror", async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-toolchain-mirror-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
		const fixture = (id: string, version: string) => {
			const program = `${id} program`;
			const license = `${id} license text`;
			return {
				program,
				license,
				entry: {
					id,
					version,
					summary: id,
					homepage: "https://fixture.invalid",
					license: "MIT",
					binaries: [id],
					primaryBinary: id,
					minimumVersion: version,
					versionArgs: ["--version"],
					downloads: {
						"linux-x64": {
							url: `https://fixture.invalid/${id}/releases/${id}-linux`,
							sha256: digest(program),
							archive: "raw" as const,
							binaryMembers: { [id]: "" },
							documentMembers: [],
						},
					},
					documents: [{ name: "LICENSE", url: `https://fixture.invalid/${id}/LICENSE`, sha256: digest(license) }],
				},
			};
		};
		const alpha = fixture("alpha", "1.0.0");
		const beta = fixture("beta", "2.0.0");
		const install = (entry: typeof alpha.entry, mirror: string, root: string) =>
			installPinnedTool(entry, { root, platform: "linux-x64", mirror });

		const namespaced = join(scratch, "namespaced");
		for (const tool of [alpha, beta]) {
			const dir = join(namespaced, tool.entry.id, tool.entry.version);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${tool.entry.id}-linux`), tool.program);
			writeFileSync(join(dir, "LICENSE"), tool.license);
		}
		// A stale flat LICENSE from another tool must not shadow the namespaced copy.
		writeFileSync(join(namespaced, "LICENSE"), beta.license);
		for (const tool of [alpha, beta]) {
			const result = await install(tool.entry, namespaced, join(scratch, "tools-namespaced"));
			equal(result.ok, true, result.message);
			equal(readFileSync(join(result.dir, "LICENSE"), "utf8"), tool.license);
		}

		const flat = join(scratch, "flat");
		mkdirSync(flat, { recursive: true });
		writeFileSync(join(flat, "alpha-linux"), alpha.program);
		writeFileSync(join(flat, "LICENSE"), alpha.license);
		const legacy = await install(alpha.entry, flat, join(scratch, "tools-flat"));
		equal(legacy.ok, true, legacy.message);
		equal(readFileSync(join(legacy.dir, "LICENSE"), "utf8"), alpha.license);

		// The flat LICENSE belongs to alpha, so beta has no copy with its pinned bytes.
		writeFileSync(join(flat, "beta-linux"), beta.program);
		const refused = await install(beta.entry, flat, join(scratch, "tools-refused"));
		equal(refused.ok, false);
		match(refused.message, /checksum mismatch for .*flat\/LICENSE/);
		equal(existsSync(refused.dir), false);
	});
});
