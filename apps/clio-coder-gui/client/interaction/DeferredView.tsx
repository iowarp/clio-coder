import { Component, type ReactNode } from "react";

/** Keep a failed detail module inside its pane so the conversation remains usable. */
export class DeferredViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div className="pane-inspection-error" role="alert">
				<p>This detail view could not open. You can continue in the conversation, or reload this window to try again.</p>
				<button type="button" onClick={() => window.location.reload()}>
					Reload window
				</button>
			</div>
		);
	}
}
