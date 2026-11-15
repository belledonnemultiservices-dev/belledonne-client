// Fenêtre de planification d'un dossier (Suivi, onglet En contrat).
// Cinq étapes dans l'ordre de travail : dossier → passages → agenda → Kizeo →
// notifications, puis un récapitulatif. Chaque étape enregistre aussitôt dans la
// fiche (même format de passages que la fiche classique), si bien que la fiche,
// la vue Semaine et l'assistant lisent tout normalement.
// Réutilise les fonctions serveur existantes (addToCalendar, pushKizeoForm) et la
// fenêtre de notification existante (modèles, contacts, pièces jointes).
// Fonctions de la page utilisées : passagesNorm, etatAgenda, etatKizeo, notifPassage,
// notifOk, cleSyncAgenda, fmtDate, jjmm, CERCLES, showToast, toNotifArray,
// window._updateSuivi, window._authHeaders, window._findKizeoFormLie, window.openNotifFromItem.

const URL_AGENDA = "https://europe-west1-belledonne-client.cloudfunctions.net/addToCalendar";
const URL_KIZEO = "https://europe-west1-belledonne-client.cloudfunctions.net/pushKizeoForm";
const ETAPES = ["Dossier", "Passages", "Agenda", "Kizeo", "Notifications", "Récapitulatif"];

const CSS = `
#plOverlay{position:fixed;inset:0;z-index:250;background:rgba(13,27,42,.38);display:none;align-items:center;justify-content:center;padding:16px;}
#plOverlay.ouvert{display:flex;}
.pl-box{background:#fff;border-radius:14px;width:920px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(13,27,42,.3);font-family:'DM Sans',sans-serif;color:#0D1B2A;}
.pl-tete{padding:18px 24px 12px;border-bottom:1px solid rgba(13,27,42,.09);}
.pl-titre{display:flex;align-items:center;gap:10px;}
.pl-titre h2{margin:0;font:700 17px 'Syne','DM Sans',sans-serif;flex:1;}
.pl-titre small{display:block;font:400 12.5px 'DM Sans',sans-serif;color:#4A6078;margin-top:2px;}
.pl-fermer{border:none;background:#F2F5F8;width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;color:#4A6078;}
.pl-etapes{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;}
.pl-etape{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:20px;border:1px solid rgba(13,27,42,.1);font-size:12.5px;font-weight:600;color:#8FA4B8;background:#fff;cursor:pointer;}
.pl-etape .pl-num{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:#F2F5F8;color:#4A6078;}
.pl-etape.active{border-color:#4338CA;color:#312E81;background:#EEF2FF;}
.pl-etape.active .pl-num{background:#4338CA;color:#fff;}
.pl-etape.faite{color:#1DA870;}
.pl-etape.faite .pl-num{background:#1DA870;color:#fff;}
.pl-corps{padding:20px 24px;overflow-y:auto;flex:1;}
.pl-pied{padding:14px 24px;border-top:1px solid rgba(13,27,42,.09);display:flex;gap:10px;align-items:center;}
.pl-pied .pl-espace{flex:1;}
.pl-btn{font:600 13px 'DM Sans',sans-serif;border:1px solid rgba(13,27,42,.12);background:#fff;color:#0D1B2A;border-radius:8px;padding:9px 16px;cursor:pointer;}
.pl-btn:disabled{opacity:.5;cursor:default;}
.pl-btn.prim{background:#1DA870;border-color:#1DA870;color:#fff;}
.pl-btn.indigo{background:#4338CA;border-color:#4338CA;color:#fff;}
.pl-btn.lien{border:none;background:none;color:#4A6078;text-decoration:underline;padding:9px 4px;}
.pl-btn.petit{padding:5px 10px;font-size:12px;}
.pl-intro{font-size:13px;color:#4A6078;margin:0 0 14px;}
.pl-grille{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;}
.pl-champ label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#8FA4B8;margin-bottom:5px;}
.pl-champ input,.pl-champ select,.pl-champ textarea{width:100%;box-sizing:border-box;height:38px;border:1px solid rgba(13,27,42,.15);border-radius:8px;padding:0 10px;font:13px 'DM Sans',sans-serif;color:#0D1B2A;background:#fff;}
.pl-champ .pl-lecture{font-size:13.5px;padding:8px 0;}
.pl-manque{color:#E74C3C;font-weight:600;}
.pl-table{width:100%;border-collapse:collapse;font-size:13px;}
.pl-table th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#8FA4B8;text-align:left;padding:6px 8px;border-bottom:1px solid rgba(13,27,42,.09);font-weight:700;}
.pl-table td{padding:8px;border-bottom:1px solid rgba(13,27,42,.06);vertical-align:middle;}
.pl-table input[type=date],.pl-table input[type=time],.pl-table select,.pl-table input[type=text]{height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;font:13px 'DM Sans',sans-serif;}
.pl-techs{display:flex;flex-wrap:wrap;gap:5px;}
.pl-tech{font-size:12px;padding:4px 9px;border-radius:14px;border:1px solid rgba(13,27,42,.15);cursor:pointer;background:#fff;user-select:none;}
.pl-tech.on{background:#4338CA;border-color:#4338CA;color:#fff;}
.pl-charge{font-size:11.5px;color:#D9480F;margin-top:4px;}
.pl-etat{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:12px;white-space:nowrap;}
.pl-ok{background:#E8F9F2;color:#1DA870;}
.pl-ko{background:#FDECEA;color:#E74C3C;}
.pl-att{background:#FFEBD6;color:#D9480F;}
.pl-na{background:#F2F5F8;color:#8FA4B8;}
.pl-actions{display:flex;gap:10px;align-items:center;margin:16px 0 4px;flex-wrap:wrap;}
.pl-note{font-size:12px;color:#8FA4B8;}
.pl-recap td{text-align:center;}
.pl-recap td:first-child{text-align:left;}
.pl-cercle{color:#4338CA;font-weight:700;}
@media (max-width:640px){.pl-grille{grid-template-columns:1fr;}}
`;

