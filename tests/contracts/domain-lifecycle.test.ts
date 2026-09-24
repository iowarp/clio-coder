import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { type DomainContext, type DomainModule, loadDomains } from "../../src/core/domain-loader.js";
import { getSharedBus } from "../../src/core/shared-bus.js";

test("failed domain startup releases its listeners and earlier dependencies in reverse order", async () => {
	const bus = getSharedBus();
	const before = bus.listeners(BusChannels.SessionStart).length;
	const stopped: string[] = [];
	let dependencyDuringStop: string | undefined;
	const failure = new Error("startup failed after subscribing");
	const modules = ["dependency", "consumer"].map(
		(name): DomainModule => ({
			manifest: { name, dependsOn: name === "consumer" ? ["dependency"] : [] },
			createExtension(context) {
				let unsubscribe: (() => void) | undefined;
				return {
					contract: { name },
					extension: {
						start() {
							unsubscribe = context.bus.on(BusChannels.SessionStart, () => {});
							if (name === "consumer") throw failure;
						},
						stop() {
							unsubscribe?.();
							stopped.push(name);
							if (name === "consumer") dependencyDuringStop = context.getContract<{ name: string }>("dependency")?.name;
						},
					},
				};
			},
		}),
	);
	await rejects(loadDomains(modules, { diagnostic() {} }), { cause: failure });
	deepStrictEqual(stopped, ["consumer", "dependency"]);
	strictEqual(dependencyDuringStop, "dependency");
	strictEqual(bus.listeners(BusChannels.SessionStart).length, before);
});

test("a rejected domain factory unwinds started dependencies", async () => {
	let stopped = false;
	await rejects(
		loadDomains(
			[
				{
					manifest: { name: "dependency", dependsOn: [] },
					createExtension: () => ({
						contract: {},
						extension: {
							start() {},
							stop() {
								stopped = true;
							},
						},
					}),
				},
				{
					manifest: { name: "consumer", dependsOn: ["dependency"] },
					createExtension() {
						throw new Error("factory failed");
					},
				},
			],
			{ diagnostic() {} },
		),
		/factory failed/,
	);
	strictEqual(stopped, true);
});

test("concurrent shutdown callers await one cleanup and stopped contracts are withdrawn", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let stops = 0;
	let context!: DomainContext;
	const loaded = await loadDomains([
		{
			manifest: { name: "owned", dependsOn: [] },
			createExtension(ctx) {
				context = ctx;
				return {
					contract: { active: true },
					extension: {
						start() {},
						async stop() {
							stops += 1;
							await pending;
						},
					},
				};
			},
		},
	]);
	const first = loaded.stop();
	const second = loaded.stop();
	strictEqual(first, second);
	release();
	await Promise.all([first, second]);
	await loaded.stop();
	strictEqual(stops, 1);
	strictEqual(loaded.getContract("owned"), undefined);
	strictEqual(context.getContract("owned"), undefined);
});

test("duplicate domain names reject the composition before either implementation starts", async () => {
	let created = false;
	const module: DomainModule = {
		manifest: { name: "duplicate", dependsOn: [] },
		createExtension() {
			created = true;
			return { contract: {}, extension: { start() {} } };
		},
	};
	await rejects(loadDomains([module, module]), /Duplicate domain: duplicate/);
	strictEqual(created, false);
});

test("a cancelled load stops the started domains and propagates the cancellation unchanged", async () => {
	const bus = getSharedBus();
	const failedEvents: unknown[] = [];
	const unsubscribe = bus.on(BusChannels.DomainFailed, (payload) => {
		failedEvents.push(payload);
	});
	const created: string[] = [];
	const stopped: string[] = [];
	const diagnostics: string[] = [];
	const cancellation = new DOMException("boot cancelled", "AbortError");
	const modules = ["first", "second", "third"].map(
		(name, index): DomainModule => ({
			manifest: { name, dependsOn: index === 0 ? [] : [["first", "second", "third"][index - 1] as string] },
			createExtension() {
				created.push(name);
				return {
					contract: {},
					extension: {
						start() {},
						stop() {
							stopped.push(name);
						},
					},
				};
			},
		}),
	);
	let boundaries = 0;
	try {
		const load = loadDomains(modules, {
			diagnostic: (text) => diagnostics.push(text),
			async beforeEach() {
				boundaries += 1;
				// Interactive boot turns the loop here; Ctrl+C at Stage 0 closes the
				// lease during the second turn.
				await new Promise((settle) => setImmediate(settle));
				if (boundaries === 3) throw cancellation;
			},
		});
		await rejects(load, (error) => error === cancellation);
	} finally {
		unsubscribe();
	}
	deepStrictEqual(created, ["first", "second"], "no domain is created after the cancelled boundary");
	deepStrictEqual(stopped, ["second", "first"], "started domains stop in reverse order");
	deepStrictEqual(failedEvents, [], "a cancellation is not a domain failure");
	deepStrictEqual(diagnostics, []);
});
