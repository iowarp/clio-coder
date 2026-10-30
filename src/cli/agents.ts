import { loadDomains } from "../core/domain-loader.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { type AgentSpec, isUserVisibleAgent } from "../domains/agents/spec.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { printError } from "./shared.js";

const HELP = `clio-coder agents [--json] [--all]
clio-coder agents validate [--json]

List user-facing agent specs from built-in, plugin, user, and project recipes.

Flags:
  --json   emit specs as JSON instead of the formatted table
  --all    include shadow/internal specs reserved for Clio orchestration

validate checks this repository's harness: project and user agent recipes,
project and user skills, and the fleet bindings in .clio-coder/settings.local.yaml.
It prints every problem as one "file: field: message" line and exits 1 when
there is any, so the whole list can be handed back to whoever wrote the files.
`;

export async function runAgentsCommand(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args[0] === "validate") return runAgentsValidate(args.slice(1));
	const json = args.includes("--json");
	const all = args.includes("--all");
	const unknown = args.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stderr.write(HELP);
		return 2;
	}
	ensureClioState();
	const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, AgentsDomainModule]);
	const agents = result.getContract<AgentsContract>("agents");
	if (!agents) {
		process.stderr.write("agents: domain not loaded\n");
		await result.stop();
		return 1;
	}
	const specs = all ? agents.listSpecs() : agents.listSpecs().filter(isUserVisibleAgent);
	if (json) {
		const withoutBody = specs.map(({ body: _body, ...rest }) => rest);
		process.stdout.write(`${JSON.stringify(withoutBody, null, 2)}\n`);
	} else {
		for (const spec of specs) {
			renderLine(spec);
		}
	}
	await result.stop();
	return 0;
}

async function runAgentsValidate(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stderr.write(HELP);
		return 2;
	}
	ensureClioState();
	const { formatHarnessIssues, validateHarnessAt } = await import("../domains/agents/harness-validate.js");
	const workspaceRoot = process.cwd();
	const issues = validateHarnessAt(workspaceRoot);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: issues.length === 0, workspaceRoot, issues }, null, 2)}\n`);
	} else if (issues.length === 0) {
		process.stdout.write(`harness: no problems found in ${workspaceRoot}\n`);
	} else {
		process.stdout.write(`${formatHarnessIssues(issues)}\n`);
	}
	return issues.length === 0 ? 0 : 1;
}

function renderLine(spec: AgentSpec): void {
	const shape = `${spec.audience}/${spec.category}/${spec.capabilityClass}/${spec.latencyClass}`;
	const skills = spec.skills.length > 0 ? ` skills=${spec.skills.join(",")}` : "";
	const maximum = spec.budget.maximum ? `..${spec.budget.maximum.toolCalls}/${spec.budget.maximum.readReserve}` : "";
	const budget = `${spec.budget.toolCalls}/${spec.budget.readReserve}${maximum}/${spec.budget.synthesis ? "synthesize" : "stop"}`;
	process.stdout.write(`${spec.id.padEnd(20)} ${shape.padEnd(48)} ${spec.description}${skills} budget=${budget}\n`);
}
