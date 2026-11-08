import { isAbsolute, relative, resolve, sep } from "node:path";
import { attributeCommitMessage, CLIO_COMMIT_EMAIL, CLIO_COMMIT_NAME } from "../../core/commit-attribution.js";
import { autonomousLandAuthorship } from "../../core/git-commit-attribution.js";
import { internalGitArgv } from "../../core/internal-git.js";
import { writeRootsCover } from "../../core/path-boundary.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { shellQuote } from "../../core/shell-quote.js";
import {
	COMMIT_IDENTITY,
	hostCommitter,
	LEFT_UNCOMMITTED_LIST_LIMIT,
	type TaskWorktree,
} from "../../tools/task-worktree.js";
import type { SshNodeEndpoint } from "./transport.js";
import { buildSshArgs } from "./transport.js";

/**
 * Remote operations own only this run's worktree and branch. Nothing removes them on failure.
 *
 * The commit applies the rule of `commitWorktreePath`: tracked changes, what the
 * worker staged, and the untracked files in `authored` (every one when it is
 * null). It reports the files it left out and a stamp of them, and cleanup
 * force-removes the worktree only while that stamp still holds, so a file that
 * arrived after the import is never deleted.
 */
const REMOTE_OPERATION = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8')),w=input.worktree,NUL=String.fromCharCode(0);
function run(env,cwd,args){const r=cp.spawnSync('git',['-C',cwd,'-c','core.hooksPath=/dev/null',...args],{env,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});if(r.status!==0)throw Error(r.stderr||'remote git failed');return r.stdout;}
function raw(cwd,...args){return run(process.env,cwd,args);}
function git(cwd,...args){return raw(cwd,...args).trim();}
function untracked(){return raw(w.path,'ls-files','--others','--exclude-standard','-z').split(NUL).filter(Boolean);}
function untrackedState(){const paths=untracked(),h=crypto.createHash('sha256');let directory=null;for(const p of paths){let s='gone';try{const t=fs.lstatSync(path.join(w.path,p),{bigint:true});if(t.isDirectory())directory??=p;s=[t.mode,t.ino,t.size,t.mtimeNs,t.ctimeNs].join(':');}catch{}h.update(p+NUL+s+NUL);}return {paths,digest:h.digest('hex'),directory};}
function authoredSet(){if(input.authored===null)return null;const roots=[w.path];try{roots.push(fs.realpathSync(w.path));}catch{}const set=new Set();for(const p of input.authored)for(const r of roots){const x=path.relative(r,path.resolve(p));if(x&&x!=='..'&&!x.startsWith('..'+path.sep)&&!path.isAbsolute(x))set.add(x.split(path.sep).join('/'));}return set;}
let out;
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
   git(w.path,'add','-u','--','.');
   const authored=authoredSet(),take=untracked().filter((p)=>authored===null||authored.has(p));
   for(let i=0;i<take.length;i+=256)git(w.path,'add','--',...take.slice(i,i+256).map((p)=>':(top,literal)'+p));
   const id=input.identity;if(git(w.path,'diff','--cached','--name-only'))run({...process.env,GIT_AUTHOR_NAME:id.author.name,GIT_AUTHOR_EMAIL:id.author.email,GIT_COMMITTER_NAME:id.committer.name,GIT_COMMITTER_EMAIL:id.committer.email},w.path,['commit','-m',input.message]);
   const remaining=untrackedState();
   out={commit:git(w.path,'rev-parse','HEAD'),untracked:remaining.digest,left:remaining.paths.slice(0,input.listLimit),leftCount:remaining.paths.length};
  }else if(input.op==='cleanup'){
   const remaining=untrackedState();
   if(remaining.directory!==null)throw Error('remote worktree has untracked directory '+remaining.directory+'; destructive cleanup refused; preserved');
   if(git(w.path,'rev-parse','HEAD')!==input.commit||git(w.path,'status','--porcelain','--untracked-files=no')||remaining.digest!==input.untracked)throw Error('remote worktree changed after import; preserved');
   git(w.root,'worktree','remove','--force',w.path);git(w.root,'branch','-D',w.branch);fs.unlinkSync(owner);
   out={commit:input.commit};
  }else throw Error('unknown remote operation');
 }
 console.log(JSON.stringify(out??{commit:git(w.path,'rev-parse','HEAD')}));
}catch(error){console.error(error.message);process.exit(1);}
`;

export interface FleetChangeReturn {
	node: SshNodeEndpoint;
	worktree: TaskWorktree;
}

/** What the remote commit produced: the commit to import and the untracked files it left on the node. */
export interface FleetChangeImport {
	commit: string;
	/** Stamp of the untracked files beside the commit; cleanup refuses once it no longer holds. */
	untracked: string;
	/** Absent when the remote commit left no file out. */
	leftUncommitted?: { count: number; paths: string[] };
}

interface GitIdent {
	name: string;
	email: string;
}

interface RemoteCommitIdentity {
	author: GitIdent;
	committer: GitIdent;
}

/**
 * Who the remote commit names, decided on the host because the commit lands
 * here: the checkout's committer, and Clio as author with that committer as
 * co-author when `commitAuthor` is `auto`, as for `commitWorktreePath`.
 */
function remoteCommitAttribution(w: TaskWorktree): { identity: RemoteCommitIdentity; message: string } {
	const committer = hostCommitter(w.root, COMMIT_IDENTITY);
	const message = `Clio Coder remote task ${w.runId}`;
	const authorship = autonomousLandAuthorship(w.root);
	if (authorship === null) return { identity: { author: committer, committer }, message };
	return {
		identity: { author: { name: CLIO_COMMIT_NAME, email: CLIO_COMMIT_EMAIL }, committer },
		message: attributeCommitMessage(message, {}, true, { clioAuthorFor: authorship.human }),
	};
}

type RemoteRequest =
	| { op: "prepare" }
	| { op: "commit"; authored: string[] | null; listLimit: number; identity: RemoteCommitIdentity; message: string }
	| { op: "cleanup"; commit: string; untracked: string };

interface RemoteResponse {
	commit: string;
	untracked?: unknown;
	left?: unknown;
	leftCount?: unknown;
}

async function remote(input: FleetChangeReturn, request: RemoteRequest): Promise<RemoteResponse> {
	const result = await runCommandVector("ssh", buildSshArgs(input.node, `node -e ${shellQuote(REMOTE_OPERATION)}`), {
		input: JSON.stringify({ ...request, worktree: input.worktree }),
		timeoutMs: 60_000,
		maxOutputBytes: 128_000,
	});
	if (result.exitCode !== 0)
		throw new Error(
			`SSH change return: ${result.stderr.trim()}; remote branch ${input.worktree.branch} and worktree ${input.worktree.path} are preserved for recovery`,
		);
	const value = JSON.parse(result.stdout) as RemoteResponse;
	if (typeof value.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(value.commit))
		throw new Error("SSH change return: invalid remote commit");
	return value;
}

/** The remote commit, read only when every field has the shape the operation writes. */
async function remoteCommit(
	input: FleetChangeReturn,
	authoredPaths: Iterable<string> | null,
): Promise<FleetChangeImport> {
	const value = await remote(input, {
		op: "commit",
		authored: authoredPaths === null ? null : [...authoredPaths],
		listLimit: LEFT_UNCOMMITTED_LIST_LIMIT,
		...remoteCommitAttribution(input.worktree),
	});
	const { untracked, left, leftCount } = value;
	if (
		typeof untracked !== "string" ||
		!/^[a-f0-9]{64}$/.test(untracked) ||
		!Array.isArray(left) ||
		!left.every((entry): entry is string => typeof entry === "string") ||
		typeof leftCount !== "number" ||
		!Number.isSafeInteger(leftCount) ||
		leftCount < left.length
	)
		throw new Error("SSH change return: invalid remote commit report");
	return {
		commit: value.commit,
		untracked,
		...(leftCount > 0 ? { leftUncommitted: { count: leftCount, paths: left } } : {}),
	};
}

export async function prepareFleetChangeReturn(
	node: SshNodeEndpoint,
	worktree: TaskWorktree,
): Promise<FleetChangeReturn> {
	const input = { node, worktree };
	await remote(input, { op: "prepare" });
	return input;
}

async function git(root: string, args: string[], env?: Record<string, string>): Promise<string> {
	const result = await runCommandVector(
		"git",
		internalGitArgv(["-C", root, "-c", "core.hooksPath=/dev/null", ...args]),
		{
			timeoutMs: 60_000,
			maxOutputBytes: 1024 * 1024,
			...(env ? { env } : {}),
		},
	);
	if (result.exitCode !== 0) throw new Error(`SSH change return: ${result.stderr.trim()}`);
	return result.stdout;
}

/**
 * Commit the remote worktree, fetch into a private ref, validate the exact
 * commit, then fast-forward only the owned local task tree. `authoredPaths` is
 * the run's host-observed write record, or null when it has none, as for
 * `commitWorktreePath`.
 */
export async function importFleetChanges(
	input: FleetChangeReturn,
	authoredPaths: Iterable<string> | null,
	writeRoots: ReadonlyArray<string>,
	protectedPaths: ReadonlyArray<string>,
): Promise<FleetChangeImport> {
	const { node, worktree: w } = input;
	const imported = await remoteCommit(input, authoredPaths);
	const { commit } = imported;
	// Drops the host, `--` and the empty command: git supplies its own host and remote command to GIT_SSH_COMMAND.
	const sshOptions = buildSshArgs(node, "").slice(0, -3);
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
	return imported;
}

/** Call only after the existing verification and guarded application succeeded. */
export async function cleanupFleetChangeReturn(input: FleetChangeReturn, imported: FleetChangeImport): Promise<void> {
	await remote(input, { op: "cleanup", commit: imported.commit, untracked: imported.untracked });
}
