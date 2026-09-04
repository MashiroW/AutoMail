"use strict";

const $ = (s) => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const isMobile = () => matchMedia("(max-width: 860px)").matches;

const state = {
  page: 1,
  pageSize: Number(LS.get("pageSize", 50)) || 50,
  view: LS.get("view", "detail"),
  nav: "mail",
  lang: LS.get("lang", (navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr"),
  progFilter: "",
  trash: false,
  filtersOpen: false,
  selectMode: false,
  selected: new Set(),
  statsSig: null,
  renderSig: null,
  dashSig: null,
  lastInFlight: 0,
  avgSecPerPage: null,
};

// ===================== i18n ===================== //
const T = {
  fr: {
    "nav.mail": "Courriers", "nav.dash": "Tableau de bord",
    "head.update": "Mise à jour", "head.update.tip": "Mettre à jour depuis GitHub",
    "head.theme": "Thème clair / sombre",
    "skin.night": "Nuit", "skin.paper": "Papier", "skin.corporate": "Corporate",
    "filters.toggle": "Filtres", "filters.title": "Filtres", "filters.close": "Fermer",
    "filters.search_ph": "Rechercher dans le texte des courriers…",
    "filters.dates": "Date du courrier", "filters.from": "du", "filters.to": "au",
    "filters.ocr": "État de l'OCR", "filters.track": "Suivi", "filters.sort": "Tri",
    "filters.nodate": "sans date détectée",
    "filters.nodate_hint": "Uniquement les courriers dont l'OCR n'a pas trouvé de date",
    "filters.apply": "Rechercher", "filters.reset": "Réinitialiser",
    "ocr.all": "tous", "ocr.ok": "traités", "ocr.pending": "en attente",
    "ocr.processing": "en cours", "ocr.failed": "échecs",
    "prog.all": "Tous", "prog.todo": "À faire", "prog.ongoing": "En cours", "prog.done": "Fait",
    "sort.date": "Date du courrier (récent → ancien)",
    "sort.date_asc": "Date du courrier (ancien → récent)",
    "sort.added": "Date d'import (récent → ancien)",
    "sort.added_asc": "Date d'import (ancien → récent)",
    "sort.pertinence": "Pertinence",
    "view.list": "Liste", "view.detail": "Détail", "view.tiles": "Tuiles", "view.trash": "Corbeille",
    "select.start": "Sélectionner", "select.stop": "Quitter la sélection",
    "trash.empty": "Vider la corbeille",
    "pager.info": "Page {page} / {pages} — {total} courrier(s)", "pager.per_page": "par page",
    "empty.none": "Aucun courrier trouvé.", "empty.trash": "La corbeille est vide.",
    "err": "Erreur : {msg}",
    "badge.pending": "en attente d'OCR", "badge.processing": "OCR en cours…",
    "badge.rescan": "fichier incomplet — à re-scanner", "badge.failed": "échec OCR ({n}×)",
    "badge.lang": "langue ? {lang}", "badge.nodate": "date non détectée",
    "meta.pages": "{n} p.", "meta.scan": "num. {when}", "meta.scan_tip": "date de numérisation (nom du fichier scanner)",
    "act.preview": "Aperçu", "act.download": "Télécharger", "act.edit": "Modifier",
    "act.retry": "Réessayer", "act.restore": "Restaurer", "act.delete": "Supprimer",
    "prog.tip": "Changer l'avancement",
    "stats.mail": "<b>{n}</b> courrier{s}", "stats.done": "dont <b>{n}</b> traité{s}",
    "stats.pending": "{n} en attente", "stats.processing": "{n} en cours",
    "stats.reprocessing": "{n} en ré-OCR", "stats.failed": "{n} en échec",
    "stats.free": "{n} Go libres",
    "preview.title": "Aperçu", "preview.open": "Ouvrir", "preview.download": "Télécharger l'original",
    "preview.close": "Fermer", "preview.open_full": "Ouvrir le PDF en plein écran",
    "preview.mobile_hint": "L'aperçu intégré ne défile pas bien sur mobile.",
    "editor.title": "Modifier le courrier",
    "editor.f.title": "Titre", "editor.f.date": "Date du courrier",
    "editor.f.progress": "Avancement", "editor.f.notes": "Notes",
    "editor.reocr": "Relancer l'OCR :", "editor.delete": "Supprimer",
    "editor.cancel": "Annuler", "editor.save": "Enregistrer",
    "lang.fra": "Français", "lang.deu": "Allemand", "lang.ara": "Arabe",
    "ei.file": "Fichier", "ei.scanned": "Numérisé le", "ei.added": "Ajouté le",
    "ei.pages": "Pages", "ei.size": "Taille", "ei.ocr": "OCR", "ei.proc": "Traitement OCR",
    "ei.per_page": "~{d}/page", "ei.in_progress": "en cours…", "ei.date": "Date",
    "ei.date_manual": "saisie", "ei.date_auto": "détectée", "ei.error": "Erreur",
    "lg.francais": "français", "lg.allemand": "allemand", "lg.arabe": "arabe", "lg.anglais": "anglais",
    "os.pending": "en attente", "os.processing": "en cours", "os.ok": "OK",
    "os.skipped": "texte conservé", "os.failed": "échec",
    "sel.count": "{n} sélectionné{s}", "sel.all_page": "Toute la page",
    "sel.dl_zip": "Télécharger (ZIP)", "sel.progress_ph": "Avancement…",
    "sel.trash": "Corbeille", "sel.restore": "Restaurer", "sel.purge": "Supprimer définitivement",
    "sel.done": "Terminer",
    "confirm.bulk": "{n} courrier(s) — {action} ?",
    "confirm.trash_one": "Déplacer ce courrier dans la corbeille ?",
    "confirm.purge_one": "Supprimer définitivement ? (irréversible)",
    "confirm.empty_trash": "Vider la corbeille ? Suppression définitive de tout son contenu.",
    "ba.trash": "déplacer vers la corbeille", "ba.restore": "restaurer",
    "ba.purge": "supprimer DÉFINITIVEMENT", "ba.progress": "changer l'avancement",
    "toast.saved": "Enregistré", "toast.reocr": "Ré-OCR ({lang}) en file d'attente",
    "toast.trashed": "Déplacé dans la corbeille", "toast.restored": "Restauré",
    "toast.deleted": "Supprimé", "toast.trash_emptied": "Corbeille vidée ({n})",
    "toast.retry": "Sera retenté automatiquement",
    "toast.bulk": "{n} traité(s)", "toast.bulk_err": " · {n} erreur(s)",
    "upd.title": "Mise à jour depuis GitHub", "upd.run": "Lancer la mise à jour",
    "upd.restart": "Redémarrer les services", "upd.reload": "Recharger la page",
    "upd.current": "Version actuelle : {commit} — {subject} ({date})",
    "upd.local_changes": " · modifs locales", "upd.current_unknown": "Version actuelle : inconnue",
    "upd.doing": "en cours…", "upd.done": "terminé", "upd.err": "\n[erreur : {msg}]\n",
    "upd.restarting": "redémarrage…",
    "upd.restart_fail": "\n[échec du redémarrage : {err}]\nSur le Pi : sudo systemctl restart automail-worker automail-web\n",
    "upd.restart_go": "\nRedémarrage en cours…\n",
    "upd.back": "\n✅ Services redémarrés. Recharge l'interface : Ctrl + Maj + R (ou le bouton).\n",
    "upd.slow": "\nLe service met du temps à revenir. Recharge dans un instant (Ctrl + Maj + R).\n",
    "upd.uptodate": "à jour",
    "dash.mail": "Courriers", "dash.this_month": "{n} ce mois-ci",
    "dash.failed_ocr": "En échec OCR", "dash.pending": "{n} en attente",
    "dash.trash": "Corbeille", "dash.not_counted": "non comptés dans le total",
    "dash.storage": "Stockage", "dash.of_gb": "sur {n} Go",
    "dash.by_month": "Courriers par mois", "dash.no_data": "Pas encore de données.",
    "dash.progress": "Avancement", "dash.ocr_state": "État de l'OCR",
    "dash.ok": "Traités", "dash.notproc": "Non traités", "dash.errors": "Échecs",
  },
  en: {
    "nav.mail": "Mail", "nav.dash": "Dashboard",
    "head.update": "Update", "head.update.tip": "Update from GitHub",
    "head.theme": "Light / dark theme",
    "skin.night": "Night", "skin.paper": "Paper", "skin.corporate": "Corporate",
    "filters.toggle": "Filters", "filters.title": "Filters", "filters.close": "Close",
    "filters.search_ph": "Search the letter text…",
    "filters.dates": "Letter date", "filters.from": "from", "filters.to": "to",
    "filters.ocr": "OCR status", "filters.track": "Follow-up", "filters.sort": "Sort",
    "filters.nodate": "no date detected",
    "filters.nodate_hint": "Only letters where OCR found no date",
    "filters.apply": "Search", "filters.reset": "Reset",
    "ocr.all": "all", "ocr.ok": "done", "ocr.pending": "queued",
    "ocr.processing": "running", "ocr.failed": "failed",
    "prog.all": "All", "prog.todo": "To do", "prog.ongoing": "In progress", "prog.done": "Done",
    "sort.date": "Letter date (newest first)",
    "sort.date_asc": "Letter date (oldest first)",
    "sort.added": "Import date (newest first)",
    "sort.added_asc": "Import date (oldest first)",
    "sort.pertinence": "Relevance",
    "view.list": "List", "view.detail": "Detail", "view.tiles": "Tiles", "view.trash": "Trash",
    "select.start": "Select", "select.stop": "Exit selection",
    "trash.empty": "Empty trash",
    "pager.info": "Page {page} / {pages} — {total} letter(s)", "pager.per_page": "per page",
    "empty.none": "No letters found.", "empty.trash": "The trash is empty.",
    "err": "Error: {msg}",
    "badge.pending": "waiting for OCR", "badge.processing": "OCR running…",
    "badge.rescan": "incomplete file — re-scan it", "badge.failed": "OCR failed ({n}×)",
    "badge.lang": "language? {lang}", "badge.nodate": "no date detected",
    "meta.pages": "{n} pg.", "meta.scan": "scan {when}", "meta.scan_tip": "scan date (from the scanner's file name)",
    "act.preview": "Preview", "act.download": "Download", "act.edit": "Edit",
    "act.retry": "Retry", "act.restore": "Restore", "act.delete": "Delete",
    "prog.tip": "Change follow-up status",
    "stats.mail": "<b>{n}</b> letter{s}", "stats.done": "incl. <b>{n}</b> done",
    "stats.pending": "{n} queued", "stats.processing": "{n} running",
    "stats.reprocessing": "{n} re-OCR", "stats.failed": "{n} failed",
    "stats.free": "{n} GB free",
    "preview.title": "Preview", "preview.open": "Open", "preview.download": "Download original",
    "preview.close": "Close", "preview.open_full": "Open the PDF full screen",
    "preview.mobile_hint": "The embedded preview does not scroll well on mobile.",
    "editor.title": "Edit letter",
    "editor.f.title": "Title", "editor.f.date": "Letter date",
    "editor.f.progress": "Follow-up", "editor.f.notes": "Notes",
    "editor.reocr": "Re-run OCR:", "editor.delete": "Delete",
    "editor.cancel": "Cancel", "editor.save": "Save",
    "lang.fra": "French", "lang.deu": "German", "lang.ara": "Arabic",
    "ei.file": "File", "ei.scanned": "Scanned on", "ei.added": "Added on",
    "ei.pages": "Pages", "ei.size": "Size", "ei.ocr": "OCR", "ei.proc": "OCR time",
    "ei.per_page": "~{d}/page", "ei.in_progress": "running…", "ei.date": "Date",
    "ei.date_manual": "manual", "ei.date_auto": "detected", "ei.error": "Error",
    "lg.francais": "French", "lg.allemand": "German", "lg.arabe": "Arabic", "lg.anglais": "English",
    "os.pending": "queued", "os.processing": "running", "os.ok": "OK",
    "os.skipped": "text kept", "os.failed": "failed",
    "sel.count": "{n} selected", "sel.all_page": "Whole page",
    "sel.dl_zip": "Download (ZIP)", "sel.progress_ph": "Follow-up…",
    "sel.trash": "Trash", "sel.restore": "Restore", "sel.purge": "Delete permanently",
    "sel.done": "Done",
    "confirm.bulk": "{n} letter(s) — {action}?",
    "confirm.trash_one": "Move this letter to the trash?",
    "confirm.purge_one": "Delete permanently? (cannot be undone)",
    "confirm.empty_trash": "Empty the trash? Everything in it is deleted for good.",
    "ba.trash": "move to trash", "ba.restore": "restore",
    "ba.purge": "delete PERMANENTLY", "ba.progress": "change follow-up",
    "toast.saved": "Saved", "toast.reocr": "Re-OCR ({lang}) queued",
    "toast.trashed": "Moved to trash", "toast.restored": "Restored",
    "toast.deleted": "Deleted", "toast.trash_emptied": "Trash emptied ({n})",
    "toast.retry": "Will be retried automatically",
    "toast.bulk": "{n} done", "toast.bulk_err": " · {n} error(s)",
    "upd.title": "Update from GitHub", "upd.run": "Run the update",
    "upd.restart": "Restart the services", "upd.reload": "Reload the page",
    "upd.current": "Current version: {commit} — {subject} ({date})",
    "upd.local_changes": " · local changes", "upd.current_unknown": "Current version: unknown",
    "upd.doing": "running…", "upd.done": "done", "upd.err": "\n[error: {msg}]\n",
    "upd.restarting": "restarting…",
    "upd.restart_fail": "\n[restart failed: {err}]\nOn the Pi: sudo systemctl restart automail-worker automail-web\n",
    "upd.restart_go": "\nRestarting…\n",
    "upd.back": "\n✅ Services restarted. Reload the interface: Ctrl + Shift + R (or the button).\n",
    "upd.slow": "\nThe service is slow to come back. Reload in a moment (Ctrl + Shift + R).\n",
    "upd.uptodate": "up to date",
    "dash.mail": "Letters", "dash.this_month": "{n} this month",
    "dash.failed_ocr": "OCR failures", "dash.pending": "{n} queued",
    "dash.trash": "Trash", "dash.not_counted": "not counted in the total",
    "dash.storage": "Storage", "dash.of_gb": "of {n} GB",
    "dash.by_month": "Letters per month", "dash.no_data": "No data yet.",
    "dash.progress": "Follow-up", "dash.ocr_state": "OCR status",
    "dash.ok": "Done", "dash.notproc": "Not processed", "dash.errors": "Failures",
  },
};
function t(key, vars) {
  let s = (T[state.lang] && T[state.lang][key]);
  if (s == null) s = T.fr[key];
  if (s == null) return key;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  return s;
}
const plural = (n) => (state.lang === "fr" ? (n > 1 ? "s" : "") : (n === 1 ? "" : "s"));
const langName = (code) => ({
  fra: t("lg.francais"), deu: t("lg.allemand"), ara: t("lg.arabe"), eng: t("lg.anglais"),
  fr: t("lg.francais"), de: t("lg.allemand"), en: t("lg.anglais"), ar: t("lg.arabe"),
}[code] || code);
const ocrStatusLabel = (s) => ({
  pending: t("os.pending"), processing: t("os.processing"), ok: t("os.ok"),
  "skipped-has-text": t("os.skipped"), failed: t("os.failed"),
}[s] || s);

function applyLang(initial = false) {
  document.documentElement.lang = state.lang;
  LS.set("lang", state.lang);
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("#langseg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === state.lang));
  refreshSelectToggle();
  $("#empty-trash") && ($("#empty-trash").textContent = t("trash.empty"));
  updateFilterCount();
  if (initial) return;
  updateSelbar();
  state.renderSig = null;
  state.dashSig = null;
  search(true);
  loadStats();
  if (state.nav === "dash") loadDashboard(true, true);
  if ($("#editor").open && editing) renderEditorInfo(editing);
}

// escape mais pas dans les templates de traduction (qui contiennent du <b>)
const RESCAN_RE = /vide \(0 octet\)|n['’]est pas un pdf|pas un pdf|illisible|empty \(0 byte|not a pdf|unreadable/i;
const PROG_NEXT = { todo: "ongoing", ongoing: "done", done: "todo" };
const PROG_CLS = { todo: "prog-todo", ongoing: "prog-ongoing", done: "prog-done" };

// --- icônes (stroke, currentColor) ------------------------------------- //
const IC = {
  eye: `<svg class="ic" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  download: `<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/></svg>`,
  edit: `<svg class="ic" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  retry: `<svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  restore: `<svg class="ic" viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>`,
  trash: `<svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
  sun: `<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg class="ic" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5Z"/></svg>`,
};

// --- thème ------------------------------------------------------------- //
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark" || mode === "light") root.dataset.theme = mode;
  else root.removeAttribute("data-theme");
  const dark = mode === "dark" ||
    (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#theme").innerHTML = dark ? IC.sun : IC.moon;
}
let themeMode = LS.get("theme", "auto");

// --- skin (direction visuelle) --------------------------------------------- //
function applySkin(s) {
  document.documentElement.dataset.skin = s;
  $("#skin").value = s;
  $("#theme").hidden = s !== "corporate";
  applyTheme(themeMode);
}
let skin = LS.get("skin", "night");
applySkin(skin);
$("#skin").addEventListener("change", (e) => {
  skin = e.target.value; LS.set("skin", skin); applySkin(skin);
});

applyTheme(themeMode);
$("#theme").addEventListener("click", () => {
  themeMode = themeMode === "dark" ? "light" : "dark";
  LS.set("theme", themeMode);
  applyTheme(themeMode);
});

$("#langseg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lang]"); if (!b || b.dataset.lang === state.lang) return;
  state.lang = b.dataset.lang; applyLang();
});

// --- utilitaires ----------------------------------------------------------- //
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3000);
}
const errToast = (e) => toast(t("err", { msg: e.message }));
function fmtBytes(n) {
  if (!n) return "";
  const u = state.lang === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(iso) {
  if (!iso) return state.lang === "fr" ? "sans date" : "no date";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return state.lang === "fr" ? `${d}/${m}/${y}` : `${y}-${m}-${d}`;
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const time = iso.slice(11, 16);
  const date = state.lang === "fr" ? `${d}/${m}/${y}` : `${y}-${m}-${d}`;
  if (!time) return date;
  return state.lang === "fr" ? `${date} à ${time}` : `${date} ${time}`;
}
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return "";
  sec = Math.round(sec);
  if (sec < 60) return sec + " s";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function tickTimers() {
  for (const el of document.querySelectorAll("[data-since]")) {
    const t0 = Date.parse(el.dataset.since);
    if (isNaN(t0)) continue;
    const elapsed = (Date.now() - t0) / 1000;
    const eta = Number(el.dataset.eta || 0);
    let txt = clock(elapsed);
    if (eta && eta > elapsed + 3) txt += ` · ~${clock(eta - elapsed)}`;
    el.textContent = `${el.dataset.label} ${txt}`;
  }
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- volet filtres (drawer) ------------------------------------------------- //
function setFilters(open) {
  state.filtersOpen = open;
  $("#filters").classList.toggle("open", open);
  $("#scrim").classList.toggle("open", open);
  $("#filters-toggle").classList.toggle("on", open);
  if (!isMobile()) LS.set("filtersOpen", open ? "1" : "0");
}
function activeFilterCount() {
  let n = 0;
  if ($("#q").value.trim()) n++;
  if ($("#date_from").value) n++;
  if ($("#date_to").value) n++;
  if (!state.trash && $("#ocrstatus").value !== "ok") n++;
  if (state.progFilter) n++;
  if ($("#nodate").checked) n++;
  if ($("#sort").value !== "date") n++;
  return n;
}
function updateFilterCount() {
  const n = activeFilterCount();
  const el = $("#filters-count");
  el.textContent = n; el.hidden = n === 0;
}

// --- requête ------------------------------------------------------------ //
function currentQuery() {
  const p = new URLSearchParams();
  const q = $("#q").value.trim();
  if (q) p.set("q", q);
  if ($("#date_from").value) p.set("date_from", $("#date_from").value);
  if ($("#date_to").value) p.set("date_to", $("#date_to").value);
  if (state.trash) {
    p.set("status", "trash");
  } else {
    p.set("status", $("#ocrstatus").value);
    if (state.progFilter) p.set("progress", state.progFilter);
    if ($("#nodate").checked) p.set("no_date", "1");
  }
  p.set("sort", $("#sort").value);
  p.set("page", state.page);
  p.set("page_size", state.pageSize);
  return p.toString();
}

function skeletonHTML(n) {
  const one = `<article class="card skeleton"><div class="thumb"></div>
    <div class="body"><div class="sk-line w60"></div><div class="sk-line w40"></div>
    <div class="sk-line w80"></div><div class="sk-line w40"></div></div></article>`;
  return one.repeat(n);
}

async function search(silent = false) {
  const results = $("#results");
  if (!silent) {
    results.innerHTML = skeletonHTML(Math.min(8, state.pageSize));
    state.renderSig = null;
  }
  updateFilterCount();
  try {
    const data = await api("/documents?" + currentQuery());
    render(data.items);
    renderPager(data);
  } catch (e) {
    if (!silent) results.innerHTML = `<p class="empty">${esc(t("err", { msg: e.message }))}</p>`;
  }
}

function renderSignature(items) {
  return state.lang + state.view + (state.selectMode ? "S" : "") + (state.trash ? "T" : "") + "|" +
    items.map((d) =>
      [d.id, d.ocr_status, d.ocr_attempts, d.progress, d.document_date || "",
       d.title || "", d.has_thumbnail ? 1 : 0, d.snippet ? 1 : 0].join(":")
    ).join("|");
}

function render(items) {
  const results = $("#results");
  const visible = new Set(items.map((d) => d.id));
  for (const id of [...state.selected]) if (!visible.has(id)) state.selected.delete(id);

  const sig = renderSignature(items);
  if (sig === state.renderSig) { updateSelbar(); return; }
  state.renderSig = sig;

  results.className = "view-" + state.view + (state.selectMode ? " selecting" : "");

  if (!items.length) {
    results.innerHTML = `<div class="empty">${IC.inbox}<div>${state.trash ? t("empty.trash") : t("empty.none")}</div></div>`;
    updateSelbar();
    return;
  }
  results.innerHTML = "";
  for (const doc of items) {
    const hasThumb = !state.trash && doc.has_thumbnail;
    const card = document.createElement("article");
    card.className = "card" + (hasThumb ? "" : " nothumb") + (state.selected.has(doc.id) ? " selected" : "");
    card.dataset.id = doc.id;

    const thumb = hasThumb
      ? `<img class="thumb" src="/api/documents/${doc.id}/thumbnail" alt="" loading="lazy" data-act="preview" data-id="${doc.id}">`
      : "";

    const badges = [];
    if (doc.ocr_status === "pending")
      badges.push(`<span class="badge busy">${t("badge.pending")}</span>`);
    if (doc.ocr_status === "processing") {
      const eta = (doc.page_count && state.avgSecPerPage)
        ? Math.round(doc.page_count * state.avgSecPerPage) : "";
      badges.push(
        `<span class="badge busy" data-since="${doc.ocr_started_at || ""}" ` +
        `data-eta="${eta}" data-label="${t("badge.processing")}">${t("badge.processing")}</span>`);
    }
    const rescan = doc.ocr_status === "failed" && RESCAN_RE.test(doc.notes || "");
    if (rescan)
      badges.push(`<span class="badge fail">${t("badge.rescan")}</span>`);
    else if (doc.ocr_status === "failed")
      badges.push(`<span class="badge fail">${t("badge.failed", { n: doc.ocr_attempts })}</span>`);
    if (doc.lang_guess && doc.lang_guess !== "fr")
      badges.push(`<span class="badge lang">${t("badge.lang", { lang: langName(doc.lang_guess) })}</span>`);
    if (!state.trash && !doc.document_date &&
        (doc.ocr_status === "ok" || doc.ocr_status === "skipped-has-text"))
      badges.push(`<span class="badge nodate">${t("badge.nodate")}</span>`);

    const btn = (extra, ic, label) => `<button ${extra} title="${label}">${ic}<span>${label}</span></button>`;
    const dl = `<a class="btn" href="/api/documents/${doc.id}/download" title="${t("act.download")}">${IC.download}<span>${t("act.download")}</span></a>`;
    const edit = btn(`data-act="edit" data-id="${doc.id}"`, IC.edit, t("act.edit"));
    const view = btn(`data-act="preview" data-id="${doc.id}"`, IC.eye, t("act.preview"));
    let actions;
    if (state.trash) {
      actions = btn(`data-act="restore" data-id="${doc.id}"`, IC.restore, t("act.restore")) +
        `<button data-act="purge" data-id="${doc.id}" class="danger" title="${t("act.delete")}">${IC.trash}<span>${t("act.delete")}</span></button>`;
    } else if (doc.ocr_status === "failed") {
      actions = view + btn(`data-act="retry" data-id="${doc.id}"`, IC.retry, t("act.retry")) + dl + edit;
    } else {
      actions = view + dl + edit;
    }
    const failReason = (doc.ocr_status === "failed" && doc.notes)
      ? `<div class="failreason">⚠ ${esc(doc.notes)}</div>` : "";

    const pcls = PROG_CLS[doc.progress] || PROG_CLS.done;
    const plabel = t("prog." + (doc.progress || "done"));
    const pill = state.trash ? "" :
      `<button class="prog ${pcls}" data-prog="${doc.id}" data-cur="${doc.progress}" title="${t("prog.tip")}">${plabel}</button>`;

    const meta = [
      fmtDate(doc.document_date),
      doc.page_count ? t("meta.pages", { n: doc.page_count }) : "",
      doc.bytes ? fmtBytes(doc.bytes) : "",
      doc.scan_time ? `<span title="${t("meta.scan_tip")}">${t("meta.scan", { when: esc(fmtDateTime(doc.scan_time)) })}</span>` : "",
    ].filter(Boolean).join(" · ");

    card.innerHTML = `
      <label class="pick"><input type="checkbox" data-pick="${doc.id}"${state.selected.has(doc.id) ? " checked" : ""}></label>
      ${thumb}
      <div class="body">
        <div class="row1">
          <h3>${esc(doc.title || doc.original_filename)}</h3>
          ${pill}
        </div>
        <div class="meta">${meta}</div>
        ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
        ${failReason}
        ${doc.snippet ? `<div class="snippet">${doc.snippet}</div>` : ""}
        <div class="actions">${actions}</div>
      </div>`;
    results.appendChild(card);
  }
  tickTimers();
  updateSelbar();
}

function renderPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $("#pager").hidden = data.total === 0;
  $("#pageinfo").textContent = t("pager.info", { page: data.page, pages, total: data.total });
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

// --- avancement (pill cliquable) ------------------------------------------ //
async function cycleProgress(id, cur) {
  const val = PROG_NEXT[cur] || "todo";
  try {
    await api("/documents/" + id, { method: "PATCH", body: JSON.stringify({ progress: val }) });
    search(true);
  } catch (e) { errToast(e); }
}

// --- sélection multiple ------------------------------------------------- //
function refreshSelectToggle() {
  $("#select-toggle").textContent = state.selectMode ? t("select.stop") : t("select.start");
}
function setSelectMode(on) {
  state.selectMode = on;
  $("#select-toggle").classList.toggle("on", on);
  refreshSelectToggle();
  if (!on) state.selected.clear();
  updateSelbar();
  search(true);
}
function clearSelection() {
  state.selected.clear();
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  document.querySelectorAll("[data-pick]:checked").forEach((c) => (c.checked = false));
  updateSelbar();
}
function updateSelbar() {
  const bar = $("#selbar");
  if (!state.selectMode) { bar.hidden = true; return; }
  bar.hidden = false;
  const n = state.selected.size;
  $("#sel-count").textContent = t("sel.count", { n, s: plural(n) });
  const acts = state.trash
    ? `<button type="button" data-bulk="restore"${n ? "" : " disabled"}>${t("sel.restore")}</button>
       <button type="button" data-bulk="purge" class="danger"${n ? "" : " disabled"}>${t("sel.purge")}</button>`
    : `<button type="button" data-bulk="download"${n ? "" : " disabled"}>${t("sel.dl_zip")}</button>
       <select id="bulk-prog"${n ? "" : " disabled"}>
         <option value="">${t("sel.progress_ph")}</option>
         <option value="todo">${t("prog.todo")}</option>
         <option value="ongoing">${t("prog.ongoing")}</option>
         <option value="done">${t("prog.done")}</option>
       </select>
       <button type="button" data-bulk="trash" class="danger"${n ? "" : " disabled"}>${t("sel.trash")}</button>`;
  $("#sel-actions").innerHTML = acts;
  const boxes = [...document.querySelectorAll("[data-pick]")];
  $("#sel-all").checked = boxes.length > 0 && boxes.every((b) => state.selected.has(Number(b.dataset.pick)));
}

async function bulkAction(action, value) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === "download") {
    window.location.href = "/api/bulk/download?ids=" + ids.join(",");
    return;
  }
  if ((action === "trash" || action === "purge") &&
      !confirm(t("confirm.bulk", { n: ids.length, action: t("ba." + action) }))) return;
  try {
    const r = await api("/bulk", {
      method: "POST", body: JSON.stringify({ ids, action, value: value || null }),
    });
    toast(t("toast.bulk", { n: r.done }) + (r.errors.length ? t("toast.bulk_err", { n: r.errors.length }) : ""));
    clearSelection();
    search(); loadStats();
  } catch (e) { errToast(e); }
}

