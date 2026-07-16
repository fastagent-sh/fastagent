#!/usr/bin/env bash
# e2e: `fastagent deploy k8s` against a real, throwaway kind cluster.
#
# Codifies the full journey with ZERO credentials and ZERO leftover state:
#   generate artifacts -> build the image -> kind create/load -> `deploy k8s --run`
#   -> assert PVC (Bound + ReadWriteOncePod) -> /health -> /invoke terminal event
#   -> /data session state survives pod replacement -> cleanup (trap).
#
# Runs locally (`./scripts/e2e-k8s.sh`) and in CI (.github/workflows/e2e-k8s.yml).
# Prereqs: docker + kubectl; kind is downloaded to the scratch dir when absent.
#
# Design notes:
# - Model auth is a DUMMY key on purpose: the /invoke assertion is the fail-visibly
#   contract itself — the turn must end in a terminal event (`failed` on a 401, or
#   `completed` if a real key happens to be exported), never a crash-looping pod.
# - ONE deviation from the generated Dockerfile: the pinned `npm i -g @kid7st/fastagent@x.y.z`
#   line is rewritten to install THIS checkout's `npm pack` tarball. Hermetic (an
#   unpublished version bump can't fail the build) and it exercises the branch's own
#   `fastagent start` runtime, not the last published one.
# - NOT covered here (layer-3, needs a public edge): a real ingress controller/TLS,
#   Telegram webhook end-to-end, and a real registry pull (kind load bypasses
#   ImagePullBackOff). See docs/deploy.md "Kubernetes".
set -euo pipefail

step() { printf '\n=== %s\n' "$*"; }

cd "$(dirname "$0")/.."
REPO=$(pwd)
KIND_VERSION=v0.32.0

# Isolate from operator knobs that would change what the deploy resolves.
unset FASTAGENT_MODEL FASTAGENT_STATE_DIR FASTAGENT_AUTH_PATH FASTAGENT_SESSIONS_DIR

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required"; exit 1; }

WORK=$(mktemp -d)
CLUSTER="fastagent-e2e-$$"
IMAGE="fastagent-e2e:$$"
LOCAL_PORT=$((20000 + $$ % 10000))
NS="e2e-bot" # toK8sName(basename of the workspace dir below)
PREV_CTX=$(kubectl config current-context 2>/dev/null || true)
CLUSTER_CREATED=""
PF_PID=""

cleanup() {
  code=$?
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true # reap it so the shell prints no "Terminated" job notice
  fi
  if [ -n "$CLUSTER_CREATED" ]; then
    "$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
  # kind switches the current context and deletes it with the cluster; restore the operator's.
  [ -n "$PREV_CTX" ] && kubectl config use-context "$PREV_CTX" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [ $code -eq 0 ]; then echo; echo "e2e-k8s: PASS"; else echo; echo "e2e-k8s: FAIL (exit $code)"; fi
}
trap cleanup EXIT

step "kind: resolve binary"
if command -v kind >/dev/null; then
  KIND=$(command -v kind)
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  KIND="$WORK/kind"
  curl -sL -o "$KIND" "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${OS}-${ARCH}"
  chmod +x "$KIND"
fi
"$KIND" version

step "pack this checkout (the image installs the branch's runtime, not npm's)"
[ -d node_modules ] || npm ci
TARBALL=$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)
[ -f "$WORK/$TARBALL" ] || { echo "npm pack failed"; exit 1; }

step "scratch workspace + generated artifacts"
mkdir -p "$WORK/$NS"
cat > "$WORK/$NS/fastagent.config.mjs" <<'EOF'
export default { model: "openai/gpt-5.2" };
EOF
cat > "$WORK/$NS/AGENTS.md" <<'EOF'
# e2e test bot
You are a minimal test agent. Reply briefly.
EOF
node "$REPO/src/cli.ts" deploy k8s --image "$IMAGE" "$WORK/$NS" > "$WORK/runbook.txt"

step "rewrite the pinned install to this checkout's tarball (the one named deviation)"
cp "$WORK/$TARBALL" "$WORK/$NS/fastagent.tgz"
sed -i.bak \
  's|^RUN npm i -g @kid7st/fastagent@.*|RUN --mount=type=bind,source=fastagent.tgz,target=/tmp/fastagent.tgz npm i -g /tmp/fastagent.tgz|' \
  "$WORK/$NS/Dockerfile"
grep -q "fastagent.tgz" "$WORK/$NS/Dockerfile" || { echo "Dockerfile rewrite failed"; exit 1; }

step "docker build"
DOCKER_BUILDKIT=1 docker build -q -t "$IMAGE" "$WORK/$NS"

step "kind: create throwaway cluster + load image"
"$KIND" create cluster --name "$CLUSTER" --wait 120s
CLUSTER_CREATED=1
"$KIND" load docker-image "$IMAGE" --name "$CLUSTER"

step "deploy k8s --run (dummy model key: mechanics only, the turn itself must FAIL VISIBLY)"
OPENAI_API_KEY="${OPENAI_API_KEY:-sk-dummy-e2e}" \
  node "$REPO/src/cli.ts" deploy k8s --image "$IMAGE" --run "$WORK/$NS"

step "assert: PVC bound with the single-consumer access mode"
MODE=$(kubectl -n "$NS" get pvc "$NS-state" -o jsonpath='{.spec.accessModes[0]}')
PHASE=$(kubectl -n "$NS" get pvc "$NS-state" -o jsonpath='{.status.phase}')
echo "pvc: $PHASE $MODE"
[ "$MODE" = "ReadWriteOncePod" ] || { echo "expected ReadWriteOncePod, got $MODE"; exit 1; }
[ "$PHASE" = "Bound" ] || { echo "expected Bound, got $PHASE"; exit 1; }

step "assert: /health via the Service"
kubectl -n "$NS" port-forward "svc/$NS" "$LOCAL_PORT:80" >/dev/null 2>&1 &
PF_PID=$!
HEALTH=""
for _ in $(seq 1 15); do
  HEALTH=$(curl -s --max-time 2 "localhost:$LOCAL_PORT/health" || true)
  [ "$HEALTH" = "ok" ] && break
  sleep 1
done
echo "health: ${HEALTH:-<none>}"
[ "$HEALTH" = "ok" ] || { echo "/health did not answer ok"; exit 1; }

step "assert: /invoke ends in a terminal event (failed on the dummy key — SPEC MUST 1/2)"
RESP=$(curl -sN --max-time 120 -X POST "localhost:$LOCAL_PORT/invoke" \
  -H 'content-type: application/json' \
  -d '{"session":"e2e-1","text":"hello"}' || true)
echo "invoke: $(echo "$RESP" | head -c 200)"
echo "$RESP" | grep -q '"type":"failed"\|"type":"completed"' || {
  echo "no terminal event in the /invoke stream"
  exit 1
}

step "assert: /data session state survives pod replacement (the PVC contract)"
BEFORE=$(kubectl -n "$NS" exec "deploy/$NS" -- sh -c 'find /data/sessions -name "*.jsonl" | sort')
echo "sessions before: $BEFORE"
[ -n "$BEFORE" ] || { echo "no session file was persisted under /data"; exit 1; }
kubectl -n "$NS" delete pod -l "app=$NS" --wait=false >/dev/null
kubectl -n "$NS" rollout status "deploy/$NS" --timeout=120s
AFTER=$(kubectl -n "$NS" exec "deploy/$NS" -- sh -c 'find /data/sessions -name "*.jsonl" | sort')
echo "sessions after:  $AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "session state did not survive pod replacement"; exit 1; }
