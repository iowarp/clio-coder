import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { validateSettings } from "../../src/core/config.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { buildBwrapInvocation } from "../../src/core/sandbox/bwrap.js";
import {
	holdsNamedCredential,
	mainSandboxEnvPolicy,
	sandboxEnvPolicy,
	scrubSandboxEnv,
} from "../../src/core/sandbox/env-scrub.js";
import { mainSandboxPolicy, planMainSandboxSpawn } from "../../src/core/sandbox/main-session.js";
import { withMountAliases } from "../../src/core/sandbox/mount-aliases.js";
import { discoverSecretMasks } from "../../src/core/sandbox/secret-files.js";
import { signalSandboxPayload } from "../../src/core/sandbox/signal.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Every value below is a fake the test sets itself, built from parts so secret scanners do not read it as a leak.
const PEM_LABEL = ["PRIVATE", "KEY"].join(" ");
const FAKE_PRIVATE_KEY = `-----BEGIN ${PEM_LABEL}-----\nZmFrZQ==\n-----END ${PEM_LABEL}-----\n`;

test("the sandbox scrub keeps ordinary variables and drops credential names, credential URLs and target keys", () => {
	const kept = {
		PATH: "/usr/bin:/bin",
		HOME: "/home/u",
		LANG: "C.UTF-8",
		TERM: "xterm-256color",
		HTTPS_PROXY: "http://proxy.example:3128",
		no_proxy: "localhost,127.0.0.1",
		CUDA_VISIBLE_DEVICES: "0,1",
		OMPI_MCA_btl: "self,vader",
		CONDA_PREFIX: "/opt/conda/envs/x",
		VIRTUAL_ENV: "/w/.venv",
		CC: "gcc",
		GIT_AUTHOR_NAME: "A Person",
		AWS_REGION: "us-east-1",
		TOKENIZERS_PARALLELISM: "false",
		UPSTREAM: "ssh://git@github.com/o/r.git",
	};
	const dropped = {
		GITHUB_TOKEN: "fake",
		GH_PAT: "fake",
		HF_TOKEN: "fake",
		OPENAI_API_KEY: "fake",
		AWS_SECRET_ACCESS_KEY: "fake",
		AWS_SESSION_TOKEN: "fake",
		AWS_CONFIG_FILE: "/home/u/.aws/config",
		DB_PASSWD: "fake",
		GPG_PASSPHRASE: "fake",
		NPM_CONFIG__AUTH: "fake",
		DOCKER_AUTH_CONFIG: "{}",
		KUBECONFIG: "/home/u/.kube/config",
		VAULT_ADDR: "https://vault.example",
		TWINE_USERNAME: "fake",
		STRIPE_KEY: "fake",
		SESSION_COOKIE: "fake",
		GIT_ASKPASS: "/usr/lib/git-core/askpass",
		DATABASE_URL: "postgres://user:fakepass@db.example/app",
		REDIS_URL: "redis://:fakepass@cache.example:6379",
		http_proxy: "http://user:fakepass@proxy.example:3128",
		SIGNING_MATERIAL: FAKE_PRIVATE_KEY,
		LLM_GATEWAY: "fake",
		SLURM_JWT: "fake",
		CI_JOB_JWT: "fake",
		ANTHROPIC_CUSTOM_HEADERS: "x-fake: fake",
		OTEL_EXPORTER_OTLP_HEADERS: "authorization=fake",
		MIRROR: `https://${["ghp", "FAKEfakeFAKEfake1234"].join("_")}@github.com/o/r.git`,
	};
	const { env, removed } = scrubSandboxEnv({ ...kept, ...dropped }, { passEnv: [], secretNames: ["LLM_GATEWAY"] });
	deepStrictEqual(env, kept);
	deepStrictEqual(removed.sort(), Object.keys(dropped).sort());
	// A scheduler client runs outside the sandbox and keeps the JWT a Slurm site authenticates it with.
	strictEqual(holdsNamedCredential("SLURM_JWT", "fake"), false);

	// The operator's pass list keeps a name, from the unfiltered source when an earlier filter dropped it.
	const passed = scrubSandboxEnv(
		{ PATH: "/bin", HF_TOKEN: "fake" },
		{ passEnv: ["HF_TOKEN", "GITHUB_TOKEN"], secretNames: [] },
		{
			PATH: "/bin",
			HF_TOKEN: "fake",
			GITHUB_TOKEN: "fake-gh",
		},
	);
	deepStrictEqual(passed.env, { PATH: "/bin", HF_TOKEN: "fake", GITHUB_TOKEN: "fake-gh" });
});

