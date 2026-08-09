# ============================================================
#  LEGEND-AMMAR — hardened build for Railway / any Docker host
#  Fixes: native C++ modules (sharp, isolated-vm, canvas etc.),
#         python3-less node-gyp, missing ffmpeg, broken deps
# ============================================================
FROM node:20-bookworm-slim AS builder

# All system libraries needed by native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        python3 \
        python3-pip \
        pkg-config \
        libvips-dev \
        libvips-tools \
        libjpeg-dev \
        libpng-dev \
        libgif-dev \
        libwebp-dev \
        libtiff-dev \
        libcairo2-dev \
        libpango1.0-dev \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# python link needed by node-gyp
RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Pin sharp to a version with prebuilds available on this platform
RUN npm init -y >/dev/null && npm install sharp@0.32.6

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts=false 2>&1 | tail -5 || true

# Copy app & run install once more so isolated-vm + others build fully
COPY . .
RUN npm install --omit=dev 2>&1 | tail -5; \
    npm rebuild 2>&1 | tail -3 || true

# Drop dev scripts; keep only what runtime needs
RUN npm prune --omit=dev

# ---------------- runtime ----------------
FROM node:20-bookworm-slim

# Minimal runtime libs (libvips already bundled via prebuilds, keep ffmpeg)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app .
# Ensure pm2 is present at runtime (start script depends on it)
RUN npm ls pm2 >/dev/null 2>&1 || npm install --omit=dev pm2
EXPOSE 3000
CMD ["npm", "start"]