let etat = null; // { id, etape, lignes (étape Passages), occupe }
let surveillance = null;

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dossier = () => (window.interventions || []).find(i => i.id === (etat && etat.id));
const techniciens = () => window._techniciens || [];
const nomTech = (t) => t.nomComplet || t.nom || "";
const techParNom = (nom) => techniciens().find(t => t.nomComplet === nom || t.nom === nom);
const cercle = (n) => (window.CERCLES && window.CERCLES[n - 1]) || "#" + n;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "_" + Math.random().toString(36).slice(2));
const etatHtml = (cls, txt, titre) => `<span class="pl-etat pl-${cls}"${titre ? ` title="${esc(titre)}"` : ""}>${txt}</span>`;
const pause = (ms) => new Promise(r => setTimeout(r, ms));

// Passages bruts du dossier (format de la fiche), anciens formats convertis.
function passagesBruts(item) {
  const bruts = Array.isArray(item.passages) ? item.passages : [item.date1, item.date2, item.date3].filter(Boolean);
  return bruts.filter(Boolean).map((p, i) => {
    if (typeof p === "string") { const [debut, fin] = p.split("|"); return { num: i + 1, passageId: null, debut: debut || "", fin: fin || "", techs: [] }; }
    return { ...p };
  }).sort((a, b) => (a.num || 0) - (b.num || 0));
}
const actifs = (item) => passagesBruts(item).filter(p => p.statut !== "annule" && p.debut);
const norm = (item, num) => (window.passagesNorm ? window.passagesNorm(item) : []).find(p => p.num === num);

// ── Ouverture / fermeture ──────────────────────────────────────────
export function ouvrirPlanification(id, etape) {
  const item = (window.interventions || []).find(i => i.id === id);
  if (!item) return;
  monter();
  etat = { id, etape: etape ?? etapeConseillee(item), lignes: null, occupe: false };
  $("#plOverlay").classList.add("ouvert");
  rendre();
  // La fiche se met à jour en temps réel (envois Kizeo, notifications…) : on redessine
  clearInterval(surveillance);
  let empreinte = JSON.stringify(item);
  surveillance = setInterval(() => {
    const it = dossier();
    if (!it || etat.occupe) return;
    const e = JSON.stringify(it);
    if (e !== empreinte) { empreinte = e; if (etat.etape !== 1) rendre(); else rendreEtapes(); }
  }, 1200);
}
function fermer() {
  clearInterval(surveillance);
  $("#plOverlay").classList.remove("ouvert");
  etat = null;
  if (window.filterTable) window.filterTable();
}
// Première étape non faite
function etapeConseillee(item) {
  const f = etatsEtapes(item);
  for (let k = 0; k < 5; k++) if (!f[k]) return k;
  return 5;
}
// Étapes faites (coches de la barre de progression)
function etatsEtapes(item) {
  const ps = actifs(item);
  const ns = ps.map(p => norm(item, p.num)).filter(Boolean);
  const dossierOk = !!(item.adresse && (item.bc || item.pl || item.devis));
  const passagesOk = ps.length > 0 && ps.every(p => (p.techs || []).length);
  const agendaOk = ns.length > 0 && ns.every(p => window.etatAgenda(p) === "ok");
  const kizeoOk = ns.length > 0 && ns.every(p => { const e = window.etatKizeo(item, p); return e === "ok" || e === "recu"; });
  const clientOk = ns.length > 0 && ns.every(p => window.notifOk(window.notifPassage(item, p, "notifBailleur")));
  const locOk = !item.emailClient || (ns.length > 0 && ns.every(p => window.notifOk(window.notifPassage(item, p, "notifLocataire"))));
  return [dossierOk, passagesOk, agendaOk, kizeoOk, clientOk && locOk];
}

