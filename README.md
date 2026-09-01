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

## Installation sur la Pi

```bash
git clone https://github.com/MashiroW/AutoMail.git courriers-ocr && cd courriers-ocr
sudo deploy/install.sh
```

Le dépôt est privé : la première fois, `git clone` demande tes identifiants
GitHub (ou utilise `git@github.com:MashiroW/AutoMail.git` si une clé SSH est
déjà configurée sur la Pi).

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

Par défaut l'inbox est `<data_dir>/inbox`, donc `/var/lib/courriers-ocr/inbox`.
Pour surveiller un autre dossier, deux façons équivalentes :

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

## Sécurité

Pensé pour un réseau local de confiance : pas d'authentification par défaut.
Pour restreindre l'accès, définir `COURRIERS_API_TOKEN` (les appels `/api/*`
exigent alors `Authorization: Bearer <token>` ou `?token=<token>`) et/ou placer
le service derrière un reverse-proxy.
