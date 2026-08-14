import { spawn } from "node:child_process";
import type { ClioSettings } from "../core/config.js";
import {
	getRuntimeRegistry,
	type ProvidersContract,
	resolveProviderReference,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { OAuthSelectPrompt } from "../engine/oauth.js";
import type { OverlayHandle, TUI } from "../engine/tui.js";
import type { OverlayState } from "./overlay-key-routing.js";
import { type AuthDialogHandle, openAuthDialog } from "./overlays/auth-dialog.js";
import type { TargetsHubNoticeLevel } from "./providers-overlay.js";

type AuthProviders = Pick<ProvidersContract, "getRuntime" | "probeTarget"> & {
	auth: Pick<ProvidersContract["auth"], "statusForTarget" | "setApiKey" | "login" | "damageReason">;
};

export interface OverlayAuthLifecycleDeps {
	tui: TUI;
	providers: AuthProviders;
	getSettings?: () => Readonly<ClioSettings> | undefined;
	notify: (level: TargetsHubNoticeLevel, text: string, key?: string) => void;
	refreshFooter: () => void;
	renderContextIsland: () => void;
	renderTaskIsland: () => void;
	requestRender: () => void;
	getOverlayState: () => OverlayState;
	setOverlayState: (state: OverlayState) => void;
	getOverlayHandle: () => OverlayHandle | null;
	setOverlayHandle: (handle: OverlayHandle | null) => void;
	openAuthDialog?: (tui: TUI, title: string, onCancel: () => void) => AuthDialogHandle;
}

export interface OverlayAuthLifecycle {
	finish(dismiss: boolean): void;
	openConnectFlow(reference: string): Promise<void>;
}

/**
 * Provider runtimes supply OAuth authorize, device-code, and management-console
 * links, so the string is not ours to trust. `src/cli/docs.ts` already opens
 * a browser the right way; this is the same shape.
 */
const maybeOpenExternalUrl = (url: string): void => {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	// `start` is a cmd builtin rather than an executable, and its first
	// quoted argument is the window title, so the empty string is required.
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best effort only: the URL is also printed for the operator.
		});
		child.unref();
	} catch {
		// Best effort only.
	}
};

/**
 * Fail the connect flow when the credential the operator just supplied never
 * reached disk.
 *
 * The store records a refused write in `damageReason()` rather than throwing,
 * and keeps serving the credential from memory, so the probe that follows
 * succeeds and the dialog reports a connection that will be gone at the next
 * start. Throwing puts this on the flow's own error path, which is what stops
 * `probeTarget()` from running and notifies with the reason. `clio-coder auth login`
 * refuses the same way; see cli/shared.ts credentialWriteFailed().
 */
function assertCredentialStored(auth: AuthProviders["auth"], providerId: string): void {
	const damage = auth.damageReason();
	if (damage === null) return;
	throw new Error(`credential for ${providerId} was not stored: ${damage}`);
}

