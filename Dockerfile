# Chhaperia ERP — container image
# Works on any container host: Fly.io, Railway, Koyeb, Render (Docker), etc.
# The database is MySQL 8.4, reached over the network — configure it with the
# CHHAPERIA_DB_* environment variables (see database/MIGRATION.md). Nothing
# here needs a compiler toolchain: mysql2 is pure JavaScript.
FROM node:20-bookworm-slim

WORKDIR /app

# Install backend deps first for better layer caching.
COPY backend/package*.json ./backend/
RUN npm install --prefix backend --omit=dev

# App source: backend (API), frontend (served static), database (schema.sql).
COPY . .

# /data holds the BarTender hand-off CSVs (and any future file artefacts) —
# the database itself lives in MySQL, not on this volume.
ENV CHHAPERIA_DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=4000
EXPOSE 4000

CMD ["node", "backend/src/server.js"]
