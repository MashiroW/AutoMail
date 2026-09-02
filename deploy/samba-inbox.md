# Partage réseau pour le scanner

But : que le scanner (profil « scan vers dossier réseau ») dépose ses PDF
directement dans le dossier **surveillé** par AutoMail, soit `<clone>/data/inbox`.

## Automatique (recommandé)

```bash
sudo bash deploy/setup-samba.sh
```

- crée un partage Samba **invité** (sans mot de passe) nommé `scans` ;
- il pointe **toujours** sur `<clone>/data/inbox` — le dossier exact que le
  worker surveille ;
- `force user` = ton utilisateur, donc les fichiers arrivent avec le bon
  propriétaire (pas besoin de `chmod 777`) ;
- **idempotent** : re-lancer le script réécrit le bloc avec le bon chemin
  (pratique si tu déplaces le projet ou si un ancien partage traînait).

Il affiche le chemin à mettre dans le scanner : `\\<ip-du-pi>\scans`.
Sortie scanner : **PDF** simple (pas « PDF cherchable »), 300 dpi conseillé.

Nom de partage personnalisé : `sudo bash deploy/setup-samba.sh mon-nom`.

## Sans Samba

N'importe quoi qui écrit un `.pdf` dans `<clone>/data/inbox` convient :
Syncthing, `scp`, un montage NFS, une clé USB + script…
