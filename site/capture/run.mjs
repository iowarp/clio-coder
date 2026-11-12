#!/usr/bin/env node
// Records the site's terminal captures from scenarios.json: an asciicast v2
// recording, a plain-text transcript, and stills rendered from the recording by
// the same player the site embeds. One command reruns any of them:
//
//   node site/capture/run.mjs --scratch <dir> [--only id,id] [--clio <path>] [--build-note <text>] [--publish --shots id,id]
//   node site/capture/run.mjs --scratch <dir> --release <version> [--package <tarball>] [--publish]
//
// --release re-records every scenario from a release: it installs
// @iowarp/clio-coder@<version> (or --package, a packed candidate of that version)
// into <scratch>/npm-<version>, rewrites version literals in each alt and caption
// to that version, holds the model lock for the whole recording phase (and stops
// at once if another user holds it), runs quote-check.mjs at the end, and writes
// wall and lock times per capture to <scratch>/timings.json. It lists Terminal
// captures in content/captures.json that no scenario re-records.
//
// --clio names the build to record: a repository checkout with dist/ built, or a
// prefix from `npm install -g --prefix <dir> @iowarp/clio-coder@beta` (or a packed
// candidate), which doctor reports as an npm global install. --build-note says
// where a build that is not a release came from. Live
// scenarios need CLIO_CAPTURE_GATEWAY_URL, LITELLM_API_KEY and CLIO_CAPTURE_LOCK
// (the lock file that serializes use of the model host). The key stays in this
// process; the recorded session sees only the loopback alias and a placeholder.
// A scenario with privateNet runs in its own network namespace: the alias proxy
// listens on a unix socket, and a forwarder inside the sandbox serves it on the
// given port, so a default model port such as 4000 never opens on the host.
// privateNet without a port isolates the sandbox to its own loopback. peers
// lists host agent CLIs bound read-only into ~/.local/bin for interop screens.
// A stillsOnly scenario publishes only its stills.
// Without --publish, output stays in <scratch>/<id>/out for review. --publish
// writes only the captures named in --shots (stills, or a scenario id for its
// cast); the other stills of a scenario stay in scratch, so a re-take made for one
// screen does not replace the others. --release publishes every capture it makes.
// Every capture rendered goes through alt-check.mjs: figures in its alt and
// caption must appear in the recording, and the run lists each for a human read.
// Casts are
// compacted losslessly before stills are rendered; compact.mjs says how.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ALIAS, startAliasProxy } from "./alias-proxy.mjs";
import { altCheck, printAltCheck } from "./alt-check.mjs";
import { compactEvents } from "./compact.mjs";
import { plain, privacyHits, scanChunks } from "./privacy.mjs";
import { quoteCheck } from "./quote-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);
const repo = dirname(site);
const { values } = parseArgs({
	options: {
		scratch: { type: "string" },
		only: { type: "string" },
		clio: { type: "string" },
		release: { type: "string" },
		package: { type: "string" },
		// Where the build under capture came from, when it is not a release (published in each source line).
		"build-note": { type: "string" },
		publish: { type: "boolean", default: false },
		shots: { type: "string" },
		list: { type: "boolean", default: false },
		chrome: { type: "string", default: process.env.CLIO_CODER_CHROME ?? "/usr/bin/google-chrome" },
	},
});
const spec = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8"));
if (values.list) {
	for (const scenario of spec.scenarios)
		console.log(`${scenario.id}${scenario.live ? " (live)" : ""}: ${scenario.summary}`);
	process.exit(0);
}
if (!values.scratch) throw new Error("--scratch <dir> is required; recordings are made outside the repository.");
const scratch = resolve(values.scratch);
const only = values.only ? new Set(values.only.split(",")) : null;
const scenarios = spec.scenarios.filter((scenario) => !only || only.has(scenario.id));
if (only && scenarios.length !== only.size) throw new Error(`Unknown scenario in --only: ${values.only}`);

const startedAt = Date.now();
if (values.release && values.clio) throw new Error("--release installs its own build; drop --clio.");
if (values.package && !values.release) throw new Error("--package needs --release <version>.");
if (values.publish && !values.release && !values.shots)
	throw new Error("--publish needs --shots id,id: the captures to replace (--release publishes all).");
if (values.shots && (values.release || !values.publish))
	throw new Error("--shots goes with --publish, without --release.");
const shots = values.shots ? new Set(values.shots.split(",")) : null;
if (shots) {
	const makes = new Set(
		scenarios.flatMap((scenario) => [
			...(scenario.stillsOnly ? [] : [scenario.id]),
			...Object.keys(scenario.shots ?? {}),
		]),
	);
	const unknown = [...shots].filter((id) => !makes.has(id));
	if (unknown.length) throw new Error(`--shots names captures this run does not make: ${unknown.join(", ")}`);
}
const installMs = values.release ? installRelease(values.release, values.package) : 0;

// The build under capture, bound read-only at /opt/clio-coder inside the sandbox.
const clio = resolveClio(values.release ? releasePrefix(values.release) : resolve(values.clio ?? repo));
const clioVersion = JSON.parse(readFileSync(join(clio.root, clio.packageDir, "package.json"), "utf8")).version;
if (values.release && clioVersion !== values.release)
	throw new Error(`${values.package ?? "the npm package"} is ${clioVersion}, not ${values.release}.`);