// --- stats + auto-refresh -------------------------------------------------- //
async function loadStats() {
  let s;
  try { s = await api("/stats"); }
  catch { return; }
  try { renderStats(s); }
  catch (e) { console.warn("loadStats", e); }
}

function renderStats(s) {
  state.avgSecPerPage = s.avg_sec_per_page || null;
  const parts = [t("stats.mail", { n: s.total, s: plural(s.total) })];
  const inFlight = (s.pending || 0) + (s.processing || 0) + (s.reprocessing || 0);
  if (s.pending || s.processing) {
    const done = Math.max(0, s.total - (s.pending || 0) - (s.processing || 0));
    parts.push(t("stats.done", { n: done, s: plural(done) }));
  }
  if (s.pending) parts.push(`<span class="busy">${t("stats.pending", { n: s.pending })}</span>`);
  if (s.processing) parts.push(`<span class="busy">${t("stats.processing", { n: s.processing })}</span>`);
  if (s.reprocessing) parts.push(`<span class="busy">${t("stats.reprocessing", { n: s.reprocessing })}</span>`);
  if (s.failed) parts.push(`<span class="warn">${t("stats.failed", { n: s.failed })}</span>`);
  parts.push(t("stats.free", { n: (s.disk_free_bytes / 1e9).toFixed(1) }));
  if (s.cpu_temp_c != null) {
    const temp = s.cpu_temp_c;
    const cls = temp >= 80 ? "warn" : temp >= 70 ? "busy" : "";
    parts.push(`<span class="${cls}">${temp.toFixed(1)} °C</span>`);
  }
  $("#stats").innerHTML = parts.join(" · ");

  const sig = [s.total, s.failed, s.pending, s.processing, s.reprocessing,
               s.trashed, s.last_added].join("|");
  const changed = state.statsSig !== null && sig !== state.statsSig;
  state.statsSig = sig;
  state.lastInFlight = inFlight;
  if (changed && !document.querySelector("dialog[open]")) {
    if (state.nav === "dash") { loadDashboard(true); return; }
    if (state.page === 1) {
      const y = window.scrollY;
      search(true).then(() => window.scrollTo(0, y));
    }
  }
}

