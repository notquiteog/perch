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

# Inside a container, binding 127.0.0.1 binds the *container's* loopback, which
# nothing outside the container can reach — a published port would connect to
# the container's address and find nothing listening. So in the image both
# listeners bind all interfaces, and the restriction moves one layer out: the
# compose file publishes them as "127.0.0.1:8099:8099", so the host only ever
# offers them on its own loopback.
#
# That means the network boundary here is the port publish, not the bind
# address. Change the publish to 0.0.0.0 and you have published the console to
# your LAN — which is why perch says so at startup, and why the console still
# refuses to serve anything but its own machine without a password.
ENV PERCH_CLIENT_DIST=/app/client/dist \
    PERCH_STATE_DIR=/var/lib/perch \
    PERCH_CONSOLE_PORT=8099 \
    PERCH_CONSOLE_BIND=0.0.0.0 \
    PERCH_PROXY_PORT=11434 \
    PERCH_PROXY_BIND=0.0.0.0

# uid 1000 matches the node user, and install.sh gives the state directory on
# the host to the same id so the two can share it.
USER node
EXPOSE 8099 11434
# No HEALTHCHECK here: podman builds OCI images by default, which have no
# field for one, and it would be silently dropped. It lives in compose.yml
# instead, where it is actually run.
CMD ["node", "server/dist/index.js"]
