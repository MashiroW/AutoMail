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
const PROG_COLOR = { todo: "var(--prog-todo)", ongoing: "var(--prog-ongoing)", done: "var(--prog-done)" };

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
  // le bouton clair/sombre ne sert que pour "corporate"
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

function skeletonHTML(n) {
  const one = `<article class="card skeleton"><div class="thumb"></div>
    <div class="body"><div class="sk-line w60"></div><div class="sk-line w40"></div>
    <div class="sk-line w80"></div><div class="sk-line w40"></div></div></article>`;
  return one.repeat(n);
}

async function search(silent = false) {
  const results = $("#results");
  if (!silent) results.innerHTML = skeletonHTML(Math.min(8, state.pageSize));
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
    results.innerHTML = `<div class="empty">${IC.inbox}<div>${state.trash ? "La corbeille est vide." : "Aucun courrier trouvé."}</div></div>`;
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

    const btn = (extra, ic, label) => `<button ${extra} title="${label}">${ic}<span>${label}</span></button>`;
    const dl = `<a class="btn" href="/api/documents/${doc.id}/download" title="Télécharger">${IC.download}<span>Télécharger</span></a>`;
    const edit = btn(`data-act="edit" data-id="${doc.id}"`, IC.edit, "Modifier");
    const view = btn(`data-act="preview" data-id="${doc.id}"`, IC.eye, "Aperçu");
    let actions;
    if (state.trash) {
      actions = btn(`data-act="restore" data-id="${doc.id}"`, IC.restore, "Restaurer") +
        `<button data-act="purge" data-id="${doc.id}" class="danger" title="Supprimer">${IC.trash}<span>Supprimer</span></button>`;
    } else if (doc.ocr_status === "failed") {
      actions = btn(`data-act="retry" data-id="${doc.id}"`, IC.retry, "Réessayer") + dl + edit;
    } else {
      actions = view + dl + edit;
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
  if (s.pending) parts.push(`<span class="busy">${s.pending} non traité${s.pending > 1 ? "s" : ""}</span>`);
  if (s.reprocessing) parts.push(`<span class="busy">${s.reprocessing} en ré-OCR</span>`);
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

// --- navigation Courriers / Tableau de bord ------------------------------- //
function setNav(v) {
  document.querySelectorAll(".mainnav button").forEach((b) => b.classList.toggle("on", b.dataset.nav === v));
  $("#view-mail").hidden = v !== "mail";
  $("#view-dash").hidden = v !== "dash";
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
async function loadDashboard() {
  const el = $("#dash");
  el.innerHTML = skeletonHTML(4);
  try {
    const o = await api("/overview");
    const usedGo = ((o.disk_total_bytes - o.disk_free_bytes) / 1e9).toFixed(1);
    const totGo = (o.disk_total_bytes / 1e9).toFixed(0);
    el.innerHTML = `
      <div class="kpi"><div class="k-label">Courriers</div><div class="k-value">${o.total}</div>
        <div class="k-sub">${o.this_month} ce mois-ci</div></div>
      <div class="kpi"><div class="k-label">En échec OCR</div><div class="k-value">${o.by_ocr.failed}</div>
        <div class="k-sub">${o.by_ocr.pending} en attente</div></div>
      <div class="kpi"><div class="k-label">Corbeille</div><div class="k-value">${o.trashed}</div>
        <div class="k-sub">non comptés dans le total</div></div>
      <div class="kpi"><div class="k-label">Stockage</div><div class="k-value">${usedGo} Go</div>
        <div class="k-sub">sur ${totGo} Go${o.cpu_temp_c != null ? " · " + o.cpu_temp_c.toFixed(0) + " °C" : ""}</div></div>
      <div class="panel"><h3>Courriers par mois</h3>${o.by_month.length ? bars(o.by_month) : '<p class="muted">Pas encore de données.</p>'}</div>
      <div class="panel half"><h3>Avancement</h3>${legend(o.by_progress,
        { todo: "var(--prog-todo)", ongoing: "var(--prog-ongoing)", done: "var(--prog-done)" },
        { todo: "À faire", ongoing: "En cours", done: "Fait" })}</div>
      <div class="panel half"><h3>État de l'OCR</h3>${legend(o.by_ocr,
        { ok: "var(--ok)", pending: "var(--accent)", failed: "var(--danger)" },
        { ok: "Traités", pending: "Non traités", failed: "Échecs" })}</div>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">Erreur : ${esc(e.message)}</p>`;
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
setView(state.view);
loadStats();
search();
(async function pollLoop() {
  await loadStats();
  setTimeout(pollLoop, state.lastInFlight > 0 ? 5000 : 12000);
})();
