FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ─── Go builder ────────────────────────────────────────────────────
FROM golang:1.22-alpine AS go-builder

WORKDIR /build
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o yt-player .

# ─── Production image ──────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache python3 py3-pip ffmpeg deno ca-certificates && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app

# Save build version
RUN date +%s > /app/version.txt

# Go binary (static, no runtime needed)
COPY --from=go-builder /build/yt-player ./

# Frontend
COPY --from=frontend-builder /frontend/dist ./frontend/dist
COPY public/sw.js ./frontend/dist/sw.js
COPY public/manifest.json ./frontend/dist/manifest.json

EXPOSE 3000

CMD ["./yt-player"]
