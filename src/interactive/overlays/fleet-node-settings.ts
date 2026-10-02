import type { ClioSettings } from "../../core/config.js";
import type { FleetNodeInspection } from "../../domains/dispatch/fleet-nodes.js";
import type { Component, SettingItem } from "../../engine/tui.js";

type Submenu = NonNullable<SettingItem["submenu"]>;
interface Choice {
	value: string;
	label: string;
}
export interface FleetNodeSettingsUi {
	text(title: string, note?: string): Submenu;
	pick(title: string, choices: ReadonlyArray<Choice>, note?: string): Submenu;
	refresh(): void;
	changed(settings: ClioSettings): void;
}

function evidence(item: FleetNodeInspection): string {
	const record = item.record;
	const age = item.ageMs === null ? "never" : `${Math.floor(item.ageMs / 60_000)} minutes ago`;
	return [
		`${item.node.host}: ${item.readiness}. Checked ${item.checkedAt ?? "never"} (${age}).`,
		item.reason ?? "Connection and project checks passed.",
		`Declared labels: ${item.node.labels?.join(", ") || "none"}.`,
		...(record
			? [
					`Project: ${record.project?.kind ?? "unknown"}. Remote Clio: ${record.remoteVersion ?? "unknown"}.`,
					`Observed resources: ${JSON.stringify(record.resources ?? "unknown")}.`,
					...record.targets
						.slice(0, 4)
						.map(
							(target) =>
								`${target.targetId}: network=${target.reachable}, listing access=${target.authentication ?? "unknown"}, model=${target.modelAvailable}, runtime=${target.runtimeCompatible}.`,
						),
				]
			: []),
	].join("\n");
}