test("the sandbox scrub drops a credential by its value shape under any name, and a session or webhook name", () => {
	const env = {
		PATH: "/usr/bin",
		BW_SESSION: "c2Vzc2lvbmtleQ==",
		SLACK_WEBHOOK_URL: ["https://hooks.slack.com/services", "T000", "B000", "XXXXXXXXXXXX"].join("/"),
		MY_SETTING: `ghp_${"a".repeat(36)}`,
		OTHER: `sk_live_${"b".repeat(24)}`,
	};
	const { env: out, removed } = scrubSandboxEnv(env, { passEnv: [], secretNames: [] });
	deepStrictEqual(Object.keys(out), ["PATH"]);
	deepStrictEqual(removed.sort(), ["BW_SESSION", "MY_SETTING", "OTHER", "SLACK_WEBHOOK_URL"]);
});

test("secret discovery masks an ignored .env and a private key, not templates, public certificates, committed fixtures or a virtualenv", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-secret-scan-")));
	execFileSync("git", ["init", "-q"], { cwd: root });
	// A committed fixture key stays readable: git objects hold it anyway, and masking it breaks `git add -A`.
	mkdirSync(join(root, "fixtures"));
	writeFileSync(join(root, "fixtures", "test.key"), "fake\n");
	execFileSync("git", ["add", "fixtures/test.key"], { cwd: root });
	execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
		{ cwd: root },
	);
	writeFileSync(join(root, ".gitignore"), ".env\nlocal-env/\n");
	writeFileSync(join(root, ".env"), "API=fake\n");
	writeFileSync(join(root, ".env.example"), "API=\n");
	mkdirSync(join(root, "certs"));
	writeFileSync(join(root, "certs", "x.pem"), FAKE_PRIVATE_KEY);
	writeFileSync(join(root, "certs", "ca.pem"), "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n");
	mkdirSync(join(root, "deploy", ".aws"), { recursive: true });
	writeFileSync(join(root, "deploy", ".aws", "credentials"), "[default]\n");
	// An ignored virtualenv under another name is skipped whole, even with a key file inside it.
	mkdirSync(join(root, "local-env"));
	writeFileSync(join(root, "local-env", "pyvenv.cfg"), "home = /usr/bin\n");
	writeFileSync(join(root, "local-env", "server.key"), "fake\n");

	const scan = discoverSecretMasks({ workspaceRoots: [root] });
	strictEqual(scan.capped, false);
	deepStrictEqual(scan.masks.map((mask) => `${mask.path.slice(root.length + 1)}:${mask.kind}`).sort(), [
		".env:file",
		"certs/x.pem:file",
		"deploy/.aws:directory",
	]);
});

test("a secret an enclosing sandbox already bound /dev/null over gains no aliases, so /dev/null stays writable", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-mount-aliases-")));
	mkdirSync(join(root, "b"));
	writeFileSync(join(root, "b", "secret"), "");
	// /dev/zero stands in for a secret path that a nested launch sees as the enclosing sandbox's devtmpfs /null bind.
	const mountinfo = join(root, "mountinfo");
	writeFileSync(
		mountinfo,
		[
			"20 1 0:6 / /dev rw - devtmpfs none rw",
			"21 20 0:6 /null /dev/null rw - devtmpfs none rw",
			"22 20 0:6 /null /dev/zero rw - devtmpfs none rw",
			`30 1 8:1 /x ${join(root, "a")} rw - ext4 /dev/sda rw`,
			`31 1 8:1 /x ${join(root, "b")} rw - ext4 /dev/sda rw`,
		].join("\n"),
	);
	const masks = [
		{ path: "/dev/zero", kind: "file" as const },
		{ path: join(root, "a", "secret"), kind: "file" as const },
	];
	// The real file's second mount is still an alias; the device's other binds are not.
	deepStrictEqual(withMountAliases(masks, mountinfo), [...masks, { path: join(root, "b", "secret"), kind: "file" }]);
});

