"""Accès SQLite + recherche plein-texte FTS5."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id                   INTEGER PRIMARY KEY,
    sha256               TEXT UNIQUE,
    original_filename    TEXT NOT NULL,
    original_path        TEXT,               -- relatif à data_dir
    ocr_path             TEXT,
    thumbnail_path       TEXT,
    text_path            TEXT,
    page_count           INTEGER,
    bytes                INTEGER,
    added_at             TEXT NOT NULL,
    document_date        TEXT,               -- 'YYYY-MM-DD' ou NULL
    document_date_source TEXT,               -- 'auto' | 'manual' | NULL
    correspondent        TEXT,
    title                TEXT,
    notes                TEXT,
    ocr_status           TEXT NOT NULL,      -- 'ok' | 'skipped-has-text' | 'failed'
    ocr_language         TEXT,
    lang_guess           TEXT,
    ocr_attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at      TEXT,
    progress             TEXT NOT NULL DEFAULT 'done',   -- 'todo' | 'ongoing' | 'done'
    deleted_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_date   ON documents(document_date);
CREATE INDEX IF NOT EXISTS idx_documents_added  ON documents(added_at);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(ocr_status);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    text,
    title,
    correspondent,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE IF NOT EXISTS reocr_jobs (
    id           INTEGER PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    language     TEXT NOT NULL,
    requested_at TEXT NOT NULL
);

-- l'ancienne fonctionnalité « tags » a été retirée
DROP TABLE IF EXISTS document_tags;
DROP TABLE IF EXISTS tags;
"""

# retry automatique : nombre max de tentatives d'OCR par courrier
MAX_OCR_ATTEMPTS = 3


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(db_path: str | Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False : FastAPI peut créer la connexion et l'utiliser
    # dans deux threads du pool. Chaque connexion reste propre à une requête
    # (jamais partagée en parallèle), donc c'est sûr ici.
    conn = sqlite3.connect(
        str(db_path), timeout=10, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # migrations légères pour les bases créées avant l'ajout de colonnes
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
    if "ocr_attempts" not in cols:
        conn.execute(
            "ALTER TABLE documents ADD COLUMN ocr_attempts INTEGER NOT NULL DEFAULT 0"
        )
    if "last_attempt_at" not in cols:
        conn.execute("ALTER TABLE documents ADD COLUMN last_attempt_at TEXT")
    if "progress" not in cols:
        conn.execute(
            "ALTER TABLE documents ADD COLUMN progress TEXT NOT NULL DEFAULT 'done'"
        )


# --------------------------------------------------------------------------- #
#  Écriture                                                                   #
# --------------------------------------------------------------------------- #
_DOC_COLUMNS = {
    "sha256", "original_filename", "original_path", "ocr_path", "thumbnail_path",
    "text_path", "page_count", "bytes", "added_at", "document_date",
    "document_date_source", "correspondent", "title", "notes", "ocr_status",
    "ocr_language", "lang_guess", "ocr_attempts", "last_attempt_at",
    "progress", "deleted_at",
}


def insert_document(conn: sqlite3.Connection, **fields: Any) -> int:
    fields.setdefault("added_at", now_iso())
    cols = [c for c in fields if c in _DOC_COLUMNS]
    placeholders = ", ".join("?" for _ in cols)
    sql = f"INSERT INTO documents ({', '.join(cols)}) VALUES ({placeholders})"
    cur = conn.execute(sql, [fields[c] for c in cols])
    return int(cur.lastrowid)


def update_document(conn: sqlite3.Connection, doc_id: int, **fields: Any) -> None:
    cols = [c for c in fields if c in _DOC_COLUMNS]
    if not cols:
        return
    sql = f"UPDATE documents SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?"
    conn.execute(sql, [fields[c] for c in cols] + [doc_id])


def set_fts(conn: sqlite3.Connection, doc_id: int, text: str,
            title: str | None, correspondent: str | None) -> None:
    conn.execute("DELETE FROM documents_fts WHERE rowid = ?", (doc_id,))
    conn.execute(
        "INSERT INTO documents_fts (rowid, text, title, correspondent) "
        "VALUES (?, ?, ?, ?)",
        (doc_id, text or "", title or "", correspondent or ""),
    )


def delete_fts(conn: sqlite3.Connection, doc_id: int) -> None:
    conn.execute("DELETE FROM documents_fts WHERE rowid = ?", (doc_id,))


def sha_exists(conn: sqlite3.Connection, sha256: str) -> int | None:
    """Id d'un document ACTIF ayant ce hash (corbeille / réessais ne bloquent pas)."""
    row = conn.execute(
        "SELECT id FROM documents WHERE sha256 = ? AND deleted_at IS NULL",
        (sha256,),
    ).fetchone()
    return int(row["id"]) if row else None


def purge_deleted_by_sha(conn: sqlite3.Connection, sha256: str) -> None:
    """Supprime définitivement les enregistrements en corbeille du même hash.

    Sans ça, la contrainte UNIQUE(sha256) empêcherait de ré-ingérer un courrier
    précédemment supprimé.
    """
    rows = conn.execute(
        "SELECT id FROM documents WHERE sha256 = ? AND deleted_at IS NOT NULL",
        (sha256,),
    ).fetchall()
    for r in rows:
        delete_fts(conn, r["id"])
        conn.execute("DELETE FROM documents WHERE id = ?", (r["id"],))


# --------------------------------------------------------------------------- #
#  Recherche                                                                  #
# --------------------------------------------------------------------------- #
def build_match_query(q: str) -> str:
    """Transforme une saisie libre en requête FTS5 sûre (préfixe, AND implicite)."""
    tokens = [t for t in q.replace('"', " ").split() if t]
    parts = []
    for t in tokens:
        t = t.replace("'", " ")
        parts.append(f'"{t}"*')
    return " ".join(parts)


def search_documents(
    conn: sqlite3.Connection,
    *,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    correspondent: str | None = None,
    status: str | None = None,
    progress: str | None = None,
    deleted: bool = False,
    sort: str = "date",
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[dict], int]:
    where = ["d.deleted_at IS NOT NULL" if deleted else "d.deleted_at IS NULL"]
    params: list[Any] = []
    joins = ""
    select_snippet = "'' AS snippet"
    order = "d.document_date IS NULL, d.document_date DESC, d.added_at DESC"
    if deleted:
        order = "d.deleted_at DESC"

    if q and not deleted:
        match = build_match_query(q)
        if match:
            joins = "JOIN documents_fts f ON f.rowid = d.id"
            where.append("documents_fts MATCH ?")
            params.append(match)
            select_snippet = (
                "snippet(documents_fts, 0, '<mark>', '</mark>', ' ... ', 12) AS snippet"
            )
            if sort in ("date", "pertinence"):
                order = "bm25(documents_fts), d.document_date DESC"

    if date_from:
        where.append("d.document_date >= ?")
        params.append(date_from)
    if date_to:
        where.append("d.document_date <= ?")
        params.append(date_to)
    if correspondent:
        where.append("d.correspondent LIKE ?")
        params.append(f"%{correspondent}%")
    if status == "ok":
        where.append("d.ocr_status IN ('ok', 'skipped-has-text')")
    elif status == "failed":
        where.append("d.ocr_status = 'failed'")
    if progress in ("todo", "ongoing", "done"):
        where.append("d.progress = ?")
        params.append(progress)

    if sort == "added" and not deleted:
        order = "d.added_at DESC"

    where_sql = " AND ".join(where)

    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM documents d {joins} WHERE {where_sql}", params
    ).fetchone()["n"]

    page = max(1, page)
    page_size = max(1, min(500, page_size))
    rows = conn.execute(
        f"""
        SELECT d.*, {select_snippet}
        FROM documents d {joins}
        WHERE {where_sql}
        ORDER BY {order}
        LIMIT ? OFFSET ?
        """,
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    return [dict(r) for r in rows], int(total)


def get_document(conn: sqlite3.Connection, doc_id: int,
                 include_deleted: bool = False) -> dict | None:
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d["deleted_at"] and not include_deleted:
        return None
    return d


def soft_delete(conn: sqlite3.Connection, doc_id: int) -> None:
    conn.execute(
        "UPDATE documents SET deleted_at = ? WHERE id = ?", (now_iso(), doc_id)
    )
    delete_fts(conn, doc_id)


def restore(conn: sqlite3.Connection, doc_id: int) -> None:
    conn.execute("UPDATE documents SET deleted_at = NULL WHERE id = ?", (doc_id,))


def purge(conn: sqlite3.Connection, doc_id: int) -> None:
    """Suppression définitive de la ligne (la corbeille)."""
    delete_fts(conn, doc_id)
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))


