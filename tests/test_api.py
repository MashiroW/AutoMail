from courriers_ocr import db
from courriers_ocr.ingest import ocr_pending_doc, register_file, rel, reprocess_failed_doc

LETTER = """Paris, le 14 février 2024

Objet : votre facture d'électricité

Madame, Monsieur,
Veuillez trouver ci-joint votre facture EDF d'un montant de 82,40 EUR.
Cordialement.
"""


def test_pipeline_complet_puis_recherche(cfg, drop_letter, ingest, client):
    drop_letter("facture-edf", LETTER)
    ingest()

    r = client.get("/api/documents", params={"q": "électricité"})
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 1
    item = data["items"][0]
    assert item["document_date"] == "2024-02-14"
    assert "<mark>" in (item["snippet"] or "")

    # l'inbox a été vidée
    assert not (cfg.inbox / "facture-edf.pdf").exists()


def test_stats(cfg, drop_letter, ingest, client):
    drop_letter("a", LETTER, pdf_bytes=b"%PDF-1.4 aaa\n%%EOF")
    drop_letter("b", LETTER.replace("14 février 2024", "3 mars 2024"),
                pdf_bytes=b"%PDF-1.4 bbb\n%%EOF")
    ingest()
    s = client.get("/api/stats").json()
    assert s["total"] == 2
    assert s["failed"] == 0
    assert s["pending"] == 0 and s["reprocessing"] == 0
    assert s["disk_total_bytes"] > 0
    assert "cpu_temp_c" in s  # None hors Raspberry Pi


