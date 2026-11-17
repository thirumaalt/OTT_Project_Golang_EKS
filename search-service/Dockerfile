FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/opt/models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedding model into the image (~130MB) so pods never need internet at runtime.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"

COPY main.py .

RUN useradd --create-home --uid 1000 appuser && chmod -R a+rX /opt/models
USER appuser

EXPOSE 8095
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8095"]
