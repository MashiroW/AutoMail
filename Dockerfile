# Image unique servant à la fois au worker d'ingestion et au service web.
# Basée sur Debian Bookworm : indépendante de la version de l'OS du Raspberry Pi
# (utile si l'hôte tourne encore sous Buster / Bullseye).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    COURRIERS_DATA_DIR=/data \
    TMPDIR=/tmp

# OCR + outils PDF. ocrmypdf tire tesseract, ghostscript, qpdf, unpaper, pngquant.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ocrmypdf \
        tesseract-ocr-fra \
        tesseract-ocr-deu \
        tesseract-ocr-ara \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY courriers_ocr/ ./courriers_ocr/
COPY web/ ./web/

# /data est un volume monté depuis l'hôte (inbox, originaux, ocr, base…).
VOLUME ["/data"]
EXPOSE 8080

# Commande par défaut = service web ; le worker surcharge via docker-compose.
CMD ["uvicorn", "courriers_ocr.app:app", "--host", "0.0.0.0", "--port", "8080"]
