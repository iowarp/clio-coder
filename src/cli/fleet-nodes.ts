import { readSettings } from "../core/config.js";
import type { FleetNodeSettings } from "../core/defaults.js";
import { addFleetNode, inspectFleetNodes, removeFleetNode, testFleetNode } from "../domains/dispatch/fleet-nodes.js";
import type { FleetPreflightRecord } from "../domains/dispatch/fleet-preflight.js";

const HELP = `clio-coder fleet nodes <command>

  setup <id> [--host <SSH alias or address> and add flags] [--yes]
  setup --all [--yes]                   add the node when --host is given, install this exact build
                                        when the node lacks it (preview without --yes), and record
                                        the check; rerun after every rebuild
  add <id> --host <SSH alias or address> [--user <name>] [--port <number>]
      [--identity-file <path>] [--entry <worker command>] [--version-command <command>]
      [--labels <comma-separated labels>] [--max-workers <number>] [--test] [--record]
                                        register a node (--max-workers defaults to 1); --test
                                        probes it after adding, --record also records the check
  discover [--json]                     list Tailscale peers and which ones are registered nodes
  install <id> [--yes]                  preview a user-level install of this exact client; --yes executes
  tools install <id> <tool> [--yes]     preview a user-level remote install of asciinema, copilot-sdk or
                                        claude-sdk pinned by the node's Clio; --yes executes
  list [--json]                         show recorded readiness for this project and check age
  remove <id>                           remove a node without deleting remote files
  test <id> [--record] [--json]         probe without remote writes; --record updates local eligibility

A registered node needs a passing recorded check before dispatch.
Exact Clio builds and project paths must match; a -dev version must match its build too. Independent checkouts must share clean Git history and commit; independent-checkout mutations require worktree: true and return commits through SSH into guarded application. Labels are operator declarations.
`;

