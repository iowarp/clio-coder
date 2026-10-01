import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
	Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]),
);
const version = args["--version"];
if (
	!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version ?? "") ||
	!args["--tarball"] ||
	!args["--url"] ||
	!args["--output"]
)
	throw new Error(
		"Usage: node scripts/packaging/prepare.mjs --version X.Y.Z --tarball local.tgz --url https://... --output directory [--windows-exe local.exe --windows-url https://...]",
	);
const output = resolve(args["--output"]);
mkdirSync(output, { recursive: true });
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const ruby = (value) => JSON.stringify(value);
if (!args["--url"].startsWith("https://")) throw new Error("Package URL must use HTTPS");
writeFileSync(
	join(output, "clio-coder.rb"),
	`class ClioCoder < Formula
  desc "Provider-agnostic terminal coding agent"
  homepage "https://coder.iowarp.ai"
  url ${ruby(args["--url"])}
  version ${ruby(version)}
  sha256 ${ruby(hash(args["--tarball"]))}
  license "Apache-2.0"
  depends_on "node@24"

  def install
    system Formula["node@24"].opt_bin/"npm", "install", "--prefix", libexec,
           "--no-save", "--omit=optional", "--install-links", buildpath
    (bin/"clio-coder").write_env_script libexec/"node_modules/@iowarp/clio-coder/bin/clio-coder.cjs",
      PATH: "#{Formula["node@24"].opt_bin}:#{ENV.fetch("PATH")}"
  end
end
`,
);
if (args["--windows-exe"]) {
	if (!args["--windows-url"]?.startsWith("https://"))
		throw new Error("--windows-exe requires its eventual HTTPS --windows-url");
	const installer = {
		PackageIdentifier: "IOWarp.ClioCoder",
		PackageVersion: version,
		InstallerType: "nullsoft",
		Scope: "user",
		UpgradeBehavior: "install",
		InstallerSwitches: { Silent: "/S", SilentWithProgress: "/S" },
		Installers: [
			{
				Architecture: "x64",
				InstallerUrl: args["--windows-url"],
				InstallerSha256: hash(args["--windows-exe"]).toUpperCase(),
			},
		],
		ManifestType: "installer",
		ManifestVersion: "1.9.0",
	};
	const locale = {
		PackageIdentifier: "IOWarp.ClioCoder",
		PackageVersion: version,
		PackageLocale: "en-US",
		Publisher: "IOWarp",
		PackageName: "Clio Coder",
		License: "Apache-2.0",
		ShortDescription: "Provider-agnostic terminal coding agent",
		PackageUrl: "https://coder.iowarp.ai",
		ManifestType: "defaultLocale",
		ManifestVersion: "1.9.0",
	};
	// JSON is also valid YAML; literal URLs and checksums need no interpolation conventions.
	for (const [suffix, value] of [
		["installer", installer],
		["locale.en-US", locale],
		[
			"",
			{
				PackageIdentifier: "IOWarp.ClioCoder",
				PackageVersion: version,
				DefaultLocale: "en-US",
				ManifestType: "version",
				ManifestVersion: "1.9.0",
			},
		],
	])
		writeFileSync(
			join(output, `IOWarp.ClioCoder${suffix ? `.${suffix}` : ""}.yaml`),
			`${JSON.stringify(value, null, 2)}\n`,
		);
}
process.stdout.write(`Local review files written to ${output}; no channel was published or submitted.\n`);
