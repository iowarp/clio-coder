# HPC Clusters

CLIO Coder needs Node.js 22.19 or newer. Cluster login nodes often offer Node 18
or 20 through `module load nodejs`, run an old glibc (RHEL and CentOS 7 ship
2.17, while official Node 22 and 24 builds need 2.28), sit behind a proxy, or
have no internet at all. The installer handles each of these without root.

## Install on a login node

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
clio-coder doctor
```

The installer ends with the next step for this account, for example
`The first launch sets up a model. Found: ANTHROPIC_API_KEY.`, and, while
`~/.local/bin` is not on `PATH`, the launcher's full path to run until it is.
[Connect a model](#connect-a-model) below takes it from there to a first answer.

If coder.iowarp.ai is unreachable from the cluster, fetch the same script from the
latest GitHub release:
`https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.

The script (`scripts/install.sh`) is POSIX sh and needs `curl` or `wget`, `tar`
with `xz` or `gzip`, and a SHA-256 tool (`sha256sum`, `shasum` or `openssl`). It
never uses `module load`, the system `node`, or `sudo`, and it refuses to run
under `sudo` because that would install into root's home. It picks a Node build
for the host:

| Host | Node build |
| --- | --- |
| Linux x64 or arm64, glibc 2.28 or newer (a glibc host that also carries the musl loader, as Debian's `musl` package installs, still gets this build) | Official `linux-x64` or `linux-arm64` from nodejs.org |
| Linux x64, glibc 2.17 to 2.27 (RHEL/CentOS 7 class) | Unofficial `linux-x64-glibc-217` from unofficial-builds.nodejs.org |
| Linux on musl (Alpine) | `linux-x64-musl` (official) or `linux-arm64-musl` (unofficial) |
| macOS arm64 or x64 | Official `darwin-arm64` or `darwin-x64` |
| Linux arm64 with glibc older than 2.28 | None exists; use conda-forge `nodejs` and `npm install -g @iowarp/clio-coder` with it |

`CLIO_CODER_NODE_BUILD` forces a build when detection is wrong, for example
`CLIO_CODER_NODE_BUILD=linux-x64-glibc-217` on a node whose `getconf` reports a
newer glibc than its compute nodes run.

Everything lands in your home directory: the runtime and package versions under
`~/.local/share/clio-coder-install` (or `--install-dir`), and the launcher in
`~/.local/bin`. Node adds about 210 MB to a version. The installer skips the
Claude Agent SDK, about 224 MB, unless `--include-claude-sdk` is passed, and when it is
provisioned it lands under the data root (`~/.local/share/clio-coder`), not under
`--install-dir`. The installer refuses to start with under about 732 MB free at the
install root. On a small home quota, put the install root on a project filesystem with
`--install-dir /project/$USER/clio-coder` and keep the launcher in `~/.local/bin`. Compute nodes that mount the same home directory run
the same launcher. `--dry-run` prints the plan without downloading anything. The
full flag list is in [Installer options](installation-and-lifecycle.md).

Shell startup files are edited only when you pass `--modify-path`; otherwise
the installer prints the `export PATH=...` line to add yourself.

## How downloads are verified

Every Node download is checked against `SHASUMS256.txt` from the same release,
and a mismatch stops the install. For official builds, the script also checks the
OpenPGP signature on `SHASUMS256.txt.asc` against the Node.js release team's
keys, fetched from the `nodejs/release-keys` repository rather than from the
download host, when `gpgv` or `gpg` is present. A bad signature always stops the
install. The install also stops when nodejs.org serves no `SHASUMS256.txt.asc`,
when a key outside that keyring signed the file, or when the
`SHASUMS256.txt.asc` nodejs.org served holds no valid signature;
`CLIO_CODER_REQUIRE_SIGNATURE=0` accepts these three cases and installs on the
checksum. A mirror or local tarball without a signature file, an unavailable
keyring, a missing `gpg`, or a `gpg` that cannot read the keyring (gpgv 1.x and
gpg 2.0, as on CentOS 7) is reported, and the install
continues on the checksum alone unless `CLIO_CODER_REQUIRE_SIGNATURE=1` is set.
unofficial-builds.nodejs.org publishes no signatures, so the glibc-2.17 and musl
arm64 builds are verified by checksum over HTTPS only.

The npm package itself is fetched and checked by npm against the registry's
integrity hashes, like any npm install.

## Proxies

`curl`, `wget` and npm all read `https_proxy` and `http_proxy` (and npm also
reads `HTTPS_PROXY`). Export them before running the installer:

```bash
export https_proxy=http://proxy.example.org:3128
export http_proxy="$https_proxy"
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

CLIO Coder reads the same variables at run time. `HTTPS_PROXY`, `HTTP_PROXY`
and their lowercase forms apply to model requests, discovery probes, OAuth
refreshes and web fetches, and `clio-coder doctor` shows the proxy in effect.
`localhost`, `127.0.0.1` and `[::1]` always go direct. A `NO_PROXY` entry
matches a host by exact name or as a domain suffix (`example.com`,
`.example.com` and `*.example.com` all cover `api.example.com`), optionally
with `:port`, and `NO_PROXY=*` turns the proxy off. A CIDR range such as
`192.168.0.0/16` or an IPv4 wildcard such as `192.168.*` sends requests to IP
addresses inside it direct. Host names are not resolved to match a range, so a
model server you reach by host name goes through the proxy
unless `NO_PROXY` names that host:

```bash
export NO_PROXY=localhost,gpu-node-07,10.1.4.22
```

## Connect a model

CLIO Coder sends prompts to a model it reaches over HTTP: a provider API, a
site or lab gateway, or a server such as vLLM or llama.cpp that you run on a
compute node. Its requests use the proxy variables in [Proxies](#proxies), so
export `https_proxy` and a `NO_PROXY` naming the cluster hosts it should reach
directly before connecting.

There are three ways to connect. Each saves a *target* in your user settings
and makes it the chat and worker model.

1. **A site setup file.** When your site or lab publishes one, import it. CLIO Coder
   prints each address and where the key comes from, and asks once:

   ```bash
   clio-coder configure --import https://hpc.example.edu/clio-coder/setup.yaml
   export LAB_API_KEY=...    # the key variable the file names, if any
   ```

   The file can only name targets, routes, key variables and notes; it cannot
   hold a key or change safety settings. The format is in
   [Setup files](configuration-and-targets.md#setup-files).

2. **One command with flags**, for a gateway or server whose address and model
   you know. The key stays in your environment and is read at call time:

   ```bash
   clio-coder configure --id lab --runtime openai-compat \
     --url https://llm.lab.example.org/v1 --model qwen3-coder-480b \
     --api-key-env LAB_API_KEY --set-orchestrator --set-fleet-default
   ```

   `clio-coder configure --list` names the runtimes (`vllm`, `llamacpp`,
   `ollama`, `litellm`, `openai-compat`, `anthropic` and the rest). An
   unreachable address is saved with a warning, so this works before the
   server is up.

3. **The setup wizard.** Run `clio-coder` in a project with no model chosen,
   or `clio-coder configure`, and pick **A model server or gateway** and its
   address, or **An API key** and paste it.

**A server on a compute node.** Start the server inside a job, then forward
its port to the login node with SSH and connect to the forwarded port:

```bash
# in the job on gpu-node-07
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --port 8000

# on the login node
ssh -N -f -L 8000:localhost:8000 gpu-node-07
clio-coder configure --id gpu --runtime vllm --url http://127.0.0.1:8000 \
  --model Qwen/Qwen3-Coder-30B-A3B-Instruct --set-orchestrator --set-fleet-default
```

A login node is shared, so pick a port other users are unlikely to take, and
see [Shared login nodes](#shared-login-nodes) for why CLIO Coder asks before using a
server it found on a local port. Connecting to `http://gpu-node-07:8000`
directly also works when the login node can reach it; name the host in
`NO_PROXY`.

**Sign in without a browser.** A login node has no display, so
`clio-coder auth login openai-codex` (or `anthropic-max`) prints a
link to open on your own computer and a code to enter there or paste back.
`--method device` picks the code flow on any machine.

**Ask the first question.**

```bash
cd /path/to/your/project
clio-coder run --read-only "Summarize this repository and how to run its tests."
clio-coder          # the interactive session
```

`clio-coder doctor` names anything still missing, such as a key variable not
set in this shell, with the command that fixes it. On a cluster, the agent's
scheduler commands run outside the shell sandbox behind an approval; see
[Scheduler clients](#scheduler-clients).

## Scheduler clients

Slurm, PBS, LSF and Flux client commands (`squeue`, `sbatch`, `qstat`, `bsub`,
`flux` and the rest) run outside the shell sandbox behind the same approval as
`ssh`: an ask at the default autonomy level, the safety judge at yolo. A script
that calls `sbatch` itself stays inside the sandbox and fails there, so submit
from the command line the agent runs rather than from a wrapper script. A
workspace script named like a client (`./sbatch`, `bin/ssh`) is not one and
stays inside the sandbox.
`/loop --command` and job poll commands get the environment `bash` gets, with
credentials scrubbed and `safety.sandboxPassEnv` honored, and a failing poll
shows its first stderr line. With the sandbox active, `clio-coder doctor` adds a
`scheduler commands` row when a scheduler client is on `PATH`.

## Shared login nodes

Other users run on the same login node, and often share the filesystem your
home is on.

- **Keep the state directory private.** Session transcripts, the session
  ledger and spilled tool output are written owner-only (`0700` directories,
  `0600` files). `clio-coder doctor` warns when the state or data root is
  open to group or other users, and `clio-coder doctor --fix` tightens it.
  Keep `CLIO_CODER_HOME` or the state directory out of shared project space.
- **Do not accept a local server you do not run.** On a home with no chat
  model, CLIO Coder may find a model server on a default local port. It uses one
  only after a yes, and on Linux the question names the account that owns the
  listener and defaults to no when it is another user. Prompts sent to
  someone else's server are readable by them; answer no and connect your own.
- **One home across nodes.** When the login node and compute nodes share one
  home, each host's workers are counted against that host's limits for the
  local node and for local-port servers, and a plan running on one node is
  not cut short by CLIO Coder starting on another. Slots held by a host that died
  free up five minutes after they expire, or at once with
  `clio-coder session terminate --force`.
- **Apptainer with its own pid namespace.** An instance started with `--pid`
  or `--containall` keeps the host's name but numbers its processes on its
  own. The lock CLIO Coder takes on its state files (`settings.yaml`,
  `credentials.yaml`, the dispatch admission state) records the holder's pid
  namespace and boot, so a CLIO Coder process on the host never takes a container
  holder's lock by mistaking it for a host process, and the reverse. This
  holds only when the host and the container both run a release that
  records the namespace; an older release on either side still compares plain
  pids. A lock left by a container that has exited, or held where the kernel
  does not report namespace pids (before Linux 4.1, as on EL7), is taken
  over once it is 30 seconds old. Other records CLIO Coder keeps on the home
  (session ownership, worker slot leases, the store lock, update and build
  locks) still compare plain pids,
  so do not share one home between the host and such a container: give the
  container its own `CLIO_CODER_HOME`, or run it without `--pid` and
  `--containall` (the Apptainer default shares the host's pid namespace,
  which needs nothing).

## Airgapped and mirrored sites

Point the installer at mirrors laid out like the upstream directories. A
`file://` URL works for a mirror on a shared filesystem:

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_NODE_MIRROR` | Base URL laid out like `https://nodejs.org/dist` (`index.tab`, `v<ver>/node-v<ver>-<build>.tar.xz`, `SHASUMS256.txt`, `SHASUMS256.txt.asc`) |
| `CLIO_CODER_NODE_UNOFFICIAL_MIRROR` | The same for unofficial-builds.nodejs.org |
| `CLIO_CODER_NODE_KEYRING` | A local copy of the release keyring (`gpg-only-active-keys/pubring.kbx` from `nodejs/release-keys`) |
| `CLIO_CODER_NODE_TARBALL` | One Node tarball by path, with its `SHASUMS256.txt` next to it or named by `CLIO_CODER_NODE_SHASUMS` |
| `CLIO_CODER_PACKAGE` | A local `npm pack` tarball of `@iowarp/clio-coder` |
| `npm_config_registry` | An npm registry mirror (Artifactory, Nexus, Verdaccio) for the package's dependencies. The update check reads release dist-tags from it too, when it is an `http` or `https` URL, so a mirror announces the version its own `npm install` would fetch |

A local package tarball still needs its dependencies from a registry, so a fully
offline site needs a registry mirror as well as the Node mirror. Without one,
npm waits on its retries and then fails.

The script itself fails closed on a bad signature or checksum, so a mirror that
serves a modified file is refused rather than installed.

After install, a few optional assets download on first use: the Ruby and C#
code map grammars and the HDF5, NetCDF-4 and Parquet readers of the `data` tool.
Without network the code map falls back to line patterns for Ruby and C#, and
the `data` tool names the file to pre-seed; see
[First-use downloads and air-gapped hosts](installation-and-lifecycle.md#9-first-use-downloads-and-air-gapped-hosts).

## Choosing versions

| Option | Effect |
| --- | --- |
| `--version 0.6.0` or `CLIO_CODER_VERSION` | Install that CLIO Coder version or dist-tag |
| `--channel beta` or `CLIO_CODER_CHANNEL` | Follow a release channel (`latest`, `beta`, `dev`) |
| `--node-version 24` or `CLIO_CODER_NODE_VERSION` | Install the newest Node of a major, or an exact version |
| `--refresh-runtime` | Download Node again even when the wanted one is present |
| `--rollback` | Point the launcher back at the previous installed version |

An exact version such as `--version 0.6.0` pins the install: `clio-coder upgrade`
and background updates leave it there, and `--version latest` (or `beta`, `dev`)
releases the pin. A channel that resolves to a version older than the installed
one is refused before anything is installed. `clio-coder upgrade --channel latest`
still leaves a pre-release for the stable release, and a direct run of a 0.8.0
or newer installer does so with `--leave-prerelease`; in any other case name that version with
`--version` or use `--rollback`. `--rollback` moves a pin to the version it restores. The
[installation guide](installation-and-lifecycle.md) has the details.

`clio-coder upgrade` installs the next version beside the current one and keeps
the managed Node unless you pass `--refresh-runtime`.
`clio-coder uninstall` removes the launcher, the runtime and
every installed version.

## Using a Node you already have

If the site provides Node 22.19 or newer somewhere other than the default `PATH`,
for example a module whose `node` you cannot put first, point CLIO Coder at it:

```bash
export CLIO_CODER_NODE=/path/to/node22/bin/node
clio-coder --version
```

The package's `clio-coder` command checks the Node before loading anything else.
When `CLIO_CODER_NODE` is set and names a different binary, it reruns itself
under that Node. Otherwise, on an older Node, it prints the installer command and
these options, naming the glibc limit when the host's glibc is older than 2.28.

## Checking the login node

`clio-coder doctor` reports a `toolchain <name>` row for the compilers, MPI
launchers, build systems, `python3` and `sbatch` it finds on `PATH`, so a login
node can be inspected before a workspace validation contract names any of them
([Doctor](doctor.md)). Slurm access through the clio-kit MCP server is covered in
[Slurm](slurm.md).

## The HPC skill pack

The `hpc` plugin in the Library collects skills for cluster work. It is content
only: installing it starts nothing and declares no MCP server.

```bash
clio-coder library install skill:slurm-jobs --project
clio-coder library install plugin:hpc --project
```

Run `/reload library` in a running session afterward.

| Skill | What it covers |
| --- | --- |
| `hpc-sweep` | Parameter sweeps as Slurm job arrays; see [Parameter sweeps](slurm.md#parameter-sweeps) |
| `hpc-modules` | Finding and loading Lmod modules and Spack installs through `bash`, keeping each load in the shell that uses it |
| `hpc-parallel-io` | Correctness rules and tuning for parallel HDF5 and MPI-IO, checked by readback and Darshan counters |
| `hpc-darshan` | Summarizing a Darshan log and naming the counters behind each I/O finding |
| `hpc-chronolog` | Recording run events in ChronoLog and reading them back |

Known limits for this release: the Slurm and Lmod paths were checked against
fake Slurm and Lmod binaries only, not on a live cluster, and the MPI-IO
guidance in `hpc-parallel-io` is compile-checked only.

On an air-gapped login node the pack needs no network of its own, but the
clio-kit Slurm server downloads its environment on its first launch; launch it
once while online or copy a warm `clio-kit` cache from a connected node. CLIO
Coder's own first-use downloads (the Ruby and C# code map grammars and the HDF5,
NetCDF-4 and Parquet readers) are listed with their pre-seeding paths in
[First-use downloads and air-gapped hosts](installation-and-lifecycle.md#9-first-use-downloads-and-air-gapped-hosts).
