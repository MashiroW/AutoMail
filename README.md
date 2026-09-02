# AutoMail — banque de courriers OCR

Petit service auto-hébergé pour Raspberry Pi qui reproduit l'expérience ScanSnap
Home, en plus léger et sans PC allumé en permanence :

1. il **surveille un dossier** (`data/inbox/`) où le scanner dépose des PDF ;
2. à chaque nouveau courrier, il lance un **OCR** (`ocrmypdf` + Tesseract) qui
   produit un **PDF cherchable** (texte sélectionnable / surlignable) et extrait
   tout le texte ;
3. il **détecte automatiquement la date du courrier** (celle imprimée en haut) ;
4. il **indexe** le texte pour la recherche plein-texte + tags / correspondant ;
5. il expose sur le réseau local une **API REST + une page web** pour chercher
   (mots-clés, plage de dates, correspondant, tag) et **télécharger l'original**.

Stack volontairement minimale : Python + FastAPI + SQLite (FTS5). Deux services
systemd (`automail-worker` pour l'ingestion, `automail-web` pour l'interface).

---

## Tout vit dans le dossier cloné

Aucun fichier n'est dispersé dans `/opt`, `/etc`, `/var`. Après installation, le
dossier du dépôt contient tout :

```
automail/
├── courriers_ocr/   web/   deploy/   …   ← le code (versionné)
├── .venv/           environnement Python        (ignoré par git)
├── .python/         Python 3.11 portable, si l'OS est trop vieux  (ignoré)
├── config.toml      configuration locale        (ignoré)
└── data/            inbox, originals, ocr, thumbnails, text,
                     failed, trash, courriers.db (ignoré)
```

Seule exception : 2 petits fichiers `*.service` dans `/etc/systemd/system/`
(systemd ne lit les services que là) — ils pointent simplement vers ce dossier.

Sauvegarder = archiver ce dossier. Désinstaller =
`sudo systemctl disable --now automail-worker automail-web` puis le supprimer.

---

## Matériel

- Raspberry Pi 4 / 5, 2 Go de RAM minimum. Un SSD USB est conseillé pour l'archive.
- Ordre de grandeur OCR sur Pi 4 : ~10 à 40 s par page.

## Installation

### 1. Récupérer le code

```bash
cd ~ && git clone https://github.com/MashiroW/AutoMail.git automail && cd automail
```

### 2a. Raspberry Pi OS Buster / Bullseye (OS ancien, Python < 3.10)

```bash
sudo bash deploy/bootstrap-pi-buster.sh
```

Ce script tout-en-un :

