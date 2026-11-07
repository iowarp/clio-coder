import { strictEqual } from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	createSafetyPolicyEngine,
	type OperatorDefaultScope,
	type OperatorYoloScope,
} from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { invokesSettingsMutation } from "../../src/domains/safety/settings-authority.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const OPERATOR_DEFAULT: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: false };
const OPERATOR_YOLO: OperatorYoloScope = { scratchRoots: [] };

test("Clio's settings, credential and trust CLI is recognized however it is launched; read forms are not", () => {
	const mutating = [
		"clio-coder configure --id litellm --runtime litellm --url http://gw:4000 --api-key-env K --set-fleet-default 2>&1",
		"clio-coder configure",
		"CLIO_CODER_CONFIG_DIR=/x CLIO_CODER_STATE_DIR=/y clio-coder configure --id a --runtime openai",
		"env FOO=1 clio-coder targets use gw",
		"node /opt/clio-coder/dist/cli/index.js configure --id a --runtime openai",
		"npx -y @iowarp/clio-coder@0.7.0 auth login litellm",
		"pnpm dlx @iowarp/clio-coder targets add --id x",
		"bash -c 'clio-coder targets profile set fast gw --model m'",
		"echo start && clio-coder targets remove gw",
		"$(which clio-coder) configure --id x --runtime y",
		"clio-coder --api-key sk-test run hello",
		"clio-coder mcp trust docs",
		"clio-coder reset --settings --force",
	];
	for (const command of mutating) strictEqual(invokesSettingsMutation(command), true, command);
	const reads = [
		"clio-coder configure --json",
		"clio-coder configure --list --all",
		"clio-coder configure --id x --help",
		"clio-coder targets --json; clio-coder targets fleet",
		"clio-coder targets profile list",
		"clio-coder auth status litellm",
		"clio-coder config inspect --json",
		"clio-coder reset --all --dry-run",
		"./configure --prefix=/usr && make",
		"git config user.name x",
		"git commit -m 'clio-coder configure --id x'",
	];
	for (const command of reads) strictEqual(invokesSettingsMutation(command), false, command);
});

// Baseline: a headless run shelled out to `clio-coder configure`, the sandbox
// refused the settings lock, and the `unsandboxed: true` rerun reached the
// safety judge, which allowed it, so settings.yaml changed with no card.
test("a settings CLI call is blocked at default, unsandboxed or not, and on the yolo floor", async (t) => {
	const home = await isolateClioEnv("clio-settings-authority-");
	t.after(() => home.restore());
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-settings-authority-ws-")));
	const engine = createSafetyPolicyEngine({ cwd, projectPolicy: loadProjectSafetyPolicy(cwd) });
	const command =
		"clio-coder configure --id litellm --runtime litellm --url http://192.0.2.1:4000 --model m --api-key-env LITELLM_API_KEY --set-fleet-default 2>&1";
	for (const unsandboxed of [false, true]) {
		const call = { tool: ToolNames.Bash, args: { command, ...(unsandboxed ? { unsandboxed: true } : {}) } };
		const atDefault = engine.evaluate(call, "default", OPERATOR_DEFAULT);
		strictEqual(atDefault.kind, "block", `default unsandboxed=${unsandboxed}`);
		strictEqual(atDefault.reasonCode, "yolo-floor:settings-authority");
		const atYolo = engine.evaluate(call, "yolo", OPERATOR_YOLO);
		strictEqual(atYolo.kind, "block", `yolo unsandboxed=${unsandboxed}`);
		strictEqual(atYolo.reasonCode, "yolo-floor:settings-authority");
	}
	const read = engine.evaluate(
		{ tool: ToolNames.Bash, args: { command: "clio-coder targets --json" } },
		"default",
		OPERATOR_DEFAULT,
	);
	strictEqual(read.reasonCode.endsWith("settings-authority"), false);
});
