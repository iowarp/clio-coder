import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { buildToolSecretPaths, workerSecretPaths } from "../../src/domains/safety/secret-paths.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("safety gate findings", () => {
	let isolated: IsolatedClioEnv;
	let scratch: string;
	let workspace: string;
	let home: string;
	let savedHome: string | undefined;
	let policy: SafetyPolicyEngine;

	before(async () => {
		await runBashCommand("true");
		isolated = await isolateClioEnv("clio-coder-gate-findings-");
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-gate-findings-ws-"));
		workspace = join(scratch, "ws");
		home = join(scratch, "home");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
		mkdirSync(home, { recursive: true });
		savedHome = process.env.HOME;
		process.env.HOME = home;
		policy = createSafetyPolicyEngine({ cwd: workspace, projectPolicy: loadProjectSafetyPolicy(workspace) });
	});

	after(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(scratch, { recursive: true, force: true });
		isolated.restore();
	});

	const kind = (call: ClassifierCall, posture?: "yolo") => policy.evaluate(call, posture).kind;

	it("typed reads refuse every path the shell sandbox masks, and the process environment", () => {
		for (const secret of [
			...workerSecretPaths(home),
			join(home, ".config", "gh", "hosts.yml"),
			// Local services' tokens and keys, which reach a process running as the operator over loopback.
			join(home, ".local", "share", "jupyter", "runtime", "kernel-1.json"),
			join(home, ".jupyter", "jupyter_server_config.json"),
			join(home, ".ipython", "profile_default", "security", "ipcontroller-client.json"),
			join(home, ".config", "code-server", "config.yaml"),
			// Browser profiles, editor secret stores and other tools' and agents' token files.
			join(home, ".mozilla", "firefox", "abcd.default-release", "cookies.sqlite"),
			join(home, "snap", "firefox", "common", ".mozilla", "firefox", "abcd.default", "logins.json"),
			join(home, ".config", "google-chrome", "Default", "Cookies"),
			join(home, ".config", "chromium", "Default", "Login Data"),
			join(home, ".config", "BraveSoftware", "Brave-Browser", "Default", "Cookies"),
			join(home, ".config", "microsoft-edge", "Default", "Cookies"),
			join(home, ".config", "Code", "User", "globalStorage", "state.vscdb"),
			join(home, ".vscode-server", "data", "User", "globalStorage", "state.vscdb"),
			join(home, ".gem", "credentials"),
			join(home, ".config", "glab-cli", "config.yml"),
			join(home, ".oci", "config"),
			join(home, ".config", "doctl", "config.yaml"),
			join(home, ".s3cfg"),
			join(home, ".boto"),
			join(home, ".config", "containers", "auth.json"),
			join(home, ".config", "litellm", "config.yaml"),
			join(home, ".wakatime.cfg"),
			join(home, ".copilot", "config.json"),
			join(home, ".local", "share", "opencode", "auth.json"),
			join(home, ".aider.conf.yml"),
			join(home, ".continue", "config.yaml"),
			join(home, ".qwen", "oauth_creds.json"),
			join(home, ".factory", "auth.json"),
			join(home, ".local", "share", "amp", "secrets.json"),
			join(home, ".grok", "user-settings.json"),
			join(home, ".mcp-auth", "tokens.json"),
			join(home, ".config", "syncthing", "config.xml"),
			join(home, ".ollama", "id_ed25519"),
			"/proc/self/environ",
			`/proc/self/task/${process.pid}/environ`,
		]) {
			strictEqual(kind({ tool: ToolNames.Read, args: { path: secret } }), "block", secret);
		}
	});

	it("build-tool settings are refused and masked only while they hold a credential", () => {
		const read = (file: string) => kind({ tool: ToolNames.Read, args: { path: file } });
		const files = [
			{
				file: join(home, ".m2", "settings.xml"),
				plain: "<settings><mirrors><mirror><url>https://mirror.example</url></mirror></mirrors></settings>",
				secret: "<settings><servers><server><id>r</id><password>hunter2</password></server></servers></settings>",
			},
			{
				file: join(home, ".gradle", "gradle.properties"),
				plain: "org.gradle.jvmargs=-Xmx2g\nsystemProp.http.proxyHost=proxy\n",
				secret: "org.gradle.jvmargs=-Xmx2g\nmavenCentralPassword = hunter2\n",
			},
			{
				file: join(home, ".config", "pip", "pip.conf"),
				plain: "[global]\nindex-url = https://mirror.example/simple\n",
				secret: "[global]\nindex-url = https://user:hunter2@mirror.example/simple\n",
			},
		];
		for (const { file, plain } of files) {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, plain);
			strictEqual(read(file), "allow", file);
		}
		strictEqual(buildToolSecretPaths(home).length, 0);
		for (const { file, secret } of files) {
			writeFileSync(file, secret);
			strictEqual(read(file), "block", file);
			strictEqual(workerSecretPaths(home).includes(file), true, file);
		}
		for (const { file } of files) rmSync(file);
	});

	it("a shell read of a thread's environ is refused", () => {
		strictEqual(kind({ tool: ToolNames.Bash, args: { command: `cat /proc/self/task/${process.pid}/environ` } }), "block");
	});

	it("the exit-code presence exemption covers only the bare ^NAME= pattern", () => {
		const bash = (command: string) => kind({ tool: ToolNames.Bash, args: { command } });
		strictEqual(bash("grep -sq '^API_KEY=' .env"), "allow");
		for (const oracle of [
			"grep -q '^API_KEY=sk-a' .env",
			"grep -q '^API_KEY=s[a-k]' .env",
			'grep -sq "^API_KEY=.*x" .env',
		]) {
			strictEqual(bash(oracle), "block", oracle);
		}
	});

	it("the safety.yaml rail follows a literal cd and every common writer", () => {
		const bash = (command: string) => kind({ tool: ToolNames.Bash, args: { command } });
		for (const command of [
			"cd .clio-coder && echo x > safety.yaml",
			"cd .clio-coder && rm safety.yaml",
			"dd if=/dev/null of=.clio-coder/safety.yaml",
			"install /dev/null .clio-coder/safety.yaml",
			"cp -t .clio-coder x/safety.yaml",
			"cd .clio-coder && cp -t . x/safety.yaml",
			"cd .git && rm hooks/pre-commit",
		]) {
			strictEqual(bash(command), "block", command);
		}
	});

	it("judges a shell target from a cd only when the target follows it", () => {
		for (const command of [
			"npm run build > build.log 2>&1; cd dist && ls",
			"echo x > out.txt && cd dist && ls",
			"cd build && make && cd .. && ./run.sh > out.log",
		]) {
			strictEqual(kind({ tool: ToolNames.Bash, args: { command } }, "yolo"), "allow", command);
		}
		strictEqual(
			kind({ tool: ToolNames.Bash, args: { command: "cd src && cd .. && cd dist && echo x > a.js" } }),
			"block",
		);
	});

	it("refuses a path argument longer than any real path without walking it", () => {
		const long = Array.from({ length: 50_000 }, () => "a").join("/");
		strictEqual(kind({ tool: ToolNames.Read, args: { path: long } }), "block");
		strictEqual(kind({ tool: ToolNames.Bash, args: { command: `cat ${long}` } }, "yolo"), "block");
		const content = JSON.stringify(Array.from({ length: 900 }, (_, i) => `https://example.test/a/b/c/d/${i}`));
		strictEqual(kind({ tool: ToolNames.Write, args: { path: "out.json", content } }, "yolo"), "allow");
	});
});
