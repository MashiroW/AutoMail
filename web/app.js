"use strict";

const $ = (sel) => document.querySelector(sel);
const state = { page: 1, pageSize: 20, total: 0, editing: null };

// --- utilitaires --------------------------------------------------------- //
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
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

const LANGS = { fra: "français", deu: "allemand", ara: "arabe", eng: "anglais", "fr": "français", "de": "allemand" };

// --- recherche --------------------------------------------------------- //
function currentQuery() {
  const p = new URLSearchParams();
  const q = $("#q").value.trim();
  if (q) p.set("q", q);
  if ($("#date_from").value) p.set("date_from", $("#date_from").value);
  if ($("#date_to").value) p.set("date_to", $("#date_to").value);
  if ($("#correspondent").value.trim()) p.set("correspondent", $("#correspondent").value.trim());
  if ($("#tag").value.trim()) p.set("tag", $("#tag").value.trim());
  p.set("status", $("#status").value);
  p.set("sort", $("#sort").value);
  p.set("page", state.page);
  p.set("page_size", state.pageSize);
  return p.toString();
}

async function search() {
  const results = $("#results");
  results.innerHTML = `<p class="empty">Recherche…</p>`;
  try {
    const data = await api("/documents?" + currentQuery());
    state.total = data.total;
    render(data.items);
    renderPager(data);
  } catch (e) {
    results.innerHTML = `<p class="empty">Erreur : ${e.message}</p>`;
  }
}

function render(items) {
  const results = $("#results");
  if (!items.length) {
    results.innerHTML = `<p class="empty">Aucun courrier trouvé.</p>`;
    return;
  }
  results.innerHTML = "";
  for (const doc of items) {
    const card = document.createElement("article");
    card.className = "card";

    const thumb = doc.has_thumbnail
      ? `<img class="thumb" src="/api/documents/${doc.id}/thumbnail" alt="" loading="lazy">`
      : `<div class="thumb"></div>`;

    const badges = [];
    if (doc.ocr_status === "failed") badges.push(`<span class="badge fail">échec OCR</span>`);
    if (doc.lang_guess && doc.lang_guess !== "fr")
      badges.push(`<span class="badge lang">langue possible : ${LANGS[doc.lang_guess] || doc.lang_guess}</span>`);
    for (const t of doc.tags) badges.push(`<span class="badge tag">${escapeHtml(t)}</span>`);

    const actions =
      doc.ocr_status === "failed"
        ? `<button data-act="retry" data-id="${doc.id}">Réessayer</button>
           <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
           <button data-act="edit" data-id="${doc.id}">Modifier</button>`
        : `<button data-act="preview" data-id="${doc.id}">Aperçu</button>
           <a class="btn" href="/api/documents/${doc.id}/download">Télécharger</a>
           <button data-act="edit" data-id="${doc.id}">Modifier</button>`;

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
  const pager = $("#pager");
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  pager.hidden = data.total === 0;
  $("#pageinfo").textContent = `Page ${data.page} / ${pages} — ${data.total} courrier(s)`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- stats & tags ---------------------------------------------------------- //
async function loadStats() {
  try {
    const s = await api("/stats");
    const freeGo = (s.disk_free_bytes / 1e9).toFixed(1);
    $("#stats").innerHTML =
      `<b>${s.total}</b> courriers` +
      (s.failed ? ` · <span class="warn">${s.failed} en échec</span>` : "") +
      (s.last_added ? ` · dernier ajout ${fmtDate(s.last_added)}` : "") +
      ` · ${freeGo} Go libres`;
  } catch (_) {}
}

async function loadTags() {
  try {
    const tags = await api("/tags");
    $("#taglist").innerHTML = tags.map((t) => `<option value="${escapeHtml(t.name)}">`).join("");
  } catch (_) {}
}

// --- modale d'aperçu ---------------------------------------------------- //
function openPreview(id) {
  $("#preview-frame").src = `/api/documents/${id}/pdf`;
  $("#preview-dl").href = `/api/documents/${id}/download`;
  $("#preview").showModal();
}

// --- modale d'édition ------------------------------------------------------ //
async function openEditor(id) {
  const doc = await api("/documents/" + id);
  state.editing = doc;
  $("#e-title").value = doc.title || "";
  $("#e-correspondent").value = doc.correspondent || "";
  $("#e-date").value = doc.document_date || "";
  $("#e-tags").value = doc.tags.join(", ");
  $("#e-notes").value = doc.notes || "";
  $("#editor").showModal();
}

async function saveEditor() {
  const id = state.editing.id;
  const body = {
    title: $("#e-title").value,
    correspondent: $("#e-correspondent").value,
    document_date: $("#e-date").value,
    notes: $("#e-notes").value,
    tags: $("#e-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  try {
    await api("/documents/" + id, { method: "PATCH", body: JSON.stringify(body) });
    toast("Enregistré");
    $("#editor").close();
    await Promise.all([search(), loadTags()]);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}

async function reocr(lang) {
  try {
    await api(`/documents/${state.editing.id}/reocr`, {
      method: "POST", body: JSON.stringify({ language: lang }),
    });
    toast(`Ré-OCR (${lang}) mis en file d'attente`);
    $("#editor").close();
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}

async function del(id) {
  if (!confirm("Déplacer ce courrier dans la corbeille ?")) return;
  try {
    await api("/documents/" + id, { method: "DELETE" });
    toast("Déplacé dans la corbeille");
    $("#editor").close();
    await Promise.all([search(), loadStats()]);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}

async function retry(id) {
  try {
    await api(`/documents/${id}/retry`, { method: "POST" });
    toast("Renvoyé dans l'inbox pour un nouveau traitement");
    setTimeout(() => { search(); loadStats(); }, 500);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}

// --- événements ------------------------------------------------------------ //
$("#search").addEventListener("submit", (e) => { e.preventDefault(); state.page = 1; search(); });
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    state.page = 1;
    search();
  }
});
$("#reset").addEventListener("click", () => {
  $("#search").reset();
  $("#status").value = "ok";
  state.page = 1;
  search();
});
$("#prev").addEventListener("click", () => { if (state.page > 1) { state.page--; search(); } });
$("#next").addEventListener("click", () => { state.page++; search(); });

$("#results").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === "preview") openPreview(id);
  if (btn.dataset.act === "edit") openEditor(id);
  if (btn.dataset.act === "retry") retry(id);
});

$("#editform").addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
$("#e-delete").addEventListener("click", () => del(state.editing.id));
document.querySelectorAll(".reocr [data-lang]").forEach((b) =>
  b.addEventListener("click", () => reocr(b.dataset.lang)));
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest("dialog").close()));
$("#preview").addEventListener("close", () => ($("#preview-frame").src = "about:blank"));

// --- démarrage ----------------------------------------------------------- //
loadStats();
loadTags();
search();
setInterval(loadStats, 30000);
