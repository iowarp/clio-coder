/** The playbook commands read `.clio-coder/playbooks/`; the first one run in a workspace converts the old layout and says so on stderr. */
export async function convertWorkspaceForCommand(cwd = process.cwd()): Promise<void> {
	const { convertWorkspaceOnce, describeConversion } = await import("../domains/lifecycle/canonical-names.js");
	const converted = convertWorkspaceOnce(cwd);
	if (converted) process.stderr.write(`${describeConversion(converted, "this workspace")}\n`);
}
