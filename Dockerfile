# Chhaperia ERP — container image
# Works on any container host: Fly.io, Railway, Koyeb, Render (Docker), etc.
# better-sqlite3 ships prebuilt binaries for Node 20 on linux/glibc, so the
# slim image needs no compiler toolchain. (If a host forces a native build,
# switch the base image to node:20-bookworm — it includes build-essential.)
FROM node:20-bookworm-slim

WORKDIR /app

# Install backend deps first for better layer caching.
COPY backend/package*.json ./backend/
RUN npm install --prefix backend --omit=dev

# App source: backend (API), frontend (served static), database (schema.sql).
COPY . .

# Keep the SQLite DB on a mounted volume so it survives restarts/redeploys.
ENV CHHAPERIA_DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=4000
EXPOSE 4000

CMD ["node", "backend/src/server.js"]