// C-38: on WSL2 every home secret also had a /dev/null bind under /mnt/wslg/distro, a second mount of the root.
test("a second mount of the root holding no run root is masked once as a directory instead of per secret", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-mount-rootview-")));
	const distro = join(root, "distro");
	mkdirSync(join(distro, "home", "u"), { recursive: true });
	const mountinfo = join(root, "mountinfo");
	writeFileSync(
		mountinfo,
		["1 0 8:48 / / rw - ext4 /dev/sdd rw", `40 1 8:48 / ${distro} rw - ext4 /dev/sdd rw`].join("\n"),
	);
	const secret = join(root, "secret.json");
	writeFileSync(secret, "{}");
	mkdirSync(join(distro, root), { recursive: true });
	writeFileSync(join(distro, secret), "{}");
	const masks = [{ path: secret, kind: "file" as const }];
	deepStrictEqual(withMountAliases(masks, mountinfo, ["/w"]), [...masks, { path: distro, kind: "directory" }]);
	// A view that holds a run root stays visible, and each secret in it keeps its own mask.
	deepStrictEqual(withMountAliases(masks, mountinfo, [join(distro, "home", "u")]), [
		...masks,
		{ path: join(distro, secret), kind: "file" },
	]);
});

// Row 262: a host program renaming a file over a masked path while bwrap starts aborts the launch.
function fakeBwrap(root: string): string {
	const fake = join(root, "bwrap");
	// Stands in for bwrap: MODE picks the outcome, attempts are counted in a file, the command after "--" really runs.
	writeFileSync(
		fake,
		[
			"#!/bin/sh",
			`n=$(cat ${root}/count 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${root}/count`,
			'status() { if [ -e /proc/$$/fd/8 ]; then echo "$1" >&8; fi; }',
			'case $MODE in race*) if [ "$n" = 1 ]; then echo "bwrap: Can\'t bind mount /oldroot/dev/null on /newroot/x: Unable to find /newroot/x in mount table" >&2; exit 1; fi ;; esac',
			'if [ "$MODE" = chdir ]; then echo "bwrap: Can\'t chdir to /nope: No such file or directory" >&2; exit 1; fi',
			`status '{ "child-pid": 2 }'`,
			'while [ "$1" != -- ]; do shift; done; shift',
			'if [ "$MODE" = signal ]; then setsid "$@" 8>&- & wait $!; else "$@" 8>&-; fi',
			"code=$?",
			`status '{ "exit-code": '"$code"' }'`,
			"exit $code",
		].join("\n"),
		{ mode: 0o755 },
	);
	return fake;
}

const fakeSpec = (root: string, script: string, masked = true) => ({
	command: { argv: ["/bin/sh", "-c", script] },
	cwd: root,
	writableRoots: [],
	network: true,
	maskedPaths: masked ? [{ path: "/x", kind: "file" as const }] : [],
});

