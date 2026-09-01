#!/usr/bin/env bash
#
# Installation SANS Docker, pour Raspberry Pi OS Buster (Debian 10, EOL) ou tout
# système dont le Python est trop ancien (< 3.10).
#
#   - ocrmypdf / tesseract / poppler : paquets de l'hôte via apt (bascule les
#     dépôts sur archive.debian.org d'abord si besoin — voir README).
#   - Python 3.11 : binaire portable (python-build-standalone) si disponible pour
#     l'architecture, sinon compilé depuis les sources (~20 min sur un Pi 4).
#   - 2 services systemd : courriers-ocr-worker + courriers-ocr-web.
#
# Usage :   sudo bash deploy/install-buster.sh
#
set -euo pipefail

APP_DIR=/opt/courriers-ocr
DATA_DIR=/var/lib/courriers-ocr
ETC_DIR=/etc/courriers-ocr
SVC_USER=courriers
PY_FALLBACK_VERSION=3.11.9
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$APP_DIR/python/bin/python3"

[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }

log() { printf '\n==> %s\n' "$*"; }
trap 'echo; echo "!! Échec. Si pip cale sur pydantic-core faute de roue ARM :"; \
      echo "   installez Rust  (curl https://sh.rustup.rs -sSf | sh -s -- -y)"; \
      echo "   puis relancez ce script."' ERR

# --------------------------------------------------------------------------- #
log "Paquets système (OCR + outils PDF)"
apt-get update
apt-get install -y --no-install-recommends \
  ocrmypdf \
  tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ara \
  poppler-utils \
  ca-certificates curl rsync xz-utils

# --------------------------------------------------------------------------- #
log "Python 3.11"
if [[ -x "$PYTHON" ]] && "$PYTHON" -c 'import sys;exit(0 if sys.version_info[:2]==(3,11) else 1)' 2>/dev/null; then
  echo "Déjà présent : $("$PYTHON" -V)"
else
  mkdir -p "$APP_DIR"
  case "$(uname -m)" in
    armv7l|armv6l) TRIPLE=armv7-unknown-linux-gnueabihf ;;
    aarch64)       TRIPLE=aarch64-unknown-linux-gnu ;;
    x86_64)        TRIPLE=x86_64-unknown-linux-gnu ;;
    *)             TRIPLE="" ;;
  esac

  URL=""
  if [[ -n "$TRIPLE" ]]; then
    echo "Recherche d'un binaire portable ($TRIPLE)…"
    URL=$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
      | grep -oE "https://[^\"]*cpython-3\.11\.[0-9]+\+[0-9]+-${TRIPLE}-install_only(_stripped)?\.tar\.gz" \
      | head -n1 || true)
  fi

  if [[ -n "$URL" ]]; then
    echo "Téléchargement : $URL"
    curl -fSL "$URL" -o /tmp/py-portable.tgz
    rm -rf "$APP_DIR/python"
    tar -xzf /tmp/py-portable.tgz -C "$APP_DIR"      # -> $APP_DIR/python
    rm -f /tmp/py-portable.tgz
  else
    echo "Pas de binaire portable pour cette architecture -> compilation."
    apt-get install -y --no-install-recommends \
      build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
      libsqlite3-dev libffi-dev liblzma-dev libncursesw5-dev uuid-dev tk-dev
    curl -fSL "https://www.python.org/ftp/python/${PY_FALLBACK_VERSION}/Python-${PY_FALLBACK_VERSION}.tgz" \
      -o /tmp/python-src.tgz
    rm -rf /tmp/python-src && mkdir -p /tmp/python-src
    tar -xzf /tmp/python-src.tgz -C /tmp/python-src --strip-components=1
    ( cd /tmp/python-src \
      && ./configure --prefix="$APP_DIR/python" --with-ensurepip=install \
      && make -j"$(nproc)" \
      && make install )
    rm -rf /tmp/python-src /tmp/python-src.tgz
  fi
  echo "Installé : $("$PYTHON" -V)"
fi

# --------------------------------------------------------------------------- #
log "Utilisateur système et arborescence des données"
id -u "$SVC_USER" &>/dev/null || \
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA_DIR"/{inbox,originals/duplicates,ocr,thumbnails,text,failed,trash,tmp,data}
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"

# --------------------------------------------------------------------------- #
log "Code applicatif -> $APP_DIR"
if [[ "$SRC" != "$APP_DIR" ]]; then
  rsync -a --delete \
    --exclude .git --exclude .venv --exclude python --exclude data \
    --exclude demo --exclude __pycache__ --exclude '.pytest_cache' \
    "$SRC"/ "$APP_DIR"/
fi

# --------------------------------------------------------------------------- #
log "Environnement Python (venv + dépendances)"
"$PYTHON" -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# --------------------------------------------------------------------------- #
log "Configuration"
mkdir -p "$ETC_DIR"
[[ -f "$ETC_DIR/courriers-ocr.env" ]] || \
  cp "$SRC/deploy/courriers-ocr.env.example" "$ETC_DIR/courriers-ocr.env"
if [[ ! -f "$ETC_DIR/config.toml" ]]; then
  cp "$SRC/config.example.toml" "$ETC_DIR/config.toml"
  sed -i 's#^data_dir = .*#data_dir = "/var/lib/courriers-ocr"#' "$ETC_DIR/config.toml"
fi

# --------------------------------------------------------------------------- #
log "Services systemd"
cp "$SRC/deploy/courriers-ocr-worker.service" /etc/systemd/system/
cp "$SRC/deploy/courriers-ocr-web.service"    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now courriers-ocr-worker.service courriers-ocr-web.service

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PORT=$(grep -E '^COURRIERS_PORT=' "$ETC_DIR/courriers-ocr.env" | cut -d= -f2 || true)
trap - ERR
cat <<EOF

Terminé.
  Interface :    http://${IP:-<ip-du-pi>}:${PORT:-8080}/
  Dépôt scans :  $DATA_DIR/inbox
  Logs :         journalctl -u courriers-ocr-worker -f  (et ...-web)
  État :         systemctl status courriers-ocr-worker courriers-ocr-web
EOF
