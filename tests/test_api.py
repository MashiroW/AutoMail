from courriers_ocr import db
from courriers_ocr.ingest import rel

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
    assert s["disk_total_bytes"] > 0


def test_patch_tags_et_date_manuelle(cfg, drop_letter, ingest, client):
    drop_letter("courrier", LETTER)
    ingest()
    doc_id = client.get("/api/documents").json()["items"][0]["id"]

    r = client.patch(
        f"/api/documents/{doc_id}",
        json={"tags": ["impôts", "2024"], "correspondent": "EDF",
              "document_date": "2024-02-01", "title": "Facture février"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["document_date"] == "2024-02-01"
    assert body["document_date_source"] == "manual"
    assert set(body["tags"]) == {"impôts", "2024"}

    # recherche par tag
    got = client.get("/api/documents", params={"tag": "impôts"}).json()
    assert got["total"] == 1


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


def test_retry_renvoie_dans_l_inbox(cfg, conn, client):
    # simule un courrier en échec dont l'original est encore sur le disque
    failed = cfg.failed_dir / "rate.pdf"
    failed.write_bytes(b"%PDF-1.4 rate")
    doc_id = db.insert_document(
        conn,
        original_filename="rate.pdf",
        original_path=rel(cfg, failed),
        title="rate",
        ocr_status="failed",
    )
    r = client.post(f"/api/documents/{doc_id}/retry")
    assert r.status_code == 200
    assert list(cfg.inbox.glob("retry_*.pdf"))
    assert client.get(f"/api/documents/{doc_id}").status_code == 404


def test_reponse_web_racine(client):
    assert client.get("/").status_code == 200
