import { Link } from "react-router";
export function Home() {
	return (
		<>
			<p className="eyebrow">A place for the tools behind your work</p>
			<h1>
				Your local
				<br />
				<em>working environment.</em>
			</h1>
			<p className="intro">
				Inspect the tools Clio uses, see which copy resolves, and manage pinned installations from one place.
			</p>
			<Link className="primary home-link" to="/toolchain">
				Open toolchain <span aria-hidden="true">↗</span>
			</Link>
			<div className="home-note">
				<span className="eyebrow">Available now</span>
				<p>Three pinned tools. Verified downloads. Live installation progress.</p>
			</div>
		</>
	);
}
