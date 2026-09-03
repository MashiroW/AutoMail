"""Boucle permanente : surveille l'inbox, lance l'OCR, retente les échecs, ré-OCR."""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import Config
from . import db
from .dates import extract_document_date
from .extract import clean_text, extract_text_fallback, guess_language
from .ingest import (
    abspath,
    ocr_pending_doc,
    pdf_sanity_error,
    register_file,
    reprocess_failed_doc,
    rel,
)
from .ocr import run_ocr

log = logging.getLogger("courriers_ocr.worker")

_IGNORE_SUFFIXES = {".part", ".tmp", ".filepart", ".crdownload", ".lock"}
_stop = False


def _handle_signal(signum, _frame):
    global _stop
    log.info("signal %s reçu, arrêt en cours…", signum)
    _stop = True


def _is_candidate(p: Path) -> bool:
    if not p.is_file() or p.name.startswith((".", "~")):
        return False
    if p.suffix.lower() in _IGNORE_SUFFIXES:
        return False
    return p.suffix.lower() == ".pdf"


# un fichier stable mais qui n'a pas l'air d'un PDF (vide, en-tête absente) :
# on patiente encore ~ce nombre de relevés (le scanner écrit peut-être encore)
# avant de le déclarer en échec pour de bon.
_STALE_AFTER = 20


def register_inbox(conn, cfg: Config,
                   pending: dict[Path, tuple[int, float, int]]) -> int:
    """Repère les PDF *stables* de l'inbox et les enregistre (phase 1, rapide,
    aucune OCR). Renvoie le nombre de courriers nouvellement enregistrés."""
    current = (
        {p for p in cfg.inbox.iterdir() if _is_candidate(p)}
        if cfg.inbox.is_dir() else set()
    )
    for gone in [p for p in pending if p not in current]:
        pending.pop(gone, None)

    registered = 0
    for path in sorted(current):
        try:
            st = path.stat()
        except OSError:
            pending.pop(path, None)
            continue
        size, mtime = st.st_size, st.st_mtime
        prev = pending.get(path)
        stable = prev[2] + 1 if (prev and prev[0] == size and prev[1] == mtime) else 0
        pending[path] = (size, mtime, stable)
        if stable + 1 < cfg.stable_checks:
            continue
        # stable mais pas (encore) un PDF valide → on laisse du temps au scanner,
        # puis on l'enregistre quand même (il finira en échec avec un message clair)
        if pdf_sanity_error(path) and stable < cfg.stable_checks + _STALE_AFTER:
            continue
        pending.pop(path, None)
        if register_file(conn, cfg, path) is not None:
            registered += 1
    return registered


# nb max d'OCR enchaînés avant de rendre la main aux tâches périodiques
# (ré-OCR demandé depuis l'UI, retry des échecs, drapeau de redémarrage)
_OCR_BATCH = 4


def scan_once(conn, cfg: Config, pending: dict[Path, tuple[int, float, int]],
              *, restart_flag: Path | None = None,
              max_ocr: int | None = None) -> bool:
    """Passage SYNCHRONE (mode --once / tests) : enregistre l'inbox puis OCRise
    au plus `max_ocr` courriers (None = tous), en re-scannant entre chaque.
    En mode continu, c'est le thread `_inbox_watcher` qui enregistre l'inbox."""
    register_inbox(conn, cfg, pending)
    done = 0
    while max_ocr is None or done < max_ocr:
        if _stop or (restart_flag is not None and restart_flag.exists()):
            break
        ids = db.pending_doc_ids(conn, limit=1)
        if not ids:
            break
        ocr_pending_doc(conn, cfg, ids[0])
        done += 1
        register_inbox(conn, cfg, pending)
    return bool(db.pending_doc_ids(conn, limit=1)) or bool(pending)


def drain_ocr(conn, cfg: Config, *, restart_flag: Path | None = None,
              max_ocr: int | None = None) -> bool:
    """OCRise les courriers en attente, au plus `max_ocr` (None = tous).
    N'enregistre PAS l'inbox (le thread watcher s'en charge en parallèle).
    Renvoie True s'il reste des courriers en attente."""
    done = 0
    while max_ocr is None or done < max_ocr:
        if _stop or (restart_flag is not None and restart_flag.exists()):
            break
        ids = db.pending_doc_ids(conn, limit=1)
        if not ids:
            break
        ocr_pending_doc(conn, cfg, ids[0])
        done += 1
    return bool(db.pending_doc_ids(conn, limit=1))


def _inbox_watcher(cfg: Config, stop_evt: threading.Event) -> None:
    """Thread léger et permanent : enregistre les fichiers stables de l'inbox
    ~toutes les secondes, avec sa PROPRE connexion SQLite. Tourne en parallèle
    de l'OCR pour qu'un courrier déposé pendant l'OCR d'un autre apparaisse
    tout de suite dans « en attente »."""
    try:
        conn = db.connect(cfg.db_path)
    except Exception:  # noqa: BLE001
        log.exception("watcher inbox : connexion DB impossible")
        return
    pending: dict[Path, tuple[int, float, int]] = {}
    try:
        while not _stop and not stop_evt.is_set():
            try:
                register_inbox(conn, cfg, pending)
            except Exception:  # noqa: BLE001
                log.exception("watcher inbox : échec d'enregistrement")
            stop_evt.wait(1.0)
    finally:
        conn.close()