// --- aperçu ------------------------------------------------------------- //
function openPreview(id) {
  const pdf = `/api/documents/${id}/pdf`;
  const orig = `/api/documents/${id}/download`;
  $("#preview-open").href = pdf;
  $("#preview-dl").href = orig;
  $("#preview-mobile-open").href = pdf;
  $("#preview-mobile-dl").href = orig;
  const frame = $("#preview-frame"), mob = $("#preview-mobile");
  if (isMobile()) {
    frame.hidden = true; frame.src = "about:blank";
    mob.hidden = false;
    const th = $("#preview-thumb");
    th.hidden = false;
    th.onerror = () => (th.hidden = true);
    th.src = `/api/documents/${id}/thumbnail`;
  } else {
    mob.hidden = true;
    frame.hidden = false;
    frame.src = pdf;
  }
  $("#preview").showModal();
}

// --- édition ---------------------------------------------------------------- //
let editing = null;
function renderEditorInfo(d) {
  const procVal = d.ocr_seconds != null
    ? fmtDuration(d.ocr_seconds) + (d.page_count ? ` (${t("ei.per_page", { d: fmtDuration(d.ocr_seconds / d.page_count) })})` : "")
    : (d.ocr_status === "processing" && d.ocr_started_at
      ? `<span data-since="${d.ocr_started_at}" data-eta="${d.page_count && state.avgSecPerPage ? Math.round(d.page_count * state.avgSecPerPage) : ""}" data-label="${t("ei.in_progress")}">${t("ei.in_progress")}</span>`
      : "—");
  $("#e-info").innerHTML = `
    <dt>${t("ei.file")}</dt><dd>${esc(d.original_filename)}</dd>
    ${d.scan_time ? `<dt>${t("ei.scanned")}</dt><dd>${esc(fmtDateTime(d.scan_time))}</dd>` : ""}
    <dt>${t("ei.added")}</dt><dd>${fmtDate(d.added_at)}</dd>
    <dt>${t("ei.pages")}</dt><dd>${d.page_count ?? "?"}</dd>
    <dt>${t("ei.size")}</dt><dd>${fmtBytes(d.bytes) || "?"}</dd>
    <dt>${t("ei.ocr")}</dt><dd>${ocrStatusLabel(d.ocr_status)}${d.ocr_language ? " · " + langName(d.ocr_language) : ""}</dd>
    <dt>${t("ei.proc")}</dt><dd>${procVal}</dd>
    <dt>${t("ei.date")}</dt><dd>${fmtDate(d.document_date)}${d.document_date ? " (" + (d.document_date_source === "manual" ? t("ei.date_manual") : t("ei.date_auto")) + ")" : ""}</dd>
    ${d.ocr_status === "failed" && d.notes ? `<dt>${t("ei.error")}</dt><dd class="err">${esc(d.notes)}</dd>` : ""}`;
  tickTimers();
}
async function openEditor(id) {
  const d = await api("/documents/" + id);
  editing = d;
  $("#e-title").value = d.title || "";
  $("#e-date").value = d.document_date || "";
  $("#e-progress").value = d.progress || "done";
  $("#e-notes").value = d.notes || "";
  renderEditorInfo(d);
  $("#editor").showModal();
}
async function saveEditor() {
  try {
    await api("/documents/" + editing.id, {
      method: "PATCH",
      body: JSON.stringify({
        title: $("#e-title").value,
        document_date: $("#e-date").value,
        progress: $("#e-progress").value,
        notes: $("#e-notes").value,
      }),
    });
    toast(t("toast.saved")); $("#editor").close(); search();
  } catch (e) { errToast(e); }
}
async function reocr(lang) {
  try {
    await api(`/documents/${editing.id}/reocr`, { method: "POST", body: JSON.stringify({ language: lang }) });
    toast(t("toast.reocr", { lang })); $("#editor").close(); setTimeout(loadStats, 300);
  } catch (e) { errToast(e); }
}
async function del(id) {
  if (!confirm(t("confirm.trash_one"))) return;
  try {
    await api("/documents/" + id, { method: "DELETE" });
    toast(t("toast.trashed")); $("#editor").close(); search(); loadStats();
  } catch (e) { errToast(e); }
}
async function retry(id) {
  try {
    await api(`/documents/${id}/retry`, { method: "POST" });
    toast(t("toast.retry"));
    setTimeout(() => { search(); loadStats(); }, 400);
  } catch (e) { errToast(e); }
}
async function restore(id) {
  try { await api(`/documents/${id}/restore`, { method: "POST" }); toast(t("toast.restored")); search(); loadStats(); }
  catch (e) { errToast(e); }
}
async function purge(id) {
  if (!confirm(t("confirm.purge_one"))) return;
  try { await api(`/documents/${id}/purge`, { method: "DELETE" }); toast(t("toast.deleted")); search(); loadStats(); }
  catch (e) { errToast(e); }
}
async function emptyTrash() {
  if (!confirm(t("confirm.empty_trash"))) return;
  try { const r = await api("/trash/empty", { method: "POST" }); toast(t("toast.trash_emptied", { n: r.count })); search(); loadStats(); }
  catch (e) { errToast(e); }
}

