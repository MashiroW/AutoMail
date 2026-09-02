# Partage réseau pour le scanner

Le but : que le scanner (profil « scan vers dossier réseau ») dépose ses PDF
directement dans l'inbox d'AutoMail (`<clone>/data/inbox`).

## Automatique

```bash
sudo bash deploy/setup-samba.sh
```

Crée un partage Samba **invité** (sans mot de passe) nommé `scans`, pointé sur
l'inbox, avec `force user = <toi>` pour que les fichiers arrivent avec le bon
propriétaire. Affiche le chemin réseau à mettre dans le logiciel du scanner
(`\\<ip-du-pi>\scans`).

Nom de partage personnalisé : `sudo bash deploy/setup-samba.sh mon-nom`.

## Repointer un partage existant

Si tu as déjà un partage qui fonctionne (le scanner écrit déjà dedans), le plus
simple est de ne **rien changer côté scanner** et juste de rediriger le partage :
dans `/etc/samba/smb.conf`, dans ton bloc `[...]`, mets

```ini
   path = /chemin/vers/<clone>/data/inbox
   force user = pi
   create mask = 0664
   directory mask = 0775
```

puis `sudo systemctl restart smbd`.

## Sans Samba

N'importe quoi qui écrit un `.pdf` dans `<clone>/data/inbox` convient :
Syncthing, `scp`, un montage NFS, une clé USB + script…
