"use strict";

const $ = (s) => document.querySelector(s);
const state = { page: 1, pageSize: 20, editing: null };

// --- thème clair / sombre --------------------------------------------------
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark" || mode === "light") root.dataset.theme = mode;
  else root.removeAttribute("data-theme");
  const dark = mode === "dark" ||
    (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#theme").textContent = dark ? "☀️" : "🌙";
}
let themeMode = (() => { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } })();
applyTheme(themeMode);
$("#theme").addEventListener("click", () => {
  themeMode = (themeMode === "dark") ? "light" : "dark";
  try { localStorage.setItem("theme", themeMode); } catch {}
  applyTheme(themeMode);
});

// --- utilitaires --------------------------------------------------------- //
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
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}

function fmtBytes(n) {
  if (!n) return "";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(iso) {
  if (!iso) return "sans date";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const LANGS = { fra: "français", deu: "allemand", ara: "arabe", eng: "anglais", fr: "français", de: "allemand", en: "anglais" };
const STATUS = { ok: "OK", "skipped-has-text": "texte conservé", failed: "échec" };

// --- recherche --------------------------------------------------------- //
function currentQuery() {
  const p = new URLSearchParams();
  const q = $("#q").value.trim();
  if (q) p.set("q", q);
  if ($("#date_from").value) p.set("date_from", $("#date_from").value);
  if ($("#date_to").value) p.set("date_to", $("#date_to").value);
  if ($("#correspondent").value.trim()) p.set("correspondent", $("#correspondent").value.trim());
  p.set("status", $("#status").value);
  p.set("sort", $("#sort").value);
  p.set("page", state.page);
  p.set("page_size", state.pageSize);
  return p.toString();
}

async function search() {
  $("#results").innerHTML = `<p class="empty">Recherche…</p>`;
  try {
    const data = await api("/documents?" + currentQuery());
    render(data.items);
    renderPager(data);
  } catch (e) {
    $("#results").innerHTML = `<p class="empty">Erreur : ${escapeHtml(e.message)}</p>`;
  }
}

function render(items) {
  const results = $("#results");
  const isTrash = $("#status").value === "trash";
  if (!items.length) {
    results.innerHTML = `<p class="empty">${isTrash ? "La corbeille est vide." : "Aucun courrier trouvé."}</p>`;
    return;
  }
  results.innerHTML = "";
  for (const doc of items) {
    const card = document.createElement("article");
    card.className = "card";
    const thumb = (!isTrash && doc.has_thumbnail)
      ? `<img class="thumb" src="/api/documents/${doc.id}/thumbnail" alt="" loading="lazy">`
      : `<div class="thumb"></div>`;

    const badges = [];
    if (doc.ocr_status === "failed")
      badges.push(`<span class="badge fail">échec OCR (${doc.ocr_attempts}×)</span>`);
    if (doc.lang_guess && doc.lang_guess !== "fr")
      badges.push(`<span class="badge lang">langue&nbsp;? ${LANGS[doc.lang_guess] || doc.lang_guess}</span>`);

    let actions;
    if (isTrash) {
      actions = `<button data-act="restore" data-id="${doc.id}">Restaurer</button>
         <button data-act="purge" data-id="${doc.id}" class="danger">Supprimer définitivement</button>`;
    } else if (doc.ocr_status === "failed") {
      actions = `<button data-act="retry" data-id="${doc.id}">Réessayer</button>
         <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
         <button data-act="edit" data-id="${doc.id}">Modifier</button>`;
    } else {
      actions = `<button data-act="preview" data-id="${doc.id}">Aperçu</button>
         <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
         <button data-act="edit" data-id="${doc.id}">Modifier</button>`;
    }

    card.innerHTML = `
      ${thumb}
      <div>
        <h3>${escapeHtml(doc.title || doc.original_filename)}</h3>
        <div class="meta">
          ${doc.correspondent ? escapeHtml(doc.correspondent) + " · " : ""}
          ${fmtDate(doc.document_date)}
          ${doc.page_count ? " · " + doc.page_count + " p." : ""}
          ${doc.bytes ? " · " + fmtBytes(doc.bytes) : ""}
        </div>
        ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
        ${doc.snippet ? `<div class="snippet">${doc.snippet}</div>` : ""}
        <div class="actions">${actions}</div>
      </div>`;
    results.appendChild(card);
  }
}

function renderPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $("#pager").hidden = data.total === 0;
  $("#pageinfo").textContent = `Page ${data.page} / ${pages} — ${data.total} courrier(s)`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

// --- stats ------------------------------------------------------------- //
async function loadStats() {
  try {
    const s = await api("/stats");
    const parts = [`<b>${s.total}</b> courriers`];
    const inFlight = (s.pending || 0) + (s.reprocessing || 0);
    if (inFlight) parts.push(`<span class="busy">${inFlight} en cours de traitement</span>`);
    if (s.failed) parts.push(`<span class="warn">${s.failed} en échec</span>`);
    if (s.last_added) parts.push(`dernier ajout ${fmtDate(s.last_added)}`);
    parts.push(`${(s.disk_free_bytes / 1e9).toFixed(1)} Go libres`);
    if (s.cpu_temp_c != null) {
      const t = s.cpu_temp_c;
      const cls = t >= 80 ? "warn" : (t >= 70 ? "busy" : "");
      parts.push(`<span class="${cls}">${t.toFixed(1)} °C</span>`);
    }
    $("#stats").innerHTML = parts.join(" · ");
  } catch {}
}

// --- aperçu ---------------------------------------------------------------- //
function openPreview(id) {
  $("#preview-frame").src = `/api/documents/${id}/pdf`;
  $("#preview-dl").href = `/api/documents/${id}/download`;
  $("#preview").showModal();
}

// --- édition ------------------------------------------------------------- //
async function openEditor(id) {
  const doc = await api("/documents/" + id);
  state.editing = doc;
  $("#e-title").value = doc.title || "";
  $("#e-correspondent").value = doc.correspondent || "";
  $("#e-date").value = doc.document_date || "";
  $("#e-notes").value = doc.notes || "";
  $("#e-info").innerHTML = `
    <dt>Fichier</dt><dd>${escapeHtml(doc.original_filename)}</dd>
    <dt>Ajouté le</dt><dd>${fmtDate(doc.added_at)}</dd>
    <dt>Pages</dt><dd>${doc.page_count ?? "?"}</dd>
    <dt>Taille</dt><dd>${fmtBytes(doc.bytes) || "?"}</dd>
    <dt>OCR</dt><dd>${STATUS[doc.ocr_status] || doc.ocr_status}${doc.ocr_language ? " · " + (LANGS[doc.ocr_language] || doc.ocr_language) : ""}${doc.ocr_status === "failed" ? " · " + doc.ocr_attempts + " tentative(s)" : ""}</dd>
    <dt>Date</dt><dd>${fmtDate(doc.document_date)}${doc.document_date ? " (" + (doc.document_date_source === "manual" ? "saisie" : "détectée") + ")" : ""}</dd>
    ${doc.lang_guess && doc.lang_guess !== "fr" ? `<dt>Langue probable</dt><dd>${LANGS[doc.lang_guess] || doc.lang_guess}</dd>` : ""}`;
  $("#editor").showModal();
}

async function saveEditor() {
  try {
    await api("/documents/" + state.editing.id, {
      method: "PATCH",
      body: JSON.stringify({
        title: $("#e-title").value,
        correspondent: $("#e-correspondent").value,
        document_date: $("#e-date").value,
        notes: $("#e-notes").value,
      }),
    });
    toast("Enregistré");
    $("#editor").close();
    search();
  } catch (e) { toast("Erreur : " + e.message); }
}

async function reocr(lang) {
  try {
    await api(`/documents/${state.editing.id}/reocr`, {
      method: "POST", body: JSON.stringify({ language: lang }),
    });
    toast(`Ré-OCR (${lang}) en file d'attente`);
    $("#editor").close();
    setTimeout(loadStats, 300);
  } catch (e) { toast("Erreur : " + e.message); }
}

async function del(id) {
  if (!confirm("Déplacer ce courrier dans la corbeille ?")) return;
  try {
    await api("/documents/" + id, { method: "DELETE" });
    toast("Déplacé dans la corbeille");
    $("#editor").close();
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

async function retry(id) {
  try {
    await api(`/documents/${id}/retry`, { method: "POST" });
    toast("Sera retenté automatiquement");
    setTimeout(() => { search(); loadStats(); }, 400);
  } catch (e) { toast("Erreur : " + e.message); }
}

async function restore(id) {
  try {
    await api(`/documents/${id}/restore`, { method: "POST" });
    toast("Courrier restauré");
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

async function purge(id) {
  if (!confirm("Supprimer définitivement ce courrier ? (irréversible)")) return;
  try {
    await api(`/documents/${id}/purge`, { method: "DELETE" });
    toast("Supprimé définitivement");
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

async function emptyTrash() {
  if (!confirm("Vider la corbeille ? Tous les courriers dedans seront supprimés définitivement.")) return;
  try {
    const r = await api("/trash/empty", { method: "POST" });
    toast(`Corbeille vidée (${r.count})`);
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

function syncTrashButton() {
  $("#empty-trash").hidden = $("#status").value !== "trash";
}

// --- événements ---------------------------------------------------------- //
$("#search").addEventListener("submit", (e) => { e.preventDefault(); state.page = 1; search(); });
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); state.page = 1; search(); }
});
$("#status").addEventListener("change", () => { syncTrashButton(); state.page = 1; search(); });
$("#empty-trash").addEventListener("click", emptyTrash);
$("#reset").addEventListener("click", () => {
  for (const id of ["q", "date_from", "date_to", "correspondent"]) $("#" + id).value = "";
  $("#status").value = "ok";
  $("#sort").value = "date";
  syncTrashButton();
  state.page = 1;
  search();
});
$("#prev").addEventListener("click", () => { if (state.page > 1) { state.page--; search(); } });
$("#next").addEventListener("click", () => { state.page++; search(); });

$("#results").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  ({ preview: openPreview, edit: openEditor, retry, restore, purge })[btn.dataset.act]?.(id);
});

$("#editform").addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
$("#e-delete").addEventListener("click", () => del(state.editing.id));
document.querySelectorAll(".reocr [data-lang]").forEach((b) =>
  b.addEventListener("click", () => reocr(b.dataset.lang)));
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest("dialog").close()));
$("#preview").addEventListener("close", () => ($("#preview-frame").src = "about:blank"));

// --- démarrage --------------------------------------------------------- //
syncTrashButton();
loadStats();
search();
setInterval(loadStats, 15000);
