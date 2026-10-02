import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeRootsCover } from "../../core/path-boundary.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { shellQuote } from "../../core/shell-quote.js";
import type { TaskWorktree } from "../../tools/task-worktree.js";
import type { SshNodeEndpoint } from "./transport.js";
import { buildSshArgs } from "./transport.js";

/** Remote operations own only this run's worktree and branch. Nothing removes them on failure. */
const REMOTE_OPERATION = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const input=JSON.parse(fs.readFileSync(0,'utf8')),w=input.worktree;
function git(cwd,...args){const r=cp.spawnSync('git',['-C',cwd,'-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});if(r.status!==0)throw Error(r.stderr||'remote git failed');return r.stdout.trim();}
function safeParent(){const rel=path.relative(w.root,w.path);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('remote worktree must be inside project');let current=w.root;for(const part of rel.split(path.sep).slice(0,-1)){current=path.join(current,part);if(fs.existsSync(current)){if(fs.lstatSync(current).isSymbolicLink()||!fs.statSync(current).isDirectory())throw Error('unsafe worktree parent');}else fs.mkdirSync(current,{mode:448});}}
const owner=path.join(path.dirname(w.path),w.runId+'.remote-owner.json');
function ownership(){const found=JSON.parse(fs.readFileSync(owner,'utf8'));for(const key of ['root','path','branch','base','ownerToken'])if(found[key]!==w[key])throw Error('remote worktree ownership changed');if(git(w.path,'symbolic-ref','HEAD')!=='refs/heads/'+w.branch)throw Error('remote worktree branch changed');}
try {
 if(input.op==='prepare'){
  if(git(w.root,'rev-parse','HEAD')!==w.base||git(w.root,'status','--porcelain','--untracked-files=all'))throw Error('remote source baseline or clean tree changed');
  safeParent();
  const exclude=git(w.root,'rev-parse','--path-format=absolute','--git-path','info/exclude');
  const rules=fs.existsSync(exclude)?fs.readFileSync(exclude,'utf8'):'';
  if(!rules.split(String.fromCharCode(10)).includes('/.clio-coder/worktrees/'))fs.appendFileSync(exclude,(rules.endsWith(String.fromCharCode(10))?'':String.fromCharCode(10))+'/.clio-coder/worktrees/'+String.fromCharCode(10));
  fs.writeFileSync(owner,JSON.stringify(w),{mode:384,flag:'wx'});
  git(w.root,'worktree','add','-b',w.branch,w.path,w.base);
 }else{
  ownership();
  if(input.op==='commit'){
   if(git(w.path,'merge-base',w.base,'HEAD')!==w.base)throw Error('remote branch lost its approved baseline');
   git(w.path,'add','-A','--','.');
   if(git(w.path,'diff','--cached','--name-only'))git(w.path,'-c','user.name=Clio Coder','-c','user.email=clio-coder-task@local','commit','-m','Clio Coder remote task '+w.runId);
  }else if(input.op==='cleanup'){
   if(git(w.path,'rev-parse','HEAD')!==input.commit||git(w.path,'status','--porcelain'))throw Error('remote worktree changed after import; preserved');
   git(w.root,'worktree','remove',w.path);git(w.root,'branch','-D',w.branch);fs.unlinkSync(owner);
  }else throw Error('unknown remote operation');
 }
 console.log(JSON.stringify({commit:input.op==='cleanup'?input.commit:git(w.path,'rev-parse','HEAD')}));
}catch(error){console.error(error.message);process.exit(1);}
`;

export interface FleetChangeReturn {
	node: SshNodeEndpoint;
	worktree: TaskWorktree;
}

async function remote(
	input: FleetChangeReturn,
	op: "prepare" | "commit" | "cleanup",
	commit?: string,
): Promise<string> {
	const result = await runCommandVector("ssh", buildSshArgs(input.node, `node -e ${shellQuote(REMOTE_OPERATION)}`), {
		input: JSON.stringify({ op, worktree: input.worktree, commit }),
		timeoutMs: 60_000,
		maxOutputBytes: 128_000,
	});
	if (result.exitCode !== 0)
		throw new Error(
			`SSH change return: ${result.stderr.trim()}; remote branch ${input.worktree.branch} and worktree ${input.worktree.path} are preserved for recovery`,
		);
	const value = JSON.parse(result.stdout) as { commit: string };
	if (!/^[a-f0-9]{40,64}$/.test(value.commit)) throw new Error("SSH change return: invalid remote commit");
	return value.commit;
}

export async function prepareFleetChangeReturn(
	node: SshNodeEndpoint,
	worktree: TaskWorktree,
): Promise<FleetChangeReturn> {
	const input = { node, worktree };
	await remote(input, "prepare");
	return input;
}

async function git(root: string, args: string[], env?: Record<string, string>): Promise<string> {
	const result = await runCommandVector("git", ["-C", root, ...args], {
		timeoutMs: 60_000,
		maxOutputBytes: 1024 * 1024,
		...(env ? { env } : {}),
	});
	if (result.exitCode !== 0) throw new Error(`SSH change return: ${result.stderr.trim()}`);
	return result.stdout;
}

/** Fetch into a private ref, validate the exact commit, then fast-forward only the owned local task tree. */
export async function importFleetChanges(
	input: FleetChangeReturn,
	writeRoots: ReadonlyArray<string>,
	protectedPaths: ReadonlyArray<string>,
): Promise<string> {
	const { node, worktree: w } = input;
	const commit = await remote(input, "commit");
	const sshOptions = buildSshArgs(node, "").slice(0, -2);
	const endpoint = `${node.user ? `${node.user}@` : ""}${node.host.includes(":") ? `[${node.host}]` : node.host}:${w.root}`;
	const fetchedRef = `refs/clio-coder/remote/${w.runId}`;
	await git(
		w.root,
		["fetch", "--no-tags", "--no-write-fetch-head", "--", endpoint, `refs/heads/${w.branch}:${fetchedRef}`],
		{ GIT_SSH_COMMAND: ["ssh", ...sshOptions.map(shellQuote)].join(" ") },
	);
	if ((await git(w.root, ["rev-parse", fetchedRef])).trim() !== commit)
		throw new Error("SSH change return: branch changed during transfer; preserved");
	if ((await git(w.root, ["merge-base", w.base, commit])).trim() !== w.base)
		throw new Error("SSH change return: returned commit does not descend from approved baseline");
	// The first parent chain must end at the baseline; merge commits could import unrelated history.
	if ((await git(w.root, ["rev-list", "--merges", `${w.base}..${commit}`])).trim())
		throw new Error("SSH change return: merge commits are not supported; remote branch preserved");
	const changed = (await git(w.root, ["diff", "--no-renames", "--name-only", "-z", w.base, commit]))
		.split("\0")
		.filter(Boolean);
	for (const name of changed) {
		const candidate = resolve(w.path, name);
		const rel = relative(w.path, candidate);
		if (
			!rel ||
			rel === ".." ||
			rel.startsWith(`..${sep}`) ||
			isAbsolute(rel) ||
			(writeRoots.length > 0 && !writeRootsCover(writeRoots, candidate))
		)
			throw new Error(`SSH change return: path outside write permit: ${name}; remote branch preserved`);
		if (protectedPaths.some((path) => candidate === path || candidate.startsWith(`${path}${sep}`)))
			throw new Error(`SSH change return: protected path changed: ${name}; remote branch preserved`);
	}
	if (
		(await git(w.path, ["symbolic-ref", "HEAD"])).trim() !== `refs/heads/${w.branch}` ||
		(await git(w.path, ["rev-parse", "HEAD"])).trim() !== w.base ||
		(await git(w.path, ["status", "--porcelain"])).trim()
	)
		throw new Error("SSH change return: local task worktree changed; remote branch preserved");
	await git(w.path, ["merge", "--ff-only", "--no-edit", commit]);
	return commit;
}

/** Call only after the existing verification and guarded application succeeded. */
export async function cleanupFleetChangeReturn(input: FleetChangeReturn, commit: string): Promise<void> {
	await remote(input, "cleanup", commit);
}
