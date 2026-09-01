#!/usr/bin/env bash
# Installe la banque de courriers OCR sur une Raspberry Pi (Raspberry Pi OS / Debian 12).
# À lancer depuis la racine du dépôt :  sudo deploy/install.sh
set -euo pipefail

APP_DIR=/opt/courriers-ocr
DATA_DIR=/var/lib/courriers-ocr
ETC_DIR=/etc/courriers-ocr
SVC_USER=courriers
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Ce script doit être lancé avec sudo." >&2
  exit 1
fi

echo "==> Paquets système"
apt-get update
apt-get install -y --no-install-recommends \
  ocrmypdf \
  tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ara \
  poppler-utils \
  python3 python3-venv python3-pip \
  rsync

echo "==> Utilisateur système '$SVC_USER'"
id -u "$SVC_USER" &>/dev/null || \
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"

echo "==> Arborescence des données ($DATA_DIR)"
mkdir -p "$DATA_DIR"/{inbox,originals/duplicates,ocr,thumbnails,text,failed,trash,tmp,data}
chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR"

echo "==> Code applicatif ($APP_DIR)"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude .git --exclude .venv --exclude data --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  "$SRC"/ "$APP_DIR"/
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"

echo "==> Environnement Python"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR/.venv"

echo "==> Configuration ($ETC_DIR)"
mkdir -p "$ETC_DIR"
if [[ ! -f "$ETC_DIR/courriers-ocr.env" ]]; then
  cp "$SRC/deploy/courriers-ocr.env.example" "$ETC_DIR/courriers-ocr.env"
  echo "   -> $ETC_DIR/courriers-ocr.env créé (éditez-le si besoin)"
fi
if [[ ! -f "$ETC_DIR/config.toml" ]]; then
  cp "$SRC/config.example.toml" "$ETC_DIR/config.toml"
  sed -i 's#^data_dir = .*#data_dir = "/var/lib/courriers-ocr"#' "$ETC_DIR/config.toml"
fi

echo "==> Services systemd"
cp "$SRC/deploy/courriers-ocr-worker.service" /etc/systemd/system/
cp "$SRC/deploy/courriers-ocr-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now courriers-ocr-worker.service courriers-ocr-web.service

PORT="$(grep -E '^COURRIERS_PORT=' "$ETC_DIR/courriers-ocr.env" | cut -d= -f2 || echo 8080)"
echo
echo "Terminé."
echo "  Interface :   http://$(hostname).local:${PORT:-8080}/"
echo "  Dépôt scans : $DATA_DIR/inbox"
echo "  Journaux :    journalctl -u courriers-ocr-worker -f"
