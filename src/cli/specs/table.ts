/**
 * Light metadata for every top-level command, one literal dynamic import per
 * key so the bundler gives each spec its own chunk and nothing here loads a
 * command implementation. Root help and `help --json` read specs only (spec
 * stubs per CLI lane L0; each stub passes to the lane that owns its command).
 *
 * The keys are the `COMMAND_HANDLERS` keys in `src/cli/index.ts`; a command
 * added there gets its stub and row here. The stubs were
 * generated from the 0.8.5 root help, the `dev` listing and the handler
 * comments, so `hidden` marks exactly what the default root help leaves out.
 */
import type { CommandSpec } from "../kit/help.js";

interface CommandSpecModule {
	readonly spec: CommandSpec;
}

export const COMMAND_SPECS = {
	acp: () => import("./acp.js"),
	auth: () => import("./auth.js"),
	config: () => import("./config.js"),
	configure: () => import("./configure.js"),
	targets: () => import("./targets.js"),
	models: () => import("./models.js"),
	agents: () => import("./agents.js"),
	evidence: () => import("./evidence.js"),
	memory: () => import("./memory.js"),
	claims: () => import("./claims.js"),
	arena: () => import("./arena.js"),
	campaign: () => import("./campaign.js"),
	research: () => import("./research.js"),
	semantic: () => import("./semantic.js"),
	usage: () => import("./usage.js"),
	telemetry: () => import("./telemetry.js"),
	report: () => import("./report.js"),
	session: () => import("./session.js"),
	systemone: () => import("./systemone.js"),
	dev: () => import("./dev.js"),
	extensions: () => import("./extensions.js"),
	fleet: () => import("./fleet.js"),
	playbook: () => import("./playbook.js"),
	library: () => import("./library.js"),
	tasks: () => import("./tasks.js"),
	mcp: () => import("./mcp.js"),
	store: () => import("./store.js"),
	verifiers: () => import("./verifiers.js"),
	gui: () => import("./gui.js"),
	share: () => import("./share.js"),
	context: () => import("./context.js"),
	run: () => import("./run.js"),
	tools: () => import("./tools.js"),
	interop: () => import("./interop.js"),
	panes: () => import("./panes.js"),
	doctor: () => import("./doctor.js"),
	paths: () => import("./paths.js"),
	setup: () => import("./setup.js"),
	reset: () => import("./reset.js"),
	uninstall: () => import("./uninstall.js"),
	upgrade: () => import("./upgrade.js"),
	version: () => import("./version.js"),
	worker: () => import("./worker.js"),
	help: () => import("./help.js"),
	schema: () => import("./schema.js"),
} as const satisfies Readonly<Record<string, () => Promise<CommandSpecModule>>>;

export type CommandName = keyof typeof COMMAND_SPECS;
