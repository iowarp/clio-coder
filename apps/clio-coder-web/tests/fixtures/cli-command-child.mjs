import { appendFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.CLIO_CODER_WEB_COMMAND_LOG ?? (existsSync("record-commands") ? "command.jsonl" : undefined);
const record = (value) => {
	if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
};
record({ kind: "start", argv, cwd: process.cwd(), pid: process.pid });
const scenario = process.env.CLIO_CODER_WEB_COMMAND_SCENARIO;
if (scenario === "slow" || scenario === "ignore-term") {
	process.on("SIGTERM", () => {
		record({ kind: "SIGTERM", pid: process.pid });
		if (scenario === "slow") process.exit(0);
	});
	setInterval(() => {}, 1000);
} else if (scenario === "stdout-limit") process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
else if (scenario === "stderr-limit") process.stderr.write("x".repeat(256 * 1024 + 1));
else if (scenario === "utf8") process.stdout.write(Buffer.from([0xff]));
else if (scenario === "json") process.stdout.write("broken JSON");
else if (scenario === "fail") {
	process.stderr.write("fixture-private-stderr-content");
	process.exitCode = 7;
} else if (argv[1] === "use" || argv[1] === "remove") process.stdout.write("This is terminal prose, not JSON.\n");
else process.stdout.write(JSON.stringify({ argv }));