test("a masked launch runs again once, silently, only when a mask mount failed before the command started", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-bwrap-retry-")));
	const fake = fakeBwrap(root);
	const script = "echo payload ran; echo payload-err >&2; case $MODE in *fail*) exit 1 ;; esac";
	const launch = (mode: string, masked = true) => {
		writeFileSync(join(root, "count"), "0");
		const { file, args } = buildBwrapInvocation(fakeSpec(root, script, masked), fake);
		const result = spawnSync(file, args, { encoding: "utf8", env: { ...process.env, MODE: mode } });
		return { ...result, attempts: readFileSync(join(root, "count"), "utf8").trim() };
	};
	// A recovered race shows the caller only the command's own output: no bwrap line, no notice.
	const race = launch("race");
	strictEqual(race.status, 0, race.stderr);
	strictEqual(race.attempts, "2");
	strictEqual(race.stdout, "payload ran\n");
	strictEqual(race.stderr, "payload-err\n");
	// A check that really fails after a recovered race reads as its own failure, never as "bwrap:" unavailability.
	const raceFail = launch("racefail");
	strictEqual(raceFail.status, 1);
	strictEqual(raceFail.stderr, "payload-err\n");
	// The command started and exited 1: bwrap's exit-code record says so, and it never runs twice.
	const fails = launch("fail");
	strictEqual(fails.status, 1);
	strictEqual(fails.attempts, "1");
	strictEqual(fails.stderr, "payload-err\n");
	// Any other setup failure is not the race: one attempt, bwrap's message passed on once.
	const chdir = launch("chdir");
	strictEqual(chdir.status, 1);
	strictEqual(chdir.attempts, "1");
	strictEqual(chdir.stderr, "bwrap: Can't chdir to /nope: No such file or directory\n");
	// Without a mask there is nothing to race, so bwrap runs alone and a setup failure stands.
	strictEqual(buildBwrapInvocation(fakeSpec(root, script, false), fake).file, fake);
	strictEqual(launch("race", false).status, 1);
});

test("a masked launch's command group sits one level below the launcher when /bin/sh is bash", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-bwrap-depth-")));
	const fake = fakeBwrap(root);
	const ready = join(root, "ready");
	const script = `trap 'echo got-term > ${root}/term; exit 0' TERM; echo $$ > ${ready}; while :; do sleep 0.05; done`;
	const { args } = buildBwrapInvocation(fakeSpec(root, script), fake);
	// bash run as sh keeps a forked process for a command substitution unless the launcher execs bwrap there.
	const child = spawn("/bin/bash", args, { argv0: "sh", stdio: "ignore", env: { ...process.env, MODE: "signal" } });
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	t.after(() => {
		try {
			process.kill(-Number(readFileSync(ready, "utf8")), "SIGKILL");
		} catch {}
		child.kill("SIGKILL");
	});
	for (let i = 0; i < 400 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
	ok(existsSync(ready), "the command started");
	ok(child.pid !== undefined && signalSandboxPayload(child.pid, "SIGTERM"), "the command's group was found");
	strictEqual(await exited, 0);
	strictEqual(readFileSync(join(root, "term"), "utf8"), "got-term\n");
});

test("under bwrap a masked launch's timeout and abort still reach the command through the launcher shell", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const isolated = await isolateClioEnv("clio-masked-launch-signal-");
	t.after(() => isolated.restore());
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-masked-launch-")));
	writeFileSync(join(cwd, ".env"), "API=fake\n");
	const shellSandbox = mainSandboxPolicy({ workspace: cwd, scratchRoots: [] });
	const plan = planMainSandboxSpawn(shellSandbox, { argv: ["/bin/true"] }, cwd);
	ok(plan.kind === "sandboxed" && plan.file === "/bin/sh", "a launch with masks goes through the launcher");
	const command = (marker: string) =>
		`trap 'echo got-term > ${marker}; exit 0' TERM; echo ready; while :; do sleep 0.1; done`;
	const timedOut = await runBashCommand(command(join(cwd, "timeout.txt")), { cwd, shellSandbox, timeoutMs: 3000 });
	strictEqual(timedOut.timedOut, true);
	ok(existsSync(join(cwd, "timeout.txt")), "the timeout's SIGTERM reached the command");
	const controller = new AbortController();
	const aborted = await runBashCommand(command(join(cwd, "abort.txt")), {
		cwd,
		shellSandbox,
		signal: controller.signal,
		onOutput: (_target, text) => {
			if (text.includes("ready")) controller.abort();
		},
	});
	strictEqual(aborted.aborted, true);
	ok(existsSync(join(cwd, "abort.txt")), "the abort's SIGTERM reached the command");
});

