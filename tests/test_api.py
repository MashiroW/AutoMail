from courriers_ocr import db
from courriers_ocr.ingest import rel, reprocess_failed_doc

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


def test_delete_deplace_en_corbeille(cfg, drop_letter, ingest, client):
    drop_letter("apoubelle", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    assert client.delete(f"/api/documents/{doc_id}").status_code == 200
    assert client.get(f"/api/documents/{doc_id}").status_code == 404
    assert any((cfg.trash_dir / str(doc_id)).glob("*.pdf"))


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


def test_reponse_web_racine(client):
    assert client.get("/").status_code == 200
