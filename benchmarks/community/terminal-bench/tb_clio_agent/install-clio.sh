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
mkdir -p "$HOME/.config/clio-coder"
cat > "$HOME/.config/clio-coder/settings.yaml" <<YAML
version: 1
identity: clio
autonomy: ${CLIO_CODER_AUTONOMY:-full-auto}
targets:
  - id: ${CLIO_CODER_MAIN_TARGET}
    runtime: llamacpp
    url: ${CLIO_CODER_MAIN_URL}
    auth:
      apiKeyEnvVar: CLIO_CODER_LLAMACPP_KEY
    wireModels:
      - ${CLIO_CODER_MAIN_MODEL}
    defaultModel: ${CLIO_CODER_MAIN_MODEL}
    gateway: true
  - id: ${CLIO_CODER_WORKER_TARGET}
    runtime: lmstudio-native
    url: ${CLIO_CODER_WORKER_URL}
    auth:
      apiKeyEnvVar: CLIO_CODER_LMSTUDIO_KEY
    wireModels:
      - ${CLIO_CODER_WORKER_MODEL}
    defaultModel: ${CLIO_CODER_WORKER_MODEL}
    gateway: true
orchestrator:
  target: ${CLIO_CODER_MAIN_TARGET}
  model: ${CLIO_CODER_MAIN_MODEL}
  thinkingLevel: low
workers:
  default:
    target: ${CLIO_CODER_WORKER_TARGET}
    model: ${CLIO_CODER_WORKER_MODEL}
    thinkingLevel: low
  onPermission: deny
YAML

# 4. Connectivity preflight so a network-isolated container fails loudly, not silently.
if ! curl -fsS -m 8 "${CLIO_CODER_MAIN_URL}/v1/models" >/dev/null 2>&1; then
  log "WARNING: cannot reach fleet main at ${CLIO_CODER_MAIN_URL} from container; runs will fail"
fi

# 5. Deterministic Stage 1 index so code_nav has data immediately.
clio-coder context index >/dev/null 2>&1 || true
log "ready"
