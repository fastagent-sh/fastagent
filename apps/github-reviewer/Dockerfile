# github-reviewer — a fastagent webhook agent. Long-running container (fly.io / any OCI host).
FROM node:22-slim

# git + gh: the reviewer shells out to `gh` (via pi's bash tool) to read the PR diff and post the
# review. gh reads GH_TOKEN from the env, so no `gh auth login` is needed in the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. @kid7st/fastagent is on GitHub Packages, so npm ci needs a
# token at build time (BuildKit secret, never baked into a layer):
#   fly deploy --build-secret GITHUB_TOKEN=$(gh auth token)
COPY package.json package-lock.json* .npmrc ./
RUN --mount=type=secret,id=GITHUB_TOKEN \
    GITHUB_TOKEN="$(cat /run/secrets/GITHUB_TOKEN)" npm ci

# Compile the self-contained artifact (.fastagent/build). Pure registry validation, no secrets.
COPY . .
RUN npx fastagent build

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.ts"]
