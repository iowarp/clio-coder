import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { scrubSandboxEnv } from "../../src/core/sandbox/env-scrub.js";
import { discoverSecretMasks } from "../../src/core/sandbox/secret-files.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Every value below is a fake the test sets itself.
const FAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n";

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
	};
	const { env, removed } = scrubSandboxEnv({ ...kept, ...dropped }, { passEnv: [], secretNames: ["LLM_GATEWAY"] });
	deepStrictEqual(env, kept);
	deepStrictEqual(removed.sort(), Object.keys(dropped).sort());

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
