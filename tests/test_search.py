from courriers_ocr import db


def _add(conn, *, text, title, correspondent=None, document_date=None, tags=()):
    doc_id = db.insert_document(
        conn,
        original_filename=title + ".pdf",
        title=title,
        correspondent=correspondent,
        document_date=document_date,
        document_date_source="auto" if document_date else None,
        ocr_status="ok",
    )
    db.set_fts(conn, doc_id, text, title, correspondent)
    if tags:
        db.set_tags(conn, doc_id, tags)
    return doc_id


def test_recherche_plein_texte(conn):
    _add(conn, text="Votre facture EDF electricite du mois", title="EDF")
    _add(conn, text="Rappel de cotisation mutuelle", title="Mutuelle")
    _add(conn, text="Facture internet et telephone", title="Orange")

    items, total = db.search_documents(conn, q="facture")
    titres = {i["title"] for i in items}
    assert total == 2
    assert titres == {"EDF", "Orange"}


def test_recherche_insensible_aux_accents(conn):
    _add(conn, text="Le règlement intérieur de la copropriété", title="Syndic")
    items, total = db.search_documents(conn, q="reglement copropriete")
    assert total == 1 and items[0]["title"] == "Syndic"


def test_prefixe(conn):
    _add(conn, text="Convocation assemblée générale", title="AG")
    items, _ = db.search_documents(conn, q="convoc")
    assert len(items) == 1


def test_filtre_par_plage_de_dates(conn):
    _add(conn, text="a", title="Jan", document_date="2024-01-15")
    _add(conn, text="b", title="Juin", document_date="2024-06-10")
    _add(conn, text="c", title="Dec", document_date="2024-12-20")

    items, total = db.search_documents(
        conn, date_from="2024-05-01", date_to="2024-09-30"
    )
    assert total == 1 and items[0]["title"] == "Juin"


def test_filtre_par_tag_et_correspondant(conn):
    _add(conn, text="x", title="Impots", correspondent="DGFiP", tags=["fiscal", "2024"])
    _add(conn, text="y", title="Banque", correspondent="Crédit Agricole", tags=["banque"])

    items, total = db.search_documents(conn, tag="fiscal")
    assert total == 1 and items[0]["title"] == "Impots"

    items, total = db.search_documents(conn, correspondent="agricole")
    assert total == 1 and items[0]["title"] == "Banque"


def test_tri_par_date_desc_par_defaut(conn):
    _add(conn, text="a", title="Vieux", document_date="2020-01-01")
    _add(conn, text="b", title="Recent", document_date="2025-01-01")
    _add(conn, text="c", title="SansDate")

    items, _ = db.search_documents(conn, sort="date")
    assert [i["title"] for i in items[:2]] == ["Recent", "Vieux"]


def test_pagination(conn):
    for i in range(25):
        _add(conn, text=f"courrier {i}", title=f"C{i:02d}", document_date="2024-01-01")
    page1, total = db.search_documents(conn, page=1, page_size=10)
    page3, _ = db.search_documents(conn, page=3, page_size=10)
    assert total == 25
    assert len(page1) == 10 and len(page3) == 5


def test_soft_delete_exclut_des_resultats(conn):
    doc_id = _add(conn, text="secret", title="ASupprimer")
    db.soft_delete(conn, doc_id)
    items, total = db.search_documents(conn, q="secret")
    assert total == 0