function monter() {
  if ($("#plOverlay")) return;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  const ov = document.createElement("div"); ov.id = "plOverlay";
  ov.innerHTML = `<div class="pl-box"><div class="pl-tete"></div><div class="pl-corps"></div><div class="pl-pied"></div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) fermer(); });
}

function rendreEtapes() {
  const item = dossier(); if (!item) return;
  const faits = etatsEtapes(item);
  const ref = item.bc ? "BC " + item.bc : item.pl ? "PL " + item.pl : item.devis ? "Devis " + item.devis : "Sans référence";
  $(".pl-tete").innerHTML = `
    <div class="pl-titre"><div style="flex:1"><h2>Planifier · ${esc(ref)}</h2><small>${esc(item.client || "")}${item.nature ? " · " + esc(item.nature) : ""}${item.adresse ? " · " + esc(item.adresse) : ""}</small></div>
      <button class="pl-fermer" data-a="fermer" title="Fermer (tout est déjà enregistré)">×</button></div>
    <div class="pl-etapes">${ETAPES.map((nom, k) => `<div class="pl-etape${k === etat.etape ? " active" : ""}${k < 5 && faits[k] ? " faite" : ""}" data-etape="${k}"><span class="pl-num">${k < 5 && faits[k] ? "✓" : k + 1}</span>${nom}</div>`).join("")}</div>`;
  $(".pl-tete [data-a=fermer]").onclick = fermer;
  document.querySelectorAll(".pl-etape").forEach(el => el.onclick = () => { etat.etape = Number(el.dataset.etape); etat.lignes = null; rendre(); });
}

function rendre() {
  if (!etat) return;
  const item = dossier();
  if (!item) { fermer(); return; }
  rendreEtapes();
  [rendreDossier, rendrePassages, rendreAgenda, rendreKizeo, rendreNotifications, rendreRecap][etat.etape](item);
}
function pied(html) { $(".pl-pied").innerHTML = html; }
function navigation(suivantLib, surSuivant) {
  pied(`${etat.etape > 0 ? `<button class="pl-btn" data-a="prec">← Précédent</button>` : ""}<span class="pl-espace"></span>
    ${etat.etape < 5 ? `<button class="pl-btn lien" data-a="plustard">Plus tard</button>` : ""}
    <button class="pl-btn prim" data-a="suiv">${suivantLib}</button>`);
  const prec = $(".pl-pied [data-a=prec]"); if (prec) prec.onclick = () => { etat.etape--; etat.lignes = null; rendre(); };
  const pt = $(".pl-pied [data-a=plustard]"); if (pt) pt.onclick = () => { etat.etape++; etat.lignes = null; rendre(); };
  $(".pl-pied [data-a=suiv]").onclick = async () => {
    const b = $(".pl-pied [data-a=suiv]"); b.disabled = true;
    try { if (surSuivant && (await surSuivant()) === false) return; etat.etape++; etat.lignes = null; rendre(); }
    finally { if (b.isConnected) b.disabled = false; }
  };
}

// ── 1. Dossier ─────────────────────────────────────────────────────
function rendreDossier(item) {
  const tel = (Array.isArray(item.coordonnees) ? item.coordonnees : item.coordonnees ? [item.coordonnees] : []).join(", ");
  const ref = [item.bc && "BC " + item.bc, item.pl && "PL " + item.pl, item.devis && "Devis " + item.devis].filter(Boolean).join(" · ");
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Vérifie qu'on a tout ce qu'il faut pour planifier et prévenir le locataire. Complète ce qui manque.</p>
    <div class="pl-grille">
      <div class="pl-champ"><label>Client</label><div class="pl-lecture">${esc(item.client || "—")}</div></div>
      <div class="pl-champ"><label>Référence</label><div class="pl-lecture">${ref ? esc(ref) : '<span class="pl-manque">Aucune référence</span>'}</div></div>
      <div class="pl-champ"><label>Nature</label><div class="pl-lecture">${esc(item.nature || "—")}</div></div>
      <div class="pl-champ"><label>Adresse</label><input id="plAdresse" value="${esc(item.adresse)}" placeholder="Adresse d'intervention"></div>
      <div class="pl-champ"><label>Locataire</label><input id="plNom" value="${esc(item.nomClient)}" placeholder="Nom du locataire"></div>
      <div class="pl-champ"><label>Téléphone(s) du locataire</label><input id="plTel" value="${esc(tel)}" placeholder="06…, séparés par des virgules"></div>
      <div class="pl-champ"><label>Email du locataire</label><input id="plEmail" value="${esc(item.emailClient)}" placeholder="Pour lui envoyer la notification"></div>
      <div class="pl-champ"><label>Observations</label><div class="pl-lecture" style="font-size:12.5px;color:#4A6078;">${esc(item.observations || "—")}</div></div>
    </div>
    <div class="pl-actions"><button class="pl-btn" data-a="attente">Mettre en attente…</button><span class="pl-note">Si une information bloque la planification (locataire injoignable, accès…)</span></div>`;
  $("[data-a=attente]").onclick = async () => {
    const note = prompt("Pourquoi ce dossier est-il en attente ? (la note est ajoutée au dossier)");
    if (note === null) return;
    const ligne = new Date().toLocaleDateString("fr-FR") + " : " + note.trim();
    await window._updateSuivi(item.id, { statut: "En attente", notes: [item.notes, ligne].filter(Boolean).join("\n"), updatedAt: new Date().toISOString() });
    showToast("Dossier mis en attente");
    fermer();
  };
  navigation("Enregistrer et continuer →", async () => {
    const coords = $("#plTel").value.split(",").map(s => s.trim()).filter(Boolean);
    const maj = { adresse: $("#plAdresse").value.trim(), nomClient: $("#plNom").value.trim(), coordonnees: coords, emailClient: $("#plEmail").value.trim(), updatedAt: new Date().toISOString() };
    const avant = { adresse: item.adresse || "", nomClient: item.nomClient || "", coordonnees: JSON.stringify(item.coordonnees || []), emailClient: item.emailClient || "" };
    if (maj.adresse !== avant.adresse || maj.nomClient !== avant.nomClient || JSON.stringify(coords) !== avant.coordonnees || maj.emailClient !== avant.emailClient) {
      await window._updateSuivi(item.id, maj);
    }
  });
}