// A version literal after the product's name (x.y.z or x.y.z-pre.n) in alt,
// caption and provenance text names the build recorded; other versions stay.
const versionLiteral =
	/(?<=(?:CLIO Coder|Clio Coder|clio-coder|@iowarp\/clio-coder@)\s?v?)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?![\w-]|\.\d)/g;
const versioned = (text) => (values.release && text ? text.replace(versionLiteral, clioVersion) : text);
const installed =
	clio.packageDir === "."
		? "built from the repository,"
		: clio.packageDir.startsWith("lib/")
			? "installed with npm install -g,"
			: "installed with npm into a local prefix,";
const nodePrefix = dirname(dirname(process.execPath));
const node = `/opt/node/${relative(nodePrefix, process.execPath)}`;
const uid = userInfo().uid;
const gid = userInfo().gid;

function releasePrefix(version) {
	return join(scratch, `npm-${version}`);
}

function installRelease(version, tarball) {
	const begin = Date.now();
	const prefix = releasePrefix(version);
	rmSync(prefix, { recursive: true, force: true });
	console.log(`release ${version}: installing ${tarball ? resolve(tarball) : `@iowarp/clio-coder@${version}`}`);
	execFileSync(
		"npm",
		[
			"install",
			"-g",
			"--prefix",
			prefix,
			"--no-audit",
			"--no-fund",
			tarball ? resolve(tarball) : `@iowarp/clio-coder@${version}`,
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	return Date.now() - begin;
}

function resolveClio(path) {
	for (const packageDir of [".", "lib/node_modules/@iowarp/clio-coder", "node_modules/@iowarp/clio-coder"])
		if (existsSync(join(path, packageDir, "dist/cli/index.js"))) return { root: path, packageDir };
	throw new Error(`${path} has no dist/cli/index.js: build it or install @iowarp/clio-coder under it.`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", ...options });

// Operator values that must never appear in anything published.
const secrets = [
	process.env.LITELLM_API_KEY,
	process.env.CLIO_CAPTURE_GATEWAY_URL,
	process.env.CLIO_CAPTURE_GATEWAY_URL && new URL(process.env.CLIO_CAPTURE_GATEWAY_URL).host,
	userInfo().username,
	homedir(),
	hostname(),
	scratch,
];

function prepareHome(dir, scenario) {
	const home = join(dir, "home/researcher");
	rmSync(dir, { recursive: true, force: true });
	for (const sub of [
		".config/clio-coder",
		".local/share/clio-coder",
		".local/state/clio-coder",
		".cache/clio-coder",
		".local/bin",
		"projects",
	])
		mkdirSync(join(home, sub), { recursive: true });
	writeFileSync(
		join(home, ".local/bin/clio-coder"),
		`#!/bin/sh\nexec ${node} /opt/clio-coder/${clio.packageDir}/dist/cli/index.js "$@"\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(home, ".bashrc"),
		["PS1='\\[\\e[2m\\]\\w\\[\\e[0m\\] \\$ '", "HISTFILE=/dev/null", "alias ls='ls --color=auto'", ""].join("\n"),
	);
	writeFileSync(
		join(dir, "passwd"),
		`root:x:0:0:root:/root:/bin/sh\nresearcher:x:${uid}:${gid}:Researcher:/home/researcher:/bin/bash\n`,
	);
	writeFileSync(join(dir, "group"), `root:x:0:\nresearcher:x:${gid}:\n`);
	if (scenario.privateNet) mkdirSync(join(dir, "net"));
	if (scenario.repo) seedRepo(join(home, "projects", scenario.repo), scenario.fixture ?? scenario.repo, scenario);
	// After the repository, so a file such as an untracked .env can sit inside it.
	for (const [path, text] of Object.entries(scenario.homeFiles ?? {})) {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), text, { mode: 0o600 });
	}
	if (scenario.profile === "configured") {
		writeFileSync(
			join(home, ".config/clio-coder/settings.yaml"),
			[
				"version: 2",
				`targets: [ { id: litellm, runtime: litellm, url: "http://127.0.0.1:${scenario.privateNet?.port ?? scenario.proxyPort ?? spec.proxyPort}", defaultModel: ${ALIAS}, auth: { apiKeyEnvVar: LITELLM_API_KEY } } ]`,
				`chat: { target: litellm, model: ${ALIAS} }`,
				`fleet: { default: { target: litellm, model: ${ALIAS} } }`,
				...(scenario.settings ?? []),
				"",
			].join("\n"),
		);
	}
	return home;
}

function seedRepo(path, name, scenario) {
	const fixture = JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
	rmSync(path, { recursive: true, force: true });
	run("unzip", ["-q", "-o", join(site, fixture.archive), "-d", dirname(path)]);
	if (fixture.root !== basename(path)) run("mv", [join(dirname(path), fixture.root), path]);
	for (const edit of fixture.edits ?? []) {
		const file = join(path, edit.file);
		const text = readFileSync(file, "utf8");
		if (!text.includes(edit.find)) throw new Error(`Fixture ${name}: ${edit.file} lacks ${edit.find}`);
		writeFileSync(file, text.replace(edit.find, edit.replace));
	}
	for (const [file, text] of Object.entries(fixture.files ?? {})) {
		mkdirSync(dirname(join(path, file)), { recursive: true });
		writeFileSync(join(path, file), text);
	}
	for (const command of fixture.run ?? []) run("sh", ["-c", command], { cwd: path, env: gitEnv() });
	const env = {
		...gitEnv(),
		GIT_AUTHOR_DATE: "2026-11-02T09:00:00Z",
		GIT_COMMITTER_DATE: "2026-11-02T09:00:00Z",
	};
	run("git", ["init", "-q", "-b", "main"], { cwd: path, env });
	run("git", ["add", "-A"], { cwd: path, env });
	run("git", ["commit", "-q", "-m", fixture.commit], { cwd: path, env });
	if (scenario.remote) {
		const remote = basename(path);
		const bare = join(dirname(dirname(path)), "remotes", `${remote}.git`);
		run("git", ["init", "-q", "--bare", bare], { env });
		run("git", ["remote", "add", "origin", `/home/researcher/remotes/${remote}.git`], { cwd: path, env });
		run("git", ["push", "-q", bare, "main"], { cwd: path, env });
		// The remote URL is the sandbox path, so record the tracking state by hand.
		run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: path, env });
		run("git", ["config", "branch.main.remote", "origin"], { cwd: path, env });
		run("git", ["config", "branch.main.merge", "refs/heads/main"], { cwd: path, env });
	}
}

function gitEnv() {
	return {
		PATH: process.env.PATH,
		HOME: "/nonexistent",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Researcher",
		GIT_AUTHOR_EMAIL: "researcher@example.org",
		GIT_COMMITTER_NAME: "Researcher",
		GIT_COMMITTER_EMAIL: "researcher@example.org",
	};
}

// The sandboxed shell the recording runs: a fresh home bound at
// /home/researcher, host name `lab`, a private /tmp, and only the environment below.
function sandboxScript(dir, scenario) {
	const env = {
		HOME: "/home/researcher",
		USER: "researcher",
		LOGNAME: "researcher",
		SHELL: "/bin/bash",
		PATH: `/home/researcher/.local/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin`,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		COLORFGBG: "15;0",
		LANG: "C.UTF-8",
		TMPDIR: "/tmp",
		CLIO_CODER_CONFIG_DIR: "/home/researcher/.config/clio-coder",
		CLIO_CODER_DATA_DIR: "/home/researcher/.local/share/clio-coder",
		CLIO_CODER_STATE_DIR: "/home/researcher/.local/state/clio-coder",
		CLIO_CODER_CACHE_DIR: "/home/researcher/.cache/clio-coder",
		CLIO_CODER_INTEROP_HOME: "none",
		// A placeholder: the alias proxy holds the gateway key, outside the sandbox.
		LITELLM_API_KEY: "capture-placeholder",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
		NPM_CONFIG_FUND: "false",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Researcher",
		GIT_AUTHOR_EMAIL: "researcher@example.org",
		GIT_COMMITTER_NAME: "Researcher",
		GIT_COMMITTER_EMAIL: "researcher@example.org",
		...(scenario.env ?? {}),
	};
	const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
	const args = [
		"bwrap",
		"--dev-bind",
		"/",
		"/",
		"--tmpfs",
		"/home",
		"--bind",
		join(dir, "home/researcher"),
		"/home/researcher",
		"--ro-bind",
		join(dir, "passwd"),
		"/etc/passwd",
		"--ro-bind",
		join(dir, "group"),
		"/etc/group",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/opt",
		"--ro-bind",
		nodePrefix,
		"/opt/node",
		"--ro-bind",
		clio.root,
		"/opt/clio-coder",
		...(scenario.privateNet ? ["--bind", join(dir, "net"), "/opt/net", "--unshare-net", "--unshare-pid"] : []),
		...[...(scenario.peers ?? []), ...(scenario.hostTools ?? [])].flatMap((name) => [
			"--ro-bind",
			peerPath(name),
			`/home/researcher/.local/bin/${name}`,
		]),
		"--unshare-uts",
		"--unshare-ipc",
		"--hostname",
		"lab",
		"--die-with-parent",
		"--clearenv",
		...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
		"--chdir",
		scenario.repo ? `/home/researcher/projects/${scenario.repo}` : "/home/researcher",
		"/bin/bash",
		"--noprofile",
		"--rcfile",
		"/home/researcher/.bashrc",
		"-i",
	];
	if (scenario.privateNet?.port) {
		// Inside the sandbox's own network namespace, the model port forwards to the
		// alias proxy's socket; nothing listens on the host's loopback.
		const forward = [
			'import { connect, createServer } from "node:net";',
			"createServer((client) => {",
			'\tconst server = connect("/opt/net/alias.sock");',
			"\tclient.pipe(server).pipe(client);",
			'\tfor (const end of [client, server]) end.on("error", () => { client.destroy(); server.destroy(); });',
			`}).listen(${scenario.privateNet.port}, "127.0.0.1");`,
			"",
		].join("\n");
		writeFileSync(join(dir, "net/forward.mjs"), forward);
		const at = args.lastIndexOf("/bin/bash");
		args.splice(at, 0, "/bin/sh", "-c", 'node /opt/net/forward.mjs & exec "$@"', "sh");
	}
	const script = join(dir, "sandbox.sh");
	writeFileSync(script, `#!/bin/sh\nexec ${args.map(quote).join(" ")}\n`, { mode: 0o700 });
	return script;
}

// A peer agent CLI or host tool from the host's PATH, bound read-only into ~/.local/bin.
function peerPath(name) {
	const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
	if (!found) throw new Error(`${name} is not on this host's PATH.`);
	return execFileSync("readlink", ["-f", found], { encoding: "utf8" }).trim();
}

class Session {
	constructor(dir, scenario) {
		this.dir = dir;
		this.id = scenario.id;
		this.cols = scenario.cols ?? spec.cols;
		this.rows = scenario.rows ?? spec.rows;
		this.socket = join(dir, "tmux.sock");
		this.cast = join(dir, "raw.cast");
		this.markers = [];
		this.chapters = [];
	}
	tmux(...args) {
		return run("tmux", ["-S", this.socket, ...args], { env: { ...process.env, TMUX: "" } });
	}
	start(script) {
		const config = join(this.dir, "tmux.conf");
		writeFileSync(config, "set -g status off\nset -g history-limit 2000\nset -g escape-time 0\n");
		const record = [
			"asciinema",
			"rec",
			"--quiet",
			"--overwrite",
			"--output-format",
			"asciicast-v2",
			"--window-size",
			`${this.cols}x${this.rows}`,
			"-c",
			script,
			this.cast,
		].join(" ");
		this.t0 = Date.now();
		run(
			"tmux",
			[
				"-S",
				this.socket,
				"-f",
				config,
				"new-session",
				"-d",
				"-s",
				"cap",
				"-x",
				String(this.cols),
				"-y",
				String(this.rows),
				record,
			],
			{
				env: { PATH: process.env.PATH, HOME: this.dir, TERM: "xterm-256color", TMPDIR: this.dir, LANG: "C.UTF-8" },
			},
		);
	}
	screen(joined = false) {
		try {
			return this.tmux("capture-pane", "-p", ...(joined ? ["-J"] : []), "-t", "cap");
		} catch {
			return null;
		}
	}
	alive() {
		return spawnSync("tmux", ["-S", this.socket, "has-session", "-t", "cap"]).status === 0;
	}
	now() {
		return (Date.now() - this.t0) / 1000;
	}
	async step(step) {
		if (step.wait !== undefined) {
			const deadline = Date.now() + (step.timeout ?? 60) * 1000;
			const pattern = new RegExp(step.wait, "m");
			while (!pattern.test(this.screen() ?? "")) {
				if (Date.now() > deadline || !this.alive())
					throw new Error(`${this.id}: timed out waiting for /${step.wait}/; screen:\n${this.screen() ?? "(ended)"}`);
				await sleep(150);
			}
		}
		// A live turn asks for approval as often as the model decides to; `until`
		// waits for the turn to end and allows each call that `approve` matches.
		if (step.until !== undefined) {
			const deadline = Date.now() + (step.timeout ?? 300) * 1000;
			const done = new RegExp(step.until, "m");
			const ask = step.approve && new RegExp(step.approve, "m");
			for (;;) {
				const screen = this.screen() ?? "";
				if (done.test(screen)) break;
				if (Date.now() > deadline || !this.alive())
					throw new Error(`${this.id}: timed out waiting for /${step.until}/; screen:\n${screen || "(ended)"}`);
				if (ask?.test(screen)) {
					await sleep((step.read ?? 1.5) * 1000);
					if (step.approveShot && !this.markers.some((marker) => marker.shot === step.approveShot))
						await this.step({ shot: step.approveShot, rows: step.approveRows });
					this.tmux("send-keys", "-t", "cap", step.answer ?? "Enter");
					const left = Date.now() + 10000;
					while (ask.test(this.screen() ?? "") && Date.now() < left) await sleep(150);
				}
				await sleep(150);
			}
		}
		if (step.gone !== undefined) {
			const deadline = Date.now() + (step.timeout ?? 60) * 1000;
			const pattern = new RegExp(step.gone, "m");
			while (pattern.test(this.screen() ?? "")) {
				if (Date.now() > deadline) throw new Error(`${this.id}: /${step.gone}/ stayed on screen`);
				await sleep(150);
			}
		}
		// A list whose order depends on the live turn: press `key` until `seek`
		// shows, at most `max` times.
		if (step.seek !== undefined) {
			const pattern = new RegExp(step.seek, "m");
			for (let presses = 0; !pattern.test(this.screen() ?? ""); presses++) {
				if (presses >= (step.max ?? 30)) throw new Error(`${this.id}: /${step.seek}/ not reached with ${step.key}`);
				this.tmux("send-keys", "-t", "cap", step.key ?? "Down");
				await sleep(step.delay ?? 250);
			}
		}
		if (step.pause) await sleep(step.pause * 1000);
		if (step.type !== undefined)
			for (const char of step.type) {
				this.firstKey ??= { time: this.now(), char };
				this.tmux("send-keys", "-t", "cap", "-l", char === ";" ? "\\;" : char);
				await sleep(step.delay ?? 45);
			}
		if (step.keys)
			for (const key of step.keys) {
				this.tmux("send-keys", "-t", "cap", key);
				await sleep(step.delay ?? 120);
			}
		if (step.marker || step.shot) {
			const label = step.marker ?? step.shot;
			this.markers.push({ time: this.now(), label, shot: step.shot, crop: step.rows, still: step.still });
			this.chapters.push({ label, text: this.screen(true) ?? "" });
		}
	}
	async finish(timeout = 30) {
		const deadline = Date.now() + timeout * 1000;
		while (this.alive() && Date.now() < deadline) await sleep(200);
		if (this.alive()) this.tmux("kill-server");
	}
}

// Fixed header, idle gaps capped, markers placed on the same compressed clock.
// endAt names a marker where the published recording ends; what follows it is dropped.
function finishCast(session, endAt) {
	const [, ...lines] = readFileSync(session.cast, "utf8").trimEnd().split("\n");
	const cap = spec.idleCap;
	const events = lines.map((line) => JSON.parse(line)).filter(([, kind]) => kind === "o" || kind === "r");
	// asciinema starts a little after the harness clock; the echo of the first
	// typed key ties the two together.
	const echo = session.firstKey && events.find(([, , data]) => data === session.firstKey.char);
	const offset = echo ? session.firstKey.time - echo[0] : 0;
	const raw = events.map(([time]) => time);
	let shift = 0;
	let last = 0;
	for (const event of events) {
		const gap = event[0] - last;
		if (gap > cap) shift += gap - cap;
		last = event[0];
		event[0] = Math.round((event[0] - shift) * 1e6) / 1e6;
	}
	let markers = session.markers.map((marker) => {
		// A marker sits just after the last output it waited for, so the frame is
		// complete. Scenarios pause before each marker; the margin absorbs clock skew.
		const at = marker.time - offset - 0.15;
		const index = raw.findLastIndex((time) => time <= at);
		const time = Math.round(((events[index]?.[0] ?? 0) + 0.05) * 1000) / 1000;
		return { ...marker, time, index };
	});
	if (endAt) {
		const end = markers.find((marker) => marker.label === endAt);
		if (!end) throw new Error(`${session.id}: the end marker ${endAt} was not reached`);
		events.splice(end.index + 1);
		markers = markers.slice(0, markers.indexOf(end) + 1);
	}
	const all = compactEvents(
		[...events, ...markers.map((marker) => [marker.time, "m", marker.label])].sort((a, b) => a[0] - b[0]),
	);
	const header = { version: 2, width: session.cols, height: session.rows, theme: spec.theme };
	const text = `${[JSON.stringify(header), ...all.map((event) => JSON.stringify(event))].join("\n")}\n`;
	const duration = endAt ? markers.at(-1).time : (events.at(-1)?.[0] ?? 0);
	return { text, markers, duration, events };
}

function transcript(session, scenario) {
	const end = session.chapters.findIndex((chapter) => chapter.label === scenario.endAt);
	const chapters = session.chapters.slice(0, end < 0 ? undefined : end + 1).map(({ label, text }) => {
		const lines = text.split("\n").map((line) => line.trimEnd());
		while (lines.length && !lines.at(-1)) lines.pop();
		return `== ${label}\n\n${lines.join("\n")}`;
	});
	return `${scenario.title}\nRecorded with CLIO Coder ${clioVersion}. Each section is the terminal screen at that moment.\n\n${chapters.join("\n\n")}\n`;
}

// Stills come from the recording through the player the site embeds, in the same fonts.
async function renderStills(castText, stills, outDir) {
	if (!stills.length) return [];
	const require = createRequire(join(repo, "apps/clio-coder-gui/package.json"));
	const { chromium } = require("playwright-core");
	const browser = await chromium.launch({ executablePath: values.chrome, headless: true });
	const files = {
		"/player.js": [join(site, "vendor/asciinema-player/asciinema-player.min.js"), "text/javascript"],
		"/player.css": [join(site, "vendor/asciinema-player/asciinema-player.css"), "text/css"],
		"/cast-symbols.woff2": [join(site, "vendor/cast-symbols/cast-symbols.woff2"), "font/woff2"],
		"/plex-400.woff2": [join(site, "assets/fonts/plex-400.woff2"), "font/woff2"],
		"/plex-500.woff2": [join(site, "assets/fonts/plex-500.woff2"), "font/woff2"],
	};
	const page = await (
		await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 1000 } })
	).newPage();
	await page.route("http://capture.invalid/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/") {
			return route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/player.css"><style>
@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(/plex-400.woff2)}
@font-face{font-family:"IBM Plex Mono";font-weight:500 700;src:url(/plex-500.woff2)}
@font-face{font-family:"Cast Symbols";src:url(/cast-symbols.woff2)}
body{margin:0;background:${spec.theme.bg}}
#host{display:inline-block;padding:16px;background:${spec.theme.bg}}
.ap-player{--term-font-family:"IBM Plex Mono","Cast Symbols",monospace}
.ap-overlay-start,.ap-control-bar{display:none!important}
</style><div id="host"></div><script src="/player.js"></script>`,
			});
		}
		const [file, type] = files[path] ?? [];
		return file ? route.fulfill({ path: file, contentType: type }) : route.fulfill({ status: 404 });
	});
	await page.goto("http://capture.invalid/");
	const results = [];
	for (const still of stills) {
		await page.evaluate(
			async ({ data, time }) => {
				document.querySelector("#host").replaceChildren();
				const el = document.createElement("div");
				document.querySelector("#host").append(el);
				window.AsciinemaPlayer.create({ data }, el, {
					poster: `npt:${time}`,
					fit: false,
					terminalFontSize: "15px",
					controls: false,
				});
				await document.fonts.load('15px "IBM Plex Mono"');
				await document.fonts.load('15px "Cast Symbols"', "✓⣾");
			},
			{ data: castText, time: still.time },
		);
		await page.waitForSelector(".ap-term");
		await page.waitForTimeout(400);
		const term = await page.$(".ap-term");
		let clip = null;
		if (still.crop) {
			let box = await term.boundingBox();
			// A clip is cut at the viewport edge; grow the viewport to hold the whole terminal.
			const needed = Math.ceil(box.y + box.height + 32);
			if (needed > page.viewportSize().height) {
				await page.setViewportSize({ width: page.viewportSize().width, height: needed });
				box = await term.boundingBox();
			}
			const [from, to] = still.crop;
			// Measured per row: the player's line boxes, not the terminal height divided evenly.
			const lines = await page.$$eval(".ap-term .ap-line", (els) =>
				els.map((el) => {
					const rect = el.getBoundingClientRect();
					return [rect.top, rect.bottom];
				}),
			);
			if (lines.length !== still.rows) throw new Error(`${still.id}: the player drew ${lines.length} rows`);
			clip = {
				x: box.x - 16,
				y: lines[from - 1][0] - 16,
				width: box.width + 32,
				height: lines[to - 1][1] - lines[from - 1][0] + 32,
			};
		}
		const path = join(outDir, `${still.id}.png`);
		if (clip) {
			await page.screenshot({ path, clip });
			// The margin above and below a crop shows parts of the neighbouring rows; paint it as background.
			run("python3", [
				"-c",
				"import sys;from PIL import Image,ImageDraw;i=Image.open(sys.argv[1]).convert('RGB');d=ImageDraw.Draw(i);w,h=i.size;m=int(sys.argv[2]);d.rectangle([0,0,w,m-1],fill=sys.argv[3]);d.rectangle([0,h-m,w,h],fill=sys.argv[3]);i.save(sys.argv[1])",
				path,
				"32",
				spec.theme.bg,
			]);
		} else await (await page.$("#host")).screenshot({ path });
		results.push({ ...still, path });
	}
	await browser.close();
	return results;
}

function pngSize(path) {
	const data = readFileSync(path);
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

// Holds the model host lock until release(); resolves once it is acquired, so
// waiting for another user of the model never shows in a recording. With
// wait false it fails at once when the lock is busy.
function holdLock(path, { wait = true } = {}) {
	return new Promise((done, fail) => {
		const child = spawn("flock", [...(wait ? [] : ["-n"]), path, "sh", "-c", "echo locked; exec cat"], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		child.on("error", fail);
		child.on("exit", (code) =>
			fail(
				new Error(
					wait ? `flock exited ${code} before taking the lock` : `the model lock ${path} is busy; nothing was recorded`,
				),
			),
		);
		child.stdout.once("data", () => {
			child.removeAllListeners("exit");
			const heldAt = Date.now();
			done(() => {
				child.stdin.end();
				return Date.now() - heldAt;
			});
		});
	});
}

function requireLiveEnv() {
	if (!process.env.CLIO_CAPTURE_LOCK)
		throw new Error("Live scenarios need CLIO_CAPTURE_LOCK, the model host lock file.");
	if (!process.env.CLIO_CAPTURE_GATEWAY_URL) throw new Error("Live scenarios need CLIO_CAPTURE_GATEWAY_URL.");
}

// Records one scenario and scans it; rendering waits until the model lock is
// free. timing gets recordMs and lockMs, also when recording fails.
async function record(scenario, lockHeld, timing) {
	let release = null;
	let proxy = null;
	const begin = Date.now();
	timing.lockMs = 0;
	try {
		const dir = join(scratch, scenario.id);
		const outDir = join(dir, "out");
		prepareHome(dir, scenario);
		mkdirSync(outDir, { recursive: true });
		if (scenario.live) {
			requireLiveEnv();
			if (!lockHeld) {
				console.log(`${scenario.id}: waiting for the model lock`);
				release = await holdLock(process.env.CLIO_CAPTURE_LOCK);
			}
			proxy = await startAliasProxy({
				gateway: process.env.CLIO_CAPTURE_GATEWAY_URL,
				apiKey: process.env.LITELLM_API_KEY,
				port: scenario.privateNet?.port ? join(dir, "net/alias.sock") : (scenario.proxyPort ?? spec.proxyPort),
				log: (line) => writeFileSync(join(scratch, "alias-proxy.log"), `${line}\n`, { flag: "a" }),
			});
		}
		const recordAt = Date.now();
		const session = new Session(dir, scenario);
		console.log(`${scenario.id}: recording`);
		session.start(sandboxScript(dir, scenario));
		try {
			for (const step of scenario.steps) await session.step(step);
			await session.finish(scenario.exitTimeout ?? 30);
		} catch (error) {
			if (session.alive()) session.tmux("kill-server");
			throw error;
		}
		if (scenario.live && lockHeld) timing.lockMs = Date.now() - recordAt;
		const cast = finishCast(session, scenario.endAt);
		const text = transcript(session, scenario);
		// Stills are rendered from this cast alone, so scanning it covers them too.
		const hits = [
			...scanChunks(
				cast.events.map(([, , data]) => plain(data)),
				secrets,
			),
			...scanChunks(
				cast.events.map(([, , data]) => data),
				secrets,
			),
			// The cast file holds these events (some dropped by compaction), its header, and the markers.
			...privacyHits(
				[cast.text.slice(0, cast.text.indexOf("\n")), ...cast.markers.map((marker) => marker.label)].join("\n"),
				secrets,
			),
			...privacyHits(text, secrets),
		];
		writeFileSync(join(outDir, `${scenario.id}.cast`), cast.text);
		writeFileSync(join(outDir, `${scenario.id}.txt`), text);
		if (hits.length) throw new Error(`${scenario.id}: privacy scan failed: ${[...new Set(hits)].join("; ")}`);
		return { scenario, outDir, session: { cols: session.cols, rows: session.rows }, cast, timing };
	} finally {
		if (proxy) await new Promise((done) => proxy.close(done));
		if (release) timing.lockMs = release();
		timing.recordMs = Date.now() - begin;
	}
}

async function render({ scenario, outDir, session, cast }) {
	const stills = cast.markers
		.filter((marker) => marker.shot)
		.map((marker) => ({ id: marker.shot, time: marker.time, crop: marker.crop, rows: session.rows }));
	// A stills-only scenario publishes its stills; its cast stays in scratch for review.
	const poster = scenario.stillsOnly ? null : cast.markers.find((marker) => marker.label === scenario.poster);
	if (!scenario.stillsOnly && !poster)
		throw new Error(`${scenario.id}: the poster marker ${scenario.poster} was not reached`);
	if (poster) stills.push({ id: scenario.id, time: poster.time, rows: session.rows });
	const rendered = await renderStills(cast.text, stills, outDir);
	for (const still of rendered)
		run("python3", [
			"-c",
			"import sys;from PIL import Image;Image.open(sys.argv[1]).save(sys.argv[2],'WEBP',quality=90,method=6)",
			still.path,
			still.path.replace(/\.png$/, ".webp"),
		]);
	const source = `CLIO Coder ${clioVersion}${values["build-note"] ? ` (${values["build-note"]})` : ""} ${installed} recorded by site/capture/run.mjs (scenario ${scenario.id}) in a fresh profile: home /home/researcher, host lab, ${session.cols}x${session.rows} terminal, asciinema v2, idle capped at ${spec.idleCap}s.${
		scenario.env
			? ` Environment: ${Object.entries(scenario.env)
					.map(([key, value]) => `${key}=${value}`)
					.join(", ")}.`
			: ""
	}${scenario.settings ? ` Settings: ${scenario.settings.join("; ")}.` : ""}${scenario.live ? ` Chat: ${spec.liveSource}.` : " No model."}${
		scenario.privateNet?.port
			? ` The sandbox has its own network namespace; the model port ${scenario.privateNet.port} exists only inside it.`
			: scenario.privateNet
				? " The sandbox has its own network namespace with only a loopback interface."
				: ""
	}${scenario.peers ? ` Peer agent CLIs (${scenario.peers.join(", ")}) bound read-only, with no credentials.` : ""}${
		scenario.hostTools ? ` Host tools (${scenario.hostTools.join(", ")}) bound read-only.` : ""
	}${scenario.sourceNote ? ` ${scenario.sourceNote}` : ""}`;
	const entries = {};
	for (const still of rendered) {
		const isCast = still.id === scenario.id;
		const meta = isCast ? scenario.capture : scenario.shots?.[still.id];
		if (!meta) throw new Error(`${scenario.id}: still ${still.id} has no caption in scenarios.json`);
		entries[still.id] = {
			image: meta.image ?? `assets/guides/${still.id}.webp`,
			original: (meta.image ?? `assets/guides/${still.id}.webp`).replace(/\.webp$/, ".png"),
			...pngSize(still.path),
			label: meta.label,
			alt: versioned(meta.alt),
			caption: versioned(meta.caption),
			interface: "Terminal",
			version: clioVersion,
			capturedAt: today,
			source: isCast
				? source
				: `${source} Still at the "${still.id}" marker${still.crop ? `, rows ${still.crop[0]}-${still.crop[1]}` : ""}, rendered by the site's player at 2x.`,
			...(isCast
				? {
						cast: `assets/casts/${scenario.id}.cast`,
						transcript: `assets/casts/${scenario.id}.txt`,
						cols: session.cols,
						rows: session.rows,
						duration: Math.round(cast.duration * 10) / 10,
						posterAt: poster.time,
					}
				: {}),
		};
	}
	const registryHits = privacyHits(JSON.stringify(entries), secrets);
	if (registryHits.length)
		throw new Error(`${scenario.id}: privacy scan failed on the registry entry: ${registryHits.join("; ")}`);
	writeFileSync(join(outDir, "captures.json"), `${JSON.stringify(entries, null, "\t")}\n`);
	console.log(
		`${scenario.id}: ${Math.round(cast.duration)}s, ${cast.text.length} B, stills ${rendered.map((still) => still.id).join(", ")}`,
	);
	return entries;
}