export function createOverlayAuthLifecycle(deps: OverlayAuthLifecycleDeps): OverlayAuthLifecycle {
	let authDialogDismiss: (() => void) | null = null;
	let authReturnOverlayHandle: OverlayHandle | null = null;
	let authCloseResolve: (() => void) | null = null;
	const openAuthDialogFactory = deps.openAuthDialog ?? openAuthDialog;

	const finish = (dismiss: boolean): void => {
		if (deps.getOverlayState() !== "auth") return;
		if (dismiss) authDialogDismiss?.();
		authDialogDismiss = null;
		const authHandle = deps.getOverlayHandle();
		const returnHandle = authReturnOverlayHandle;
		authReturnOverlayHandle = null;
		deps.setOverlayHandle(returnHandle);
		deps.setOverlayState(returnHandle ? "providers" : "closed");
		authHandle?.hide();
		const resolveAuthClose = authCloseResolve;
		authCloseResolve = null;
		resolveAuthClose?.();
		deps.refreshFooter();
		deps.renderContextIsland();
		deps.renderTaskIsland();
		deps.requestRender();
	};

	const resolveConnectionReference = (target: string) => {
		const settings = deps.getSettings?.();
		if (!settings) return null;
		return resolveProviderReference(
			target,
			settings,
			(runtimeId) => deps.providers.getRuntime(runtimeId) ?? getRuntimeRegistry().get(runtimeId),
		);
	};

	const openConnectFlow = async (reference: string): Promise<void> => {
		if (deps.getOverlayState() !== "closed" && deps.getOverlayState() !== "providers") return;
		const returnHandle = deps.getOverlayState() === "providers" ? deps.getOverlayHandle() : null;
		const resolved = resolveConnectionReference(reference);
		if (!resolved?.target) {
			deps.notify(
				"warning",
				`connect: unknown target ${reference}. Add it with clio-coder targets add.`,
				`connect:${reference}`,
			);
			return;
		}
		const target = resolved.target;
		const runtime = resolved.runtime;
		const authTarget = resolved.authTarget;
		const targetId = target.id;
		const runtimeId = runtime.id;
		await new Promise<void>((resolveAuthFlow) => {
			const dialog = openAuthDialogFactory(deps.tui, `Connect ${targetId}`, () => finish(true));
			authReturnOverlayHandle = returnHandle;
			authCloseResolve = resolveAuthFlow;
			deps.setOverlayState("auth");
			deps.setOverlayHandle(dialog.handle);

			const probeTarget = async (): Promise<void> => {
				dialog.controller.setLines([`Target: ${targetId}`, `Runtime: ${runtimeId}`, "Checking target..."]);
				const status = await deps.providers.probeTarget(targetId);
				if (!status) {
					dialog.controller.setLines([`Target: ${targetId}`, "Target check failed: target is not configured."]);
					deps.notify("error", `connect: ${targetId} is not configured`, `connect:${targetId}`);
					return;
				}
				const health = status.health.status;
				const detail =
					status.reason ||
					status.health.lastError ||
					(status.health.latencyMs !== null ? `${status.health.latencyMs}ms` : "no details");
				dialog.controller.setLines([
					`Target: ${targetId}`,
					`Runtime: ${runtimeId}`,
					status.available ? `Target ready (${health})` : `Target check failed (${health})`,
					detail,
				]);
				deps.notify(
					status.available ? "info" : "warning",
					status.available ? `connected ${targetId} (${health})` : `connect ${targetId} failed (${health})`,
					`connect:${targetId}`,
				);
				deps.refreshFooter();
				deps.requestRender();
			};

			const selectOAuthOption = async (
				prompt: OAuthSelectPrompt,
				prefix: ReadonlyArray<string>,
			): Promise<string | undefined> => {
				const defaultId = prompt.options[0]?.id;
				if (!defaultId) return undefined;
				const ids = new Set(prompt.options.map((option) => option.id));
				const baseLines = [
					...prefix,
					prompt.message,
					...prompt.options.map((option, index) => {
						const marker = option.id === defaultId ? "*" : " ";
						return `${marker} ${String(index + 1).padStart(2)}. ${option.label} (${option.id})`;
					}),
				];
				let errorLine: string | null = null;
				for (;;) {
					dialog.controller.setLines(errorLine ? [...baseLines, errorLine] : baseLines);
					const answer = (await dialog.controller.prompt(`Selection (number or id, q to cancel) [${defaultId}]`)).trim();
					if (answer.length === 0) return defaultId;
					if (answer === "q" || answer === "quit" || answer === "cancel") return undefined;
					const numeric = Number(answer);
					if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
						return prompt.options[numeric - 1]?.id;
					}
					if (ids.has(answer)) return answer;
					errorLine = `Unknown selection: ${answer}`;
				}
			};

			const requiresManagedAuth = targetRequiresAuth(target, runtime);
			const authStatus = deps.providers.auth.statusForTarget(target, runtime);
			if (!requiresManagedAuth || authStatus.available) {
				void (async () => {
					try {
						await probeTarget();
					} catch (error) {
						dialog.controller.setLines([
							`Target: ${targetId}`,
							`Target check failed: ${error instanceof Error ? error.message : String(error)}`,
						]);
						deps.requestRender();
					} finally {
						finish(false);
					}
				})();
				deps.requestRender();
				return;
			}
			if (resolved.runtime.auth === "api-key") {
				authDialogDismiss = dialog.controller.dismiss;
				dialog.controller.setLines([
					`Target: ${targetId}`,
					`Runtime: ${runtime.id}`,
					"API key required before Clio can connect to this target.",
				]);
				void (async () => {
					try {
						const apiKey = (await dialog.controller.prompt("API key")).trim();
						if (apiKey.length === 0) throw new Error("empty API key");
						deps.providers.auth.setApiKey(authTarget.providerId, apiKey);
						assertCredentialStored(deps.providers.auth, authTarget.providerId);
						authDialogDismiss = null;
						await probeTarget();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (message !== "dismissed" && message !== "cancelled") {
							deps.notify("error", `connect ${targetId}: ${message}`, `connect:${targetId}`);
						}
					} finally {
						authDialogDismiss = null;
						finish(false);
					}
				})();
				deps.requestRender();
				return;
			}
			authDialogDismiss = dialog.controller.dismiss;
			dialog.controller.setLines([`Target: ${targetId}`, `Runtime: ${runtime.id}`, "Starting authorization flow..."]);
			void (async () => {
				let manualCodeTimer: NodeJS.Timeout | null = null;
				try {
					await deps.providers.auth.login(authTarget.providerId, {
						onAuth: ({ url, instructions }) => {
							dialog.controller.setLines(
								[
									`Open: ${url}`,
									instructions ?? "Complete sign-in in your browser.",
									"Waiting for the browser callback. A manual code prompt will appear if needed.",
								].filter(Boolean),
							);
							maybeOpenExternalUrl(url);
						},
						onDeviceCode: ({ verificationUri, userCode }) => {
							dialog.controller.setLines([
								`Open: ${verificationUri}`,
								`Enter code: ${userCode}`,
								"Waiting for authentication...",
							]);
							maybeOpenExternalUrl(verificationUri);
						},
						onPrompt: async (prompt) => (await dialog.controller.prompt(prompt.message)).trim(),
						onSelect: (prompt) => selectOAuthOption(prompt, [`Target: ${targetId}`, `Runtime: ${runtime.id}`]),
						onManualCodeInput: async () =>
							await new Promise<string>((resolve, reject) => {
								manualCodeTimer = setTimeout(() => {
									manualCodeTimer = null;
									dialog.controller
										.prompt("Verification code")
										.then((value) => resolve(value.trim()))
										.catch(reject);
								}, 10_000);
								manualCodeTimer.unref?.();
							}),
						onProgress: (message) => {
							dialog.controller.appendLine(message);
						},
					});
					assertCredentialStored(deps.providers.auth, authTarget.providerId);
					authDialogDismiss = null;
					await probeTarget();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message !== "dismissed" && message !== "cancelled") {
						deps.notify("error", `connect ${targetId}: ${message}`, `connect:${targetId}`);
					}
				} finally {
					if (manualCodeTimer) {
						clearTimeout(manualCodeTimer);
					}
					authDialogDismiss = null;
					finish(false);
				}
			})();
			deps.requestRender();
		});
	};

	return { finish, openConnectFlow };
}
