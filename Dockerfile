# ---------- Base ----------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm install

# ---------- Build ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ---------- Runtime ----------
FROM python:3.11-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Install Node.js
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg libgomp1 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

COPY scripts/ ./scripts/
COPY models/ ./models

EXPOSE 3001

CMD ["npm", "start"]
