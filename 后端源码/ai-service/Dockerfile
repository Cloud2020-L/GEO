FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AI_SERVICE_PORT=8010 \
    WEB_CONCURRENCY=2 \
    GUNICORN_TIMEOUT=180

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8010

CMD ["sh", "-c", "gunicorn app:app --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:${AI_SERVICE_PORT:-8010} --workers ${WEB_CONCURRENCY:-2} --timeout ${GUNICORN_TIMEOUT:-180} --access-logfile - --error-logfile - --forwarded-allow-ips='*'"]
