import { resolve } from "node:path";
import { readSettings, updateSettings } from "../../core/config.js";
import type { FleetNodeSettings } from "../../core/defaults.js";
import { resolveEnvironmentApiKey, resolveStoredApiKey } from "../providers/auth/api-key.js";
import { openAuthStorage, resolveAuthTarget } from "../providers/auth/index.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import { registerBuiltinRuntimes } from "../providers/runtimes/builtins.js";
import {
	type FleetPreflightRecord,
	type FleetPreflightRunOptions,
	type FleetPreflightTarget,
	fleetPreflightVerdict,
	readFleetPreflightRecords,
	recordFleetPreflight,
	runFleetNodePreflight,
} from "./fleet-preflight.js";
import { verifyFleetProject } from "./fleet-project-verification.js";

export type FleetNodeReadiness = "not checked" | "ready for this project" | "needs attention" | "offline";

export interface FleetNodeInspection {
	node: FleetNodeSettings;
	readiness: FleetNodeReadiness;
	reason: string | null;
	checkedAt: string | null;
	ageMs: number | null;
	record: FleetPreflightRecord | null;
}

export function inspectFleetNodes(projectRoot = process.cwd()): FleetNodeInspection[] {
	const records = readFleetPreflightRecords();
	return readSettings().fleet.nodes.map((node) => {
		const record = records.find((item) => item.nodeId === node.id && item.projectRoot === resolve(projectRoot)) ?? null;
		const verdict = fleetPreflightVerdict(node, resolve(projectRoot), records);
		const age = record ? Date.now() - Date.parse(record.checkedAt) : null;
		return {
			node,
			record,
			reason: verdict.reason,
			checkedAt: record?.checkedAt ?? null,
			ageMs: age !== null && Number.isFinite(age) ? Math.max(0, age) : null,
			readiness: verdict.ok ? "ready for this project" : record === null ? "not checked" : "needs attention",
		};
	});
}

export function fleetNode(id: string): FleetNodeSettings {
	const node = readSettings().fleet.nodes.find((item) => item.id === id);
	if (!node) throw new Error(`unknown fleet node '${id}'; use 'clio-coder fleet nodes list'`);
	return node;
}

export function addFleetNode(node: FleetNodeSettings): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(node.id) || node.id === "local") {
		throw new Error("node id must use letters, numbers, underscores or hyphens; 'local' is reserved");
	}
	if (
		!node.host.trim() ||
		node.host.startsWith("-") ||
		/\s/u.test(node.host) ||
		[...node.host].some((char) => char.charCodeAt(0) < 32)
	) {
		throw new Error("host must be an SSH alias, hostname or address; use --user for the SSH user");
	}
	if (node.port !== undefined && (node.port < 1 || node.port > 65535)) throw new Error("port must be 1 through 65535");
	updateSettings((settings) => {
		if (settings.fleet.nodes.some((item) => item.id === node.id))
			throw new Error(`fleet node '${node.id}' already exists`);
		settings.fleet.nodes.push(node);
	});
}

export function removeFleetNode(id: string): void {
	updateSettings((settings) => {
		if (!settings.fleet.nodes.some((node) => node.id === id)) throw new Error(`unknown fleet node '${id}'`);
		if (settings.fleet.defaultNode === id)
			throw new Error(`node '${id}' is the standing fleet.defaultNode preference; clear that preference first`);
		const pins = Object.entries(settings.fleet.profiles)
			.filter(([, profile]) => profile.node === id)
			.map(([name]) => name);
		if (pins.length) throw new Error(`node '${id}' is pinned by profiles ${pins.join(", ")}; remove those pins first`);
		settings.fleet.nodes = settings.fleet.nodes.filter((node) => node.id !== id);
	});
}

/**
 * Read stored API keys without refreshing OAuth or writing credential state during diagnostics.
 * Only targets this node is pinned to carry credentials; a dispatch sends one target's key, and
 * a check must not send every key the operator holds. Other targets get an anonymous probe.
 */
function fleetPreflightTargets(nodeId: string): FleetPreflightTarget[] {
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const auth = openAuthStorage();
	const settings = readSettings();
	const pinned = new Set(
		Object.values(settings.fleet.profiles)
			.filter((profile) => profile.node === nodeId)
			.map((profile) => profile.target),
	);
	if (settings.fleet.defaultNode === nodeId) pinned.add(settings.fleet.default.target);
	return settings.targets.map((target) => {
		const runtime = registry.get(target.runtime);
		const credentialed = pinned.has(target.id);
		const headers: Record<string, string> = credentialed ? { ...target.auth?.headers } : {};
		if (runtime && credentialed) {
			const binding = resolveAuthTarget(target, runtime);
			const stored = auth.get(binding.providerId);
			const token =
				stored?.type === "api_key"
					? resolveStoredApiKey(stored.key, binding.providerId)
					: resolveEnvironmentApiKey(binding.providerId, binding.explicitEnvVar).apiKey;
			if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
		}
		const family = runtime?.apiFamily;
		const listing =
			family === "ollama-native"
				? "ollama"
				: family === "openai-completions" || family === "openai-responses"
					? "openai"
					: undefined;
		return {
			id: target.id,
			runtimeId: target.runtime,
			headers,
			...(target.url !== undefined ? { url: target.url } : {}),
			...(target.defaultModel !== undefined ? { wireModelId: target.defaultModel } : {}),
			...(listing !== undefined ? { listing } : {}),
		};
	});
}

export async function testFleetNode(
	id: string,
	projectRoot = process.cwd(),
	options: FleetPreflightRunOptions & { record?: boolean; verifyProject?: boolean; sharedProbe?: boolean } = {},
): Promise<FleetPreflightRecord> {
	const node = fleetNode(id);
	const result = await runFleetNodePreflight(node, resolve(projectRoot), {
		...options,
		targets: options.targets ?? fleetPreflightTargets(id),
	});
	if (result.ok && options.verifyProject !== false) {
		result.project = await verifyFleetProject(
			node,
			resolve(projectRoot),
			options.record === true || options.sharedProbe === true,
		);
		if (result.project.kind === "unverified") {
			result.ok = false;
			result.detail = result.project.reason;
		}
	}
	if (options.record) recordFleetPreflight([result]);
	return result;
}