function parse(
	args: ReadonlyArray<string>,
	flags: ReadonlyArray<string>,
	values: ReadonlyArray<string>,
): { positional: string[]; flags: Set<string>; values: Map<string, string> } {
	const result = { positional: [] as string[], flags: new Set<string>(), values: new Map<string, string>() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (flags.includes(arg)) result.flags.add(arg);
		else if (values.includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
			result.values.set(arg, value);
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else result.positional.push(arg);
	}
	return result;
}

const ADD_VALUE_FLAGS = [
	"--host",
	"--user",
	"--port",
	"--identity-file",
	"--entry",
	"--version-command",
	"--labels",
	"--max-workers",
] as const;

function nodeFromFlags(id: string, host: string, values: ReadonlyMap<string, string>): FleetNodeSettings {
	const node: FleetNodeSettings = {
		id,
		host,
		maxWorkers: positiveInteger(values.get("--max-workers") ?? "1", "--max-workers"),
		residency: "observe",
	};
	for (const [flag, key] of [
		["--user", "user"],
		["--identity-file", "identityFile"],
		["--entry", "clioCoderEntry"],
		["--version-command", "clioCoderVersionCommand"],
	] as const) {
		const value = values.get(flag);
		if (value !== undefined) node[key] = value;
	}
	const port = values.get("--port");
	if (port !== undefined) node.port = positiveInteger(port, "--port");
	const labels = values.get("--labels");
	if (labels !== undefined)
		node.labels = labels
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
	return node;
}

function writeRecord(record: FleetPreflightRecord, recorded: boolean): void {
	process.stdout.write(
		`${record.nodeId}: ${record.ok ? "checks passed" : "needs attention"}${recorded ? " (recorded)" : " (observation only)"}\n`,
	);
	if (record.project)
		process.stdout.write(
			`  project=${record.project.kind}${record.project.head ? ` commit=${record.project.head}` : ""}\n`,
		);
	if (record.detail) process.stdout.write(`  ${record.detail}\n`);
	if (record.note) process.stdout.write(`  note: ${record.note}\n`);
	for (const fact of record.targets)
		process.stdout.write(
			`  ${fact.targetId}: network=${fact.reachable} listingAccess=${fact.authentication ?? "unknown"} model=${fact.modelAvailable} runtime=${fact.runtimeCompatible}\n`,
		);
}

/** A peer is registered when a node's host names it by MagicDNS, host name or address. */
function registeredNodeFor(
	nodes: ReadonlyArray<FleetNodeSettings>,
	peer: { name: string; magicDns: string | null; addresses: string[] },
): string | null {
	const names = new Set(
		[peer.name, peer.magicDns?.replace(/\.$/u, ""), peer.magicDns?.split(".")[0], ...peer.addresses]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map((value) => value.toLowerCase()),
	);
	const node = nodes.find((item) => names.has(item.host.toLowerCase().replace(/\.$/u, "")));
	return node?.id ?? null;
}

function positiveInteger(value: string, field: string): number {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
		throw new Error(`${field} needs a positive integer`);
	return Number(value);
}

export async function runFleetNodes(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	try {
		const sub = args[0];
		if (sub === "list") {
			const parsed = parse(args.slice(1), ["--json"], []);
			if (parsed.positional.length) throw new Error("list takes no node id");
			const nodes = inspectFleetNodes();
			if (parsed.flags.has("--json")) process.stdout.write(`${JSON.stringify({ nodes }, null, 2)}\n`);
			else {
				process.stdout.write("local  implicit local worker node\n");
				for (const item of nodes) {
					const age = item.ageMs === null ? "never" : `${Math.floor(item.ageMs / 60_000)}m ago`;
					process.stdout.write(
						`${item.node.id}  ${item.node.host}  ${item.readiness}  checked ${age}  maxWorkers=${item.node.maxWorkers}  labels=${item.node.labels?.join(",") || "none"}\n`,
					);
					if (item.reason) process.stdout.write(`  ${item.reason}\n`);
				}
				if (!nodes.length)
					process.stdout.write("No remote nodes. Set one up with 'clio-coder fleet nodes setup <id> --host <host>'.\n");
			}
			return 0;
		}
		if (sub === "remove") {
			const parsed = parse(args.slice(1), [], []);
			if (parsed.positional.length !== 1) throw new Error("remove requires one node id");
			removeFleetNode(parsed.positional[0] as string);
			process.stdout.write(`Removed node ${parsed.positional[0]}. Remote files were left in place.\n`);
			return 0;
		}
		if (sub === "add") {
			const parsed = parse(args.slice(1), ["--test", "--record"], ADD_VALUE_FLAGS);
			const host = parsed.values.get("--host");
			if (parsed.positional.length !== 1 || !host)
				throw new Error("add requires one node id and --host <SSH alias or address>");
			const node = nodeFromFlags(parsed.positional[0] as string, host, parsed.values);
			addFleetNode(node);
			process.stdout.write(`Added ${node.id} (${node.host}).\n`);
			if (parsed.flags.has("--test") || parsed.flags.has("--record"))
				return runFleetNodes(["test", node.id, ...(parsed.flags.has("--record") ? ["--record"] : [])]);
			process.stdout.write(`Next: clio-coder fleet nodes setup ${node.id}\n`);
			return 0;
		}
		if (sub === "setup") {
			const parsed = parse(args.slice(1), ["--yes", "--all"], ADD_VALUE_FLAGS);
			const all = parsed.flags.has("--all");
			if (all ? parsed.positional.length > 0 || parsed.values.size > 0 : parsed.positional.length !== 1)
				throw new Error("setup requires one node id, or --all without node flags");
			const known = new Set(readSettings().fleet.nodes.map((node) => node.id));
			const ids = all ? [...known] : [parsed.positional[0] as string];
			let added = false;
			if (!all) {
				const id = ids[0] as string;
				const host = parsed.values.get("--host");
				if (!known.has(id)) {
					if (!host) throw new Error(`unknown fleet node '${id}'; give --host <SSH alias or address> to add it`);
					addFleetNode(nodeFromFlags(id, host, parsed.values));
					process.stdout.write(`Added ${id} (${host}).\n`);
					added = true;
				} else if (parsed.values.size > 0) {
					throw new Error(`node '${id}' already exists; change its connection with remove and add`);
				}
			}
			if (ids.length === 0) {
				process.stdout.write("No remote nodes. Set one up with 'clio-coder fleet nodes setup <id> --host <host>'.\n");
				return 0;
			}
			const { setupFleetNode } = await import("../domains/dispatch/fleet-node-setup.js");
			let exit = 0;
			for (const id of ids) {
				const result = await setupFleetNode(id, {
					yes: parsed.flags.has("--yes"),
					added,
					write: (line) => process.stdout.write(`${line}\n`),
				});
				if (result.recorded) writeRecord(result.record, true);
				if (result.outcome !== "ready" && result.outcome !== "install-previewed") exit = 1;
			}
			return exit;
		}
		if (sub === "discover") {
			const parsed = parse(args.slice(1), ["--json"], []);
			if (parsed.positional.length) throw new Error("discover takes no node id; select a candidate with nodes add");
			const { discoverTailscaleNodes } = await import("../domains/dispatch/fleet-node-discovery.js");
			const nodes = readSettings().fleet.nodes;
			const candidates = (await discoverTailscaleNodes()).map((peer) => ({
				...peer,
				registeredAs: registeredNodeFor(nodes, peer),
			}));
			if (parsed.flags.has("--json"))
				process.stdout.write(`${JSON.stringify({ candidates, readiness: "not checked" }, null, 2)}\n`);
			else {
				process.stdout.write("Tailscale peers (SSH and worker readiness are not checked):\n");
				for (const peer of candidates)
					process.stdout.write(
						`${peer.name}  MagicDNS=${peer.magicDns ?? "unavailable"}  addresses=${peer.addresses.join(", ") || "unavailable"}  ${peer.online === true ? "Tailscale online" : peer.online === false ? "Tailscale offline" : "Tailscale state unknown"}${peer.registeredAs !== null ? `  registered as node '${peer.registeredAs}'` : ""}\n`,
					);
				if (!candidates.length)
					process.stdout.write("No peers reported. You can still add an SSH alias or address directly.\n");
				process.stdout.write(
					"Set one up: clio-coder fleet nodes setup <id> --host <MagicDNS name or address>\nIf a known LAN address is reachable on your network, you can choose it instead.\n",
				);
			}
			return 0;
		}
		if (sub === "install") {
			const parsed = parse(args.slice(1), ["--yes"], []);
			if (parsed.positional.length !== 1) throw new Error("install requires one node id");
			const { prepareFleetNodeInstall, describeFleetNodeInstall, executeFleetNodeInstall } = await import(
				"../domains/dispatch/fleet-node-install.js"
			);
			const plan = await prepareFleetNodeInstall(parsed.positional[0] as string);
			try {
				process.stdout.write(`${describeFleetNodeInstall(plan)}\n`);
				if (!parsed.flags.has("--yes")) {
					process.stdout.write(`Run 'clio-coder fleet nodes install ${plan.node.id} --yes' to execute.\n`);
					return 0;
				}
				await executeFleetNodeInstall(plan);
				process.stdout.write(`Installed and version-verified. Next: clio-coder fleet nodes setup ${plan.node.id}\n`);
				return 0;
			} finally {
				plan.cleanup();
			}
		}
		if (sub === "tools") {
			const { prepareFleetToolInstall, describeFleetToolInstall, executeFleetToolInstall, FLEET_TOOLS, isFleetTool } =
				await import("../domains/dispatch/index.js");
			const usage = `tools install requires <node-id> and one of ${FLEET_TOOLS.join(", ")}`;
			if (args[1] !== "install") throw new Error(usage);
			const parsed = parse(args.slice(2), ["--yes"], []);
			const tool = parsed.positional[1];
			if (parsed.positional.length !== 2 || tool === undefined || !isFleetTool(tool)) throw new Error(usage);
			const plan = prepareFleetToolInstall(parsed.positional[0] as string, tool);
			process.stdout.write(`${describeFleetToolInstall(plan)}\n`);
			if (!parsed.flags.has("--yes")) {
				process.stdout.write(`Run 'clio-coder fleet nodes tools install ${plan.node.id} ${tool} --yes' to execute.\n`);
				return 0;
			}
			const output = await executeFleetToolInstall(plan);
			process.stdout.write(`${output.trim()}\n`);
			return 0;
		}
		if (sub === "test") {
			const parsed = parse(args.slice(1), ["--record", "--json"], []);
			if (parsed.positional.length !== 1) throw new Error("test requires one node id");
			const record = await testFleetNode(parsed.positional[0] as string, process.cwd(), {
				record: parsed.flags.has("--record"),
			});
			if (parsed.flags.has("--json")) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
			else {
				writeRecord(record, parsed.flags.has("--record"));
				if (record.ok && !parsed.flags.has("--record"))
					process.stdout.write(`Record this check with: clio-coder fleet nodes test ${record.nodeId} --record\n`);
			}
			return record.ok ? 0 : 1;
		}
		throw new Error(`unknown node command '${sub ?? ""}'`);
	} catch (error) {
		process.stderr.write(`clio-coder fleet nodes: ${error instanceof Error ? error.message : String(error)}\n${HELP}`);
		return 2;
	}
}
