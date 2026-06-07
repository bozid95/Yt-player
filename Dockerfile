FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ─── Production image ────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg deno && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app

# Save build version
RUN date +%s > /app/version.txt

# Backend
COPY package.json ./
RUN npm install
COPY server.js ./

# Frontend built
COPY --from=frontend-builder /frontend/dist ./frontend/dist
COPY public/sw.js ./frontend/dist/sw.js
COPY public/manifest.json ./frontend/dist/manifest.json

EXPOSE 3000

CMD ["node", "server.js"]