test("task worktrees nested in a checkout past the walk budget leave its .env and their own secrets masked", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-secret-worktrees-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-q");
	for (let dir = 0; dir < 105; dir++) {
		mkdirSync(join(root, "src", `d${dir}`), { recursive: true });
		for (let file = 0; file < 100; file++) writeFileSync(join(root, "src", `d${dir}`, `f${file}.txt`), "x\n");
	}
	writeFileSync(join(root, ".gitignore"), ".env\n.clio-coder/\n");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
	// Two checkouts of 10,500 files under `.clio-coder/` sort before `.env` and exceed one root's 20,000-entry walk.
	for (const run of ["run-a", "run-b"])
		git("worktree", "add", "-q", join(root, ".clio-coder", "worktrees", run), "HEAD");
	writeFileSync(join(root, ".env"), "API=fake\n");
	writeFileSync(join(root, ".clio-coder", "worktrees", "run-b", ".env"), "API=fake\n");

	const scan = discoverSecretMasks({ workspaceRoots: [root] });
	strictEqual(scan.capped, false);
	deepStrictEqual(scan.masks.map((mask) => mask.path.slice(root.length + 1)).sort(), [
		".clio-coder/worktrees/run-b/.env",
		".env",
	]);
});

test("a workspace scan is reused past 10 s while the git index is unchanged, and redone once it changes", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-secret-index-")));
	execFileSync("git", ["init", "-q"], { cwd: root });
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "a.txt"), "a\n");
	execFileSync("git", ["add", "sub/a.txt"], { cwd: root });
	const t0 = 1_000_000;
	strictEqual(discoverSecretMasks({ workspaceRoots: [root] }, [], t0).masks.length, 0);
	// A deep untracked secret leaves the top directory and the index alone.
	writeFileSync(join(root, "sub", "x.pem"), FAKE_PRIVATE_KEY);
	strictEqual(discoverSecretMasks({ workspaceRoots: [root] }, [], t0 + 20_000).masks.length, 0);
	writeFileSync(join(root, "sub", "b.txt"), "b\n");
	execFileSync("git", ["add", "sub/b.txt"], { cwd: root });
	deepStrictEqual(
		discoverSecretMasks({ workspaceRoots: [root] }, [], t0 + 21_000).masks.map((mask) =>
			mask.path.slice(root.length + 1),
		),
		["sub/x.pem"],
	);
	// Past the stable-index ceiling the scan is redone anyway.
	writeFileSync(join(root, "sub", "y.pem"), FAKE_PRIVATE_KEY);
	strictEqual(discoverSecretMasks({ workspaceRoots: [root] }, [], t0 + 82_000).masks.length, 2);
});

test("a secret the write tool creates is masked on the next scan inside the reuse window", async (t) => {
	const isolated = await isolateClioEnv("clio-secret-write-");
	t.after(() => isolated.restore());
	process.env.HOME = isolated.dir;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-secret-write-ws-")));
	execFileSync("git", ["init", "-q"], { cwd: root });
	mkdirSync(join(root, "sub"));
	const saved = process.cwd();
	process.chdir(root);
	t.after(() => process.chdir(saved));
	const t0 = Date.now();
	strictEqual(discoverSecretMasks({ workspaceRoots: [root] }, [], t0).masks.length, 0);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
	// Path policy refuses a typed write to a key file, so the body stands in for any write the tool name covers.
	registry.register({
		...writeTool,
		run: async () => {
			writeFileSync(join(root, "sub", "x.pem"), FAKE_PRIVATE_KEY);
			return { kind: "ok", output: "wrote" };
		},
	} as typeof writeTool);
	const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "sub/notes.txt", content: "x" } });
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	deepStrictEqual(
		discoverSecretMasks({ workspaceRoots: [root] }, [], t0 + 1_000).masks.map((mask) => mask.path.slice(root.length + 1)),
		["sub/x.pem"],
	);
});

