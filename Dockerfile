FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.14.7-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    SPHEREX_CACHE_DIR=/var/data/cache SPHEREX_STATIC_DIR=/var/data/static \
    XDG_CACHE_HOME=/var/data/astro-cache HOME=/var/data \
    SPHEREX_PUBLIC_LIMITS=1 SPHEREX_FETCH_WORKERS=2 SPHEREX_MAX_COMPARISONS=1 \
    SPHEREX_SOURCE_CACHE_BYTES=2147483648 SPHEREX_RESULT_CACHE_BYTES=1073741824 \
    SPHEREX_RESULT_TTL_SECONDS=3600 SPHEREX_WORK_BYTES=8589934592 \
    SPHEREX_MIN_FREE_GB=3 SPHEREX_CORS_ORIGINS="" \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
WORKDIR /app
COPY backend/requirements-render.txt ./backend/requirements-render.txt
RUN pip install --no-cache-dir -r backend/requirements-render.txt
COPY backend/app/ ./backend/app/
COPY --from=frontend /build/frontend/dist/ ./frontend/dist/
COPY deploy/start.py ./deploy/start.py
EXPOSE 10000
CMD ["python", "deploy/start.py"]
