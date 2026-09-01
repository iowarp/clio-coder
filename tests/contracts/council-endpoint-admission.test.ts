/**
 * /council admission against a single-slot inference endpoint (#256).
 *
 * The bug was timing, not arithmetic. Provider startup builds target statuses
 * asynchronously, and `endpointCapacityForTarget` resolved only from
 * `providers.list()`. A council typed before that list was populated produced a
 * plan whose members carried no `endpointKey`, reservation planning skips a
 * dimension it has no limit for, and the whole roster was admitted against one
 * slot. A council typed after the list filled resolved the endpoint at the
 * local-native default of one and was denied. Same command, opposite outcomes,
 * decided by how many seconds had passed since boot.
 *
 * These tests drive both orderings against one bundle and assert the same
 * verdict, and assert that the denial names both ways out.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { COUNCIL_MIN_MEMBERS } from "../../src/domains/dispatch/gate-role-prompts.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

/** A one-slot llama.cpp box, the README's recommended single-GPU setup. */
const ENDPOINT_URL = "http://192.168.86.141:8080";

const LLAMACPP: RuntimeDescriptor = {
	id: "llamacpp",
	displayName: "llama.cpp",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "none",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
	synthesizeModel: () => ({ id: "model", provider: "llamacpp" }) as never,
};

function councilSettings(): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "mini", runtime: "llamacpp", url: ENDPOINT_URL, defaultModel: "model" }];
	settings.fleet.default.target = "mini";
	settings.fleet.default.model = "model";
	return settings;
}

const MEMBERS = [
	{ label: "alpha", target: "mini" },
	{ label: "beta", target: "mini" },
];

/**
 * Provider statuses appear only once `probed` flips, which is what provider
 * startup does asynchronously in production. Everything else about the
 * contract is the stub's.
 */
function stagedProviderContext(settings: typeof DEFAULT_SETTINGS): {
	context: DomainContext;
	landProbe(): void;
} {
	const base = dispatchStubContext({ settings, runtime: LLAMACPP });
	const inner = base.getContract<ProvidersContract>("providers");
	if (inner === undefined) throw new Error("stub context has no providers contract");
	let probed = false;
	const providers: ProvidersContract = {
		...inner,
		list: () => (probed ? inner.list() : ([] as ReadonlyArray<TargetStatus>)),
	};
	const context: DomainContext = {
		bus: base.bus,
		getContract: ((name: string) =>
			name === "providers" ? providers : base.getContract(name)) as DomainContext["getContract"],
	};
	return {
		context,
		landProbe: () => {
			probed = true;
		},
	};
}

async function councilDenial(input: { landProbeFirst: boolean }): Promise<string | undefined> {
	const settings = councilSettings();
	const staged = stagedProviderContext(settings);
	if (input.landProbeFirst) staged.landProbe();
	const bundle = makeDispatchBundle(staged.context);
	await bundle.extension.start();
	try {
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: bundle.contract,
			getAutonomy: () => "full-auto",
			getWorkerRosters: () => settings.fleet.rosters,
		});
		const prepared = tool.prepareAdmissionArguments?.({
			mode: "council",
			task: "weigh the storage layout",
			members: MEMBERS,
		});
		ok(prepared);
		const failure = prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT];
		return failure === undefined ? undefined : String(failure);
	} finally {
		await bundle.extension.stop?.();
	}
}

describe("council admission against a single-slot endpoint", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("denies the same council whether or not provider statuses have been built", async () => {
		const beforeProbe = await councilDenial({ landProbeFirst: false });
		const afterProbe = await councilDenial({ landProbeFirst: true });
		ok(
			beforeProbe !== undefined,
			"a council needing two slots on a one-slot endpoint must be refused before discovery lands, not admitted whole",
		);
		ok(afterProbe !== undefined, "the same council is refused once discovery has landed");
		match(beforeProbe, /endpoint '192\.168\.86\.141:8080' capacity exceeded \(2\/1 slots\)/);
		strictEqual(beforeProbe, afterProbe, "admission does not depend on how soon after boot the council is typed");
	});

	it("names the maxConcurrentRequests override and the roster floor as the two ways out", async () => {
		const denial = await councilDenial({ landProbeFirst: true });
		ok(denial);
		match(denial, /maxConcurrentRequests/);
		match(denial, new RegExp(`cannot go below ${COUNCIL_MIN_MEMBERS} members`));
		// "dispatch fewer at once" is the one remedy a council cannot take, so the
		// denial must not offer it.
		strictEqual(denial.includes("reduce the same-wave worker count"), false);
	});

	it("admits the same council once the endpoint declares the slots the roster needs", async () => {
		const settings = councilSettings();
		const target = settings.targets[0];
		ok(target);
		target.maxConcurrentRequests = 4;
		const staged = stagedProviderContext(settings);
		const bundle = makeDispatchBundle(staged.context);
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
				getWorkerRosters: () => settings.fleet.rosters,
			});
			const prepared = tool.prepareAdmissionArguments?.({
				mode: "council",
				task: "weigh the storage layout",
				members: MEMBERS,
			});
			ok(prepared);
			strictEqual(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