/** Operator actions use the CLI's shared service; only installation starts with a remote write preview. */
export function fleetNodeSettingsSubmenu(
	action: "add" | "discover" | "manage",
	ui: FleetNodeSettingsUi,
	id?: string,
): Submenu {
	return (_current, done) => {
		let busy = false;
		let active: Component;
		const show = (
			title: string,
			choices: ReadonlyArray<Choice>,
			note: string,
			selected: (value?: string) => void,
		): void => {
			active = ui.pick(title, choices, note)("", selected);
			ui.refresh();
		};
		const message = (title: string, note: string): void =>
			show(title, [{ value: "done", label: "Back to Fleet settings" }], note, () => done());
		const run = (title: string, operation: () => Promise<void>): void => {
			busy = true;
			active = ui.pick(title, [], "Working. This operation has a timeout; wait for its result.")("", () => {});
			ui.refresh();
			void operation()
				.catch((error: unknown) => message("Needs attention", error instanceof Error ? error.message : String(error)))
				.finally(() => {
					busy = false;
					ui.refresh();
				});
		};
		const changed = async (): Promise<void> => {
			const { readSettings } = await import("../../core/config.js");
			ui.changed(readSettings());
		};
		const test = (nodeId: string): void =>
			run(`Testing ${nodeId}`, async () => {
				const service = await import("../../domains/dispatch/fleet-nodes.js");
				await service.testFleetNode(nodeId, process.cwd(), { record: true });
				const item = service.inspectFleetNodes().find((entry) => entry.node.id === nodeId);
				message(`Test ${nodeId}`, item ? evidence(item) : "Node was removed during the check.");
			});
		const next = (nodeId: string, note: string): void =>
			show(
				`Node ${nodeId}`,
				[
					{ value: "test", label: "Test and record readiness for this project" },
					{ value: "install", label: "Preview exact client installation" },
					{ value: "done", label: "Back to Fleet settings" },
				],
				note,
				(value) => {
					if (value === "test") test(nodeId);
					else if (value === "install") install(nodeId);
					else done();
				},
			);
		const install = (nodeId: string): void =>
			run(`Preparing installation for ${nodeId}`, async () => {
				const service = await import("../../domains/dispatch/fleet-node-install.js");
				const plan = await service.prepareFleetNodeInstall(nodeId);
				show(
					`Install on ${nodeId}?`,
					[
						{ value: "cancel", label: "Cancel" },
						{ value: "install", label: "Install this exact client build at user level" },
					],
					service.describeFleetNodeInstall(plan),
					(value) => {
						if (value !== "install") {
							plan.cleanup();
							done();
							return;
						}
						run(`Installing on ${nodeId}`, async () => {
							try {
								await service.executeFleetNodeInstall(plan);
								await changed();
								next(
									nodeId,
									"Installed and version verified. Test again to record eligibility; installation changes the worker entry.",
								);
							} finally {
								plan.cleanup();
							}
						});
					},
				);
			});
		const add = (host?: string): void => {
			active = ui.text("Name this SSH worker node", "Use letters, numbers, underscores or hyphens; local is reserved.")(
				"",
				(name) => {
					if (!name?.trim()) return done();
					const save = (address?: string): void => {
						if (!address?.trim()) {
							done();
							return;
						}
						run("Adding SSH node", async () => {
							const service = await import("../../domains/dispatch/fleet-nodes.js");
							service.addFleetNode({ id: name.trim(), host: address.trim(), maxWorkers: 1, residency: "observe" });
							await changed();
							next(
								name.trim(),
								"Saved globally with one worker slot. SSH uses your existing config for user, port and identity. Registration does not change placement or prove readiness.",
							);
						});
					};
					if (host) save(host);
					else {
						active = ui.text(
							"SSH alias, hostname or address",
							"Use an existing SSH alias for user, port and identity. Prefer a verified LAN endpoint on the same network.",
						)("", save);
						ui.refresh();
					}
				},
			);
			ui.refresh();
		};
		if (action === "add") add();
		else if (action === "discover")
			run("Discovering Tailscale peers", async () => {
				const { discoverTailscaleNodes } = await import("../../domains/dispatch/fleet-node-discovery.js");
				const peers = await discoverTailscaleNodes();
				const choices = peers.flatMap((peer) =>
					[...(peer.magicDns ? [peer.magicDns] : []), ...peer.addresses].map((host) => ({
						value: host,
						label: `${[...peer.name].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("")} · ${host} · ${peer.online === null ? "Tailscale state unknown" : peer.online ? "Tailscale online" : "Tailscale offline"}`,
					})),
				);
				if (!choices.length)
					return message(
						"Tailscale discovery",
						"No peer addresses reported. Add an SSH alias or address directly; Tailscale is optional.",
					);
				show(
					"Choose a peer endpoint",
					choices,
					"MagicDNS names and IP addresses are candidates. SSH access, Clio and project readiness are not checked. You can add a known LAN address instead.",
					(host) => {
						if (host) add(host);
						else done();
					},
				);
			});
		else
			run(`Inspecting ${id}`, async () => {
				const service = await import("../../domains/dispatch/fleet-nodes.js");
				const item = service.inspectFleetNodes().find((entry) => entry.node.id === id);
				if (!item)
					return message(
						"Node unavailable",
						"This node is not in the saved global fleet. Manage project or session-only nodes in their settings scope.",
					);
				show(
					`SSH node ${id}`,
					[
						{ value: "test", label: "Test and record readiness for this project" },
						{ value: "install", label: "Preview exact client installation" },
						{ value: "remove", label: "Remove this node" },
					],
					evidence(item),
					(value) => {
						if (value === "test") test(item.node.id);
						else if (value === "install") install(item.node.id);
						else if (value === "remove")
							show(
								`Remove ${id}?`,
								[
									{ value: "cancel", label: "Cancel" },
									{ value: "remove", label: "Remove the saved node" },
								],
								"Remote files remain in place. Profile pins or a standing preference must be cleared first.",
								(choice) => {
									if (choice !== "remove") return done();
									run(`Removing ${id}`, async () => {
										service.removeFleetNode(item.node.id);
										await changed();
										message("Node removed", `${id} was removed from global settings. Remote files remain in place.`);
									});
								},
							);
						else done();
					},
				);
			});
		return {
			render: (width) => active.render(width),
			handleInput: (data) => {
				if (!busy) active.handleInput?.(data);
			},
			invalidate: () => active.invalidate?.(),
		};
	};
}
