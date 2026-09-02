# Image unique servant à la fois au worker d'ingestion et au service web.
# Basée sur Debian Bookworm : indépendante de la version de l'OS du Raspberry Pi
# (utile si l'hôte tourne encore sous Buster / Bullseye).
#
# Python 3.11 (et non 3.12) pour coller aux roues précompilées de piwheels,
# indispensables sur Raspberry Pi 32 bits (pydantic-core, uvloop… sont en Rust/C).
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_EXTRA_INDEX_URL=https://www.piwheels.org/simple \
    COURRIERS_DATA_DIR=/data \
    TMPDIR=/tmp

# Sur certaines box (MTU réduit, IPv6 partielle), apt se fige dans le conteneur :
# on force l'IPv4, on ajoute des retries et des timeouts courts.
RUN printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
        > /etc/apt/apt.conf.d/99network

# OCR + outils PDF. unpaper est requis par --clean, pngquant par --optimize.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ocrmypdf \
        tesseract-ocr-fra \
        tesseract-ocr-deu \
        tesseract-ocr-ara \
        poppler-utils \
        unpaper \
        pngquant \
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