const today = new Date().toISOString().slice(0, 10);
const recorded = [];
const timings = [];
let lockTotalMs = 0;
let releaseLock = null;
if (values.release && scenarios.some((scenario) => scenario.live)) {
	requireLiveEnv();
	releaseLock = await holdLock(process.env.CLIO_CAPTURE_LOCK, { wait: false }).catch((error) => {
		console.error(`release ${values.release}: ${error.message}`);
		process.exit(1);
	});
	console.log(`release ${values.release}: holding the model lock for the recording phase`);
}
try {
	for (const scenario of scenarios) {
		const timing = {};
		try {
			recorded.push(await record(scenario, Boolean(releaseLock), timing));
		} finally {
			if (!releaseLock) lockTotalMs += timing.lockMs;
		}
	}
} finally {
	if (releaseLock) lockTotalMs = releaseLock();
}
const rendered = {};
const scopes = [];
for (const take of recorded) {
	const begin = Date.now();
	const entries = await render(take);
	const scoped = Object.fromEntries(Object.entries(entries).filter(([id]) => !shots || shots.has(id)));
	Object.assign(rendered, values.publish ? scoped : entries);
	scopes.push([take, scoped]);
	take.timing.renderMs = Date.now() - begin;
	timings.push({ id: take.scenario.id, live: Boolean(take.scenario.live), ...take.timing });
}
// Checked before anything is published: a figure the take does not show stops the run.
const alts = altCheck({ scratch, ids: Object.keys(rendered), entries: rendered });
printAltCheck(alts);
if (alts.misses.length) {
	process.exitCode = 1;
	if (values.publish) console.log("alt-check: nothing published; fix the alt or caption in scenarios.json and rerun.");
} else if (values.publish) for (const [take, scoped] of scopes) publish(take.scenario, take.outDir, scoped);

