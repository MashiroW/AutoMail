from datetime import date

import pytest

from courriers_ocr.dates import extract_document_date

TODAY = date(2026, 9, 1)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Paris, le 12 mars 2024\n\nObjet : votre facture", "2024-03-12"),
        ("Nous vous écrivons le 12/03/2024 au sujet de…", "2024-03-12"),
        ("Rechnung vom 03.12.2024\nSehr geehrte Damen und Herren", "2024-12-03"),
        ("Référence 2024-03-12 / dossier 88", "2024-03-12"),
        ("15. Januar 2023\nBetreff: Vertrag", "2023-01-15"),
        ("Lyon, le 5 juin 2024", "2024-06-05"),
        ("EDF\n\n01/02/2026\nBonjour,", "2026-02-01"),
        # abréviations et variantes
        ("Fait à Lille le 1er sept. 2023", "2023-09-01"),
        ("Le 4 déc 2024,\nMadame,", "2024-12-04"),
        ("Toulouse, le 09.06.2025", "2025-06-09"),
        ("Date : 7 avril 24", "2024-04-07"),
        # bruit OCR : lettres à la place de chiffres
        ("Paris, le l2/o3/2o24", "2024-03-12"),
        ("Berlin, den 3. Marz 2024", "2024-03-03"),
    ],
)
def test_extraction_ok(text, expected):
    assert extract_document_date(text, today=TODAY) == expected


def test_pas_de_date():
    assert extract_document_date("Bonjour,\nun courrier sans aucune date ici.", TODAY) is None


def test_annee_hors_plage():
    assert extract_document_date("Courrier du 01/01/1990", TODAY) is None
    assert extract_document_date("Le 01/01/2099", TODAY) is None


def test_repli_sur_le_corps_si_entete_sans_date():
    # si l'en-tête n'a pas de date, on cherche dans tout le texte
    corps = "\n".join(f"ligne de contenu numero {i}" for i in range(50))
    text = "En-tete sans date\n" + corps + "\nSigné le 04/05/2024"
    assert extract_document_date(text, TODAY) == "2024-05-04"


def test_date_la_plus_haute_gagne():
    text = (
        "Direction generale des Finances publiques\n"
        "Le 05/09/2023\n"
        "Avis d'impot 2023\n"
        "Date limite de paiement : 25 septembre 2023\n"
    )
    assert extract_document_date(text, TODAY) == "2023-09-05"


def test_position_avant_format():
    text = "Paris, le 3 avril 2024\nRef 99/99/9999 12/12/2012"
    assert extract_document_date(text, TODAY) == "2024-04-03"


def test_chaine_vide():
    assert extract_document_date("", TODAY) is None