// --- mise à jour depuis GitHub ------------------------------------------- //
async function openUpdater() {
  const log = $("#upd-log");
  log.hidden = true; log.textContent = "";
  $("#upd-run").hidden = false; $("#upd-run").disabled = false;
  $("#upd-restart").hidden = true; $("#upd-restart").disabled = false;
  $("#upd-reload").hidden = true;
  $("#upd-state").textContent = "";
  $("#upd-current").textContent = "…";
  $("#updater").showModal();
  try {
    const v = await api("/version");
    $("#upd-current").textContent = v.commit
      ? t("upd.current", { commit: v.commit, subject: v.subject, date: v.date }) + (v.dirty ? t("upd.local_changes") : "")
      : t("upd.current_unknown");
  } catch { $("#upd-current").textContent = ""; }
}
async function runUpdate() {
  const log = $("#upd-log");
  log.hidden = false; log.textContent = "";
  $("#upd-run").disabled = true; $("#upd-state").textContent = t("upd.doing");
  try {
    const res = await fetch("/api/update", { method: "POST" });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      log.textContent += dec.decode(value, { stream: true });
      log.scrollTop = log.scrollHeight;
    }
    $("#upd-state").textContent = t("upd.done");
    $("#upd-run").hidden = true; $("#upd-restart").hidden = false;
  } catch (e) {
    log.textContent += t("upd.err", { msg: e.message });
    $("#upd-run").disabled = false; $("#upd-state").textContent = "";
  }
}
async function restartServices() {
  const log = $("#upd-log");
  $("#upd-restart").disabled = true; $("#upd-state").textContent = t("upd.restarting");
  try {
    const r = await fetch("/api/restart", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (j.ok === false) {
      log.textContent += t("upd.restart_fail", { err: j.error });
      $("#upd-restart").disabled = false; $("#upd-state").textContent = ""; return;
    }
  } catch {}
  log.textContent += t("upd.restart_go");
  const t0 = Date.now(); let back = false;
  while (Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 2000));
    try { const h = await fetch("/api/health", { cache: "no-store" }); if (h.ok) { back = true; break; } } catch {}
  }
  log.textContent += back ? t("upd.back") : t("upd.slow");
  $("#upd-state").textContent = back ? t("upd.uptodate") : "";
  $("#upd-restart").hidden = true; $("#upd-reload").hidden = false;
}

