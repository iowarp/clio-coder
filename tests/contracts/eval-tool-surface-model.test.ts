import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const broken of [false, true]) {
	test(`model-required tool surface suite executes real graders against controlled events: broken=${broken}`, async () => {
		const env = await isolateClioEnv("tool-surface-model-");
		try {
			const loaded = await loadEvalSuiteFile(resolve("evals/tool-surface-model.yaml"));
			assert.equal(loaded.suite.tasks.length, 3);
			const workspace = join(env.dir, "workspace");
			mkdirSync(join(workspace, "evals/fixtures"), { recursive: true });
			cpSync("evals/tool-surface-grader.mjs", join(workspace, "evals/tool-surface-grader.mjs"));
			cpSync("evals/fixtures/tool-surface", join(workspace, "evals/fixtures/tool-surface"), { recursive: true });
			loaded.suite.matrix.repeats = 1;
			for (const task of loaded.suite.tasks) {
				assert.equal(task.behavioral?.execution.mode, "model-required");
				task.workspace.path = workspace;
			}
			const clioEntry = join(env.dir, "fixture.mjs");
			// This substitutes only the model process. Suite parsing, workspace
			// isolation, stream metrics, protected graders and verdicts are real.
			writeFileSync(
				clioEntry,
				`
const broken = ${broken};
const prompt = process.argv.at(-1);
let id = 0;
function call(toolName,args,text,isError=false) {
 const toolCallId = String(++id);
 console.log(JSON.stringify({type:"tool_execution_start",toolCallId,toolName,args}));
 console.log(JSON.stringify({type:"tool_execution_end",toolCallId,toolName,isError,result:{content:[{type:"text",text}]}}));
}
if (prompt.includes("final two lines")) call("read",{path:"evals/fixtures/tool-surface/read.txt",tail:broken?4:2},broken?"alpha beta gamma delta":"gamma delta");
else if (prompt.includes("two bash calls")) {
 call("bash",{command:"cd evals/fixtures/tool-surface/subdir && pwd"},process.cwd()+"/evals/fixtures/tool-surface/subdir");
 call("bash",{command:"pwd"},process.cwd()+(broken?"/evals/fixtures/tool-surface/subdir":""));
} else call("web_fetch",{url:"file:///tool-surface-fixture"},broken?"unexpected success":"web_fetch: unsupported scheme file: (must be http or https)",!broken);
`,
			);
			const artifact = await runEvalSuiteV2(loaded, { clioEntry });
			assert.equal(artifact.results.length, 3);
			for (const result of artifact.results) {
				assert.equal(result.pass, !broken, `${result.taskId}: ${JSON.stringify(result.artifacts)}`);
				assert.equal(result.metrics["task.solved"], !broken);
				assert.equal(result.behavioral?.outcome, broken ? "behavioral_failure" : "pass");
				const tool = result.taskId === "read-tail" ? "read" : result.taskId === "bash-cwd-reset" ? "bash" : "web_fetch";
				assert.equal(result.metrics[`tools.blocked.${tool}`], 0);
				assert.equal(result.metrics[`tools.failed.${tool}`], tool === "web_fetch" && !broken ? 1 : 0);
			}
		} finally {
			env.restore();
		}
	});
}
