#!/usr/bin/env bash
#
# Expose l'inbox d'AutoMail en partage réseau (Samba, invité, sans mot de passe).
# Le scanner (profil « scan vers dossier réseau ») écrit dedans, le worker traite.
#
# Usage :   sudo bash deploy/setup-samba.sh [nom-du-partage]
#           (nom par défaut : "scans")
#
set -euo pipefail

CLONE="$(cd "$(dirname "$0")/.." && pwd)"
SHARE="${1:-scans}"
INBOX="$CLONE/data/inbox"
RUN_USER="${SUDO_USER:-$(id -un)}"
SMB_CONF=/etc/samba/smb.conf

[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }

command -v smbd >/dev/null || apt-get install -y --no-install-recommends samba

mkdir -p "$INBOX"
chown -R "$RUN_USER:$(id -gn "$RUN_USER")" "$CLONE/data"

if grep -q "^\[$SHARE\]" "$SMB_CONF"; then
  echo "Le partage [$SHARE] existe déjà dans $SMB_CONF."
  echo "Vérifie à la main :  path = $INBOX  et  force user = $RUN_USER"
else
  cp "$SMB_CONF" "$SMB_CONF.bak.$(date +%s)"
  cat >> "$SMB_CONF" <<EOF

[$SHARE]
   comment = Depot des courriers a numeriser (AutoMail)
   path = $INBOX
   browseable = yes
   read only = no
   guest ok = yes
   force user = $RUN_USER
   force group = $(id -gn "$RUN_USER")
   create mask = 0664
   directory mask = 0775
EOF
  echo "Partage [$SHARE] ajouté à $SMB_CONF."
fi

testparm -s >/dev/null
systemctl enable --now smbd
systemctl restart smbd

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

Partage prêt :
   \\\\${IP:-<ip-du-pi>}\\$SHARE   ->   $INBOX

Dans le logiciel du scanner, règle la destination « scan vers dossier » sur ce
chemin réseau. Chaque PDF déposé sera OCRisé puis indexé automatiquement.
EOF