1. bascule les dépôts Debian sur `archive.debian.org` (Buster n'est plus signé) ;
2. lance `deploy/install.sh` — installe `ocrmypdf` + Tesseract (fra/deu/ara) +
   poppler + unpaper via l'apt de l'hôte, récupère un **Python 3.11 portable**
   (binaire, sans compilation ; compilé en dernier recours), crée `.venv/` +
   `data/` + `config.toml` **dans ce dossier**, génère et démarre les 2 services ;
3. lance `deploy/setup-samba.sh` — partage réseau `scans` pointé sur
   `data/inbox` (le dossier que le worker surveille).

### 2b. Raspberry Pi OS Bookworm ou plus récent (Python ≥ 3.10 fourni)

```bash
sudo bash deploy/install.sh
sudo bash deploy/setup-samba.sh
```

`install.sh` utilise directement le Python du système ; pas de bascule de dépôts.

### Après l'installation

```
Interface :   http://<ip-du-pi>:8080/
Dépôt scans : <dossier>/data/inbox/
Logs :        journalctl -u automail-worker -f      (et automail-web)
État :        systemctl status automail-worker automail-web
```

## Alimenter l'inbox depuis le scanner

`deploy/setup-samba.sh` crée un partage Samba **invité** (sans mot de passe)
nommé `scans` qui pointe **exactement sur `<clone>/data/inbox`**, c'est-à-dire le
dossier que le worker surveille — le fichier déposé par le scanner et le fichier
attendu par le programme sont le même. `force user` = ton utilisateur, donc pas
de souci de droits. Le script est **idempotent** : le relancer réécrit le bloc
avec le bon chemin (utile après un déménagement du projet ou si un vieux partage
traînait).

Il affiche le chemin réseau (`\\<ip-du-pi>\scans`) à mettre comme destination
« scan vers dossier » dans le logiciel du scanner. Sortie **PDF** simple (pas
« PDF cherchable » : c'est le Pi qui s'en charge), 300 dpi conseillé. Détails :
[`deploy/samba-inbox.md`](deploy/samba-inbox.md).

Un fichier n'est traité qu'une fois sa **taille stable** (scanner qui a fini
d'écrire). Une fois traité il quitte l'inbox : l'original va dans
`data/originals/AAAA/MM/`, le PDF OCR dans `data/ocr/AAAA/MM/`.

## Tester

```bash
cp un_scan.pdf data/inbox/
journalctl -u automail-worker -f
```

Au bout de ~10 s : `traitement de un_scan.pdf` puis `#1 indexé — … statut=ok`.
Rafraîchir l'interface : le courrier apparaît, cherchable.

## Mise à jour / redéploiement

Mise à jour du code sur un Pi déjà installé :

```bash
cd automail && git pull && sudo systemctl restart automail-worker automail-web
```

(relancer `sudo bash deploy/install.sh` seulement si `requirements.txt` a changé.)

Nouveau Pi : cloner + une seule commande (`bootstrap-pi-buster.sh` ou
`install.sh` selon l'OS). `config.toml` et `data/` ne sont pas dans le dépôt,
donc rien à écraser.

## Réglages — `config.toml`

Édite `config.toml` dans le dossier, puis
`sudo systemctl restart automail-worker automail-web`.

- `ocr_languages` : `"fra"` par défaut. `"fra+deu"` si tu as souvent de
  l'allemand (un peu plus lent). Sinon garde `fra` et fais un « Re-OCR »
  ponctuel par courrier depuis l'interface.
- `ocr_extra_args` : `["--rotate-pages", "--deskew", "--clean"]`. `--clean`
  (nettoyage via unpaper) aide sur les scans bruités ; retire-le si tes scans
  sont déjà nets, c'est plus rapide.
- `port`, `thumbnail_width`, `poll_interval_seconds`, `api_token`…
  (liste complète commentée dans `config.example.toml`).

### Changer le dossier surveillé

Par défaut l'inbox est `data/inbox`. Pour surveiller un autre dossier, dans
`config.toml` :

```toml
inbox_dir = "/chemin/vers/mon/dossier"
```

puis `sudo systemctl restart automail-worker`. (Changer `data_dir` déplace
**tout** ; `inbox_dir` ne change que la zone de dépôt. Si le dossier est hors du
home de l'utilisateur du service, vérifie les droits.)

## Recherche

- **Mots-clés** : sur tout le texte OCR, insensible aux accents et à la casse,
  par préfixe (`convoc` trouve « convocation »).
- **Date du courrier** : filtres « du / au » sur la date détectée (corrigeable
  dans l'interface si l'extraction se trompe).
- **Correspondant** et **tags** : saisis à la main, puis filtrables.
- Chaque résultat : aperçu du PDF cherchable, **téléchargement de l'original**,
  édition des métadonnées, relance de l'OCR dans une autre langue, corbeille.

## Sauvegarde

Tout est dans le dossier. De temps en temps :

```bash
sudo systemctl stop automail-worker
tar czf ~/automail-$(date +%F).tgz -C "$(dirname "$PWD")" "$(basename "$PWD")"
sudo systemctl start automail-worker
```

## Développement (sans Raspberry Pi)

`ocrmypdf` n'est pas requis : le **mode simulé** copie le PDF et lit un `.txt`
voisin comme « texte OCR ».

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt      # Windows
# ou : .venv/bin/pip install -r requirements-dev.txt

.venv/Scripts/python -m pytest

set COURRIERS_FAKE_OCR=1
set COURRIERS_DATA_DIR=.\data
.venv/Scripts/python -m courriers_ocr.worker           # terminal 1
.venv/Scripts/python -m courriers_ocr.serve            # terminal 2
```

Déposer `data/inbox/x.pdf` (+ éventuellement `data/inbox/x.txt` avec un texte
connu), puis ouvrir `http://localhost:8080/`.

## Docker (optionnel)

`Dockerfile` + `docker-compose.yml` sont fournis pour un hôte disposant déjà d'un
moteur Docker **fonctionnel**. `docker compose up -d --build`, données dans
`./data`. À éviter sur Buster : le réseau interne de Docker y est souvent cassé
(utiliser `bootstrap-pi-buster.sh` à la place).

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
| `courriers_ocr/serve.py`   | lanceur uvicorn (lit host/port de la config) |
| `web/`                     | interface web (HTML/CSS/JS, sans build) |
| `deploy/`                  | `bootstrap-pi-buster.sh`, `install.sh`, `setup-samba.sh` |
| `Dockerfile`, `docker-compose.yml` | déploiement conteneurisé (optionnel) |

## Sécurité

Pensé pour un réseau local de confiance : pas d'authentification par défaut.
Pour restreindre l'accès, définir `api_token` dans `config.toml` (les appels
`/api/*` exigent alors `Authorization: Bearer <token>` ou `?token=<token>`)
et/ou placer le service derrière un reverse-proxy.
