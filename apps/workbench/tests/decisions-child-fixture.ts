const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? Deno.args : Deno.args.slice(separator + 1);
if (commandArgs.join(" ") !== "fleet decisions --json") Deno.exit(73);

console.log(JSON.stringify({
	version: 1,
	generatedAt: "2026-08-31T14:01:30.000Z",
	available: true,
	decisions: [
		{
			id: "fleet-345ea2e6c1ad_review-mtgy1k87-945afd774c1d",
			group: "fleet-345ea2e6c1ad:review",
			topology: "review",
			cycle: 2,
			outcome: "exhausted",
			decidedAt: "2026-08-31T13:58:00.000Z",
			subjects: ["run-alpha"],
			subjectsTruncated: false,
			decider: "run-reviewer",
			correlation: {
				agent: false,
				target: true,
				modelFamily: true,
				runtime: true,
				node: true,
				independent: false,
			},
			winner: null,
			confirms: null,
			reason: "reviewer-report-invalid",
		},
		{
			id: "compete-mt20xowx-a270cb-mt213mjr-5462547e6338",
			group: "compete-mt20xowx-a270cb",
			topology: "compete",
			cycle: 1,
			outcome: "winner",
			decidedAt: "2026-08-31T13:40:00.000Z",
			subjects: ["run-candidate-1", "run-candidate-2"],
			subjectsTruncated: false,
			decider: "run-judge",
			correlation: {
				agent: false,
				target: true,
				modelFamily: false,
				runtime: true,
				node: true,
				independent: true,
			},
			winner: { index: 2, runId: "run-candidate-2" },
			confirms: null,
			reason: null,
		},
	],
	truncated: true,
	unverifiable: 1,
}));
