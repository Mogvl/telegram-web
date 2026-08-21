# syntax=docker/dockerfile:1

# ---------- build stage ----------
# NOTE: node:24 (glibc), NOT alpine: TypeScript 7 Native (@typescript/native)
# only ships glibc prebuilt binaries and crashes on musl.
FROM node:24 AS build

WORKDIR /app

# enable pnpm (version pinned via packageManager in package.json)
RUN corepack enable

# install dependencies first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# copy the rest of the source
COPY . .

# optional branding overrides (also settable in CI / compose build args)
ARG TWEB_TITLE
ARG TWEB_URL
ARG TWEB_ORIGIN
ENV TWEB_TITLE=$TWEB_TITLE TWEB_URL=$TWEB_URL TWEB_ORIGIN=$TWEB_ORIGIN

# production build: typecheck + changelog + vite build + bundle check
RUN pnpm run build \
    && node scripts/merge-public-to-dist.mjs \
    && node scripts/check-dist-assets.mjs

# ---------- runtime stage ----------
# Source maps (~33MB) stay in the CI artifact for debugging but are not
# shipped in the image.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN find /usr/share/nginx/html -name '*.map' -delete

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
