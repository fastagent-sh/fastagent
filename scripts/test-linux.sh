#!/bin/sh
# Both test tiers on Linux, which CI runs on: a test that passes on macOS can still take a Linux-only path (flock, dpkg).
# The checkout is copied into the container without node_modules, whose native packages are this machine's, and the
# tests run as a user that is not root, as on CI, where a file mode is a permission. `--init` reaps what a test's
# detached processes leave, as a CI runner's init does: without it a stopped ticket's process stays a zombie and reads
# as running.
set -eu
exec docker run --rm --init -v "$(pwd)":/src:ro node:24.15.0-bookworm-slim sh -euc '
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  mkdir /work && cd /src && tar --exclude=./node_modules --exclude=./dist --exclude=./.git -cf - . | tar -xf - -C /work
  chown -R node:node /work
  exec runuser -u node -- sh -euc "cd /work && npm ci --no-audit --no-fund && npm test && npm run test:integration"
'
