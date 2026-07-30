# ---------- Base ----------
FROM node:22-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm install

# ---------- Build ----------
FROM node:22-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Capture commit info while .git is available; file is copied to runtime image
# so prestart can print it without needing git in the container.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && printf "Git commit: %s - %s\n" \
         "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
         "$(git log -1 --pretty=%s 2>/dev/null || echo unknown)" \
       > .git-commit-info \
    && rm -rf /var/lib/apt/lists/*

RUN npm run build

# ---------- Runtime ----------
FROM python:3.11-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Node.js 22 binaries copied from the node:22-slim build stage (both are
# glibc/Debian-based, so this is binary-compatible). NodeSource's setup_22.x
# script now returns HTTP 403 for this base image, and yahoo-finance2
# requires Node >=22, so installing Debian's own nodejs/npm (v20) is not an
# option either.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY --from=builder /app/.git-commit-info ./.git-commit-info
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

COPY scripts/ ./scripts/
COPY models/ ./models

EXPOSE 3001

CMD ["npm", "start"]
