"use strict";

const $ = (s) => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  page: 1,
  pageSize: Number(LS.get("pageSize", 50)) || 50,
  view: LS.get("view", "detail"),
  progFilter: "",
  trash: false,
  selectMode: false,
  selected: new Set(),
  statsSig: null,
  lastInFlight: 0,
};

const LANGS = { fra: "français", deu: "allemand", ara: "arabe", eng: "anglais", fr: "français", de: "allemand", en: "anglais" };
const OCRSTATUS = { pending: "en attente", ok: "OK", "skipped-has-text": "texte conservé", failed: "échec" };
const PROG = {
  todo: ["À faire", "prog-todo"],
  ongoing: ["En cours", "prog-ongoing"],
  done: ["Fait", "prog-done"],
};
const PROG_NEXT = { todo: "ongoing", ongoing: "done", done: "todo" };

// --- thème ------------------------------------------------------------- //
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark" || mode === "light") root.dataset.theme = mode;
  else root.removeAttribute("data-theme");
  const dark = mode === "dark" ||
    (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#theme").textContent = dark ? "☀️" : "🌙";
}
let themeMode = LS.get("theme", "auto");
applyTheme(themeMode);
$("#theme").addEventListener("click", () => {
  themeMode = themeMode === "dark" ? "light" : "dark";
  LS.set("theme", themeMode);
  applyTheme(themeMode);
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
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}
function fmtBytes(n) {
  if (!n) return "";
  const u = ["o", "Ko", "Mo", "Go"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(iso) {
  if (!iso) return "sans date";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  }
  p.set("sort", $("#sort").value);
  p.set("page", state.page);
  p.set("page_size", state.pageSize);
  return p.toString();
}

async function search(silent = false) {
  const results = $("#results");
  if (!silent) results.innerHTML = `<p class="empty">Recherche…</p>`;
  try {
    const data = await api("/documents?" + currentQuery());
    render(data.items);
    renderPager(data);
  } catch (e) {
    if (!silent) results.innerHTML = `<p class="empty">Erreur : ${esc(e.message)}</p>`;
  }
}

function render(items) {
  const results = $("#results");
  results.className = "view-" + state.view + (state.selectMode ? " selecting" : "");
  const visible = new Set(items.map((d) => d.id));
  for (const id of [...state.selected]) if (!visible.has(id)) state.selected.delete(id);

  if (!items.length) {
    results.innerHTML = `<p class="empty">${state.trash ? "La corbeille est vide." : "Aucun courrier trouvé."}</p>`;
    updateSelbar();
    return;
  }
  results.innerHTML = "";
  for (const doc of items) {
    const card = document.createElement("article");
    card.className = "card" + (state.selected.has(doc.id) ? " selected" : "");
    card.dataset.id = doc.id;

    const thumb = (!state.trash && doc.has_thumbnail && state.view !== "list")
      ? `<img class="thumb" src="/api/documents/${doc.id}/thumbnail" alt="" loading="lazy">`
      : `<div class="thumb"></div>`;

    const badges = [];
    if (doc.ocr_status === "pending")
      badges.push(`<span class="badge busy">OCR en cours…</span>`);
    if (doc.ocr_status === "failed")
      badges.push(`<span class="badge fail">échec OCR (${doc.ocr_attempts}×)</span>`);
    if (doc.lang_guess && doc.lang_guess !== "fr")
      badges.push(`<span class="badge lang">langue&nbsp;? ${LANGS[doc.lang_guess] || doc.lang_guess}</span>`);

    let actions;
    if (state.trash) {
      actions = `<button data-act="restore" data-id="${doc.id}">Restaurer</button>
        <button data-act="purge" data-id="${doc.id}" class="danger">Supprimer</button>`;
    } else if (doc.ocr_status === "pending") {
      actions = `<button data-act="preview" data-id="${doc.id}">Aperçu</button>
        <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
        <button data-act="edit" data-id="${doc.id}">Modifier</button>`;
    } else if (doc.ocr_status === "failed") {
      actions = `<button data-act="retry" data-id="${doc.id}">Réessayer</button>
        <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
        <button data-act="edit" data-id="${doc.id}">Modifier</button>`;
    } else {
      actions = `<button data-act="preview" data-id="${doc.id}">Aperçu</button>
        <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
        <button data-act="edit" data-id="${doc.id}">Modifier</button>`;
    }

    const [plabel, pcls] = PROG[doc.progress] || PROG.done;
    const pill = state.trash ? "" :
      `<button class="prog ${pcls}" data-prog="${doc.id}" data-cur="${doc.progress}" title="Changer l'avancement">${plabel}</button>`;

    card.innerHTML = `
      <label class="pick"><input type="checkbox" data-pick="${doc.id}"${state.selected.has(doc.id) ? " checked" : ""}></label>
      ${thumb}
      <div class="body">
        <div class="row1">
          <h3>${esc(doc.title || doc.original_filename)}</h3>
          ${pill}
        </div>
        <div class="meta">
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

function renderPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $("#pager").hidden = data.total === 0;
  $("#pageinfo").textContent = `Page ${data.page} / ${pages} — ${data.total} courrier(s)`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

// --- avancement (pill cliquable) ------------------------------------------ //
async function cycleProgress(id, cur) {
  const val = PROG_NEXT[cur] || "todo";
  try {
    await api("/documents/" + id, { method: "PATCH", body: JSON.stringify({ progress: val }) });
    search(true);
  } catch (e) { toast("Erreur : " + e.message); }
}

// --- sélection multiple ------------------------------------------------- //
function setSelectMode(on) {
  state.selectMode = on;
  $("#select-toggle").classList.toggle("on", on);
  $("#select-toggle").textContent = on ? "Quitter la sélection" : "Sélectionner";
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
  $("#sel-count").textContent = `${n} sélectionné${n > 1 ? "s" : ""}`;
  const acts = state.trash
    ? `<button type="button" data-bulk="restore"${n ? "" : " disabled"}>Restaurer</button>
       <button type="button" data-bulk="purge" class="danger"${n ? "" : " disabled"}>Supprimer définitivement</button>`
    : `<button type="button" data-bulk="download"${n ? "" : " disabled"}>Télécharger (ZIP)</button>
       <select id="bulk-prog"${n ? "" : " disabled"}>
         <option value="">Avancement…</option>
         <option value="todo">À faire</option>
         <option value="ongoing">En cours</option>
         <option value="done">Fait</option>
       </select>
       <button type="button" data-bulk="trash" class="danger"${n ? "" : " disabled"}>Corbeille</button>`;
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
  const label = { trash: "déplacer vers la corbeille", restore: "restaurer",
                  purge: "supprimer DÉFINITIVEMENT", progress: "changer l'avancement" }[action];
  if ((action === "trash" || action === "purge") &&
      !confirm(`${ids.length} courrier(s) — ${label} ?`)) return;
  try {
    const r = await api("/bulk", {
      method: "POST", body: JSON.stringify({ ids, action, value: value || null }),
    });
    toast(`${r.done} traité(s)` + (r.errors.length ? ` · ${r.errors.length} erreur(s)` : ""));
    clearSelection();
    search(); loadStats();
  } catch (e) { toast("Erreur : " + e.message); }
}

// --- stats + auto-refresh -------------------------------------------------- //
async function loadStats() {
  let s;
  try { s = await api("/stats"); } catch { return; }
  const parts = [`<b>${s.total}</b> courriers`];
  const inFlight = (s.pending || 0) + (s.reprocessing || 0);
  const prevInFlight = state.lastInFlight;
  if (inFlight) parts.push(`<span class="busy">${inFlight} en traitement</span>`);
  if (s.failed) parts.push(`<span class="warn">${s.failed} en échec</span>`);
  parts.push(`${(s.disk_free_bytes / 1e9).toFixed(1)} Go libres`);
  if (s.cpu_temp_c != null) {
    const t = s.cpu_temp_c;
    const cls = t >= 80 ? "warn" : t >= 70 ? "busy" : "";
    parts.push(`<span class="${cls}">${t.toFixed(1)} °C</span>`);
  }
  $("#stats").innerHTML = parts.join(" · ");

  // rafraîchit la liste si l'état a changé OU si un traitement est/était en cours
  // (un courrier qui passe non traité -> traité ne bouge aucun compteur global)
  const sig = [s.total, s.failed, s.pending, s.reprocessing, s.trashed, s.last_added].join("|");
  const shouldRefresh =
    (state.statsSig !== null && sig !== state.statsSig) ||
    inFlight > 0 || prevInFlight > 0;
  if (shouldRefresh && state.page === 1 && !document.querySelector("dialog[open]")) {
    const y = window.scrollY;
    await search(true);
    window.scrollTo(0, y);
  }
  state.statsSig = sig;
  state.lastInFlight = inFlight;
}

// --- aperçu ------------------------------------------------------------- //
function openPreview(id) {
  $("#preview-frame").src = `/api/documents/${id}/pdf`;
  $("#preview-dl").href = `/api/documents/${id}/download`;
  $("#preview").showModal();
}

// --- édition ---------------------------------------------------------------- //
let editing = null;
async function openEditor(id) {
  const d = await api("/documents/" + id);
  editing = d;
  $("#e-title").value = d.title || "";
  $("#e-date").value = d.document_date || "";
  $("#e-progress").value = d.progress || "done";
  $("#e-notes").value = d.notes || "";
  $("#e-info").innerHTML = `
    <dt>Fichier</dt><dd>${esc(d.original_filename)}</dd>
    <dt>Ajouté le</dt><dd>${fmtDate(d.added_at)}</dd>
    <dt>Pages</dt><dd>${d.page_count ?? "?"}</dd>
    <dt>Taille</dt><dd>${fmtBytes(d.bytes) || "?"}</dd>
    <dt>OCR</dt><dd>${OCRSTATUS[d.ocr_status] || d.ocr_status}${d.ocr_language ? " · " + (LANGS[d.ocr_language] || d.ocr_language) : ""}</dd>
    <dt>Date</dt><dd>${fmtDate(d.document_date)}${d.document_date ? " (" + (d.document_date_source === "manual" ? "saisie" : "détectée") + ")" : ""}</dd>`;
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
    toast("Enregistré"); $("#editor").close(); search();
  } catch (e) { toast("Erreur : " + e.message); }
}
async function reocr(lang) {
  try {
    await api(`/documents/${editing.id}/reocr`, { method: "POST", body: JSON.stringify({ language: lang }) });
    toast(`Ré-OCR (${lang}) en file d'attente`); $("#editor").close(); setTimeout(loadStats, 300);
  } catch (e) { toast("Erreur : " + e.message); }
}
async function del(id) {
  if (!confirm("Déplacer ce courrier dans la corbeille ?")) return;
  try {
    await api("/documents/" + id, { method: "DELETE" });
    toast("Déplacé dans la corbeille"); $("#editor").close(); search(); loadStats();
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
  try { await api(`/documents/${id}/restore`, { method: "POST" }); toast("Restauré"); search(); loadStats(); }
  catch (e) { toast("Erreur : " + e.message); }
}
async function purge(id) {
  if (!confirm("Supprimer définitivement ? (irréversible)")) return;
  try { await api(`/documents/${id}/purge`, { method: "DELETE" }); toast("Supprimé"); search(); loadStats(); }
  catch (e) { toast("Erreur : " + e.message); }
}
async function emptyTrash() {
  if (!confirm("Vider la corbeille ? Suppression définitive de tout son contenu.")) return;
  try { const r = await api("/trash/empty", { method: "POST" }); toast(`Corbeille vidée (${r.count})`); search(); loadStats(); }
  catch (e) { toast("Erreur : " + e.message); }
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
      ? `Version actuelle : ${v.commit} — ${v.subject} (${v.date})${v.dirty ? " · modifs locales" : ""}`
      : "Version actuelle : inconnue";
  } catch { $("#upd-current").textContent = ""; }
}
async function runUpdate() {
  const log = $("#upd-log");
  log.hidden = false; log.textContent = "";
  $("#upd-run").disabled = true; $("#upd-state").textContent = "en cours…";
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
    $("#upd-state").textContent = "terminé";
    $("#upd-run").hidden = true; $("#upd-restart").hidden = false;
  } catch (e) {
    log.textContent += `\n[erreur : ${e.message}]\n`;
    $("#upd-run").disabled = false; $("#upd-state").textContent = "";
  }
}
async function restartServices() {
  const log = $("#upd-log");
  $("#upd-restart").disabled = true; $("#upd-state").textContent = "redémarrage…";
  try {
    const r = await fetch("/api/restart", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (j.ok === false) {
      log.textContent += `\n[échec du redémarrage : ${j.error}]\n` +
        "Sur le Pi : sudo systemctl restart automail-worker automail-web\n";
      $("#upd-restart").disabled = false; $("#upd-state").textContent = ""; return;
    }
  } catch {}
  log.textContent += "\nRedémarrage en cours…\n";
  const t0 = Date.now(); let back = false;
  while (Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 2000));
    try { const h = await fetch("/api/health", { cache: "no-store" }); if (h.ok) { back = true; break; } } catch {}
  }
  log.textContent += back
    ? "\n✅ Services redémarrés. Recharge l'interface : Ctrl + Maj + R (ou le bouton).\n"
    : "\nLe service met du temps à revenir. Recharge dans un instant (Ctrl + Maj + R).\n";
  $("#upd-state").textContent = back ? "à jour" : "";
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
  $("#progseg").querySelectorAll("button").forEach((b) => (b.disabled = on));
  $("#empty-trash")?.remove();
  if (on) {
    const b = document.createElement("button");
    b.id = "empty-trash"; b.type = "button"; b.className = "danger";
    b.textContent = "Vider la corbeille";
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

$("#go").addEventListener("click", () => { state.page = 1; search(); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { state.page = 1; search(); } });
$("#ocrstatus").addEventListener("change", () => { state.page = 1; search(); });
$("#progseg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pf]"); if (!b) return;
  setProgFilter(b.dataset.pf); state.page = 1; search();
});
$("#sort").addEventListener("change", () => { state.page = 1; search(); });
$("#reset").addEventListener("click", () => {
  for (const id of ["q", "date_from", "date_to"]) $("#" + id).value = "";
  $("#ocrstatus").value = "ok"; setProgFilter(""); $("#sort").value = "date";
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
setView(state.view);
loadStats();
search();
(async function pollLoop() {
  await loadStats();
  setTimeout(pollLoop, state.lastInFlight > 0 ? 5000 : 12000);
})();
