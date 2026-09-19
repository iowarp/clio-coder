/** Read-only local OS counters. No subprocesses, server probes, or renderer I/O. */
import { readdir, readFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";

export interface LocalMachineMetrics {
	scope: string;
	sampledAt: number;
	cpuPercent: number | null;
	processRssBytes: number;
	hostFreeBytes: number;
	hostTotalBytes: number;
	network: { name: string; receivedPerSecond: number; sentPerSecond: number } | null;
	disk: { name: string; readPerSecond: number; writtenPerSecond: number } | null;
	gpu: { name: string; busyPercent: number | null; usedBytes: number | null; totalBytes: number | null } | null;
}
type Pair = { first: number; second: number };
export function counterRate(current: number, previous: number, elapsedMs: number): number | null {
	return elapsedMs > 0 && current >= previous && Number.isFinite(current) && Number.isFinite(previous)
		? ((current - previous) * 1000) / elapsedMs
		: null;
}
export function networkCounters(text: string): Map<string, Pair> {
	const result = new Map<string, Pair>();
	for (const line of text.split("\n")) {
		const [raw, values] = line.split(":");
		const name = raw?.trim();
		if (!name || name === "lo" || !values) continue;
		const fields = values.trim().split(/\s+/).map(Number);
		if (fields.length >= 16 && Number.isFinite(fields[0]) && Number.isFinite(fields[8]))
			result.set(name, { first: fields[0] ?? 0, second: fields[8] ?? 0 });
	}
	return result;
}
export function diskCounters(text: string, devices: ReadonlySet<string>): Map<string, Pair> {
	const result = new Map<string, Pair>();
	for (const line of text.trim().split("\n")) {
		const fields = line.trim().split(/\s+/);
		const name = fields[2];
		if (!name || !devices.has(name) || /^(loop|ram|zram)/.test(name)) continue;
		const read = Number(fields[5]);
		const written = Number(fields[9]);
		if (Number.isFinite(read) && Number.isFinite(written)) result.set(name, { first: read * 512, second: written * 512 });
	}
	return result;
}
function busiest(current: Map<string, Pair>, previous: Map<string, Pair>, elapsed: number) {
	const rates = [...current].flatMap(([name, value]) => {
		const before = previous.get(name);
		if (!before) return [];
		const first = counterRate(value.first, before.first, elapsed);
		const second = counterRate(value.second, before.second, elapsed);
		return first === null || second === null ? [] : [{ name, first, second }];
	});
	return rates.sort((a, b) => b.first + b.second - a.first - a.second)[0] ?? null;
}
const read = (path: string) => readFile(path, "utf8").catch(() => null);
const numeric = async (path: string) => {
	const raw = await read(path);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : null;
};
async function gpuMetrics(): Promise<LocalMachineMetrics["gpu"]> {
	const cards = (await readdir("/sys/class/drm").catch(() => [])).filter((name) => /^card\d+$/.test(name)).slice(0, 8);
	const samples = await Promise.all(
		cards.map(async (name) => {
			const root = `/sys/class/drm/${name}/device`;
			const [busyPercent, usedBytes, totalBytes] = await Promise.all([
				numeric(`${root}/gpu_busy_percent`),
				numeric(`${root}/mem_info_vram_used`),
				numeric(`${root}/mem_info_vram_total`),
			]);
			return { name, busyPercent, usedBytes, totalBytes };
		}),
	);
	return (
		samples
			.filter((s) => s.busyPercent !== null || s.usedBytes !== null)
			.sort((a, b) => (b.busyPercent ?? -1) - (a.busyPercent ?? -1))[0] ?? null
	);
}
export function createLocalMachineSampler(onUpdate: () => void) {
	let snapshot: LocalMachineMetrics | null = null;
	let disposed = false;
	let pending = false;
	let previous: { at: number; cpu: Pair; network: Map<string, Pair>; disk: Map<string, Pair> } | null = null;
	const sample = async () => {
		if (disposed || pending) return;
		pending = true;
		try {
			const at = performance.now();
			const cpu = cpus().reduce(
				(sum, c) => ({
					first: sum.first + c.times.idle,
					second: sum.second + Object.values(c.times).reduce((a, b) => a + b, 0),
				}),
				{ first: 0, second: 0 },
			);
			const linux = platform() === "linux";
			const [netText, diskText, devices, gpu] = await Promise.all([
				linux ? read("/proc/net/dev") : null,
				linux ? read("/proc/diskstats") : null,
				linux ? readdir("/sys/block").catch(() => []) : [],
				linux ? gpuMetrics() : null,
			]);
			const network = networkCounters(netText ?? "");
			const disk = diskCounters(diskText ?? "", new Set(devices));
			const elapsed = previous ? at - previous.at : 0;
			const netRate = previous ? busiest(network, previous.network, elapsed) : null;
			const diskRate = previous ? busiest(disk, previous.disk, elapsed) : null;
			const totalDelta = previous ? cpu.second - previous.cpu.second : 0;
			const idleDelta = previous ? cpu.first - previous.cpu.first : 0;
			if (disposed) return;
			snapshot = {
				scope: linux && /microsoft/i.test(release()) ? "WSL guest" : "local OS",
				sampledAt: Date.now(),
				cpuPercent:
					totalDelta > 0 && idleDelta >= 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null,
				processRssBytes: process.memoryUsage.rss(),
				hostFreeBytes: freemem(),
				hostTotalBytes: totalmem(),
				network: netRate ? { name: netRate.name, receivedPerSecond: netRate.first, sentPerSecond: netRate.second } : null,
				disk: diskRate ? { name: diskRate.name, readPerSecond: diskRate.first, writtenPerSecond: diskRate.second } : null,
				gpu,
			};
			previous = { at, cpu, network, disk };
			onUpdate();
		} finally {
			pending = false;
		}
	};
	const tick = () => {
		void sample().catch(() => {
			snapshot = null;
		});
	};
	const timer = setInterval(tick, 2000);
	timer.unref();
	tick();
	return {
		snapshot: () => snapshot,
		dispose: () => {
			disposed = true;
			clearInterval(timer);
		},
	};
}
