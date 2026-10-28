# Dockerfile
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

# System dependencies for OpenCV + FFmpeg RTSP decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    curl \
    libgl1 \
    libglib2.0-0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# RTSP over TCP with generous timeouts; keep BLAS single-threaded so several
# camera workers do not oversubscribe the CPU.
ENV OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp|timeout;10000000|stimeout;10000000|max_delay;500000" \
    OPENCV_FFMPEG_THREAD_COUNT=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    YOLO_CONFIG_DIR=/app/.ultralytics

RUN python -m pip install --upgrade pip

# CUDA torch by default, for MODEL_DEVICE=cuda on the host GPU. Build with
# --build-arg TORCH_VARIANT=cpu for a CPU-only image (~2 GB instead of ~7 GB).
ARG TORCH_VARIANT=cu128
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/${TORCH_VARIANT} torch torchvision

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Runs as an unprivileged "app" user (uid 1000, the usual host owner of the
# bind-mounted models/, logs/ and data/). The entrypoint starts as root only
# to hand those mounts to that user, then drops privileges for good.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/models /app/logs /app/data /app/.ultralytics \
    && chown -R app:app /app/models /app/logs /app/data /app/.ultralytics \
    && chmod +x /app/docker-entrypoint.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
# One worker process: camera workers are in-process tasks (see docker-compose.yml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "300"]
