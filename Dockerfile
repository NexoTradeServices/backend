# Two stages on purpose: the first has the TypeScript compiler and every dev
# dependency, the second has neither. Only compiled JavaScript and production
# packages reach the machine that runs in Sydney.

# ---- build ----
FROM node:22-slim AS build

WORKDIR /app

# Copy the manifests alone first. Docker caches this layer, so a code-only
# change does not reinstall every package.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:22-slim AS run

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Matches internal_port in fly.toml and the PORT the app reads.
EXPOSE 8080

# node directly, not npm: signals from Fly reach the process instead of stopping
# at a shell wrapper, so the machine shuts down cleanly on deploy.
CMD ["node", "dist/index.js"]
