# Banque de courriers OCR

Petit service auto-hébergé pour Raspberry Pi qui reproduit l'expérience ScanSnap
Home, en plus léger et sans PC allumé en permanence :

1. il **surveille un dossier** (`inbox/`) où le scanner dépose des PDF ;
2. à chaque nouveau courrier, il lance un **OCR** (`ocrmypdf` + Tesseract) qui
   produit un **PDF cherchable** (texte sélectionnable / surlignable) et extrait
   tout le texte ;
3. il **détecte automatiquement la date du courrier** (celle imprimée en haut) ;
4. il **indexe** le texte pour la recherche plein-texte + tags / correspondant ;
5. il expose sur le réseau local une **API REST + une page web** pour chercher
   (mots-clés, plage de dates, correspondant, tag) et **télécharger l'original**.

Stack volontairement minimale : Python + FastAPI + SQLite (FTS5). Deux services
systemd (`worker` d'ingestion, `web` pour l'interface).

---

## Matériel conseillé

- Raspberry Pi 4 ou 5, 2 Go de RAM minimum.
- Stockage : une carte SD suffit pour démarrer, un SSD USB est recommandé pour
  l'archive (les PDF s'accumulent) et la longévité.
- Ordre de grandeur OCR sur Pi 4 : ~10 à 40 s par page selon la qualité du scan.

Trois méthodes d'installation :

- **`install-buster.sh`** (juste ci-dessous) — pour un Pi sur un OS **ancien**
  (Raspberry Pi OS Buster / Bullseye, Python < 3.10). Installe la pile OCR via
  l'apt de l'hôte + un Python 3.11 portable. **Pas de Docker.** C'est le chemin
  conseillé sur un Pi qui ne peut pas être remis à niveau.
- **systemd** (`install.sh`, plus bas) — installation « bare-metal » sur Debian 12
  (Bookworm) ou plus récent (Python 3.11 déjà fourni par le système).
- **Docker** (plus bas) — utile si un moteur Docker fonctionnel est déjà en
  place. À éviter sur Buster : le réseau interne de Docker y est souvent cassé.

Le dépôt est privé : `git clone` demande tes identifiants GitHub, ou ajoute une
**clé de déploiement** (`cat ~/.ssh/id_ed25519.pub` → GitHub → repo → Settings →
Deploy keys), ou télécharge simplement le ZIP depuis l'interface web de GitHub.

---

## Installation sur OS ancien (Buster / Bullseye) — sans Docker

Prérequis : l'`apt` du Pi doit pouvoir installer des paquets. Sur Buster (EOL),
basculer d'abord les dépôts Debian sur l'archive :

```bash
sudo tee /etc/apt/sources.list.d/debian-archive.list >/dev/null <<'EOF'
deb [trusted=yes] http://archive.debian.org/debian buster main contrib non-free
deb [trusted=yes] http://archive.debian.org/debian-security buster/updates main contrib non-free
EOF
sudo sed -i 's/^\s*deb /#deb /' /etc/apt/sources.list
echo 'Acquire::Check-Valid-Until "false";' | sudo tee /etc/apt/apt.conf.d/99no-check-valid-until
sudo apt-get update
```

Puis, depuis le dossier du projet :

```bash
sudo bash deploy/install-buster.sh
```

Le script : installe `ocrmypdf` + Tesseract (fra/deu/ara) + poppler via l'apt de
l'hôte ; récupère un **Python 3.11 portable** (binaire, sans compilation — ou le
compile si aucun binaire n'existe pour l'architecture) ; crée un venv et installe
les dépendances ; pose et démarre les 2 services systemd.

Interface : `http://<ip-du-pi>:8080/` — dépôt des scans : `/var/lib/courriers-ocr/inbox/`

```bash
systemctl status courriers-ocr-worker courriers-ocr-web
journalctl -u courriers-ocr-worker -f
```

---

## Installation avec Docker

### 1. Installer Docker sur le Pi (si absent)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker   # ou se déconnecter / reconnecter
```

### 2. Récupérer le projet et démarrer

```bash
git clone https://github.com/MashiroW/AutoMail.git courriers-ocr && cd courriers-ocr
mkdir -p data/inbox
docker compose up -d --build
```

La construction de l'image prend quelques minutes sur un Pi (compilation +
téléchargement des paquets Tesseract). Ensuite, deux conteneurs tournent :
`courriers-ocr-worker-1` (ingestion) et `courriers-ocr-web-1` (interface).

Interface : `http://<ip-du-pi>:8080/`

