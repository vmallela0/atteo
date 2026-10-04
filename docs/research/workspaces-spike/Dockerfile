# The board's workspace image: Node + git, plus the sandbox-shim that Files and DirectoryBackup run.
FROM docker.io/cloudflare/sandbox:1.0.0 AS sandbox-tools

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