def trashed_ids(conn: sqlite3.Connection) -> list[int]:
    return [
        r["id"] for r in
        conn.execute("SELECT id FROM documents WHERE deleted_at IS NOT NULL")
    ]


def retryable_failures(conn: sqlite3.Connection, older_than_iso: str) -> list[dict]:
    """Courriers en échec à retenter (moins de MAX_OCR_ATTEMPTS, pas trop récents)."""
    rows = conn.execute(
        """
        SELECT * FROM documents
        WHERE ocr_status = 'failed' AND deleted_at IS NULL
          AND ocr_attempts < ?
          AND (last_attempt_at IS NULL OR last_attempt_at < ?)
        ORDER BY id
        """,
        (MAX_OCR_ATTEMPTS, older_than_iso),
    ).fetchall()
    return [dict(r) for r in rows]


def stats(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        """
        SELECT
            SUM(CASE WHEN deleted_at IS NULL AND ocr_status != 'failed'
                     THEN 1 ELSE 0 END)                              AS total,
            SUM(CASE WHEN deleted_at IS NULL AND ocr_status = 'failed'
                     THEN 1 ELSE 0 END)                              AS failed,
            SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END)  AS trashed,
            MAX(added_at)                                            AS last_added
        FROM documents
        """
    ).fetchone()
    reocr = conn.execute("SELECT COUNT(*) AS n FROM reocr_jobs").fetchone()["n"]
    return {
        "total": row["total"] or 0,
        "failed": row["failed"] or 0,
        "trashed": row["trashed"] or 0,
        "last_added": row["last_added"],
        "reprocessing": reocr,
    }


# --------------------------------------------------------------------------- #
#  File de ré-OCR                                                             #
# --------------------------------------------------------------------------- #
def enqueue_reocr(conn: sqlite3.Connection, doc_id: int, language: str) -> None:
    conn.execute(
        "INSERT INTO reocr_jobs (document_id, language, requested_at) "
        "VALUES (?, ?, ?)",
        (doc_id, language, now_iso()),
    )


def take_reocr_jobs(conn: sqlite3.Connection, limit: int = 5) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM reocr_jobs ORDER BY id LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def delete_reocr_job(conn: sqlite3.Connection, job_id: int) -> None:
    conn.execute("DELETE FROM reocr_jobs WHERE id = ?", (job_id,))
