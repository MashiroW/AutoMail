"""API REST + service des fichiers statiques de l'interface web."""

from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Config
from . import db
from .ingest import abspath, rel, safe_name
from .models import (
    DocumentOut,
    DocumentPatch,
    ReocrRequest,
    SearchResponse,
    StatsOut,
    TagOut,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _row_to_out(cfg: Config, row: dict) -> DocumentOut:
    return DocumentOut(
        id=row["id"],
        original_filename=row["original_filename"],
        title=row.get("title"),
        correspondent=row.get("correspondent"),
        document_date=row.get("document_date"),
        document_date_source=row.get("document_date_source"),
        added_at=row["added_at"],
        page_count=row.get("page_count"),
        bytes=row.get("bytes"),
        ocr_status=row["ocr_status"],
        ocr_language=row.get("ocr_language"),
        lang_guess=row.get("lang_guess"),
        tags=row.get("tags", []),
        snippet=row.get("snippet") or None,
        has_thumbnail=bool(row.get("thumbnail_path")),
        notes=row.get("notes"),
    )


def create_app(cfg: Config | None = None) -> FastAPI:
    cfg = cfg or Config.load()
    cfg.ensure_dirs()
    _conn = db.connect(cfg.db_path)
    db.init_db(_conn)
    _conn.close()

    app = FastAPI(title="Banque de courriers OCR", version="1.0.0")
    app.state.cfg = cfg

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def get_conn():
        conn = db.connect(cfg.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def auth(request: Request):
        if not cfg.api_token:
            return
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else None
        token = token or request.query_params.get("token")
        if token != cfg.api_token:
            raise HTTPException(401, "jeton d'API invalide ou manquant")

    # ------------------------------------------------------------------ #
    #  Recherche / liste                                                 #
    # ------------------------------------------------------------------ #
    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/stats", response_model=StatsOut, dependencies=[Depends(auth)])
    def get_stats(conn=Depends(get_conn)):
        s = db.stats(conn)
        usage = shutil.disk_usage(cfg.data_dir)
        return StatsOut(
            **s, disk_free_bytes=usage.free, disk_total_bytes=usage.total
        )

    @app.get("/api/tags", response_model=list[TagOut], dependencies=[Depends(auth)])
    def get_tags(conn=Depends(get_conn)):
        return [TagOut(**t) for t in db.list_tags(conn)]

    @app.get("/api/documents", response_model=SearchResponse,
             dependencies=[Depends(auth)])
    def list_documents(
        conn=Depends(get_conn),
        q: str | None = None,
        date_from: str | None = Query(None, alias="date_from"),
        date_to: str | None = Query(None, alias="date_to"),
        correspondent: str | None = None,
        tag: str | None = None,
        status: str | None = Query(None, pattern="^(ok|failed|all)?$"),
        sort: str = Query("date", pattern="^(date|added|pertinence)$"),
        page: int = 1,
        page_size: int = 20,
    ):
        for label, value in (("date_from", date_from), ("date_to", date_to)):
            if value and not _ISO_DATE.match(value):
                raise HTTPException(422, f"{label} doit être au format YYYY-MM-DD")
        rows, total = db.search_documents(
            conn, q=q, date_from=date_from, date_to=date_to,
            correspondent=correspondent, tag=tag,
            status=None if status in (None, "all") else status,
            sort=sort, page=page, page_size=page_size,
        )
        return SearchResponse(
            items=[_row_to_out(cfg, r) for r in rows],
            total=total, page=max(1, page), page_size=page_size,
        )

    @app.get("/api/documents/{doc_id}", response_model=DocumentOut,
             dependencies=[Depends(auth)])
    def get_one(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id)
        if not row:
            raise HTTPException(404, "courrier introuvable")
        return _row_to_out(cfg, row)

    @app.get("/api/documents/{doc_id}/text", dependencies=[Depends(auth)])
    def get_text(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id)
        if not row:
            raise HTTPException(404, "courrier introuvable")
        if not row["text_path"]:
            return {"text": ""}
        p = abspath(cfg, row["text_path"])
        return {"text": p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""}

    # ------------------------------------------------------------------ #
    #  Modification                                                      #
    # ------------------------------------------------------------------ #
    @app.patch("/api/documents/{doc_id}", response_model=DocumentOut,
               dependencies=[Depends(auth)])
    def patch_one(doc_id: int, patch: DocumentPatch, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id)
        if not row:
            raise HTTPException(404, "courrier introuvable")

        fields: dict = {}
        if patch.title is not None:
            fields["title"] = patch.title.strip() or None
        if patch.correspondent is not None:
            fields["correspondent"] = patch.correspondent.strip() or None
        if patch.notes is not None:
            fields["notes"] = patch.notes.strip() or None
        if patch.document_date is not None:
            val = patch.document_date.strip()
            if val == "":
                fields["document_date"] = None
                fields["document_date_source"] = None
            elif _ISO_DATE.match(val):
                try:
                    datetime.strptime(val, "%Y-%m-%d")
                except ValueError:
                    raise HTTPException(422, "date invalide")
                fields["document_date"] = val
                fields["document_date_source"] = "manual"
            else:
                raise HTTPException(422, "document_date doit être au format YYYY-MM-DD")

        if fields:
            db.update_document(conn, doc_id, **fields)
        if patch.tags is not None:
            db.set_tags(conn, doc_id, patch.tags)

        fresh = db.get_document(conn, doc_id)
        p = abspath(cfg, fresh["text_path"]) if fresh["text_path"] else None
        text = p.read_text(encoding="utf-8", errors="replace") if p and p.is_file() else ""
        db.set_fts(conn, doc_id, text, fresh["title"], fresh["correspondent"])
        return _row_to_out(cfg, fresh)

    @app.post("/api/documents/{doc_id}/reocr", dependencies=[Depends(auth)])
    def reocr(doc_id: int, body: ReocrRequest, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id, include_deleted=True)
        if not row:
            raise HTTPException(404, "courrier introuvable")
        lang = body.language.strip()
        if not re.fullmatch(r"[a-z]{3}(\+[a-z]{3})*", lang):
            raise HTTPException(422, "code langue invalide (ex. 'deu', 'fra+deu')")
        db.enqueue_reocr(conn, doc_id, lang)
        return {"status": "en file d'attente", "language": lang}

    @app.post("/api/documents/{doc_id}/retry", dependencies=[Depends(auth)])
    def retry(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id, include_deleted=True)
        if not row or row["ocr_status"] != "failed":
            raise HTTPException(404, "aucun courrier en échec avec cet id")
        if not row["original_path"]:
            raise HTTPException(409, "fichier d'origine introuvable")
        src = abspath(cfg, row["original_path"])
        if not src.is_file():
            raise HTTPException(409, "fichier d'origine introuvable sur le disque")
        dest = cfg.inbox / f"retry_{doc_id}_{safe_name(row['original_filename'])}"
        shutil.move(str(src), str(dest))
        db.soft_delete(conn, doc_id)  # l'ancienne ligne en échec sort des résultats
        return {"status": "renvoyé dans l'inbox"}

    @app.delete("/api/documents/{doc_id}", dependencies=[Depends(auth)])
    def delete_one(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id)
        if not row:
            raise HTTPException(404, "courrier introuvable")
        trash = cfg.trash_dir / str(doc_id)
        trash.mkdir(parents=True, exist_ok=True)
        for key in ("original_path", "ocr_path", "thumbnail_path", "text_path"):
            if row[key]:
                p = abspath(cfg, row[key])
                if p.is_file():
                    shutil.move(str(p), str(trash / p.name))
        db.soft_delete(conn, doc_id)
        return {"status": "déplacé dans la corbeille"}

    # ------------------------------------------------------------------ #
    #  Fichiers                                                          #
    # ------------------------------------------------------------------ #
    def _file_or_404(row: dict | None, key: str) -> Path:
        if not row or not row[key]:
            raise HTTPException(404, "fichier indisponible")
        p = abspath(cfg, row[key])
        if not p.is_file():
            raise HTTPException(404, "fichier absent du disque")
        return p

    @app.get("/api/documents/{doc_id}/download", dependencies=[Depends(auth)])
    def download_original(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id, include_deleted=True)
        p = _file_or_404(row, "original_path")
        return FileResponse(
            p, media_type="application/pdf", filename=row["original_filename"]
        )

    @app.get("/api/documents/{doc_id}/pdf", dependencies=[Depends(auth)])
    def view_ocr_pdf(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id, include_deleted=True)
        p = _file_or_404(row, "ocr_path")
        return FileResponse(
            p, media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{doc_id}.pdf"'},
        )

    @app.get("/api/documents/{doc_id}/thumbnail", dependencies=[Depends(auth)])
    def thumbnail(doc_id: int, conn=Depends(get_conn)):
        row = db.get_document(conn, doc_id, include_deleted=True)
        p = _file_or_404(row, "thumbnail_path")
        return FileResponse(p, media_type="image/jpeg")

    # ------------------------------------------------------------------ #
    #  Interface web statique                                            #
    # ------------------------------------------------------------------ #
    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


app = create_app()