// --- vue / corbeille --------------------------------------------------------- //
function setView(v) {
  state.view = v; LS.set("view", v);
  document.querySelectorAll("#viewseg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#results").className = "view-" + v + (state.selectMode ? " selecting" : "");
}
function setTrash(on) {
  state.trash = on;
  $("#trash-toggle").classList.toggle("on", on);
  $("#ocrstatus").disabled = on;
  $("#nodate").disabled = on;
  $("#progseg").querySelectorAll("button").forEach((b) => (b.disabled = on));
  $("#empty-trash")?.remove();
  if (on) {
    const b = document.createElement("button");
    b.id = "empty-trash"; b.type = "button"; b.className = "danger";
    b.textContent = t("trash.empty");
    b.addEventListener("click", emptyTrash);
    $("#select-toggle").after(b);
  }
  clearSelection();
  state.page = 1;
  search();
}

// --- événements ---------------------------------------------------------- //
function setProgFilter(v) {
  state.progFilter = v;
  document.querySelectorAll("#progseg button").forEach((b) => b.classList.toggle("on", b.dataset.pf === v));
}

$("#filters-toggle").addEventListener("click", () => setFilters(!state.filtersOpen));
$("#filters-close").addEventListener("click", () => setFilters(false));
$("#scrim").addEventListener("click", () => setFilters(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.filtersOpen) setFilters(false); });

