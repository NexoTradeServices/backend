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

# prisma/ and prisma.config.ts before src, and generate before build. src/generated
# is gitignored (Prisma's client is build output, not source), so a clone of this
# repo has no client and `npm run build` would die on
# "Cannot find module '../generated/prisma/client.js'". Fly builds the image
# remotely from the committed Dockerfile (setup/03), so it only ever sees the
# clone -- never the generated client sitting on .40. Review finding R1.2.
#
# generate needs no database: it reads prisma/schema.prisma and nothing else, so
# no build secret is required here.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- run ----
FROM node:22-slim AS run

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# dist alone is enough at runtime. The generated client is plain TypeScript with
# no engine binary or wasm beside it, so tsc compiles it into dist/generated and
# it travels with the rest of the build. Nothing in the run stage shells out to
# the Prisma CLI either: fly.toml has no release_command, so migrations are run
# by hand from a machine that has DIRECT_URL. That is why prisma/ is not copied
# here.
COPY --from=build /app/dist ./dist

# Matches internal_port in fly.toml and the PORT the app reads.
EXPOSE 8080

# node directly, not npm: signals from Fly reach the process instead of stopping
# at a shell wrapper, so the machine shuts down cleanly on deploy.
CMD ["node", "dist/index.js"]