test("under bwrap a secret whose parent a verify script renamed is masked at its new path in the next command", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const isolated = await isolateClioEnv("clio-secret-rename-");
	t.after(() => isolated.restore());
	// bwrap masks home credential files by path, and a host agent renaming one over mid-launch fails the launch.
	process.env.HOME = isolated.dir;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-secret-rename-ws-")));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), ".env.local\n");
	mkdirSync(join(root, "apps", "web"), { recursive: true });
	writeFileSync(join(root, "apps", "web", ".env.local"), "FAKE_DEEP=fake-deep-value\n");
	// The script renames the secret's parent from inside verify's own launch, which leaves the cached scan in place.
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "p", private: true, scripts: { lint: "mv apps/web apps/w2 && echo lint-ok" } }),
	);
	const saved = process.cwd();
	process.chdir(root);
	t.after(() => process.chdir(saved));
	const policy = mainSandboxPolicy({ workspace: root, scratchRoots: [] });

	const verified = await verifyTool.run({ check: "lint" }, { shellSandbox: policy });
	strictEqual(verified.kind, "ok", verified.kind === "error" ? verified.message : "");
	const plan = planMainSandboxSpawn(policy, { argv: ["cat", "apps/w2/.env.local"] }, root);
	strictEqual(plan.kind, "sandboxed");
	const read = plan.kind === "sandboxed" ? spawnSync(plan.file, plan.args, { encoding: "utf8" }) : undefined;
	ok(!`${read?.stdout}`.includes("fake-deep-value"), read?.stdout);
	match(`${read?.stderr}`, /Permission denied/u);
});

test("under bwrap a contained command cannot read .env or credential variables, and an unsandboxed one still can", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const isolated = await isolateClioEnv("clio-contained-secrets-");
	t.after(() => isolated.restore());
	process.env.HOME = isolated.dir;
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-contained-secrets-ws-")));
	writeFileSync(join(cwd, ".env"), "FAKE_ENV_FILE=fake-file-value\n");
	// Admission refuses a literal `cat .env`; a script reads it where no command text names it.
	writeFileSync(
		join(cwd, "show.sh"),
		'cat .env; echo "token=$(printenv FAKE_TEST_TOKEN)"; echo "dsn=$(printenv FAKE_TEST_DSN)"\n',
	);
	process.env.FAKE_TEST_TOKEN = "fake-token-value";
	// The plain bash filter already drops names like *_TOKEN for every call; a
	// credential URL under an ordinary name is what only the sandbox scrub removes.
	process.env.FAKE_TEST_DSN = "postgres://fake:fake-dsn-pass@localhost/db";
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const command = "bash show.sh";

	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	const verdict = await registry.invoke({ tool: ToolNames.Bash, args: { command } });
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const contained = verdict.kind === "ok" ? JSON.stringify(verdict.result) : "";
	ok(!contained.includes("fake-file-value"), contained);
	ok(!contained.includes("fake-token-value"), contained);
	ok(!contained.includes("fake-dsn-pass"), contained);
	match(contained, /dsn=\\n/u);

	const unsandboxed = await runBashCommand(command, { cwd });
	match(unsandboxed.stdout, /fake-file-value/u);
	match(unsandboxed.stdout, /fake-dsn-pass/u);
});

