import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { holdsNamedCredential, scrubSandboxEnv } from "../../src/core/sandbox/env-scrub.js";
import { discoverSecretMasks } from "../../src/core/sandbox/secret-files.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
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

test("under bwrap a contained command cannot read .env or credential variables, and an unsandboxed one still can", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const isolated = await isolateClioEnv("clio-contained-secrets-");
	t.after(() => isolated.restore());
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
