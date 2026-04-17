import { DEFAULT_SETTINGS } from "../src/core/defaults.js";
import type { DomainContext } from "../src/core/domain-loader.js";
import type { SafeEventBus } from "../src/core/event-bus.js";
import { createIntelligenceBundle } from "../src/domains/intelligence/extension.js";

type IntelligenceSettings = typeof DEFAULT_SETTINGS & { intelligence?: { enabled?: boolean } };

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-intelligence] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-intelligence] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

const noopBus: SafeEventBus = {
	emit() {},
	on() {
		return () => {};
	},
	listeners() {
		return [];
	},
	clear() {},
};

function createContext(settings: IntelligenceSettings): DomainContext {
	const config = {
		get: () => settings,
		onChange: () => () => {},
	};
	return {
		bus: noopBus,
		getContract(name) {
			return name === "config" ? config : undefined;
		},
	};
}

async function main(): Promise<void> {
	const disabledSettings: IntelligenceSettings = structuredClone(DEFAULT_SETTINGS);
	const disabledBundle = createIntelligenceBundle(createContext(disabledSettings));
	await disabledBundle.extension.start();
	check("disabled:enabled-false", disabledBundle.contract.enabled() === false);
	check("disabled:observations-empty", disabledBundle.contract.observations().length === 0);
	await disabledBundle.extension.stop();

	const enabledSettings: IntelligenceSettings = {
		...structuredClone(DEFAULT_SETTINGS),
		intelligence: { enabled: true },
	};
	const enabledBundle = createIntelligenceBundle(createContext(enabledSettings));
	try {
		await enabledBundle.extension.start();
		check("enabled:throws", false, "start resolved unexpectedly");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		check(
			"enabled:throws",
			message === "intelligence.enabled=true but no detector implementation is present in this build",
			message,
		);
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-intelligence] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-intelligence] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-intelligence] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
