/**
 * Prepare a scratch Clio home for an interactive run and print its environment.
 *
 * For an agent or operator who wants the real TUI in a tmux or herdr pane
 * rather than a scripted drive: the same isolation the other drivers use
 * (one configured target copied into a throwaway home, credentials for the
 * run only), printed as shell exports to source before launching
 * `node dist/cli/index.js`. The tree is never removed by this command; delete
 * it when the pane is done, which also removes the copied credentials.
 *
 *   eval "$(npm run -s live:home -- --target <id>)"
 *   node dist/cli/index.js
 */
import { parseLiveArgs, prepareLiveHome, rejectUnknown, runDriver } from "./live-target.js";

const USAGE = `usage: eval "$(npm run -s live:home -- --target <id> [--model <wireId>] [--thinking <level>])"

Prints shell exports for a throwaway Clio home holding only the chosen target.
Launch node dist/cli/index.js in that shell; remove the printed directory when done.
`;

await runDriver(USAGE, async () => {
	const args = parseLiveArgs(process.argv.slice(2));
	rejectUnknown(args.rest);
	const home = prepareLiveHome({ ...args, keep: true }, { prefix: "clio-live-home-", autonomy: "full-auto" });
	const lines = Object.entries(home.env)
		.filter(([key, value]) => (key.startsWith("CLIO_CODER_") || key === "TMPDIR") && typeof value === "string")
		.map(([key, value]) => `export ${key}=${JSON.stringify(value)}`);
	lines.push(`# target=${home.target.id} model=${home.model} thinking=${home.thinking}`);
	lines.push(`# remove when done: rm -rf ${JSON.stringify(home.dir)}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return true;
});