def auto_retry_failed(conn, cfg: Config) -> int:
    """Retente les courriers en échec, un seul par passage pour ménager le Pi."""
    backoff = max(120, cfg.poll_interval_seconds * 6)
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=backoff)
    ).replace(microsecond=0).isoformat()

    for doc in db.retryable_failures(conn, cutoff)[:1]:
        reprocess_failed_doc(conn, cfg, doc)
        return 1
    return 0


def process_reocr(conn, cfg: Config) -> int:
    done = 0
    for job in db.take_reocr_jobs(conn, limit=3):
        doc = db.get_document(conn, job["document_id"], include_deleted=True)
        tmp_out = cfg.tmp_dir / f"{uuid.uuid4().hex}.pdf"
        tmp_txt = tmp_out.with_suffix(".txt")
        try:
            if not doc or not doc["original_path"]:
                raise RuntimeError("document ou original introuvable")
            src = abspath(cfg, doc["original_path"])
            if not src.is_file():
                raise FileNotFoundError(src)

            result = run_ocr(src, tmp_out, tmp_txt, job["language"], cfg)
            text = ""
            if tmp_txt.is_file():
                text = tmp_txt.read_text(encoding="utf-8", errors="replace")
            if len(text.strip()) < 3:
                text = extract_text_fallback(tmp_out)
            text = clean_text(text)

            ocr_dest = (
                abspath(cfg, doc["ocr_path"]) if doc["ocr_path"]
                else cfg.ocr_dir / f"{doc['id']}.pdf"
            )
            ocr_dest.parent.mkdir(parents=True, exist_ok=True)
            tmp_out.replace(ocr_dest)

            text_dest = (
                abspath(cfg, doc["text_path"]) if doc["text_path"]
                else cfg.text_dir / f"{doc['id']}.txt"
            )
            text_dest.write_text(text, encoding="utf-8")

            fields = dict(
                ocr_path=rel(cfg, ocr_dest),
                text_path=rel(cfg, text_dest),
                ocr_language=job["language"],
                ocr_status=result.status,
                lang_guess=guess_language(text),
            )
            new_date = extract_document_date(text)
            if new_date and doc["document_date_source"] != "manual":
                fields["document_date"] = new_date
                fields["document_date_source"] = "auto"
            db.update_document(conn, doc["id"], **fields)
            db.set_fts(conn, doc["id"], text, doc["title"], doc["correspondent"])
            log.info("ré-OCR #%s en %s : ok", doc["id"], job["language"])
        except Exception as exc:  # noqa: BLE001
            log.error("ré-OCR #%s échoué : %s", job["document_id"], exc)
        finally:
            tmp_out.unlink(missing_ok=True)
            tmp_txt.unlink(missing_ok=True)
            db.delete_reocr_job(conn, job["id"])
            done += 1
    return done


def run(cfg: Config, once: bool = False) -> None:
    cfg.ensure_dirs()
    conn = db.connect(cfg.db_path)
    db.init_db(conn)
    stuck = db.reset_stuck_processing(conn)
    if stuck:
        log.info("%s OCR interrompus remis en file d'attente", stuck)

    log.info("worker démarré — inbox=%s langues=%s", cfg.inbox, cfg.ocr_languages)
    restart_flag = cfg.data_dir / ".restart-requested"

    # --- mode --once (tests / debug) : tout en synchrone, sans thread --------
    if once:
        try:
            process_reocr(conn, cfg)
            auto_retry_failed(conn, cfg)
            scan_once(conn, cfg, {}, max_ocr=None)
        except Exception:  # noqa: BLE001
            log.exception("erreur inattendue dans la boucle du worker")
        conn.close()
        log.info("worker arrêté")
        return

    # --- mode continu : un thread enregistre l'inbox en permanence, ce
    #     thread-ci enchaîne les OCR -------------------------------------------
    stop_evt = threading.Event()

    def _spawn_watcher() -> threading.Thread:
        t = threading.Thread(target=_inbox_watcher, args=(cfg, stop_evt),
                             name="inbox-watcher", daemon=True)
        t.start()
        return t

    watcher = _spawn_watcher()
    try:
        while not _stop:
            if restart_flag.exists():   # posé par le bouton « Mettre à jour »
                restart_flag.unlink(missing_ok=True)
                log.info("redémarrage demandé — sortie (systemd relancera)")
                break
            if not watcher.is_alive():
                log.warning("watcher inbox arrêté — redémarrage")
                watcher = _spawn_watcher()

            backlog = False
            try:
                process_reocr(conn, cfg)
                auto_retry_failed(conn, cfg)
                backlog = drain_ocr(conn, cfg, restart_flag=restart_flag,
                                    max_ocr=_OCR_BATCH)
            except Exception:  # noqa: BLE001 — la boucle ne doit jamais mourir
                log.exception("erreur inattendue dans la boucle du worker")

            # l'inbox est surveillée par le thread watcher ; ici on ne fait que
            # sonder la file d'OCR → un réveil court suffit (le courrier que le
            # watcher vient d'enregistrer démarre en ≤ 3 s, pas au bout de
            # poll_interval). 1 s tant qu'il reste du backlog.
            delay = 1.0 if backlog else max(1.0, min(3.0, cfg.poll_interval_seconds))
            for _ in range(int(delay * 10)):
                if _stop or restart_flag.exists():
                    break
                time.sleep(0.1)
    finally:
        stop_evt.set()
        watcher.join(timeout=3)
        conn.close()
    log.info("worker arrêté")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Worker OCR d'AutoMail")
    parser.add_argument("--once", action="store_true",
                        help="un seul passage puis quitter (tests)")
    parser.add_argument("--config", default=None, help="chemin d'un config.toml")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    run(Config.load(args.config), once=args.once)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