def test_patch_correspondant_et_date_manuelle(cfg, drop_letter, ingest, client):
    drop_letter("courrier", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    r = client.patch(
        f"/api/documents/{doc_id}",
        json={"correspondent": "EDF", "document_date": "2024-02-01",
              "title": "Facture février"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["document_date"] == "2024-02-01"
    assert body["document_date_source"] == "manual"
    assert body["correspondent"] == "EDF"

    # correspondant filtrable + cherchable en plein texte
    assert client.get("/api/documents", params={"correspondent": "edf"}).json()["total"] == 1
    assert client.get("/api/documents", params={"q": "EDF"}).json()["total"] == 1


def test_patch_date_invalide(cfg, drop_letter, ingest, client):
    drop_letter("c", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]
    r = client.patch(f"/api/documents/{doc_id}", json={"document_date": "01-02-2024"})
    assert r.status_code == 422


def test_download_renvoie_l_original(cfg, drop_letter, ingest, client):
    pdf = drop_letter("scan", LETTER)
    original_bytes = pdf.read_bytes()
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    r = client.get(f"/api/documents/{doc_id}/download")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers["content-disposition"]
    assert r.content == original_bytes


def test_reocr_cree_un_job(cfg, drop_letter, ingest, client, conn):
    drop_letter("de", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    r = client.post(f"/api/documents/{doc_id}/reocr", json={"language": "deu"})
    assert r.status_code == 200
    jobs = db.take_reocr_jobs(conn)
    assert jobs and jobs[0]["document_id"] == doc_id and jobs[0]["language"] == "deu"


def test_reocr_langue_invalide(cfg, drop_letter, ingest, client):
    drop_letter("x", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]
    r = client.post(f"/api/documents/{doc_id}/reocr", json={"language": "klingon"})
    assert r.status_code == 422


def test_corbeille_supprimer_restaurer_vider(cfg, drop_letter, ingest, client):
    drop_letter("apoubelle", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    # supprimer -> corbeille
    assert client.delete(f"/api/documents/{doc_id}").status_code == 200
    assert client.get(f"/api/documents/{doc_id}").status_code == 404
    assert list((cfg.trash_dir / str(doc_id)).rglob("*.pdf"))
    assert client.get("/api/documents").json()["total"] == 0

    # onglet corbeille
    trash = client.get("/api/documents", params={"status": "trash"}).json()
    assert trash["total"] == 1 and trash["items"][0]["id"] == doc_id

    # restaurer
    assert client.post(f"/api/documents/{doc_id}/restore").status_code == 200
    assert client.get("/api/documents").json()["total"] == 1
    assert not (cfg.trash_dir / str(doc_id)).exists()
    # cherchable de nouveau (réindexé)
    assert client.get("/api/documents", params={"q": "électricité"}).json()["total"] == 1

    # re-supprimer puis vider la corbeille
    client.delete(f"/api/documents/{doc_id}")
    r = client.post("/api/trash/empty")
    assert r.status_code == 200 and r.json()["count"] == 1
    assert client.get("/api/documents", params={"status": "trash"}).json()["total"] == 0
    assert client.get(f"/api/documents/{doc_id}").status_code == 404


def test_purge_definitif(cfg, drop_letter, ingest, client):
    drop_letter("purge", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]
    client.delete(f"/api/documents/{doc_id}")
    assert client.delete(f"/api/documents/{doc_id}/purge").status_code == 200
    assert not (cfg.trash_dir / str(doc_id)).exists()
    # purge d'un courrier non supprimé -> 404
    drop_letter("vivant", LETTER, pdf_bytes=b"%PDF-1.4 v\n%%EOF")
    ingest()
    live = client.get("/api/documents").json()["items"][0]["id"]
    assert client.delete(f"/api/documents/{live}/purge").status_code == 404


def _make_failed(cfg, conn, name="rate", attempts=3):
    failed = cfg.failed_dir / f"{name}.pdf"
    failed.write_bytes(b"%PDF-1.4 rate\n%%EOF")
    (cfg.failed_dir / f"{name}.txt").write_text(
        "Lyon, le 9 janvier 2025\nRelance de paiement", encoding="utf-8"
    )
    return db.insert_document(
        conn, sha256=None, original_filename=f"{name}.pdf",
        original_path=rel(cfg, failed), title=name,
        ocr_status="failed", ocr_attempts=attempts, last_attempt_at="2000-01-01T00:00:00",
        notes="boom",
    )


def test_retry_remet_le_compteur_a_zero(cfg, conn, client):
    doc_id = _make_failed(cfg, conn, attempts=3)
    assert client.post(f"/api/documents/{doc_id}/retry").status_code == 200
    got = client.get(f"/api/documents/{doc_id}").json()
    assert got["ocr_attempts"] == 0 and got["ocr_status"] == "failed"


def test_courrier_en_echec_ouvrable_et_raison_visible(cfg, conn, client):
    doc_id = _make_failed(cfg, conn, attempts=1)
    d = client.get(f"/api/documents/{doc_id}").json()
    assert d["notes"] == "boom"                       # raison de l'échec exposée
    # aperçu + téléchargement possibles (l'original est sur le disque)
    assert client.get(f"/api/documents/{doc_id}/pdf").status_code == 200
    assert client.get(f"/api/documents/{doc_id}/download").status_code == 200
    # filtre « en échec »
    assert client.get("/api/documents", params={"status": "failed"}).json()["total"] == 1


def test_auto_retry_recupere_un_echec(cfg, conn, client):
    doc_id = _make_failed(cfg, conn, attempts=0)
    doc = db.get_document(conn, doc_id, include_deleted=True)
    ok = reprocess_failed_doc(conn, cfg, doc)
    assert ok is True
    fresh = client.get(f"/api/documents/{doc_id}").json()
    assert fresh["ocr_status"] == "ok"
    assert fresh["document_date"] == "2025-01-09"
    assert fresh["ocr_attempts"] == 1


def test_auto_retry_abandonne_apres_3(cfg, conn):
    from courriers_ocr.worker import auto_retry_failed
    _make_failed(cfg, conn, attempts=3)   # déjà au plafond
    assert auto_retry_failed(conn, cfg) == 0


def test_inbox_rescannee_pendant_le_backlog(cfg, conn, drop_letter, monkeypatch):
    """Un courrier déposé PENDANT le traitement d'un lot doit être enregistré et
    traité dans la même passe — pas seulement au prochain cycle (bug : total figé
    puis qui saute d'un coup)."""
    from courriers_ocr import worker

    drop_letter("a", "Paris, le 1 mars 2024\nun", pdf_bytes=b"%PDF-1.4 a\n%%EOF")
    drop_letter("b", "Paris, le 2 mars 2024\ndeux", pdf_bytes=b"%PDF-1.4 b\n%%EOF")

    real = worker.ocr_pending_doc
    dropped: list = []

    def spy(c, cf, doc_id):
        if not dropped:                       # au 1er OCR, un nouveau scan arrive
            dropped.append(drop_letter(
                "c", "Paris, le 3 mars 2024\ntrois", pdf_bytes=b"%PDF-1.4 c\n%%EOF"))
        return real(c, cf, doc_id)

    monkeypatch.setattr(worker, "ocr_pending_doc", spy)
    worker.scan_once(conn, cfg, {})

    rows = conn.execute("SELECT original_filename, ocr_status FROM documents").fetchall()
    assert {r["original_filename"] for r in rows} == {"a.pdf", "b.pdf", "c.pdf"}
    assert all(r["ocr_status"] == "ok" for r in rows)


def test_reingestion_apres_suppression(cfg, drop_letter, ingest, client):
    drop_letter("revient", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]
    assert client.delete(f"/api/documents/{doc_id}").status_code == 200

    # le même fichier redéposé doit être ré-indexé, pas rejeté comme doublon
    drop_letter("revient", LETTER)
    ingest()
    listing = client.get("/api/documents", params={"q": "électricité"}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["ocr_status"] == "ok"


def test_bulk_corbeille_et_restauration(cfg, drop_letter, ingest, client):
    for i, n in enumerate(("a", "b", "c")):
        drop_letter(n, LETTER, pdf_bytes=f"%PDF-1.4 {n}\n%%EOF".encode())
    ingest()
    ids = [d["id"] for d in client.get("/api/documents").json()["items"]]
    assert len(ids) == 3

    # sélection multiple -> corbeille
    r = client.post("/api/bulk", json={"ids": ids[:2], "action": "trash"})
    assert r.status_code == 200 and r.json()["done"] == 2
    assert client.get("/api/documents").json()["total"] == 1
    assert client.get("/api/documents", params={"status": "trash"}).json()["total"] == 2

    # restauration groupée
    r = client.post("/api/bulk", json={"ids": ids[:2], "action": "restore"})
    assert r.json()["done"] == 2
    assert client.get("/api/documents").json()["total"] == 3

    # purge groupée depuis la corbeille
    client.post("/api/bulk", json={"ids": ids, "action": "trash"})
    r = client.post("/api/bulk", json={"ids": ids, "action": "purge"})
    assert r.json()["done"] == 3
    assert client.get("/api/documents", params={"status": "trash"}).json()["total"] == 0

    # action inconnue
    assert client.post("/api/bulk", json={"ids": [1], "action": "x"}).status_code == 422


def test_progress_defaut_et_patch_et_filtre(cfg, drop_letter, ingest, client):
    for n in ("p1", "p2"):
        drop_letter(n, LETTER, pdf_bytes=f"%PDF-1.4 {n}\n%%EOF".encode())
    ingest()
    items = client.get("/api/documents").json()["items"]
    assert all(d["progress"] == "done" for d in items)   # défaut = fait
    a, b = items[0]["id"], items[1]["id"]

    assert client.patch(f"/api/documents/{a}", json={"progress": "ongoing"}).json()["progress"] == "ongoing"
    assert client.patch(f"/api/documents/{a}", json={"progress": "nope"}).status_code == 422

    got = client.get("/api/documents", params={"progress": "ongoing"}).json()
    assert got["total"] == 1 and got["items"][0]["id"] == a


def test_bulk_progress_et_download(cfg, drop_letter, ingest, client):
    for n in ("d1", "d2", "d3"):
        drop_letter(n, LETTER, pdf_bytes=f"%PDF-1.4 {n}\n%%EOF".encode())
    ingest()
    ids = [d["id"] for d in client.get("/api/documents").json()["items"]]

    r = client.post("/api/bulk",
                    json={"ids": ids, "action": "progress", "value": "todo"})
    assert r.status_code == 200 and r.json()["done"] == 3
    assert client.get("/api/documents", params={"progress": "todo"}).json()["total"] == 3
    assert client.post("/api/bulk",
                       json={"ids": ids, "action": "progress", "value": "x"}).status_code == 422

    import io, zipfile
    r = client.get("/api/bulk/download", params={"ids": ",".join(map(str, ids))})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert len(zf.namelist()) == 3


def test_courrier_visible_avant_ocr(cfg, conn, client):
    pdf = cfg.inbox / "avantocr.pdf"
    pdf.write_bytes(b"%PDF-1.4 en attente\n%%EOF")
    (cfg.inbox / "avantocr.txt").write_text("Paris, le 4 mars 2024\ntexte", encoding="utf-8")

    doc_id = register_file(conn, cfg, pdf)          # phase 1 seulement
    assert doc_id is not None

    d = client.get(f"/api/documents/{doc_id}").json()
    assert d["ocr_status"] == "pending"

    # visible dans "non traités" et "tous", pas dans "traités"
    assert client.get("/api/documents", params={"status": "pending"}).json()["total"] == 1
    assert client.get("/api/documents", params={"status": "all"}).json()["total"] == 1
    assert client.get("/api/documents", params={"status": "ok"}).json()["total"] == 0

    # déjà téléchargeable et prévisualisable (l'aperçu retombe sur l'original)
    assert client.get(f"/api/documents/{doc_id}/download").status_code == 200
    r = client.get(f"/api/documents/{doc_id}/pdf")
    assert r.status_code == 200 and r.content == b"%PDF-1.4 en attente\n%%EOF"

    # après l'OCR -> "traités" + durée de traitement enregistrée
    ocr_pending_doc(conn, cfg, doc_id)
    done = client.get(f"/api/documents/{doc_id}").json()
    assert done["ocr_status"] == "ok"
    assert done["ocr_seconds"] is not None and done["ocr_seconds"] >= 0
    assert client.get("/api/documents", params={"status": "pending"}).json()["total"] == 0


def test_version(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    assert set(r.json()) == {"commit", "subject", "date", "dirty"}


def test_overview(cfg, drop_letter, ingest, client):
    for i, n in enumerate(("o1", "o2", "o3")):
        drop_letter(n, LETTER, pdf_bytes=f"%PDF-1.4 {n}\n%%EOF".encode())
    ingest()
    ids = [d["id"] for d in client.get("/api/documents").json()["items"]]
    client.patch(f"/api/documents/{ids[0]}", json={"progress": "todo"})

    o = client.get("/api/overview").json()
    assert o["total"] == 3
    assert o["by_ocr"]["ok"] == 3 and o["by_ocr"]["failed"] == 0
    assert o["by_progress"]["todo"] == 1 and o["by_progress"]["done"] == 2
    assert sum(m["count"] for m in o["by_month"]) == 3
    assert o["disk_total_bytes"] > 0


def test_reponse_web_racine(client):
    assert client.get("/").status_code == 200
