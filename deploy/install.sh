#!/usr/bin/env bash
#
# Installe AutoMail « en place » : tout vit dans CE dossier cloné —
#   <clone>/.venv/        environnement Python
#   <clone>/.python/      Python 3.11 portable (seulement si l'OS est trop vieux)
#   <clone>/config.toml   configuration locale
#   <clone>/data/         inbox, originaux, ocr, base SQLite, vignettes…
#
# Seule chose posée ailleurs : 2 unités systemd dans /etc/systemd/system/,
# qui pointent simplement vers ce dossier.
#
# Usage :   sudo bash deploy/install.sh
#
set -euo pipefail

CLONE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER")"
PY_FALLBACK_VERSION=3.11.9

[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

# --------------------------------------------------------------------------- #
log "Anciens services / anciens emplacements (le cas échéant)"
for old in courriers-ocr-worker courriers-ocr-web; do
  systemctl disable --now "$old" 2>/dev/null || true
  rm -f "/etc/systemd/system/$old.service"
done
systemctl daemon-reload 2>/dev/null || true
# ancien code (aucune donnée dedans) : on peut le retirer sans risque
rm -rf /opt/courriers-ocr /etc/courriers-ocr
LEGACY_DATA=/var/lib/courriers-ocr
if [[ -d "$LEGACY_DATA" ]]; then
  echo "!! Ancien dossier de données encore présent : $LEGACY_DATA"
  echo "   (courriers d'un install précédent). À supprimer toi-même une fois"
  echo "   que tu as vérifié que la nouvelle install fonctionne :"
  echo "     sudo rm -rf $LEGACY_DATA"
fi

# --------------------------------------------------------------------------- #
log "Paquets système (OCR + outils PDF)"
apt-get update
apt-get install -y --no-install-recommends \
  ocrmypdf \
  tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ara \
  poppler-utils unpaper pngquant \
  ca-certificates curl rsync xz-utils

# --------------------------------------------------------------------------- #
log "Python (≥ 3.10)"
PYBIN=""
if command -v python3 >/dev/null && \
   python3 -c 'import sys;exit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then
  apt-get install -y --no-install-recommends python3-venv
  PYBIN="$(command -v python3)"
  echo "Python du système : $("$PYBIN" -V)"
elif [[ -x "$CLONE/.python/bin/python3" ]]; then
  PYBIN="$CLONE/.python/bin/python3"
  echo "Python portable déjà présent : $("$PYBIN" -V)"
else
  echo "Python du système trop ancien -> récupération d'un binaire portable 3.11."
  case "$(uname -m)" in
    armv7l|armv6l) TRIPLE=armv7-unknown-linux-gnueabihf ;;
    aarch64)       TRIPLE=aarch64-unknown-linux-gnu ;;
    x86_64)        TRIPLE=x86_64-unknown-linux-gnu ;;
    *)             TRIPLE="" ;;
  esac
  URL=""
  [[ -n "$TRIPLE" ]] && URL=$(curl -fsSL \
    https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
    | grep -oE "https://[^\"]*cpython-3\.11\.[0-9]+\+[0-9]+-${TRIPLE}-install_only(_stripped)?\.tar\.gz" \
    | head -n1 || true)

  if [[ -n "$URL" ]]; then
    echo "Téléchargement : $URL"
    curl -fSL "$URL" -o /tmp/py.tgz
    rm -rf "$CLONE/.python" && mkdir -p "$CLONE/.python"
    tar -xzf /tmp/py.tgz -C "$CLONE/.python" --strip-components=1
    rm -f /tmp/py.tgz
  else
    echo "Aucun binaire portable pour $(uname -m) -> compilation (~20 min)."
    apt-get install -y --no-install-recommends \
      build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
      libsqlite3-dev libffi-dev liblzma-dev libncursesw5-dev uuid-dev tk-dev
    curl -fSL "https://www.python.org/ftp/python/${PY_FALLBACK_VERSION}/Python-${PY_FALLBACK_VERSION}.tgz" -o /tmp/pysrc.tgz
    rm -rf /tmp/pysrc && mkdir -p /tmp/pysrc
    tar -xzf /tmp/pysrc.tgz -C /tmp/pysrc --strip-components=1
    ( cd /tmp/pysrc && ./configure --prefix="$CLONE/.python" --with-ensurepip=install \
      && make -j"$(nproc)" && make install )
    rm -rf /tmp/pysrc /tmp/pysrc.tgz
  fi
  PYBIN="$CLONE/.python/bin/python3"
  echo "Installé : $("$PYBIN" -V)"
fi

# --------------------------------------------------------------------------- #
log "Environnement Python (venv + dépendances)"
"$PYBIN" -m venv "$CLONE/.venv"
"$CLONE/.venv/bin/pip" install --upgrade pip
"$CLONE/.venv/bin/pip" install -r "$CLONE/requirements.txt"

# --------------------------------------------------------------------------- #
log "Configuration et dossiers de données"
if [[ ! -f "$CLONE/config.toml" ]]; then
  cp "$CLONE/config.example.toml" "$CLONE/config.toml"
fi
sed -i "s#^data_dir = .*#data_dir = \"$CLONE/data\"#" "$CLONE/config.toml"
mkdir -p "$CLONE"/data/{inbox,originals/duplicates,ocr,thumbnails,text,failed,trash,tmp}

chown -R "$RUN_USER:$RUN_GROUP" "$CLONE"

# --------------------------------------------------------------------------- #
log "Services systemd"
write_unit() {
  local name="$1" desc="$2" cmd="$3"
  cat > "/etc/systemd/system/$name.service" <<EOF
[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CLONE
ExecStart=$CLONE/.venv/bin/python -m $cmd
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
}
write_unit automail-worker "AutoMail — worker OCR (surveillance de l'inbox)" courriers_ocr.worker
write_unit automail-web    "AutoMail — interface web / API"                  courriers_ocr.serve

systemctl daemon-reload
systemctl enable --now automail-worker.service automail-web.service

# --------------------------------------------------------------------------- #
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(grep -E '^\s*port\s*=' "$CLONE/config.toml" | grep -oE '[0-9]+' | head -n1)"
cat <<EOF

Terminé — tout est dans : $CLONE
  Interface :    http://${IP:-<ip-du-pi>}:${PORT:-8080}/
  Dépôt scans :  $CLONE/data/inbox
  Config :       $CLONE/config.toml
  Logs :         journalctl -u automail-worker -f   (et automail-web)
  Mise à jour :  git pull && sudo systemctl restart automail-worker automail-web
  Partage réseau pour le scanner :  sudo bash deploy/setup-samba.sh
EOF
