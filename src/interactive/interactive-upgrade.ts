import { inspectInstallation } from "../domains/lifecycle/install-method.js";
import { planSelfUpgrade, runApprovedSelfUpgrade, type SelfUpgradePlan } from "../domains/lifecycle/self-upgrade.js";
import type { AskUserHandler } from "../tools/ask-user.js";

export type InteractiveUpgradeNoticeLevel = "info" | "success" | "warning" | "error";

export interface InteractiveUpgradeFlowDeps {
	runningVersion: string;
	openAskUser: AskUserHandler;
	notify(level: InteractiveUpgradeNoticeLevel, text: string, key?: string): void;
	/** True only when no turn, worker, command, queue, draft, or overlay is active. */
	isIdle(): boolean;
	dismissUpdateHint(): void;
	shutdown(): void;
	signal: AbortSignal;
	cwd?: string;
	plan?: () => Promise<SelfUpgradePlan>;
	run?: typeof runApprovedSelfUpgrade;
}

export interface InteractiveUpgradeFlow {
	start(): void;
	isRunning(): boolean;
}

const UPGRADE_NOW = "Upgrade now";
const NOT_NOW = "Not now";
const EXIT_NOW = "Exit now";
const LATER = "Later";

/**
 * Consent and execution for `/upgrade`.
 *
 * Detection itself never opens this flow. The muted footer points here; only
 * the operator command opens the first decision. The package manager runs only
 * after an explicit Upgrade now answer, and successful replacement opens a
 * second decision asking when to restart. User config, data, state, and cache
 * are named on the approval because none is package-manager-owned.
 */
export function createInteractiveUpgradeFlow(deps: InteractiveUpgradeFlowDeps): InteractiveUpgradeFlow {
	let active = false;

	const start = (): void => {
		if (active) {
			deps.notify("info", "An upgrade check is already in progress.", "lifecycle:upgrade-running");
			return;
		}
		if (!deps.isIdle()) {
			deps.notify(
				"warning",
				"Finish the active turn, worker, command, or draft before upgrading. The footer reminder will stay available.",
				"lifecycle:upgrade-busy",
			);
			return;
		}
		active = true;
		void (async () => {
			try {
				const plan = deps.plan
					? await deps.plan()
					: await planSelfUpgrade({
							installation: inspectInstallation(),
							runningVersion: deps.runningVersion,
							signal: deps.signal,
						});
				deps.signal.throwIfAborted();
				if (plan.status === "manual") {
					const postInstall =
						plan.installation.kind === "pnpm" || plan.installation.kind === "bun"
							? "\nThen run: clio-coder upgrade --post-install"
							: "";
					deps.notify(
						"warning",
						`This ${plan.installation.kind} installation must be updated by its owning package manager. Run:\n${plan.command}${postInstall}`,
						"lifecycle:upgrade-manual",
					);
					return;
				}
				if (plan.status === "unavailable") {
					deps.notify(
						"warning",
						"Clio could not reach the release registry. Nothing changed; /upgrade can be retried later.",
						"lifecycle:upgrade-unavailable",
					);
					return;
				}
				if (plan.status === "current") {
					deps.dismissUpdateHint();
					deps.notify("success", `Clio Coder ${plan.current} is current.`, "lifecycle:upgrade-current");
					return;
				}
				if (!deps.isIdle()) {
					deps.notify(
						"warning",
						"The session became busy while checking the release. Nothing changed; run /upgrade again when it is idle.",
						"lifecycle:upgrade-busy",
					);
					return;
				}

				const approval = await deps.openAskUser([
					{
						header: "Upgrade",
						question:
							`Upgrade Clio Coder ${plan.current} → ${plan.available}? ` +
							`This replaces only the npm package in ${plan.installation.prefix}. ` +
							"Settings, credentials, memory, evidence, and session history stay in their current directories. " +
							"After replacement Clio runs pending lifecycle checks, then asks you to restart.",
						options: [
							{ label: UPGRADE_NOW, description: "Replace the package and run migrations plus doctor checks." },
							{ label: NOT_NOW, description: "Keep working; leave the quiet footer reminder in place." },
						],
					},
				]);
				const approved = approval.answers[0];
				if (approval.cancelled || !(approved?.answer === UPGRADE_NOW || approved?.options?.includes(UPGRADE_NOW) === true))
					return;
				deps.signal.throwIfAborted();
				if (!deps.isIdle()) {
					deps.notify(
						"warning",
						"The session is no longer idle. The approved upgrade did not start; run /upgrade again after active work settles.",
						"lifecycle:upgrade-busy",
					);
					return;
				}
				deps.notify(
					"info",
					`Upgrading Clio Coder to ${plan.available}; do not close this process while the package manager is running.`,
					"lifecycle:upgrade-running",
				);
				const result = await (deps.run ?? runApprovedSelfUpgrade)({
					plan,
					signal: deps.signal,
					cwd: deps.cwd ?? process.cwd(),
				});
				deps.signal.throwIfAborted();
				deps.dismissUpdateHint();
				deps.notify(
					"warning",
					`Clio Coder ${result.to} is installed. Restart before the next turn; your current session is saved and available through /resume.`,
					"lifecycle:restart-required",
				);
				const restart = await deps.openAskUser([
					{
						header: "Restart",
						question: `Clio Coder ${result.to} installed successfully. Exit now so you can restart on the new version?`,
						options: [
							{ label: EXIT_NOW, description: "Save and exit; run clio-coder again, then /resume." },
							{ label: LATER, description: "Keep this process open; the footer keeps the restart notice." },
						],
					},
				]);
				const restartAnswer = restart.answers[0];
				if (
					!restart.cancelled &&
					(restartAnswer?.answer === EXIT_NOW || restartAnswer?.options?.includes(EXIT_NOW) === true)
				)
					deps.shutdown();
			} catch (error) {
				if (deps.signal.aborted) return;
				deps.notify(
					"error",
					`Upgrade failed without removing user data: ${error instanceof Error ? error.message : String(error)}. Run clio-coder upgrade from a shell for full recovery steps.`,
					"lifecycle:upgrade-failed",
				);
			} finally {
				active = false;
			}
		})();
	};

	return { start, isRunning: () => active };
}
