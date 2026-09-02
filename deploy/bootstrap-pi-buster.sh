#!/usr/bin/env bash
#
# Déploiement complet en une commande, pour Raspberry Pi OS Buster (Debian 10,
# EOL) : répare l'apt (archive.debian.org), installe AutoMail en place, puis
# monte le partage réseau pour le scanner.
#
#   git clone <repo> automail && cd automail
#   sudo bash deploy/bootstrap-pi-buster.sh [nom-du-partage]
#
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

# --- 1. Dépôts apt : Buster est passé sur l'archive et n'est plus signé -------
if ! grep -rqs archive.debian.org /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null; then
  echo "==> Bascule des dépôts Debian sur archive.debian.org"
  tee /etc/apt/sources.list.d/debian-archive.list >/dev/null <<'EOF'
deb [trusted=yes] http://archive.debian.org/debian buster main contrib non-free
deb [trusted=yes] http://archive.debian.org/debian-security buster/updates main contrib non-free
EOF
  sed -i 's/^\s*deb /#deb /' /etc/apt/sources.list
  echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99no-check-valid-until
fi

# --- 2. Application ----------------------------------------------------------
bash "$HERE/install.sh"

# --- 3. Partage réseau pour le scanner -------------------------------------
bash "$HERE/setup-samba.sh" "${1:-scans}"

echo
echo "Bootstrap terminé."
