import { loadDomains } from "../core/domain-loader.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { type AgentSpec, isUserVisibleAgent } from "../domains/agents/spec.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";

const HELP = `clio agents [--json] [--all]

List user-facing agent specs from built-in, user, and project recipes.

Flags:
  --json   emit specs as JSON instead of the formatted table
  --all    include shadow/internal specs reserved for Clio orchestration
`;

export async function runAgentsCommand(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const all = args.includes("--all");
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

function renderLine(spec: AgentSpec): void {
	const shape = `${spec.audience}/${spec.category}/${spec.capabilityClass}/${spec.latencyClass}`;
	const skills = spec.skills.length > 0 ? ` skills=${spec.skills.join(",")}` : "";
	process.stdout.write(`${spec.id.padEnd(20)} ${shape.padEnd(48)} ${spec.description}${skills}\n`);
}
