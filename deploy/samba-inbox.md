# Partager l'inbox par le réseau (optionnel)

Pour que le scanner ScanSnap (ou n'importe quel poste) dépose les PDF directement
dans le dossier surveillé, on expose `/var/lib/courriers-ocr/inbox` en partage
Samba.

## 1. Installer Samba

```bash
sudo apt install samba
```

## 2. Déclarer le partage

Ajouter à la fin de `/etc/samba/smb.conf` :

```ini
[courriers-inbox]
   path = /var/lib/courriers-ocr/inbox
   browseable = yes
   read only = no
   force user = courriers
   force group = courriers
   create mask = 0664
   directory mask = 0775
   # Restreindre au réseau local :
   hosts allow = 192.168.0.0/16 127.0.0.1
   hosts deny = 0.0.0.0/0
```

## 3. Créer l'utilisateur Samba

```bash
sudo smbpasswd -a courriers      # définir un mot de passe pour le partage
sudo systemctl restart smbd
```

## 4. Configurer le scanner

Dans **ScanSnap Home**, créer un profil **« Scan vers dossier »** (Scan to Folder)
et pointer le dossier de destination sur :

```
\\raspberrypi\courriers-inbox
```

(remplacer `raspberrypi` par le nom d'hôte réel de la Pi, ou son IP).

Format de sortie : **PDF** (pas « PDF cherchable » : c'est la Pi qui s'en charge).
Un PDF par courrier, résolution 300 dpi conseillée.

Dès qu'un fichier arrive et que sa taille est stable, le worker le récupère,
l'OCRise et l'indexe. Il disparaît de l'inbox une fois traité (déplacé dans
`originals/AAAA/MM/`).

## Alternative sans Samba

- **Dossier synchronisé** (Syncthing, Nextcloud…) dont un côté est
  `/var/lib/courriers-ocr/inbox`.
- **SFTP** : `scp courrier.pdf courriers@raspberrypi:/var/lib/courriers-ocr/inbox/`.
- **clé USB / script** : n'importe quel moyen qui écrit un `.pdf` dans l'inbox.
