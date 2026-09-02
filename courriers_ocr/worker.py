"""Boucle permanente : surveille l'inbox, lance l'OCR, retente les échecs, ré-OCR."""

from __future__ import annotations

import argparse
import logging
import signal
import sys
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


def scan_once(conn, cfg: Config, pending: dict[Path, tuple[int, float, int]]) -> int:
    """1) enregistre les fichiers stables (visibles tout de suite),
       2) OCRise les documents en attente, un par un."""
    processed = 0
    current = (
        {p for p in cfg.inbox.iterdir() if _is_candidate(p)}
        if cfg.inbox.is_dir() else set()
    )
    for gone in [p for p in pending if p not in current]:
        pending.pop(gone, None)

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
        if stable + 1 >= cfg.stable_checks:
            pending.pop(path, None)
            register_file(conn, cfg, path)

    for doc_id in db.pending_doc_ids(conn, limit=50):
        ocr_pending_doc(conn, cfg, doc_id)
        processed += 1
        if _stop:
            break
    return processed


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
    pending: dict[Path, tuple[int, float, int]] = {}
    restart_flag = cfg.data_dir / ".restart-requested"

    while not _stop:
        if restart_flag.exists():   # posé par le bouton « Mettre à jour »
            restart_flag.unlink(missing_ok=True)
            log.info("redémarrage demandé — sortie (systemd relancera)")
            break
        try:
            process_reocr(conn, cfg)
            auto_retry_failed(conn, cfg)
            scan_once(conn, cfg, pending)
        except Exception:  # noqa: BLE001 — la boucle ne doit jamais mourir
            log.exception("erreur inattendue dans la boucle du worker")

        if once:
            break
        for _ in range(int(max(1, cfg.poll_interval_seconds) * 10)):
            if _stop:
                break
            time.sleep(0.1)

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
