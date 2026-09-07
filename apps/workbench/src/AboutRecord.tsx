import { PROTOCOL_VERSION } from "./protocol.ts";
import type { WireClioCapabilities, WireClioSnapshot, WireRecoveryInspection } from "./protocol.ts";

const CAPABILITY_ROWS: ReadonlyArray<{ readonly key: keyof WireClioCapabilities; readonly label: string }> = [
	{ key: "load", label: "Resume an earlier session" },
	{ key: "list", label: "List sessions" },
	{ key: "label", label: "Label a session" },
	{ key: "delete", label: "Delete a session" },
	{ key: "autonomy", label: "Change working freedom for a session" },
	{ key: "settings", label: "Read and patch safe settings" },
	{ key: "targets", label: "List and probe targets" },
	{ key: "loopBlocked", label: "Report a blocked repeated command" },
	{ key: "dispatchEvents", label: "Report worker dispatch as it happens" },
	{ key: "agentAttribution", label: "Name the agent behind each tool call" },
];

const PHASE_COPY: Readonly<Record<WireClioSnapshot["phase"], string>> = {
	starting: "Starting Clio Coder",
	unbound: "Connected, no session bound",
	idle: "Connected and idle",
	running: "Connected and working",
	"awaiting-approval": "Connected, waiting for an approval",
	cancelling: "Connected, stopping a turn",
	failed: "Connection failed",
	closed: "Connection closed",
};

/**
 * What is running, from one place. Every value is a fact the app already
 * holds: the ACP handshake, the bootstrap, the protocol constant, and the
 * recovery inspection. Two sources that disagree are shown side by side and
 * labelled; they are never reconciled here.
 */
export function AboutRecord(
	{ snapshot, recovery, recoveryPending, mode, workspaceInstanceId, appVersion, onInspectRecovery }: {
		snapshot: WireClioSnapshot | null;
		recovery: WireRecoveryInspection | null;
		recoveryPending: boolean;
		mode: "browser" | "desktop";
		workspaceInstanceId: string | null;
		appVersion: string | null;
		onInspectRecovery(): void;
	},
) {
	const agent = snapshot?.agent ?? null;
	const doctorVersion = recovery?.versions.clioCoder ?? null;
	const versionsDisagree = agent !== null && doctorVersion !== null && agent.version !== doctorVersion;
	return (
		<section className="about-record" aria-labelledby="about-record-title">
			<div className="settings__section-heading">
				<div>
					<div className="eyebrow">ABOUT</div>
					<h3 id="about-record-title">What is running</h3>
				</div>
				<p>
					The facts a bug report needs, from the sources that hold them. Nothing here is measured by the app itself.
				</p>
			</div>

			<dl className="about-record__facts">
				<div>
					<dt>Clio Coder</dt>
					<dd>
						{snapshot === null
							? (
								<span className="about-record__pending">
									Open a project to start Clio Coder. Its version appears after the handshake.
								</span>
							)
							: agent !== null
							? (
								<>
									<strong>{agent.version}</strong>
									<small>over ACP</small>
								</>
							)
							: snapshot.phase === "failed"
							? (
								<>
									<strong>Version unknown</strong>
									{snapshot.lastFailure !== null && <small>{snapshot.lastFailure.summary}</small>}
								</>
							)
							: (
								<span className="about-record__pending">
									Version appears once Clio Coder answers the connection handshake.
								</span>
							)}
					</dd>
				</div>
				<div>
					<dt>Desktop app</dt>
					<dd>
						{appVersion === null
							? <span className="about-record__pending">Not reported by this host build.</span>
							: <strong>{appVersion}</strong>}
					</dd>
				</div>
				<div>
					<dt>Connection</dt>
					<dd>
						<strong>{snapshot === null ? "No project open" : PHASE_COPY[snapshot.phase]}</strong>
						<small>{mode} host on this machine</small>
					</dd>
				</div>
			</dl>

			<div className="about-record__doctor" aria-label="Versions as the recovery check saw them">
				{recovery === null
					? (
						<>
							<p>
								Run the recovery check to record Clio Coder, Node, and the platform as Clio Coder's own diagnostics see
								them.
							</p>
							<button
								type="button"
								className="button button--quiet"
								disabled={recoveryPending}
								onClick={onInspectRecovery}
							>
								{recoveryPending ? "Running diagnostics…" : "Run the recovery check"}
							</button>
						</>
					)
					: (
						<>
							<dl className="about-record__versions">
								<div>
									<dt>Clio Coder</dt>
									<dd>
										<code>{doctorVersion ?? "not reported"}</code>
										<small>from doctor</small>
									</dd>
								</div>
								<div>
									<dt>Node</dt>
									<dd>
										<code>{recovery.versions.node ?? "not reported"}</code>
									</dd>
								</div>
								<div>
									<dt>Platform</dt>
									<dd>
										<code>{recovery.versions.platform ?? "not reported"}</code>
									</dd>
								</div>
							</dl>
							{versionsDisagree && (
								<p className="about-record__disagree" role="note">
									The version over ACP and the version from doctor differ. Both are shown as their sources reported
									them; the app does not decide which is right.
								</p>
							)}
						</>
					)}
			</div>

			<div className="about-record__capabilities">
				<div className="about-record__capabilities-heading">
					<strong>What this Clio Coder advertised</strong>
					<small>Read from the connection handshake. A missing capability hides its control; it is not an error.</small>
				</div>
				{snapshot?.capabilities == null
					? (
						<p className="about-record__pending">
							{snapshot === null
								? "Capabilities are read when a project opens."
								: "Capabilities appear with the handshake."}
						</p>
					)
					: (
						<ul className="about-record__capability-list" aria-label="Advertised capabilities">
							{CAPABILITY_ROWS.map((row) => {
								const advertised = snapshot.capabilities?.[row.key] === true;
								return (
									<li key={row.key} className={advertised ? "is-advertised" : "is-absent"}>
										<span aria-hidden="true">{advertised ? "●" : "○"}</span>
										<span>{row.label}</span>
										<small>{advertised ? "advertised" : "not advertised"}</small>
									</li>
								);
							})}
						</ul>
					)}
			</div>

			<details className="about-record__diagnostics">
				<summary>Diagnostic details</summary>
				<dl>
					<div>
						<dt>GUI protocol</dt>
						<dd>
							<code>{PROTOCOL_VERSION}</code>
						</dd>
					</div>
					<div>
						<dt>Host mode</dt>
						<dd>
							<code>{mode}</code>
						</dd>
					</div>
					<div>
						<dt>Host instance</dt>
						<dd>
							<code>{workspaceInstanceId ?? "not reported"}</code>
						</dd>
					</div>
					<div>
						<dt>Last checked</dt>
						<dd>
							<code>{snapshot?.checkedAt ?? "no project open"}</code>
						</dd>
					</div>
				</dl>
			</details>
		</section>
	);
}
