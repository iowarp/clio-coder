/**
 * Machinery bench driver: runs one scenario against the production machinery
 * and prints one clio-coder.eval.measure.v1 line.
 *
 * node --import tsx evals/machinery/lib/driver.ts --suite <name> --scenario <id>
 *
 * The run is offline and model-free. It isolates Clio's home before any domain
 * module loads, so a scenario reads and writes a throwaway state directory
 * rather than the operator's. Exit 0 means every expectation the scenario
 * declared held, and the eval runner records that as `task.solved`.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolvePackageRoot } from "../../../src/core/package-root.js";
import { isolateClioEnv } from "../../../tests/harness/scratch-env.js";
import { behaviorDigest, behaviorDocument, type MachineryScenario, measureLine } from "./observation.js";
import { machinerySuite } from "./suites.js";

type ScenarioModule = { SCENARIOS: Record<string, MachineryScenario> };

/**
 * Loaded on demand: a scenario module pulls in the domain it measures, and a
 * continuity task has no reason to pay for the dispatch graph.
 */
const SUITE_MODULES: Record<string, () => Promise<ScenarioModule>> = {
	"dispatch-admission": () => import("./dispatch-admission.js"),
	"prompt-compile": () => import("./prompt-compile.js"),
};

function parseArgs(argv: ReadonlyArray<string>): { suite: string; scenario: string } {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new Error("usage: driver.ts --suite <name> --scenario <id>");
		}
		values.set(flag.slice(2), value);
	}
	const suite = values.get("suite");
	const scenario = values.get("scenario");
	if (suite === undefined || scenario === undefined) throw new Error("--suite and --scenario are both required");
	values.delete("suite");
	values.delete("scenario");
	if (values.size > 0) throw new Error(`unknown flags: ${[...values.keys()].join(", ")}`);
	return { suite, scenario };
}

/**
 * Pairs of (path, token) whose longest entry is applied first, so a scratch
 * directory wins over the temp root that holds it and the checkout wins over
 * its parent.
 */
function normalizationRoots(home: string): Array<readonly [string, string]> {
	const candidates: Array<readonly [string, string]> = [];
	const add = (path: string, token: string): void => {
		candidates.push([path, token]);
		try {
			const real = realpathSync(path);
			if (real !== path) candidates.push([real, token]);
		} catch {
			// A path that does not exist cannot appear in an observed value either.
		}
	};
	add(home, "<home>");
	add(resolvePackageRoot(), "<checkout>");
	add(process.cwd(), "<workspace>");
	add(tmpdir(), "<tmp>");
	return candidates.sort(([left], [right]) => right.length - left.length);
}

const { suite, scenario } = parseArgs(process.argv.slice(2));
const declared = machinerySuite(suite);
if (!declared.scenarios.includes(scenario)) {
	throw new Error(`scenario ${scenario} is not declared by suite ${suite} in evals/machinery/lib/suites.ts`);
}
const isolated = await isolateClioEnv(`clio-coder-machinery-${suite}-`);
try {
	const loader = SUITE_MODULES[suite];
	if (loader === undefined) throw new Error(`suite ${suite} has no scenario module`);
	const run = (await loader()).SCENARIOS[scenario];
	if (run === undefined) throw new Error(`suite ${suite} declares ${scenario} but its module does not implement it`);
	const observation = await run();
	const document = behaviorDocument(suite, scenario, observation, normalizationRoots(isolated.dir));
	process.stderr.write(`${JSON.stringify(document)}\n`);
	process.stdout.write(`${measureLine(behaviorDigest(document))}\n`);
	process.exitCode = observation.failures.length === 0 ? 0 : 1;
} finally {
	isolated.restore();
}
