// A stdio MCP server that speaks the five compact tool names of the clio-kit
// Slurm server (`clio-kit mcp-server slurm`), with the same annotations and no
// scheduler behind it. Plain Node, one JSON-RPC message per line. Every
// submission and cancellation is appended to the file named by the first
// argument, so a test can prove which calls reached the server.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const journal = process.argv[2];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const object = (properties, required = []) => ({ type: "object", properties, required });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

const TOOLS = [
	{
		name: "slurm_submit",
		description: "Submit one Slurm job or array and return its scheduler-native job ID.",
		inputSchema: object({ script_path: { type: "string" }, partition: { type: "string" } }, ["script_path"]),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
	},
	{
		name: "slurm_list",
		description: "List Slurm jobs.",
		inputSchema: object({ user: { type: "string" } }),
		annotations: readOnly,
	},
	{
		name: "slurm_describe",
		description: "Describe one Slurm job.",
		inputSchema: object({ job_id: { type: "string" }, output: { type: "string" } }, ["job_id"]),
		annotations: readOnly,
	},
	{
		name: "slurm_cluster",
		description: "Inspect partitions and the queue.",
		inputSchema: object({}),
		annotations: readOnly,
	},
	{
		name: "slurm_cancel",
		description: "Request destructive cancellation of one Slurm job.",
		inputSchema: object({ job_id: { type: "string" }, confirm_job_id: { type: "string" } }, ["job_id", "confirm_job_id"]),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
	},
];

function call(name, args) {
	switch (name) {
		case "slurm_submit":
			appendFileSync(journal, `submit ${args.script_path}\n`);
			return { job_id: "4821", state: "PENDING" };
		case "slurm_list":
			return { jobs: [{ job_id: "4821", state: "RUNNING" }], truncated: false };
		case "slurm_describe":
			return { job_id: args.job_id, state: "COMPLETED", terminal: true, exit_code: 0 };
		case "slurm_cluster":
			return { partitions: [{ name: "debug", state: "up" }], queue: [] };
		case "slurm_cancel":
			if (args.confirm_job_id !== args.job_id) return null;
			appendFileSync(journal, `cancel ${args.job_id}\n`);
			return { job_id: args.job_id, state: "CANCELLED" };
		default:
			return null;
	}
}

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof message.method !== "string" || message.id === undefined) return;
	if (message.method === "initialize") {
		reply(message.id, {
			protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "slurm-fixture", version: "1.0" },
		});
	} else if (message.method === "tools/list") {
		reply(message.id, { tools: TOOLS });
	} else if (message.method === "tools/call") {
		const result = call(message.params?.name, message.params?.arguments ?? {});
		reply(
			message.id,
			result === null
				? { content: [{ type: "text", text: "rejected" }], isError: true }
				: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
		);
	} else {
		write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
	}
});
