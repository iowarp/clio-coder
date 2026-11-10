# HPC Clusters

Clio Coder needs Node.js 22.19 or newer. Cluster login nodes often offer Node 18
or 20 through `module load nodejs`, run an old glibc (RHEL and CentOS 7 ship
2.17, while official Node 22 and 24 builds need 2.28), sit behind a proxy, or
have no internet at all. The installer handles each of these without root.

## Install on a login node

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
clio-coder doctor
```

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
download host, when `gpgv` or `gpg` is present. A bad signature stops the
install. An unavailable keyring or missing `gpg` is reported, and the install
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

Clio Coder reads the same variables at run time. `HTTPS_PROXY`, `HTTP_PROXY`
and their lowercase forms apply to model requests, discovery probes, OAuth
refreshes and web fetches, and `clio-coder doctor` shows the proxy in effect.
`localhost`, `127.0.0.1` and `[::1]` always go direct. A `NO_PROXY` entry
matches a host by exact name or as a domain suffix (`example.com`,
`.example.com` and `*.example.com` all cover `api.example.com`), optionally
with `:port`, and `NO_PROXY=*` turns the proxy off. CIDR ranges such as
`192.168.0.0/16` and wildcards such as `192.168.*` are ignored (a CIDR range
gets one stderr line naming it), so a model server on a cluster or LAN address goes through the proxy
unless `NO_PROXY` names its host or IP address exactly:

```bash
export NO_PROXY=localhost,gpu-node-07,10.1.4.22
```

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
| `--version 0.6.0` or `CLIO_CODER_VERSION` | Install that Clio Coder version or dist-tag |
| `--channel beta` or `CLIO_CODER_CHANNEL` | Follow a release channel (`latest`, `beta`, `dev`) |
| `--node-version 24` or `CLIO_CODER_NODE_VERSION` | Install the newest Node of a major, or an exact version |
| `--refresh-runtime` | Download Node again even when the wanted one is present |
| `--rollback` | Point the launcher back at the previous installed version |

An exact version such as `--version 0.6.0` pins the install: `clio-coder upgrade`
and background updates leave it there, and `--version latest` (or `beta`, `dev`)
releases the pin. `--rollback` moves a pin to the version it restores. The
[installation guide](installation-and-lifecycle.md) has the details.

`clio-coder upgrade` installs the next version beside the current one and keeps
the managed Node unless you pass `--refresh-runtime`.
`clio-coder uninstall` removes the launcher, the runtime and
every installed version.

## Using a Node you already have

If the site provides Node 22.19 or newer somewhere other than the default `PATH`,
for example a module whose `node` you cannot put first, point Clio Coder at it:

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
once while online or copy a warm `clio-kit` cache from a connected node. Clio
Coder's own first-use downloads (the Ruby and C# code map grammars and the HDF5,
NetCDF-4 and Parquet readers) are listed with their pre-seeding paths in
[First-use downloads and air-gapped hosts](installation-and-lifecycle.md#9-first-use-downloads-and-air-gapped-hosts).
