FROM node:lts-buster

# Build tools + ffmpeg needed by native modules (sharp, isolated-vm, wa-sticker-formatter, etc.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        libvips \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install && npm install -g qrcode-terminal pm2
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
