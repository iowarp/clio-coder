import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { AgentRecipe } from "../domains/agents/recipe.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";

export async function runAgentsCommand(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	ensureClioState();
	const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule, AgentsDomainModule]);
	const agents = result.getContract<AgentsContract>("agents");
	if (!agents) {
		process.stderr.write("agents: domain not loaded\n");
		await result.stop();
		return 1;
	}
	const recipes = agents.list();
	if (json) {
		const withoutBody = recipes.map(({ body: _body, ...rest }) => rest);
		process.stdout.write(`${JSON.stringify(withoutBody, null, 2)}\n`);
	} else {
		for (const r of recipes) {
			renderLine(r);
		}
	}
	await result.stop();
	return 0;
}

function renderLine(r: AgentRecipe): void {
	const mode = r.mode ?? "default";
	const modeColored = mode === "super" ? chalk.red(mode) : mode === "advise" ? chalk.yellow(mode) : chalk.green(mode);
	process.stdout.write(`${r.id.padEnd(18)} ${modeColored.padEnd(16)} ${r.description}\n`);
}
