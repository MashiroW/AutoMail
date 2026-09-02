"use strict";

const $ = (s) => document.querySelector(s);
const state = { page: 1, pageSize: 20, editing: null, selected: new Set() };

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

async function search(silent = false) {
  if (!silent) $("#results").innerHTML = `<p class="empty">Recherche…</p>`;
  try {
    const data = await api("/documents?" + currentQuery());
    render(data.items);
    renderPager(data);
  } catch (e) {
    if (!silent) $("#results").innerHTML = `<p class="empty">Erreur : ${escapeHtml(e.message)}</p>`;
  }
}

function render(items) {
  const results = $("#results");
  const isTrash = $("#status").value === "trash";
  // ne garder en sélection que les courriers encore visibles
  const visible = new Set(items.map((d) => d.id));
  for (const id of [...state.selected]) if (!visible.has(id)) state.selected.delete(id);

  if (!items.length) {
    results.innerHTML = `<p class="empty">${isTrash ? "La corbeille est vide." : "Aucun courrier trouvé."}</p>`;
    updateSelbar();
    return;
  }
  results.innerHTML = "";
  for (const doc of items) {
    const card = document.createElement("article");
    card.className = "card";
    const picked = state.selected.has(doc.id);
    if (picked) card.classList.add("selected");
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
      <label class="pick"><input type="checkbox" data-pick="${doc.id}"${picked ? " checked" : ""}></label>
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
  updateSelbar();
}

// --- sélection multiple ------------------------------------------------- //
function updateSelbar() {
  const n = state.selected.size;
  $("#selbar").hidden = n === 0;
  if (!n) return;
  $("#sel-count").textContent = `${n} sélectionné${n > 1 ? "s" : ""}`;
  $("#sel-actions").innerHTML = $("#status").value === "trash"
    ? `<button type="button" data-bulk="restore">Restaurer</button>
       <button type="button" data-bulk="purge" class="danger">Supprimer définitivement</button>`
    : `<button type="button" data-bulk="trash" class="danger">Déplacer vers la corbeille</button>`;
  const boxes = [...document.querySelectorAll("[data-pick]")];
  $("#sel-all").checked = boxes.length > 0 && boxes.every((b) => state.selected.has(Number(b.dataset.pick)));
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  document.querySelectorAll("[data-pick]:checked").forEach((c) => (c.checked = false));
  updateSelbar();
}

async function bulkAction(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  const verb = { trash: "déplacer vers la corbeille", restore: "restaurer",
                 purge: "supprimer DÉFINITIVEMENT" }[action];
  if (action !== "restore" && !confirm(`${ids.length} courrier(s) — ${verb} ?`)) return;
  try {
    const r = await api("/documents/bulk", {
      method: "POST", body: JSON.stringify({ ids, action }),
    });
    toast(`${r.done} traité(s)` + (r.errors.length ? ` · ${r.errors.length} erreur(s)` : ""));
    clearSelection();
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

function renderPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $("#pager").hidden = data.total === 0;
  $("#pageinfo").textContent = `Page ${data.page} / ${pages} — ${data.total} courrier(s)`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

// --- stats + auto-refresh de la liste --------------------------------- //
let statsSig = null;
let lastInFlight = 0;

async function loadStats() {
  let s;
  try { s = await api("/stats"); } catch { return; }

  const parts = [`<b>${s.total}</b> courriers`];
  const inFlight = (s.pending || 0) + (s.reprocessing || 0);
  lastInFlight = inFlight;
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

  // rafraîchit la liste toute seule si le contenu a changé (nouveau courrier,
  // OCR terminé, échec…), sans casser la position de lecture
  const sig = [s.total, s.failed, s.trashed, s.last_added].join("|");
  const dialogOpen = document.querySelector("dialog[open]");
  if (statsSig !== null && sig !== statsSig && state.page === 1 && !dialogOpen) {
    const y = window.scrollY;
    await search(true);
    window.scrollTo(0, y);
  }
  statsSig = sig;
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

// --- mise à jour depuis GitHub ---------------------------------------------- //
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
      ? `Version actuelle : ${v.commit} — ${v.subject} (${v.date})${v.dirty ? " · modifs locales" : ""}`
      : "Version actuelle : inconnue (dossier non git ?)";
  } catch { $("#upd-current").textContent = ""; }
}

async function runUpdate() {
  const log = $("#upd-log");
  log.hidden = false; log.textContent = "";
  $("#upd-run").disabled = true;
  $("#upd-state").textContent = "en cours…";
  try {
    const res = await fetch("/api/update", { method: "POST" });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      log.textContent += dec.decode(value, { stream: true });
      log.scrollTop = log.scrollHeight;
    }
    $("#upd-state").textContent = "terminé";
    $("#upd-run").hidden = true;
    $("#upd-restart").hidden = false;
  } catch (e) {
    log.textContent += `\n[erreur : ${e.message}]\n`;
    $("#upd-run").disabled = false;
    $("#upd-state").textContent = "";
  }
}

async function restartServices() {
  const log = $("#upd-log");
  $("#upd-restart").disabled = true;
  $("#upd-state").textContent = "redémarrage…";
  try {
    const r = await fetch("/api/restart", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (j.ok === false) {
      log.textContent += `\n[le redémarrage automatique a échoué : ${j.error}]\n` +
        "Lance à la main sur le Pi :\n  sudo systemctl restart automail-worker automail-web\n";
      $("#upd-restart").disabled = false;
      $("#upd-state").textContent = "";
      return;
    }
  } catch { /* connexion coupée = le service redémarre, c'est bon signe */ }
  log.textContent += "\nRedémarrage en cours…\n";
  const t0 = Date.now();
  let back = false;
  while (Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const h = await fetch("/api/health", { cache: "no-store" });
      if (h.ok) { back = true; break; }
    } catch { /* pas encore revenu */ }
  }
  if (back) {
    log.textContent += "\n✅ Services redémarrés sur la nouvelle version.\n" +
      "   Recharge l'interface : Ctrl + Maj + R  (ou le bouton ci-dessous).\n";
    $("#upd-state").textContent = "à jour";
  } else {
    log.textContent += "\nLe service met du temps à revenir. Recharge la page dans un instant (Ctrl + Maj + R).\n";
    $("#upd-state").textContent = "";
  }
  $("#upd-restart").hidden = true;
  $("#upd-reload").hidden = false;
}

// --- événements ---------------------------------------------------------- //
$("#update").addEventListener("click", openUpdater);
$("#upd-run").addEventListener("click", runUpdate);
$("#upd-restart").addEventListener("click", restartServices);
$("#upd-reload").addEventListener("click", () => location.reload());
$("#search").addEventListener("submit", (e) => { e.preventDefault(); state.page = 1; search(); });
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); state.page = 1; search(); }
});
$("#status").addEventListener("change", () => { clearSelection(); syncTrashButton(); state.page = 1; search(); });
$("#empty-trash").addEventListener("click", emptyTrash);
$("#reset").addEventListener("click", () => {
  for (const id of ["q", "date_from", "date_to", "correspondent"]) $("#" + id).value = "";
  $("#status").value = "ok";
  $("#sort").value = "date";
  clearSelection();
  syncTrashButton();
  state.page = 1;
  search();
});
$("#prev").addEventListener("click", () => { if (state.page > 1) { clearSelection(); state.page--; search(); } });
$("#next").addEventListener("click", () => { clearSelection(); state.page++; search(); });

$("#results").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  ({ preview: openPreview, edit: openEditor, retry, restore, purge })[btn.dataset.act]?.(id);
});

$("#results").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-pick]");
  if (!cb) return;
  const id = Number(cb.dataset.pick);
  const card = cb.closest(".card");
  if (cb.checked) { state.selected.add(id); card.classList.add("selected"); }
  else { state.selected.delete(id); card.classList.remove("selected"); }
  updateSelbar();
});
$("#sel-clear").addEventListener("click", clearSelection);
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
  if (b) bulkAction(b.dataset.bulk);
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

// boucle de rafraîchissement : plus rapide quand un traitement est en cours
async function pollLoop() {
  await loadStats();
  const delay = lastInFlight > 0 ? 5000 : 12000;
  setTimeout(pollLoop, delay);
}
setTimeout(pollLoop, 5000);
