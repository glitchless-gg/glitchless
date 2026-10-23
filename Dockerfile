# The Glitchless server in one image: intake, the query API, findings, alerts and the dashboard, with a file store
# under /data. The server itself has no npm dependencies; the build stage only builds the browser SDK and the dashboard.
#
#   docker run -d -p 7777:7777 -v glitchless-data:/data ghcr.io/glitchless-gg/glitchless
#
# Settings are environment variables (.env.example lists them). On a server others can reach, set
# GLITCHLESS_API_KEY so reads need a key, and GLITCHLESS_CLIENT_TOKENS to your own write token.

FROM node:22-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund -w glitchless -w glitchless-dashboard \
 && npm run build -w glitchless \
 && npm run build -w glitchless-dashboard

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=7777 GLITCHLESS_DATA_DIR=/data
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/src server/src
COPY --from=build /src/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /src/packages/sdk/src/sketch.js packages/sdk/src/sketch.js
COPY --from=build /src/packages/sdk/dist packages/sdk/dist
COPY --from=build /src/apps/dashboard/dist apps/dashboard/dist
COPY --from=build /src/assets/brand/glitchless/logo assets/brand/glitchless/logo
COPY LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/src/local.js"]
