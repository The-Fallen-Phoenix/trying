# Use official Node LTS
FROM node:20-bullseye-slim

# install required libs for Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango1.0-0 \
    libasound2 \
    libatspi2.0-0 \
    wget \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
# Puppeteer will download a Chromium binary during npm install; ensure PUPPETEER_SKIP_CHROMIUM_DOWNLOAD not set.

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