$("#go").addEventListener("click", () => { state.page = 1; search(); if (isMobile()) setFilters(false); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { state.page = 1; search(); if (isMobile()) setFilters(false); } });
$("#date_from").addEventListener("change", () => { state.page = 1; search(); });
$("#date_to").addEventListener("change", () => { state.page = 1; search(); });
$("#ocrstatus").addEventListener("change", () => { state.page = 1; search(); });
$("#progseg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pf]"); if (!b) return;
  setProgFilter(b.dataset.pf); state.page = 1; search();
});
$("#sort").addEventListener("change", () => { state.page = 1; search(); });
$("#nodate").addEventListener("change", () => { state.page = 1; search(); });
$("#reset").addEventListener("click", () => {
  for (const id of ["q", "date_from", "date_to"]) $("#" + id).value = "";
  $("#ocrstatus").value = "ok"; setProgFilter(""); $("#sort").value = "date";
  $("#nodate").checked = false;
  clearSelection(); state.page = 1; search();
});
$("#prev").addEventListener("click", () => { if (state.page > 1) { clearSelection(); state.page--; search(); } });
$("#next").addEventListener("click", () => { clearSelection(); state.page++; search(); });
$("#page_size").addEventListener("change", (e) => {
  state.pageSize = Number(e.target.value); LS.set("pageSize", state.pageSize);
  state.page = 1; search();
});
$("#page_size").value = String(state.pageSize);