const seconds = (ms) => Math.round(ms / 100) / 10;
const report = {
	version: clioVersion,
	release: values.release ?? null,
	installSeconds: seconds(installMs),
	wallSeconds: seconds(Date.now() - startedAt),
	lockSeconds: seconds(lockTotalMs),
	captures: timings.map((timing) => ({
		id: timing.id,
		live: timing.live,
		recordSeconds: seconds(timing.recordMs),
		lockSeconds: seconds(timing.lockMs),
		renderSeconds: seconds(timing.renderMs),
	})),
};
writeFileSync(join(scratch, "timings.json"), `${JSON.stringify(report, null, "\t")}\n`);
for (const capture of report.captures)
	console.log(
		`timing ${capture.id}: record ${capture.recordSeconds}s (model lock ${capture.lockSeconds}s), render ${capture.renderSeconds}s`,
	);
console.log(
	`timing total: wall ${report.wallSeconds}s (install ${report.installSeconds}s), model lock held ${report.lockSeconds}s`,
);

if (values.release) {
	const registry = JSON.parse(readFileSync(join(site, "content/captures.json"), "utf8")).captures;
	const made = new Set(spec.scenarios.flatMap((scenario) => [scenario.id, ...Object.keys(scenario.shots ?? {})]));
	const left = Object.entries(registry)
		.filter(([id, entry]) => entry.interface === "Terminal" && !made.has(id))
		.map(([id, entry]) => `${id} (${entry.version})`);
	if (left.length) console.log(`release ${values.release}: no scenario re-records ${left.join(", ")}`);
	const { checked, misses, notes } = quoteCheck({ scratch: values.publish ? undefined : scratch });
	for (const line of [...notes, ...misses]) console.log(`quote-check: ${line}`);
	console.log(`quote-check: ${checked} quoted lines, ${misses.length} not in their recording`);
	if (misses.length) process.exitCode = 1;
	if (values.publish)
		console.log("Next: python3 site/image-variants.py, then read every take (alt-check list above) before committing.");
}