### 3. Tester que ça fonctionne

```bash
docker compose ps                     # les 2 services "running"
docker compose logs -f worker         # suivre le traitement

# dans un autre terminal : déposer un PDF de test
cp mon_scan.pdf data/inbox/
```

Dès que le log affiche `#1 indexé — …`, ouvrir l'interface et chercher un mot
du courrier.

### Réglages (Docker)

Créer un fichier `.env` à côté de `docker-compose.yml` :

```
COURRIERS_PORT=8080
COURRIERS_OCR_LANGUAGES=fra
# COURRIERS_API_TOKEN=un-secret-optionnel
```

Puis `docker compose up -d`.

**Mise à jour du code** : le dossier `courriers_ocr/` (et `web/`) est monté en
direct dans les conteneurs, donc :

```bash
git pull && docker compose restart      # ~2 s, aucune reconstruction
```

Ne reconstruire l'image (`docker compose up -d --build`) que si
`requirements.txt` ou le `Dockerfile` a changé — et même là, la couche
`apt-get` (Tesseract) reste en cache, seul `pip install` retourne.

Sauvegarde : tout est dans le dossier `data/` → `tar czf sauvegarde.tgz data`
(arrêter le worker d'abord : `docker compose stop worker`).

---

## Installation systemd (Debian 12+)

```bash
git clone https://github.com/MashiroW/AutoMail.git courriers-ocr && cd courriers-ocr
sudo deploy/install.sh
```

Le script installe les paquets (`ocrmypdf`, `tesseract-ocr-fra/deu/ara`,
`poppler-utils`), crée l'utilisateur `courriers`, l'arborescence
`/var/lib/courriers-ocr/`, un venv dans `/opt/courriers-ocr/`, puis active les
deux services.

Interface : `http://raspberrypi.local:8080/` (adapter le nom d'hôte / le port).

### Tester que ça fonctionne

```bash
# les deux services doivent être "active (running)"
sudo systemctl status courriers-ocr-worker courriers-ocr-web

# suivre le traitement en direct
journalctl -u courriers-ocr-worker -f
```

Dans un autre terminal, déposer un PDF de test dans l'inbox :

```bash
cp mon_scan.pdf /var/lib/courriers-ocr/inbox/
```

Dès que le journal affiche `#1 indexé — …`, ouvrir
`http://raspberrypi.local:8080/` et chercher un mot du courrier.

### Configuration

- `/etc/courriers-ocr/courriers-ocr.env` — variables lues par systemd
  (port, langues, dossier de données, jeton d'API optionnel).
- `/etc/courriers-ocr/config.toml` — mêmes réglages sous forme de fichier
  (voir `config.example.toml` pour la liste complète et les commentaires).

Après modification :

```bash
sudo systemctl restart courriers-ocr-worker courriers-ocr-web
```

### Journaux

```bash
journalctl -u courriers-ocr-worker -f
journalctl -u courriers-ocr-web -f
```

## Alimenter l'inbox depuis le scanner

Voir [`deploy/samba-inbox.md`](deploy/samba-inbox.md) : partage Samba
`\\raspberrypi\courriers-inbox` pointant sur `/var/lib/courriers-ocr/inbox`, puis
profil **« Scan vers dossier »** dans ScanSnap Home (sortie **PDF** simple, 300 dpi).
Alternatives : Syncthing/Nextcloud, `scp`, clé USB… tout ce qui écrit un `.pdf`
dans l'inbox.

Un fichier n'est traité qu'une fois sa taille **stable** (le scanner a fini
d'écrire). Une fois traité, il quitte l'inbox : l'original va dans
`originals/AAAA/MM/`, le PDF OCR dans `ocr/AAAA/MM/`.

### Changer le dossier surveillé (inbox)

Par défaut l'inbox est `<data_dir>/inbox`.

#### En Docker

Le plus simple : monter le dossier voulu de l'hôte sur `/data/inbox` du conteneur.
Dans `docker-compose.yml`, sous **`worker`** *et* **`web`**, ajouter un volume :

```yaml
    volumes:
      - ./data:/data
      - /chemin/vers/mon/dossier:/data/inbox   # <-- dossier réel du Pi
```

puis `docker compose up -d`. (Ou, si le dossier est ailleurs dans `data`,
définir `COURRIERS_INBOX_DIR=/data/autre-sous-dossier` dans le `.env`.)

#### En systemd

Par défaut : `/var/lib/courriers-ocr/inbox`. Deux façons équivalentes :

**A. Fichier d'environnement systemd** (le plus simple) :

```bash
sudo nano /etc/courriers-ocr/courriers-ocr.env
```

Ajouter ou modifier :

```
COURRIERS_INBOX_DIR=/chemin/vers/mon/dossier
```

puis redémarrer uniquement le worker (le service web n'utilise pas ce réglage) :

```bash
sudo systemctl restart courriers-ocr-worker
```

**B. Fichier `config.toml`** (`/etc/courriers-ocr/config.toml`) : décommenter et
éditer la ligne

```toml
inbox_dir = "/chemin/vers/mon/dossier"
```

puis le même `systemctl restart courriers-ocr-worker`.

Changer `data_dir` déplace tout (originaux, OCR, base, corbeille…) ; changer
`inbox_dir` ne déplace que le dossier de dépôt.

## Recherche

- **Mots-clés** : sur tout le texte OCR, insensible aux accents et à la casse,
  recherche par préfixe (`convoc` trouve « convocation »).
- **Date du courrier** : filtres « du / au » sur la date détectée (corrigeable
  dans l'UI si l'extraction se trompe).
- **Correspondant** et **tags** : saisis à la main dans l'UI, puis filtrables.
- Chaque résultat : aperçu du PDF cherchable, **téléchargement de l'original**,
  édition des métadonnées, relance de l'OCR dans une autre langue.

## Cas des courriers en allemand / arabe

Le premier OCR utilise `ocr_languages` (défaut `fra`). Pour un courrier dans une
autre langue : bouton **« Relancer l'OCR »** dans la fiche → `deu`, `ara`, ou
`fra+deu`. Le worker retraite l'original et réindexe. On peut aussi passer tout le
système en `fra+deu` via la configuration.

## Sauvegarde

Tout est dans le dossier de données :

```bash
sudo systemctl stop courriers-ocr-worker
sudo tar czf courriers-$(date +%F).tar.gz -C /var/lib courriers-ocr
sudo systemctl start courriers-ocr-worker
```

## Développement (sans Raspberry Pi)

`ocrmypdf` n'est pas requis : le **mode simulé** copie le PDF et lit un fichier
`.txt` voisin comme « texte OCR ».

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt   # Windows
# ou : .venv/bin/pip install -r requirements-dev.txt

# Tests
.venv/Scripts/python -m pytest

# Lancer en local en OCR simulé
set COURRIERS_FAKE_OCR=1
set COURRIERS_DATA_DIR=.\data
.venv/Scripts/python -m courriers_ocr.worker        # terminal 1
.venv/Scripts/uvicorn courriers_ocr.app:app --reload --port 8080   # terminal 2
```

Déposer `data/inbox/mon-courrier.pdf` (+ éventuellement `data/inbox/mon-courrier.txt`
avec un texte connu), puis ouvrir `http://localhost:8080/`.

## Structure du code

| Fichier | Rôle |
|---|---|
| `courriers_ocr/config.py`  | configuration (TOML + variables d'env) |
| `courriers_ocr/db.py`      | SQLite, schéma, recherche FTS5 |
| `courriers_ocr/ocr.py`     | appel `ocrmypdf` (+ mode simulé) |
| `courriers_ocr/extract.py` | texte de repli, pages, vignette, langue probable |
| `courriers_ocr/dates.py`   | détection de la date du courrier |
| `courriers_ocr/ingest.py`  | pipeline complet pour un PDF |
| `courriers_ocr/worker.py`  | boucle de surveillance + ré-OCR |
| `courriers_ocr/app.py`     | API REST + service de l'UI |
| `web/`                     | interface web (HTML/CSS/JS, sans build) |
| `deploy/`                  | `install.sh`, unités systemd, partage Samba |
| `Dockerfile`, `docker-compose.yml` | déploiement conteneurisé (worker + web) |

## Sécurité

Pensé pour un réseau local de confiance : pas d'authentification par défaut.
Pour restreindre l'accès, définir `COURRIERS_API_TOKEN` (les appels `/api/*`
exigent alors `Authorization: Bearer <token>` ou `?token=<token>`) et/ou placer
le service derrière un reverse-proxy.