$("#viewseg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]"); if (b) { setView(b.dataset.view); search(true); }
});
$("#trash-toggle").addEventListener("click", () => setTrash(!state.trash));
$("#select-toggle").addEventListener("click", () => setSelectMode(!state.selectMode));
$("#select-done").addEventListener("click", () => setSelectMode(false));
$("#sel-all").addEventListener("change", (e) => {
  for (const cb of document.querySelectorAll("[data-pick]")) {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.pick);
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    cb.closest(".card").classList.toggle("selected", e.target.checked);
  }
  updateSelbar();
});
$("#selbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bulk]");
  if (b && !b.disabled) bulkAction(b.dataset.bulk);
});
$("#selbar").addEventListener("change", (e) => {
  if (e.target.id === "bulk-prog" && e.target.value) bulkAction("progress", e.target.value);
});

$("#results").addEventListener("click", (e) => {
  const prog = e.target.closest("[data-prog]");
  if (prog) { cycleProgress(Number(prog.dataset.prog), prog.dataset.cur); return; }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  ({ preview: openPreview, edit: openEditor, retry, restore, purge })[btn.dataset.act]?.(id);
});
$("#results").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-pick]"); if (!cb) return;
  const id = Number(cb.dataset.pick);
  const card = cb.closest(".card");
  if (cb.checked) { state.selected.add(id); card.classList.add("selected"); }
  else { state.selected.delete(id); card.classList.remove("selected"); }
  updateSelbar();
});

