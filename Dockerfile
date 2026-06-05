FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app /data
USER appuser

EXPOSE 10000

CMD ["sh", "-c", "gunicorn --worker-class gthread --workers 1 --threads 4 --bind 0.0.0.0:${PORT:-10000} --timeout 120 --keep-alive 75 app:app"]