test("a live-check target's login file reads through the main sandbox, and nothing else nor a worker policy does (M-5)", async (t) => {
	const targets = [
		{ id: "seat", runtime: "copilot-sdk", auth: {} },
		{ id: "local", runtime: "openai-compat", auth: {} },
	];
	const validated = validateSettings({ targets: [], safety: { liveCheckTargets: ["seat"] } });
	ok(
		validated.issues.some((issue) => issue.path === "safety.liveCheckTargets"),
		JSON.stringify(validated.issues),
	);
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const isolated = await isolateClioEnv("clio-live-check-login-");
	t.after(() => isolated.restore());
	process.env.HOME = isolated.dir;
	delete process.env.COPILOT_HOME;
	mkdirSync(join(isolated.dir, ".copilot"), { recursive: true });
	mkdirSync(join(isolated.dir, ".codex"), { recursive: true });
	writeFileSync(join(isolated.dir, ".copilot", "config.json"), '{"fake":"seat-login-value"}\n');
	writeFileSync(join(isolated.dir, ".codex", "auth.json"), '{"fake":"codex-login-value"}\n');
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-live-check-ws-")));
	const settings = { safety: { sandboxPassEnv: [], liveCheckTargets: ["seat", "local"] }, targets };
	const read = (env: ReturnType<typeof sandboxEnvPolicy>): string => {
		const plan = planMainSandboxSpawn(
			mainSandboxPolicy({ workspace: cwd, scratchRoots: [], env }),
			{ argv: ["/bin/sh", "-c", "cat .copilot/config.json; cat .codex/auth.json"] },
			isolated.dir,
		);
		strictEqual(plan.kind, "sandboxed");
		return plan.kind === "sandboxed" ? spawnSync(plan.file, plan.args, { encoding: "utf8" }).stdout : "";
	};
	const main = read(mainSandboxEnvPolicy(settings, {}, isolated.dir));
	match(main, /seat-login-value/u);
	ok(!main.includes("codex-login-value"), main);
	// Workers and host verification build their policy from sandboxEnvPolicy, which reveals nothing.
	ok(!read(sandboxEnvPolicy(settings)).includes("seat-login-value"));
});

test("typed read and grep refuse Clio's settings and MCP files while they hold a secret, as the sandbox hides them", async (t) => {
	const isolated = await isolateClioEnv("clio-config-secrets-");
	t.after(() => isolated.restore());
	process.env.HOME = isolated.dir;
	const config = join(isolated.dir, "config");
	mkdirSync(config, { recursive: true });
	const settings = join(config, "settings.yaml");
	const backup = join(config, "settings.yaml.bak");
	const mcp = join(config, "mcp.yaml");
	const secretSettings = "targets:\n  - id: lab\n    auth:\n      headers:\n        X-Api-Key: HEADER_MARKER\n";
	writeFileSync(settings, secretSettings);
	writeFileSync(backup, secretSettings);
	writeFileSync(
		mcp,
		"version: 1\nservers:\n  - id: gh\n    command: gh-mcp\n    env:\n      GITHUB_TOKEN: MCP_MARKER\n",
	);
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "clio-config-secrets-ws-")));
	const engine = createSafetyPolicyEngine({ cwd: workspace });
	const scope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true } as never;
	const verdicts = () =>
		[settings, backup, mcp].flatMap((file) => [
			engine.evaluate({ tool: ToolNames.Read, args: { path: file } }, "default", scope).kind,
			engine.evaluate({ tool: ToolNames.Grep, args: { pattern: "MARKER", path: file } }, "default", scope).kind,
		]);
	deepStrictEqual(verdicts(), ["block", "block", "block", "block", "block", "block"]);
	strictEqual(engine.readablePath(settings), false, "a listing withholds settings.yaml");
	// Without a header target or a server token the same engine reads both again, so an agent can help with them.
	writeFileSync(settings, "targets:\n  - id: lab\n    auth:\n      apiKeyEnvVar: LAB_KEY\n");
	writeFileSync(backup, "targets: []\n");
	writeFileSync(mcp, "version: 1\nservers:\n  - id: gh\n    command: gh-mcp\n");
	deepStrictEqual(verdicts(), ["allow", "allow", "allow", "allow", "allow", "allow"]);
	// A backup kept from when settings held a header target, and a token passed in a server's args, stay refused.
	writeFileSync(backup, secretSettings);
	writeFileSync(mcp, 'version: 1\nservers:\n  - id: gh\n    command: gh-mcp\n    args: ["--token", "MCP_ARG_MARKER"]\n');
	deepStrictEqual(verdicts(), ["allow", "allow", "block", "block", "block", "block"]);
});
