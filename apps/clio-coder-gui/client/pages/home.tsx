import { Link } from "react-router";
export function Home() {
	return (
		<>
			<p className="eyebrow">Clio Coder / your local workspace</p>
			<h1>
				From a question
				<br />
				<em>to a working answer.</em>
			</h1>
			<p className="intro">
				Work with Clio Coder in your own projects. Follow the conversation, review each consequential action, and inspect
				the evidence behind the result.
			</p>
			<Link className="primary home-link" to="/sessions">
				Open a workspace <span aria-hidden="true">↗</span>
			</Link>
			<div className="home-instruments">
				<Link to="/sessions">
					<span className="eyebrow">01 / Conversation</span>
					<h2>Make progress.</h2>
					<p>Start a session or return to a saved conversation.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/traces">
					<span className="eyebrow">02 / Evidence</span>
					<h2>See what happened.</h2>
					<p>Inspect phases, tool calls, receipts, and recorded outcomes.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/toolchain">
					<span className="eyebrow">03 / Environment</span>
					<h2>Keep tools ready.</h2>
					<p>Check resolution and manage verified, pinned installations.</p>
					<span aria-hidden="true">↗</span>
				</Link>
			</div>
		</>
	);
}