function publish(scenario, outDir, entries) {
	mkdirSync(join(site, "assets/casts"), { recursive: true });
	if (!Object.keys(entries).length) return;
	if (entries[scenario.id])
		for (const ext of ["cast", "txt"])
			copyFileSync(join(outDir, `${scenario.id}.${ext}`), join(site, `assets/casts/${scenario.id}.${ext}`));
	const registry = JSON.parse(readFileSync(join(site, "content/captures.json"), "utf8"));
	for (const [id, entry] of Object.entries(entries)) {
		mkdirSync(dirname(join(site, entry.image)), { recursive: true });
		copyFileSync(join(outDir, `${id}.png`), join(site, entry.original));
		copyFileSync(join(outDir, `${id}.webp`), join(site, entry.image));
		registry.captures[id] = entry;
		syncManifest(entry);
	}
	writeFileSync(join(site, "content/captures.json"), `${JSON.stringify(registry, null, "\t")}\n`);
	console.log(`${scenario.id}: published to site/assets and content/captures.json`);
}

// A still the repository also ships (assets/media-manifest.json lists the site
// file as a delivery copy) is written to the canonical file too, byte-identical,
// and its manifest entry takes the new hash, size and version.
function syncManifest(entry) {
	const path = join(repo, "assets/media-manifest.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	let changed = false;
	for (const asset of manifest.assets) {
		const file = [entry.original, entry.image].find((name) => asset.copies?.includes(`site/${name}`));
		if (!file) continue;
		copyFileSync(join(site, file), join(repo, asset.source));
		const data = readFileSync(join(repo, asset.source));
		asset.sha256 = createHash("sha256").update(data).digest("hex");
		if (file.endsWith(".png")) asset.dimensions = pngSize(join(repo, asset.source));
		else asset.dimensions = { width: entry.width, height: entry.height };
		asset.capturedVersion = clioVersion;
		asset.provenance = asset.provenance.replace(versionLiteral, clioVersion);
		changed = true;
	}
	if (changed) writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}
