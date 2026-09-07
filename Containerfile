# Two stages: build the console and compile the server, then ship only what
# runs. The result is a small image with no build tools in it, running as an
# unprivileged user.
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The server has no runtime dependencies at all — it is plain node:http — so
# there is nothing to install here. Only the compiled output is copied in.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY package.json ./
# The server's own package.json comes too, for its "type": "module". Without
# it node finds only the root package.json, does not see the field, and
# reparses every file after guessing wrong.
COPY server/package.json server/package.json

ENV PERCH_CLIENT_DIST=/app/client/dist \
    PERCH_STATE_DIR=/var/lib/perch \
    PERCH_CONSOLE_PORT=8099 \
    PERCH_PROXY_PORT=11434

# uid 1000 matches the node user, and install.sh gives the state directory on
# the host to the same id so the two can share it.
USER node
EXPOSE 8099 11434
# No HEALTHCHECK here: podman builds OCI images by default, which have no
# field for one, and it would be silently dropped. It lives in compose.yml
# instead, where it is actually run.
CMD ["node", "server/dist/index.js"]
