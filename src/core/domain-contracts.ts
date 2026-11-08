/**
 * The one map from a loaded domain's name to the contract it publishes.
 * `DomainModule<N>` makes a module named N return `DomainContractMap[N]`, and
 * `getContract(N)` returns that same type, so a lookup needs no caller-chosen
 * cast and a module cannot publish a contract its name does not declare.
 * Adding a loaded domain means adding its row here.
 */
import type { AgentsContract } from "../domains/agents/contract.js";
import type { ConfigContract } from "../domains/config/contract.js";
import type { ContextContract } from "../domains/context/contract.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../domains/extensions/contract.js";
import type { InteropContract } from "../domains/interop/contract.js";
import type { MemoryContract } from "../domains/memory/contract.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type { MuxContract } from "../domains/mux/contract.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import type { ResourcesContract } from "../domains/resources/contract.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { ShareContract } from "../domains/share/contract.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";

export interface DomainContractMap {
	agents: AgentsContract;
	config: ConfigContract;
	context: ContextContract;
	dispatch: DispatchContract;
	extensions: ExtensionsContract;
	interop: InteropContract;
	/** Declared inline by the composition root around its `MemoryRuntime`. */
	memory: MemoryContract;
	middleware: MiddlewareContract;
	mux: MuxContract;
	/** Publishes nothing; stays loaded so teardown drops cached plugin snapshots. */
	plugins: Record<never, never>;
	prompts: PromptsContract;
	providers: ProvidersContract;
	resources: ResourcesContract;
	safety: SafetyContract;
	scheduling: SchedulingContract;
	session: SessionContract;
	share: ShareContract;
	telemetry: TelemetryContract;
}

export type DomainName = keyof DomainContractMap;
