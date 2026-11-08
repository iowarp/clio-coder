// Stands in for `clio-coder research` in the GUI tests: real CLI output captured from a scratch campaign, replayed.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.CLIO_CODER_WEB_COMMAND_LOG;
const record = (value) => {
	if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
};
record({ kind: "start", argv, cwd: process.cwd(), pid: process.pid });
const fixture = (name) => JSON.parse(readFileSync(new URL(`./research/${name}.json`, import.meta.url), "utf8"));
const [domain, action, id] = argv;
const list = fixture("list");
const view = (campaignId) => list.campaigns.find((entry) => entry.id === campaignId);

if (domain !== "research") process.exitCode = 2;
else if (action === "list") process.stdout.write(JSON.stringify(list));
else if (action === "status") {
	if (view(id)) process.stdout.write(JSON.stringify(view(id)));
	else {
		process.stderr.write(`clio-coder: research status: no campaign ${id}\n`);
		process.exitCode = 1;
	}
} else if (action === "report") {
	// A report whose recomputation disagrees still prints its record and exits 1.
	const report = fixture("report");
	report.agrees = false;
	report.recomputed[1].agrees = false;
	process.stdout.write(JSON.stringify(report));
	process.exitCode = 1;
} else if (action === "start") {
	const campaign = list.campaigns.at(-1);
	const goal = argv[argv.indexOf("--goal") + 1];
	process.stderr.write(`research ${campaign.id}: opened at 405d368742a5 on clio/research/${campaign.id}\n`);
	process.stderr.write(`research ${campaign.id}: A/A unchanged\n`);
	if (goal === "wait for a stop") {
		process.on("SIGTERM", () => {
			record({ kind: "SIGTERM", pid: process.pid });
			process.stderr.write(`research ${campaign.id}: SIGTERM: stopping after the current step\n`);
			process.stdout.write(JSON.stringify(campaign));
			process.exit(143);
		});
		setInterval(() => {}, 1000);
	} else process.stdout.write(JSON.stringify(list.campaigns[0]));
}