// ── 2. Passages ────────────────────────────────────────────────────
function lignesDepuis(item) {
  const ps = passagesBruts(item);
  const l = ps.map(p => ({
    ref: p, num: p.num, annule: p.statut === "annule",
    date: (p.debut || "").substring(0, 10), hDebut: (p.debut || "").substring(11, 16), hFin: (p.fin || "").substring(11, 16),
    techs: (p.techs || []).slice(),
  }));
  if (!l.length) l.push({ ref: null, num: 1, date: "", hDebut: "09:00", hFin: "11:00", techs: [] });
  return l;
}
function chargeTech(nom, date, idDossier) {
  if (!date) return 0;
  let n = 0;
  (window.interventions || []).forEach(i => {
    if (i.id === idDossier || i.statut === "Annulé") return;
    passagesBruts(i).forEach(p => { if (p.statut !== "annule" && (p.debut || "").startsWith(date) && (p.techs || []).includes(nom)) n++; });
  });
  return n;
}
function rendrePassages(item) {
  if (!etat.lignes) etat.lignes = lignesDepuis(item);
  const L = etat.lignes;
  const techs = techniciens().filter(t => nomTech(t));
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Saisis tous les passages prévus pour ce dossier, avec leur technicien. Ils sont enregistrés dans la fiche.</p>
    <table class="pl-table"><thead><tr><th>N°</th><th>Date</th><th>Début</th><th>Fin</th><th>Technicien(s)</th><th></th></tr></thead><tbody>
    ${L.map((l, k) => `<tr data-k="${k}"${l.annule ? ' style="opacity:.5"' : ""}>
      <td class="pl-cercle">${cercle(l.num)}${l.annule ? '<div class="pl-note">annulé</div>' : ""}</td>
      <td><input type="date" data-f="date" value="${esc(l.date)}"${l.annule ? " disabled" : ""}></td>
      <td><input type="time" data-f="hDebut" value="${esc(l.hDebut)}"${l.annule ? " disabled" : ""}></td>
      <td><input type="time" data-f="hFin" value="${esc(l.hFin)}"${l.annule ? " disabled" : ""}></td>
      <td><div class="pl-techs">${techs.map(t => `<span class="pl-tech${l.techs.includes(nomTech(t)) ? " on" : ""}" data-t="${esc(nomTech(t))}">${esc(nomTech(t))}</span>`).join("")}</div>
        ${l.techs.map(t => { const c = chargeTech(t, l.date, item.id); return c ? `<div class="pl-charge">${esc(t.split(" ")[0])} a déjà ${c} passage${c > 1 ? "s" : ""} ce jour-là</div>` : ""; }).join("")}</td>
      <td>${l.annule ? "" : `<button class="pl-btn petit" data-a="suppr" title="Supprimer ce passage">✕</button>`}</td></tr>`).join("")}
    </tbody></table>
    <div class="pl-actions"><button class="pl-btn" data-a="ajout">+ Ajouter un passage</button>
      <button class="pl-btn" data-a="dupli">Dupliquer le dernier à +</button><input id="plEcart" type="number" min="1" value="15" style="width:60px;height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;"> jours</div>`;
  const ligneDe = (el) => L[Number(el.closest("tr").dataset.k)];
  document.querySelectorAll(".pl-corps [data-f]").forEach(inp => inp.onchange = () => { ligneDe(inp)[inp.dataset.f] = inp.value; rendrePassages(item); });
  document.querySelectorAll(".pl-corps .pl-tech").forEach(ch => ch.onclick = () => {
    const l = ligneDe(ch); if (l.annule) return;
    const t = ch.dataset.t; l.techs = l.techs.includes(t) ? l.techs.filter(x => x !== t) : l.techs.concat(t); rendrePassages(item);
  });
  document.querySelectorAll(".pl-corps [data-a=suppr]").forEach(b => b.onclick = () => { L.splice(Number(b.closest("tr").dataset.k), 1); rendrePassages(item); });
  const prochainNum = () => Math.max(0, ...L.map(l => l.num || 0)) + 1;
  $("[data-a=ajout]").onclick = () => { const der = L.filter(l => !l.annule).slice(-1)[0]; L.push({ ref: null, num: prochainNum(), date: "", hDebut: der ? der.hDebut : "09:00", hFin: der ? der.hFin : "11:00", techs: der ? der.techs.slice() : [] }); rendrePassages(item); };
  $("[data-a=dupli]").onclick = () => {
    const der = L.filter(l => !l.annule && l.date).slice(-1)[0];
    if (!der) { showToast("Saisis d'abord la date d'un passage.", true); return; }
    const d = new Date(der.date + "T12:00:00"); d.setDate(d.getDate() + (Number($("#plEcart").value) || 15));
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    L.push({ ref: null, num: prochainNum(), date: iso, hDebut: der.hDebut, hFin: der.hFin, techs: der.techs.slice() });
    rendrePassages(item);
  };
  navigation("Enregistrer les passages →", () => enregistrerPassages(item));
}
async function enregistrerPassages(item) {
  const L = etat.lignes;
  const vivants = L.filter(l => !l.annule);
  if (!vivants.length) { showToast("Ajoute au moins un passage.", true); return false; }
  if (vivants.some(l => !l.date)) { showToast("Chaque passage doit avoir une date.", true); return false; }
  if (vivants.some(l => !l.techs.length)) { showToast("Chaque passage doit avoir au moins un technicien.", true); return false; }
  // Passages retirés : leurs rendez-vous agenda sont supprimés
  const gardes = new Set(L.filter(l => l.ref && l.ref.passageId).map(l => l.ref.passageId));
  const retires = passagesBruts(item).filter(p => p.passageId && !gardes.has(p.passageId) && p.statut !== "annule");
  if (retires.length) {
    const avecKizeo = retires.filter(p => p.kizeoPush).length;
    if (!confirm(`${retires.length} passage(s) supprimé(s). Leurs rendez-vous agenda seront retirés.` + (avecKizeo ? `\n\n${avecKizeo} avai(en)t un formulaire Kizeo : à supprimer à la main dans Kizeo.` : "") + "\n\nContinuer ?")) return false;
    etat.occupe = true;
    for (const p of retires) for (const [nom, ev] of Object.entries(p.calEvents || {})) {
      const t = techParNom(nom); if (!t || !t.email || !ev) continue;
      try { await requeteAgenda({ technicienEmail: t.email, operation: "delete", calEventId: ev }); } catch (e) { /* rendez-vous déjà absent */ }
    }
  }
  const passages = L.map(l => {
    const base = l.ref ? { ...l.ref } : { passageId: uuid(), statut: "", kizeoPush: null, calEvents: {}, notifs: null, titre: "", desc: "", adresse: item.adresse || "", manualRapport: null };
    if (!l.annule) {
      base.debut = l.date + "T" + (l.hDebut || "09:00");
      base.fin = l.date + "T" + (l.hFin || l.hDebut || "09:00");
      base.techs = l.techs.slice();
    }
    base.num = l.num;
    if (!base.passageId) base.passageId = uuid();
    return base;
  }).sort((a, b) => (a.num || 0) - (b.num || 0));
  const assignes = [...new Set(passages.filter(p => p.statut !== "annule").flatMap(p => p.techs || []))];
  try {
    await window._updateSuivi(item.id, { passages, calEventIds: passages.map(p => p.calEvents || {}), assignes, assigne: assignes[0] || "", updatedAt: new Date().toISOString() });
    showToast("Passages enregistrés");
  } finally { etat.occupe = false; }
  await pause(400); // laisse l'écoute temps réel rapporter la fiche à jour
}

// ── 3. Agenda ──────────────────────────────────────────────────────
async function requeteAgenda(payload) {
  const r = await fetch(URL_AGENDA, { method: "POST", headers: await window._authHeaders(), body: JSON.stringify(payload) });
  return r.json();
}
const titreDefaut = (item) => [item.nature || "Intervention", item.client, item.bc ? "BC " + item.bc : item.pl ? "PL " + item.pl : ""].filter(Boolean).join(" — ");
function rendreAgenda(item) {
  const ps = actifs(item);
  const lignes = [];
  ps.forEach(p => {
    const n = norm(item, p.num);
    const e = n ? window.etatAgenda(n) : "manque";
    (p.techs || []).forEach(nom => {
      const t = techParNom(nom);
      const ev = (p.calEvents || {})[nom];
      let st;
      if (!t || !t.email) st = etatHtml("att", "pas d'agenda", "Ce technicien n'a pas d'email (agenda) dans la page Techniciens");
      else if (ev && e !== "desync") st = etatHtml("ok", "✓ dans l'agenda");
      else if (ev) st = etatHtml("att", "à mettre à jour", "Date, heure ou technicien modifiés depuis");
      else st = etatHtml("ko", "✕ à ajouter");
      lignes.push(`<tr><td class="pl-cercle">${cercle(p.num)}</td><td>${window.fmtDate ? window.fmtDate(p.debut) : p.debut}${p.fin ? " → " + p.fin.substring(11, 16) : ""}</td><td>${esc(nom)}</td><td>${st}</td></tr>`);
    });
  });
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Crée ou met à jour le rendez-vous de chaque passage dans l'agenda Google de son technicien.</p>
    <div class="pl-champ" style="max-width:520px;margin-bottom:14px;"><label>Titre des rendez-vous</label><input id="plTitreAgenda" value="${esc(ps.find(p => p.titre)?.titre || titreDefaut(item))}"></div>
    ${ps.length ? `<table class="pl-table"><thead><tr><th>N°</th><th>Créneau</th><th>Technicien</th><th>Agenda</th></tr></thead><tbody>${lignes.join("")}</tbody></table>` : '<p class="pl-manque">Aucun passage daté : reviens à l\'étape Passages.</p>'}
    <div class="pl-actions"><button class="pl-btn indigo" data-a="agenda"${ps.length ? "" : " disabled"}>Mettre tous les passages à l'agenda</button><span class="pl-note" id="plAgendaInfo"></span></div>`;
  $("[data-a=agenda]").onclick = () => synchroniserAgenda(item);
  navigation("Continuer →");
}
async function synchroniserAgenda(item) {
  const b = $("[data-a=agenda]"); b.disabled = true; b.textContent = "Envoi à l'agenda…";
  etat.occupe = true;
  const titre = $("#plTitreAgenda").value.trim() || titreDefaut(item);
  const passages = passagesBruts(item);
  let ok = 0, erreurs = [];
  for (const p of passages) {
    if (p.statut === "annule" || !p.debut) continue;
    const cal = { ...(p.calEvents || {}) };
    for (const nom of p.techs || []) {
      const t = techParNom(nom);
      if (!t || !t.email) { erreurs.push(nom + " : pas d'agenda configuré"); continue; }
      const base = { technicienEmail: t.email, passages: [p.debut + "|" + (p.fin || "")], customSummary: titre, adresse: p.adresse || item.adresse || "", colorId: t.calendarColorId || null, nature: item.nature || "", nomClient: item.nomClient || "", bc: item.bc || item.pl || "", observations: item.observations || "", interventionId: item.id };
      try {
        const r = cal[nom] ? await requeteAgenda({ ...base, operation: "update", calEventId: cal[nom] }) : await requeteAgenda(base);
        if (r.success || r.created > 0 || r.updated > 0) { if (!cal[nom]) cal[nom] = (r.results && r.results[0] && r.results[0].eventId) || ""; ok++; }
        else erreurs.push(nom + " : " + ((r.errors && r.errors[0] && r.errors[0].error) || r.error || "refusé"));
      } catch (e) { erreurs.push(nom + " : " + e.message); }
    }
    // Techniciens retirés du passage : leur rendez-vous est supprimé
    for (const nom of Object.keys(cal)) {
      if (nom === "_" || (p.techs || []).includes(nom)) continue;
      const t = techParNom(nom);
      if (t && t.email && cal[nom]) { try { await requeteAgenda({ technicienEmail: t.email, operation: "delete", calEventId: cal[nom] }); } catch (e) { /* déjà absent */ } }
      delete cal[nom];
    }
    p.calEvents = cal;
    p.titre = titre;
    p.calSync = Object.keys(cal).length ? window.cleSyncAgenda(p.debut, p.fin, p.techs) : "";
  }
  try {
    // On relit la fiche juste avant d'écrire pour ne rien écraser (envoi Kizeo en parallèle…)
    const frais = passagesBruts(dossier() || item);
    const parId = Object.fromEntries(passages.filter(p => p.passageId).map(p => [p.passageId, p]));
    const fusion = frais.map(p => parId[p.passageId] ? { ...p, calEvents: parId[p.passageId].calEvents, titre: parId[p.passageId].titre, calSync: parId[p.passageId].calSync } : p);
    await window._updateSuivi(item.id, { passages: fusion, calEventIds: fusion.map(p => p.calEvents || {}), updatedAt: new Date().toISOString() });
  } finally { etat.occupe = false; }
  showToast(ok ? `✅ ${ok} rendez-vous dans l'agenda` : "Aucun rendez-vous créé", !ok);
  if (erreurs.length) alert("Certains rendez-vous n'ont pas pu être créés :\n\n" + erreurs.join("\n"));
  await pause(400);
  rendre();
}

