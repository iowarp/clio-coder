#!/usr/bin/env bash
# Install Clio Coder into a Terminal-Bench task container and point it at the local fleet.
# Sourced by AbstractInstalledAgent.perform_task after setup-env.sh exports CLIO_CODER_* vars.
set -u

log() { echo "[install-clio] $*"; }

# 1. Node >= 22 (Clio engine requirement).
if ! command -v node >/dev/null 2>&1; then
  log "installing Node 22"
  if command -v apt-get >/dev/null 2>&1; then
    (curl -fsSL https://deb.nodesource.com/setup_22.x | bash -) >/dev/null 2>&1 || true
    apt-get install -y nodejs >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  log "Node unavailable and could not be installed"; exit 1
fi
log "node $(node --version)"

# 2. Clio itself. A tarball URL the container can reach is preferred so a run
#    measures the working tree rather than the last published release; the npm
#    registry is the fallback.
if [ -n "${CLIO_CODER_TARBALL_URL:-}" ]; then
  log "fetching clio tarball from CLIO_CODER_TARBALL_URL"
  curl -fsSL "$CLIO_CODER_TARBALL_URL" -o /tmp/clio.tgz || { log "tarball fetch failed"; exit 1; }
  npm i -g /tmp/clio.tgz >/dev/null 2>&1 || { log "npm install of tarball failed"; exit 1; }
else
  log "no CLIO_CODER_TARBALL_URL; trying npm registry"
  npm i -g @iowarp/clio-coder >/dev/null 2>&1 || {
    log "clio install failed: set CLIO_CODER_TARBALL_URL to a reachable npm-pack tarball"; exit 1;
  }
fi
command -v clio-coder >/dev/null 2>&1 || { log "clio-coder not on PATH after install"; exit 1; }
log "clio-coder $(clio-coder --version 2>/dev/null || echo unknown)"

# 3. Fleet config pointing at the operator's nodes.
if [ -z "${CLIO_CODER_MAIN_URL:-}" ] || [ -z "${CLIO_CODER_WORKER_URL:-}" ]; then
  log "CLIO_CODER_MAIN_URL and CLIO_CODER_WORKER_URL must be set for Terminal-Bench runs"; exit 1
fi
CLIO_CODER_MAIN_TARGET=${CLIO_CODER_MAIN_TARGET:-local-main}
CLIO_CODER_WORKER_TARGET=${CLIO_CODER_WORKER_TARGET:-local-worker}
# Each node's runtime and thinking level travel from the operator's fleet.
# Hardcoding them described an LM Studio orchestrator as llama.cpp and raised
# the thinking level the operator had turned off, so the container ran a
# different fleet than the one being benchmarked.
CLIO_CODER_MAIN_RUNTIME=${CLIO_CODER_MAIN_RUNTIME:-llamacpp}
CLIO_CODER_WORKER_RUNTIME=${CLIO_CODER_WORKER_RUNTIME:-lmstudio-native}
CLIO_CODER_MAIN_THINKING=${CLIO_CODER_MAIN_THINKING:-off}
CLIO_CODER_WORKER_THINKING=${CLIO_CODER_WORKER_THINKING:-off}
key_env_for_runtime() {
  case "$1" in
    lmstudio-native|lmstudio) echo CLIO_CODER_LMSTUDIO_KEY ;;
    *) echo CLIO_CODER_LLAMACPP_KEY ;;
  esac
}
MAIN_KEY_ENV=$(key_env_for_runtime "$CLIO_CODER_MAIN_RUNTIME")
WORKER_KEY_ENV=$(key_env_for_runtime "$CLIO_CODER_WORKER_RUNTIME")
mkdir -p "$HOME/.config/clio-coder"
cat > "$HOME/.config/clio-coder/settings.yaml" <<YAML
version: 1
identity: clio
autonomy: ${CLIO_CODER_AUTONOMY:-full-auto}
targets:
  - id: ${CLIO_CODER_MAIN_TARGET}
    runtime: ${CLIO_CODER_MAIN_RUNTIME}
    url: ${CLIO_CODER_MAIN_URL}
    auth:
      apiKeyEnvVar: ${MAIN_KEY_ENV}
    wireModels:
      - ${CLIO_CODER_MAIN_MODEL}
    defaultModel: ${CLIO_CODER_MAIN_MODEL}
    gateway: true
  - id: ${CLIO_CODER_WORKER_TARGET}
    runtime: ${CLIO_CODER_WORKER_RUNTIME}
    url: ${CLIO_CODER_WORKER_URL}
    auth:
      apiKeyEnvVar: ${WORKER_KEY_ENV}
    wireModels:
      - ${CLIO_CODER_WORKER_MODEL}
    defaultModel: ${CLIO_CODER_WORKER_MODEL}
    gateway: true
orchestrator:
  target: ${CLIO_CODER_MAIN_TARGET}
  model: ${CLIO_CODER_MAIN_MODEL}
  thinkingLevel: ${CLIO_CODER_MAIN_THINKING}
workers:
  default:
    target: ${CLIO_CODER_WORKER_TARGET}
    model: ${CLIO_CODER_WORKER_MODEL}
    thinkingLevel: ${CLIO_CODER_WORKER_THINKING}
  onPermission: deny
YAML

# State the freshly written settings describe: doctor creates the data, state,
# and cache trees so the first turn is not also a first-install.
clio-coder doctor --fix >/dev/null 2>&1 || true

# 4. Connectivity preflight so a network-isolated container fails loudly, not silently.
#    Both nodes are checked: a reachable orchestrator with an unreachable worker
#    fails only once dispatch starts, which reads as a mid-episode agent fault.
if ! curl -fsS -m 8 "${CLIO_CODER_MAIN_URL}/v1/models" >/dev/null 2>&1; then
  log "WARNING: cannot reach fleet main at ${CLIO_CODER_MAIN_URL} from container; runs will fail"
fi
if ! curl -fsS -m 8 "${CLIO_CODER_WORKER_URL}/v1/models" >/dev/null 2>&1; then
  log "WARNING: cannot reach fleet workers at ${CLIO_CODER_WORKER_URL} from container; dispatch will fail"
fi

# 5. Deterministic Stage 1 index so code_nav has data immediately.
clio-coder context index >/dev/null 2>&1 || true
log "ready"