// --- navigation Courriers / Tableau de bord ------------------------------- //
function setNav(v) {
  state.nav = v;
  document.querySelectorAll(".mainnav button").forEach((b) => b.classList.toggle("on", b.dataset.nav === v));
  $("#view-mail").hidden = v !== "mail";
  $("#view-dash").hidden = v !== "dash";
  if (v !== "mail") setFilters(false);
  if (v === "dash") loadDashboard();
}
document.querySelector(".mainnav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]"); if (b) setNav(b.dataset.nav);
});

// --- tableau de bord ------------------------------------------------------- //
function bars(data) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return `<div class="bars">${data.map((d) => {
    const [y, m] = d.month.split("-");
    return `<div class="bar"><b>${d.count}</b><i style="height:${Math.round((d.count / max) * 130) + 4}px"></i>
      <span>${m}/${y.slice(2)}</span></div>`;
  }).join("")}</div>`;
}
function legend(obj, colors, labels) {
  const total = Math.max(1, Object.values(obj).reduce((a, b) => a + b, 0));
  return `<div class="legend">${Object.keys(labels).map((k) => `
    <div class="row">
      <span class="dot" style="background:${colors[k]}"></span>
      <span>${labels[k]}</span>
      <span class="track"><span class="fill" style="width:${Math.round((obj[k] || 0) / total * 100)}%;background:${colors[k]}"></span></span>
      <span class="num">${obj[k] || 0}</span>
    </div>`).join("")}</div>`;
}
async function loadDashboard(silent = false, force = false) {
  const el = $("#dash");
  if (!silent) { el.innerHTML = skeletonHTML(4); state.dashSig = null; }
  try {
    const o = await api("/overview");
    const sig = state.lang + "|" + JSON.stringify(o);
    if (!force && sig === state.dashSig) return;
    state.dashSig = sig;
    const usedGo = ((o.disk_total_bytes - o.disk_free_bytes) / 1e9).toFixed(1);
    const totGo = (o.disk_total_bytes / 1e9).toFixed(0);
    el.innerHTML = `
      <div class="kpi"><div class="k-label">${t("dash.mail")}</div><div class="k-value">${o.total}</div>
        <div class="k-sub">${t("dash.this_month", { n: o.this_month })}</div></div>
      <div class="kpi"><div class="k-label">${t("dash.failed_ocr")}</div><div class="k-value">${o.by_ocr.failed}</div>
        <div class="k-sub">${t("dash.pending", { n: o.by_ocr.pending })}</div></div>
      <div class="kpi"><div class="k-label">${t("dash.trash")}</div><div class="k-value">${o.trashed}</div>
        <div class="k-sub">${t("dash.not_counted")}</div></div>
      <div class="kpi"><div class="k-label">${t("dash.storage")}</div><div class="k-value">${usedGo} Go</div>
        <div class="k-sub">${t("dash.of_gb", { n: totGo })}${o.cpu_temp_c != null ? " · " + o.cpu_temp_c.toFixed(0) + " °C" : ""}</div></div>
      <div class="panel"><h3>${t("dash.by_month")}</h3>${o.by_month.length ? bars(o.by_month) : `<p class="muted">${t("dash.no_data")}</p>`}</div>
      <div class="panel half"><h3>${t("dash.progress")}</h3>${legend(o.by_progress,
        { todo: "var(--prog-todo)", ongoing: "var(--prog-ongoing)", done: "var(--prog-done)" },
        { todo: t("prog.todo"), ongoing: t("prog.ongoing"), done: t("prog.done") })}</div>
      <div class="panel half"><h3>${t("dash.ocr_state")}</h3>${legend(o.by_ocr,
        { ok: "var(--ok)", pending: "var(--accent)", failed: "var(--danger)" },
        { ok: t("dash.ok"), pending: t("dash.notproc"), failed: t("dash.errors") })}</div>`;
  } catch (e) {
    if (!silent) el.innerHTML = `<p class="empty">${esc(t("err", { msg: e.message }))}</p>`;
  }
}

$("#update").addEventListener("click", openUpdater);
$("#upd-run").addEventListener("click", runUpdate);
$("#upd-restart").addEventListener("click", restartServices);
$("#upd-reload").addEventListener("click", () => location.reload());
$("#editform").addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
$("#e-delete").addEventListener("click", () => del(editing.id));
document.querySelectorAll(".reocr [data-lang]").forEach((b) =>
  b.addEventListener("click", () => reocr(b.dataset.lang)));
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest("dialog").close()));
$("#preview").addEventListener("close", () => ($("#preview-frame").src = "about:blank"));

// --- démarrage --------------------------------------------------------- //
applyLang(true);
setView(state.view);
setFilters(!isMobile() && LS.get("filtersOpen", "0") === "1");
loadStats();
search();
(function pollLoop() {
  Promise.resolve()
    .then(loadStats)
    .catch((e) => console.warn("pollLoop", e))
    .finally(() => setTimeout(pollLoop, state.lastInFlight > 0 ? 4000 : 10000));
})();
setInterval(tickTimers, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  loadStats();
  if (state.nav === "dash") loadDashboard(true); else search(true);
});