// ── 4. Kizeo ───────────────────────────────────────────────────────
function rendreKizeo(item) {
  const ps = actifs(item);
  const forms = window._kizeoForms || [];
  const lignes = ps.map(p => {
    const n = norm(item, p.num);
    const e = n ? window.etatKizeo(item, n) : "manque";
    const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", p.num) : null;
    const sel = p.kizeoPush ? p.kizeoPush.kizeoFormDocId : (lie ? lie.id : "");
    const techsKz = (p.techs || []).map(techParNom).filter(t => t && t.kizeoUserId);
    const st = e === "ok" || e === "recu" ? etatHtml("ok", "✓ envoyé" + (p.kizeoPush && p.kizeoPush.technicien ? " à " + esc(p.kizeoPush.technicien.split(" ")[0]) : ""))
      : e === "ecart" ? etatHtml("att", "chez le mauvais technicien") : etatHtml("ko", "✕ à envoyer");
    return `<tr data-num="${p.num}" data-pid="${esc(p.passageId || "")}" data-envoi="${e === "manque" || e === "ecart" ? 1 : 0}">
      <td class="pl-cercle">${cercle(p.num)}</td><td>${window.fmtDate ? window.fmtDate(p.debut) : p.debut}</td>
      <td><select data-f="form" style="max-width:240px;"><option value="">— Formulaire —</option>${forms.map(f => `<option value="${esc(f.id)}"${String(sel) === String(f.id) ? " selected" : ""}>${esc(f.nom || "Formulaire")}${lie && lie.id === f.id ? " (lié)" : ""}</option>`).join("")}</select></td>
      <td>${techsKz.length ? `<select data-f="tech">${techsKz.map(t => `<option value="${esc(t.kizeoUserId)}"${p.kizeoPush && String(p.kizeoPush.recipientUserId) === String(t.kizeoUserId) ? " selected" : ""}>${esc(nomTech(t))}</option>`).join("")}</select>` : '<span class="pl-manque">aucun technicien avec compte Kizeo</span>'}</td>
      <td><input type="text" data-f="lib" value="${esc((p.kizeoPush && p.kizeoPush.libelle) || p.titre || titreDefaut(item))}" style="width:170px;"></td>
      <td>${st}</td></tr>`;
  });
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Un formulaire par passage, envoyé sur le téléphone de son technicien. Le formulaire lié à ce client et à cette nature est présélectionné.</p>
    ${ps.length ? `<table class="pl-table"><thead><tr><th>N°</th><th>Date</th><th>Formulaire</th><th>Technicien</th><th>Nom du rapport</th><th>Kizeo</th></tr></thead><tbody>${lignes.join("")}</tbody></table>` : '<p class="pl-manque">Aucun passage daté : reviens à l\'étape Passages.</p>'}
    <div class="pl-actions"><button class="pl-btn indigo" data-a="kizeo"${ps.length ? "" : " disabled"}>Envoyer tous les formulaires</button>
      <span class="pl-note">Seuls les passages sans formulaire (ou chez le mauvais technicien) sont envoyés.</span></div>`;
  $("[data-a=kizeo]").onclick = () => envoyerKizeo(item);
  navigation("Continuer →");
}
async function envoyerKizeo(item) {
  const lignes = [...document.querySelectorAll(".pl-corps tr[data-num]")].filter(tr => tr.dataset.envoi === "1");
  if (!lignes.length) { showToast("Tous les formulaires sont déjà envoyés."); return; }
  for (const tr of lignes) {
    if (!tr.querySelector("[data-f=form]").value) { showToast("Choisis un formulaire pour le passage " + tr.dataset.num + ".", true); return; }
    if (!tr.querySelector("[data-f=tech]")) { showToast("Le passage " + tr.dataset.num + " n'a pas de technicien avec compte Kizeo.", true); return; }
  }
  const ecarts = lignes.filter(tr => (passagesBruts(item).find(p => String(p.num) === tr.dataset.num) || {}).kizeoPush).length;
  if (!confirm(`Envoyer ${lignes.length} formulaire(s) Kizeo ?` + (ecarts ? `\n\n${ecarts} passage(s) avai(en)t déjà un formulaire chez un autre technicien : supprime l'ancien dans Kizeo (forms.kizeo.com/data/history/).` : ""))) return;
  const b = $("[data-a=kizeo]"); b.disabled = true; b.textContent = "Envoi à Kizeo…";
  etat.occupe = true;
  let ok = 0; const erreurs = [];
  for (const tr of lignes) {
    const body = { suiviId: item.id, numPassage: Number(tr.dataset.num), passageId: tr.dataset.pid || null, kizeoFormDocId: tr.querySelector("[data-f=form]").value, recipientUserId: tr.querySelector("[data-f=tech]").value, libelle: tr.querySelector("[data-f=lib]").value.trim() };
    try {
      const r = await fetch(URL_KIZEO, { method: "POST", headers: await window._authHeaders(), body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      ok++;
    } catch (e) { erreurs.push("Passage " + tr.dataset.num + " : " + e.message); }
  }
  etat.occupe = false;
  showToast(ok ? `✅ ${ok} formulaire(s) envoyé(s) sur Kizeo` : "Aucun formulaire envoyé", !ok);
  if (erreurs.length) alert("Certains formulaires n'ont pas pu partir :\n\n" + erreurs.join("\n"));
  await pause(800);
  rendre();
}

// ── 5. Notifications ───────────────────────────────────────────────
function etatNotif(item, champ) {
  const ns = actifs(item).map(p => norm(item, p.num)).filter(Boolean);
  if (!ns.length) return etatHtml("na", "aucun passage");
  const rs = ns.map(p => window.notifPassage(item, p, champ));
  if (rs.every(r => window.notifOk(r))) { const der = rs.map(r => r.le).sort().pop(); return etatHtml("ok", "✓ notifié" + (der && window.fmtDate ? " le " + window.fmtDate(der) : "")); }
  if (rs.some(r => r && r.change)) return etatHtml("att", "date modifiée, à re-notifier");
  return etatHtml("ko", "✕ pas encore notifié");
}
function rendreNotifications(item) {
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Le message annonce tous les passages d'un coup. Il utilise tes modèles habituels (page Contacts), avec les contacts du client et les pièces jointes.</p>
    <table class="pl-table"><tbody>
      <tr><td style="width:160px;"><b>Client</b><div class="pl-note">${esc(item.client || "")}</div></td><td>${etatNotif(item, "notifBailleur")}</td>
        <td style="text-align:right;"><button class="pl-btn indigo" data-a="client">Notifier le client</button></td></tr>
      <tr><td><b>Locataire</b><div class="pl-note">${esc(item.nomClient || "")}</div></td>
        <td>${item.emailClient ? etatNotif(item, "notifLocataire") : etatHtml("na", "pas d'email locataire")}</td>
        <td style="text-align:right;">${item.emailClient ? '<button class="pl-btn indigo" data-a="loc">Notifier le locataire</button>' : '<button class="pl-btn" data-a="ajoutEmail">Ajouter son email</button>'}</td></tr>
    </tbody></table>
    <p class="pl-note" style="margin-top:12px;">La fenêtre d'envoi s'ouvre à gauche. Une fois l'email parti, ferme-la : la coche se met à jour ici.</p>`;
  const ouvrirNotif = (onglet) => {
    if (!window.openNotifFromItem) return;
    window._nsCurrentItemId = item.id;
    window._nsCurrentClient = item.client || "";
    window.openNotifFromItem(dossier() || item).then(() => { if (window.switchNotifTab) window.switchNotifTab(onglet); });
  };
  const bc = $("[data-a=client]"); if (bc) bc.onclick = () => ouvrirNotif("bailleur");
  const bl = $("[data-a=loc]"); if (bl) bl.onclick = () => ouvrirNotif("locataire");
  const be = $("[data-a=ajoutEmail]"); if (be) be.onclick = () => { etat.etape = 0; rendre(); };
  navigation("Continuer →");
}

// ── Récapitulatif ──────────────────────────────────────────────────
function rendreRecap(item) {
  const ns = actifs(item).map(p => norm(item, p.num)).filter(Boolean);
  const m = (cls, t) => `<span class="pl-etat pl-${cls}">${t}</span>`;
  const lignes = ns.map(p => {
    const a = window.etatAgenda(p), k = window.etatKizeo(item, p);
    const c = window.notifPassage(item, p, "notifBailleur"), l = window.notifPassage(item, p, "notifLocataire");
    return `<tr><td class="pl-cercle">${cercle(p.num)} <span style="color:#0D1B2A;font-weight:400;">${window.fmtDate ? window.fmtDate(p.debut) : p.debut} · ${esc(p.techs.join(", "))}</span></td>
      <td>${a === "ok" ? m("ok", "✓") : a === "manque" ? m("ko", "✕") : m("att", "!")}</td>
      <td>${k === "ok" || k === "recu" ? m("ok", "✓") : k === "ecart" ? m("att", "!") : m("ko", "✕")}</td>
      <td>${window.notifOk(c) ? m("ok", "✓") : c && c.change ? m("att", "!") : m("ko", "✕")}</td>
      <td>${!item.emailClient ? m("na", "–") : window.notifOk(l) ? m("ok", "✓") : l && l.change ? m("att", "!") : m("ko", "✕")}</td></tr>`;
  });
  const faits = etatsEtapes(item);
  const toutOk = faits.every(Boolean);
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">${toutOk ? "Tout est prêt : les passages sont planifiés, dans l'agenda, sur Kizeo, et le client et le locataire sont prévenus." : "Il reste des étapes à faire. Tu peux les reprendre maintenant ou plus tard depuis la vue Semaine."}</p>
    <table class="pl-table pl-recap"><thead><tr><th>Passage</th><th>Agenda</th><th>Kizeo</th><th>Client</th><th>Locataire</th></tr></thead><tbody>${lignes.join("") || '<tr><td colspan="5">Aucun passage</td></tr>'}</tbody></table>
    <p class="pl-note" style="margin-top:12px;">Les rapports (reçu, envoyé au client) se suivront après l'intervention, dans la vue Semaine.</p>`;
  pied(`<button class="pl-btn" data-a="prec">← Précédent</button><span class="pl-espace"></span><button class="pl-btn prim" data-a="fin">Terminer</button>`);
  $(".pl-pied [data-a=prec]").onclick = () => { etat.etape--; rendre(); };
  $(".pl-pied [data-a=fin]").onclick = async () => {
    // Planification faite : le dossier passe de « À traiter » à « En cours »
    if (["À traiter", "", undefined, null].includes(item.statut) && ns.length) {
      await window._updateSuivi(item.id, { statut: "En cours", updatedAt: new Date().toISOString() });
      showToast("Dossier planifié · passé en « En cours »");
    }
    fermer();
  };
}

window.ouvrirPlanification = ouvrirPlanification;
