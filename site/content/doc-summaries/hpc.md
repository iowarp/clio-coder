## Install without root

The installer brings its own Node.js, so you do not need `module load nodejs` or a system Node. It never uses `sudo` and refuses to run under it.

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
clio-coder doctor
```

It needs `curl` or `wget`, `tar`, and a SHA-256 tool. The runtime and package go under `~/.local/share/clio-coder-install` and the launcher under `~/.local/bin`. Compute nodes that mount the same home directory run the same launcher.

## Old glibc, proxies, and quotas

The installer picks a Node build for the host. Official builds cover Linux with glibc 2.28 or newer, macOS, and Alpine on x64. An unofficial build covers x64 hosts with glibc 2.17 to 2.27, the RHEL and CentOS 7 class. Linux arm64 with an older glibc has no build; use conda-forge Node and npm instead.

Export `https_proxy` before running the installer behind a proxy. A version takes about 460 MB, or 190 MB with `--omit-optional`, and Node adds about 210 MB. On a small home quota, move the install root with `--install-dir /project/$USER/clio-coder`.

## Verified downloads

Every Node download is checked against its release `SHASUMS256.txt`, and a mismatch stops the install. When `gpgv` or `gpg` is present, the installer also verifies the OpenPGP signature on official builds. Set `CLIO_CODER_REQUIRE_SIGNATURE=1` to fail when no signature verifies.

## Airgapped sites and your own Node

Point `CLIO_CODER_NODE_MIRROR` at a mirror laid out like nodejs.org/dist, and `npm_config_registry` at a registry mirror for the package's dependencies. `file://` URLs work on a shared filesystem. If a site already provides Node 22.19 or newer, set `CLIO_CODER_NODE` to its binary.

Pick versions with `--version` or `--channel`, and undo an upgrade with `--rollback`. The full guide lists every mirror variable and installer option.
