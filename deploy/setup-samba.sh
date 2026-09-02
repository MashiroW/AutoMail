#!/usr/bin/env bash
#
# Expose l'inbox d'AutoMail en partage réseau (Samba, invité, sans mot de passe).
# Le scanner (profil « scan vers dossier réseau ») écrit dedans, le worker traite.
#
# Le partage pointe TOUJOURS sur  <ce-dossier>/data/inbox  — exactement le dossier
# surveillé par le worker. Le script est idempotent : re-le lancer réécrit le bloc
# avec les bons paramètres (utile après un déménagement du projet).
#
# Usage :   sudo bash deploy/setup-samba.sh [nom-du-partage]   (défaut : "scans")
#
set -euo pipefail

CLONE="$(cd "$(dirname "$0")/.." && pwd)"
SHARE="${1:-scans}"
INBOX="$CLONE/data/inbox"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER")"
SMB_CONF=/etc/samba/smb.conf

[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }

command -v smbd >/dev/null || apt-get install -y --no-install-recommends samba

mkdir -p "$INBOX"
chown -R "$RUN_USER:$RUN_GROUP" "$CLONE/data"

cp "$SMB_CONF" "$SMB_CONF.bak.$(date +%s)"

# retire un éventuel bloc [SHARE] existant, puis ré-ajoute le bon
awk -v hdr="[$SHARE]" '
  { line=$0; t=$0; gsub(/^[ \t]+|[ \t]+$/,"",t) }
  t == hdr        { skip=1; next }
  skip && /^[ \t]*\[.*\]/ { skip=0 }
  !skip           { print line }
' "$SMB_CONF" > "$SMB_CONF.tmp"

cat >> "$SMB_CONF.tmp" <<EOF

[$SHARE]
   comment = Depot des courriers a numeriser (AutoMail)
   path = $INBOX
   browseable = yes
   read only = no
   guest ok = yes
   force user = $RUN_USER
   force group = $RUN_GROUP
   create mask = 0664
   directory mask = 0775
EOF

mv "$SMB_CONF.tmp" "$SMB_CONF"

testparm -s >/dev/null
systemctl enable --now smbd
systemctl restart smbd

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

Partage réseau prêt :
   \\\\${IP:-<ip-du-pi>}\\$SHARE   ->   $INBOX

C'est le dossier surveillé par le worker. Règle la destination « scan vers
dossier » de ton scanner sur ce chemin réseau — chaque PDF déposé sera OCRisé
puis indexé automatiquement.
EOF
