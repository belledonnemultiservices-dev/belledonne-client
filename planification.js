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
// Passages, Agenda et Kizeo fusionnés en une étape (15/11)
const ETAPES = ["Dossier", "Passages, agenda & Kizeo", "Notifications", "Récapitulatif"];
// Noms courts (bouton « Reprendre · … » de l'onglet Planification)
const ETAPES_COURTES = ["Dossier", "Passages", "Notifications", "Récapitulatif"];
const DERNIERE = ETAPES.length - 1;

const CSS = `
/* Décidé le 15/11 : même taille et même place à toutes les étapes, panneau de droite ouvert ou non.
   La fenêtre occupe la partie gauche (52 % de l'écran), le panneau la partie droite (48 %), toute hauteur. */
#plOverlay{position:fixed;inset:0;z-index:250;background:rgba(13,27,42,.38);display:none;align-items:stretch;justify-content:flex-start;padding:16px calc(48vw + 16px) 16px 16px;}
#plOverlay.ouvert{display:flex;}
.pl-box{background:#fff;border-radius:14px;width:100%;height:100%;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(13,27,42,.3);font-family:'DM Sans',sans-serif;color:#0D1B2A;}
@media (max-width:900px){#plOverlay{padding-right:16px;}#plDroite{display:none !important;}}
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
#plDroite{position:fixed;top:0;right:0;width:48vw;height:100vh;z-index:260;display:none;flex-direction:column;background:#2a2a2a;box-shadow:-8px 0 32px rgba(0,0,0,.35);font-family:'DM Sans',sans-serif;}
#plDroite.ouvert{display:flex;}
#plDroite.agenda{background:#fff;}
.pld-tete{padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.12);flex-shrink:0;}
#plDroite.agenda .pld-tete{border-bottom-color:#e5e7eb;}
.pld-titre{font-size:13px;font-weight:600;color:#fff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#plDroite.agenda .pld-titre{color:#1e293b;}
.pld-onglet{font:600 12px 'DM Sans',sans-serif;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;}
.pld-onglet.on{background:#fff;color:#0D1B2A;}
.pld-btn{font:600 12px 'DM Sans',sans-serif;border:1px solid #C7D2FE;background:#EEF2FF;color:#4338CA;border-radius:6px;padding:5px 10px;cursor:pointer;}
.pld-x{width:30px;height:30px;border:none;border-radius:6px;cursor:pointer;font-size:16px;background:rgba(255,255,255,.12);color:#fff;}
#plDroite.agenda .pld-x{background:#f1f5f9;color:#64748b;}
#plDroite iframe{flex:1;width:100%;border:none;background:#fff;}
.pld-vide{flex:1;display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:13px;padding:24px;text-align:center;}
.pl-voir-droite{font:600 12px 'DM Sans',sans-serif;border:1px solid #C7D2FE;background:#EEF2FF;color:#4338CA;border-radius:8px;padding:6px 11px;cursor:pointer;margin-right:8px;}
.pl-section{grid-column:1/-1;font:700 11px 'DM Sans',sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#4338CA;margin-top:6px;padding-bottom:4px;border-bottom:1px solid rgba(13,27,42,.08);}
.pl-champ textarea{height:64px;padding:8px 10px;resize:vertical;}
.pl-champ.large{grid-column:1/-1;}
.pl-doc{display:flex;gap:6px;align-items:center;}
.pl-doc input:not([type=file]){flex:1;min-width:0;}
.pl-doc .pl-btn{white-space:nowrap;}
.pl-doc-nom{font-size:11.5px;color:#1DA870;margin-top:3px;}
.pl-passage{border:1px solid rgba(13,27,42,.12);border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;}
.pl-passage.annule{opacity:.5;}
.pl-psg-l1{display:grid;grid-template-columns:auto 1fr 1fr auto;gap:10px;align-items:end;}
.pl-psg-num label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#8FA4B8;margin-bottom:5px;}
.pl-psg-num input{width:56px;height:38px;border:1px solid rgba(13,27,42,.15);border-radius:8px;text-align:center;font:700 15px 'DM Sans',sans-serif;}
.pl-psg-actions{display:flex;gap:6px;align-items:center;padding-bottom:4px;}
.pl-passage.jumeau{margin-left:28px;border-style:dashed;background:#FAFBFF;padding:8px 12px;}
.pl-psg-jum{display:flex;gap:10px;align-items:flex-end;}
.pl-psg-agenda{display:flex;flex-wrap:wrap;gap:6px;}
.pl-raps{border:1px solid #E0E7FF;background:#F8F9FF;border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
.pl-raps-tete{display:flex;gap:10px;align-items:baseline;font-size:13px;}
.pl-rap{display:grid;grid-template-columns:22px minmax(150px,1.2fr) minmax(110px,.8fr) minmax(160px,1.4fr) auto auto;gap:8px;align-items:center;}
.pl-rap select,.pl-rap input{height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;font:13px 'DM Sans',sans-serif;min-width:0;width:100%;box-sizing:border-box;background:#fff;}
.pl-rap-n{font-weight:700;color:#4338CA;font-size:13px;}
.pl-raps-pied{display:flex;gap:8px;align-items:center;}
@media (max-width:900px){.pl-rap{grid-template-columns:22px 1fr 1fr;}}
.pl-psg-pb{font-size:12px;font-weight:600;color:#C0392B;background:#FDECEA;border-radius:7px;padding:6px 10px;}
@media (max-width:640px){.pl-psg-l1{grid-template-columns:1fr 1fr;}}
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
// Passage normalisé correspondant : par identifiant (jumeaux de même n°), sinon par n°
const norm = (item, p) => (window.passagesNorm ? window.passagesNorm(item) : []).find(x => p.passageId && x.passageId ? x.passageId === p.passageId : x.num === p.num);

// ── Ouverture / fermeture ──────────────────────────────────────────
export function ouvrirPlanification(id, etape) {
  const item = (window.interventions || []).find(i => i.id === id);
  if (!item) return;
  monter();
  libererFichiers();
  // « Planifier » ouvre toujours sur l'étape Dossier (décidé le 15/11) ; les boutons ciblés
  // (Reprendre · Kizeo, Replanifier, Mettre à l'agenda…) passent leur étape
  etat = { id, etape: etape ?? 0, lignes: null, occupe: false, droiteFermee: {}, docVu: null, fichiers: {} };
  $("#plOverlay").classList.add("ouvert");
  rendre();
  // La fiche se met à jour en temps réel (envois Kizeo, notifications…) : on redessine
  clearInterval(surveillance);
  let empreinte = JSON.stringify(item);
  surveillance = setInterval(() => {
    const it = dossier();
    if (!it || etat.occupe) return;
    const e = JSON.stringify(it);
    // Étapes avec saisie (Dossier, Passages) : on ne redessine que les coches, pour ne pas perdre la frappe
    if (e !== empreinte) { empreinte = e; if (etat.etape > 1) rendre(); else rendreEtapes(); }
  }, 1200);
}
function fermer() {
  viderDossier();
  viderPassages();
  clearInterval(surveillance);
  $("#plOverlay").classList.remove("ouvert");
  cacherDroite();
  libererFichiers();
  etat = null;
  if (window.filterTable) window.filterTable();
}
// Première étape non faite
function etapeConseillee(item) {
  const f = etatsEtapes(item);
  for (let k = 0; k < DERNIERE; k++) if (!f[k]) return k;
  return DERNIERE;
}
// Étapes faites (coches de la barre de progression)
// Jumeaux : comptent pour Kizeo (un rapport chacun), pas pour l'agenda ni les notifications (même visite)
function etatsEtapes(item) {
  const ps = actifs(item);
  const pr = ps.filter(p => !p.jumeau);
  const ns = ps.map(p => norm(item, p)).filter(Boolean);
  const nsPr = pr.map(p => norm(item, p)).filter(Boolean);
  const dossierOk = !!(item.adresse && (item.bc || item.pl || item.devis));
  const passagesOk = pr.length > 0 && pr.every(p => (p.techs || []).length);
  const agendaOk = nsPr.length > 0 && nsPr.every(p => window.etatAgenda(p) === "ok");
  // Rapport Kizeo exigé sauf « Aucun rapport Kizeo » choisi (kzForm vide) sur un passage jamais envoyé
  const bruts = passagesBruts(item);
  const veutKizeo = (n) => { const b = bruts.find(x => x.passageId && x.passageId === n.passageId); return !b || b.kzForm === undefined || !!b.kzForm || !!b.kizeoPush; };
  const kizeoOk = ns.filter(veutKizeo).every(p => { const e = window.etatKizeo(item, p); return e === "ok" || e === "recu"; });
  const clientOk = nsPr.length > 0 && nsPr.every(p => window.notifOk(window.notifPassage(item, p, "notifBailleur")));
  const locOk = !item.emailClient || (nsPr.length > 0 && nsPr.every(p => window.notifOk(window.notifPassage(item, p, "notifLocataire"))));
  return [dossierOk, passagesOk && agendaOk && kizeoOk, clientOk && locOk];
}

function monter() {
  if ($("#plOverlay")) return;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  const ov = document.createElement("div"); ov.id = "plOverlay";
  ov.innerHTML = `<div class="pl-box"><div class="pl-tete"></div><div class="pl-corps"></div><div class="pl-pied"></div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) fermer(); });
  const dr = document.createElement("div"); dr.id = "plDroite";
  dr.innerHTML = `<div class="pld-tete"></div><div class="pld-corps" style="flex:1;display:flex;flex-direction:column;"></div>`;
  document.body.appendChild(dr);
}

// ── Panneau de droite ─────────────────────────────────────────────
// Décidé le 15/11 : ouvert par défaut. Étape Dossier → le PDF de référence (BC, PL, devis) ;
// étapes Passages et Agenda → l'agenda Google des techniciens ; rien aux autres étapes.
// Le ✕ le ferme pour l'étape en cours ; un bouton dans l'en-tête le rouvre.
function typeDroite(k) { return k === 0 ? "pdf" : k === 1 ? "agenda" : null; }
// Documents du dossier : PDF enregistrés, remplacés à l'écran par un fichier choisi et pas encore enregistré
function documents(item) {
  return [["bc", "BC", item.bcUrl], ["pl", "PL", item.plUrl], ["devis", "Devis", item.devisUrl]]
    .map(([cle, lib, url]) => ({ cle, lib, url: (etat.fichiers[cle] && etat.fichiers[cle].blob) || url || "", local: !!etat.fichiers[cle] }))
    .filter(d => d.url);
}
function libererFichiers() {
  if (!etat || !etat.fichiers) return;
  Object.values(etat.fichiers).forEach(f => { try { URL.revokeObjectURL(f.blob); } catch (e) { /* déjà libéré */ } });
  etat.fichiers = {};
}
function cacherDroite() {
  const dr = $("#plDroite"); if (dr) dr.classList.remove("ouvert");

}
function rendreDroite(item) {
  const type = typeDroite(etat.etape);
  const dr = $("#plDroite");
  if (!type || etat.droiteFermee[etat.etape]) { cacherDroite(); return; }
  const tete = $(".pld-tete", dr), corps = $(".pld-corps", dr);
  dr.classList.toggle("agenda", type === "agenda");
  if (type === "pdf") {
    const docs = documents(item);
    if (!docs.length) {
      tete.innerHTML = `<span class="pld-titre">Document de référence</span><button class="pld-x" title="Fermer">✕</button>`;
      corps.innerHTML = `<div class="pld-vide">Aucun PDF sur ce dossier.<br>Ajoute le BC, la PL ou le devis à gauche.</div>`;
      dr.dataset.src = "";
    } else {
      const vu = docs.find(d => d.cle === etat.docVu) || docs[0];
      etat.docVu = vu.cle;
      tete.innerHTML = (docs.length > 1 ? docs.map(d => `<button class="pld-onglet${d.cle === vu.cle ? " on" : ""}" data-doc="${d.cle}">${d.lib}</button>`).join("") : "")
        + `<span class="pld-titre">${docs.length > 1 ? "" : vu.lib}${vu.local && !etat.fichiers[vu.cle].envoye ? " (envoi en cours…)" : ""}</span>`
        + (vu.local ? "" : `<button class="pld-btn" data-a="onglet" title="Ouvrir le PDF dans un nouvel onglet">Nouvel onglet</button>`)
        + `<button class="pld-x" title="Fermer">✕</button>`;
      // Fichier choisi à l'écran : lu tel quel ; PDF enregistré : visionneuse Google (contourne le CORS du Storage)
      // PDF (fichier choisi ou stocké en application/pdf) : affiché directement par le navigateur.
      // La visionneuse Google restait souvent blanche au premier chargement ; on ne la garde
      // que pour un document Word (BC reçu en .doc/.docx), que le navigateur ne sait pas lire.
      const estPdf = vu.local || /\.pdf$/i.test(decodeURIComponent(vu.url.split("?")[0]));
      const src = estPdf ? vu.url + "#toolbar=1&navpanes=0&view=FitH" : "https://docs.google.com/viewer?url=" + encodeURIComponent(vu.url) + "&embedded=true";
      if (dr.dataset.src !== src) { corps.innerHTML = `<iframe allowfullscreen></iframe>`; $("iframe", corps).src = src; dr.dataset.src = src; }
      tete.querySelectorAll("[data-doc]").forEach(b => b.onclick = () => { etat.docVu = b.dataset.doc; rendreDroite(dossier() || item); });
      const bo = $("[data-a=onglet]", tete); if (bo) bo.onclick = () => window.open(vu.url, "_blank", "noopener");
    }
  } else {
    tete.innerHTML = `<span class="pld-titre">Agenda des techniciens</span><button class="pld-btn" data-a="onglet" title="Si l'agenda ne s'affiche pas (Safari)">Nouvel onglet</button><button class="pld-x" title="Fermer">✕</button>`;
    const src = typeof window.buildCalendarUrl === "function" ? window.buildCalendarUrl() : "";
    // Déjà chargé (passage de l'étape Passages à Agenda) : on ne recharge pas
    if (dr.dataset.src !== "agenda") { corps.innerHTML = `<iframe allow="storage-access" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>`; $("iframe", corps).src = src; dr.dataset.src = "agenda"; }
    $("[data-a=onglet]", tete).onclick = () => window.open(src, "_blank", "noopener");
  }
  // Pas de rendre() : il redessinerait le formulaire de l'étape Dossier en cours de saisie
  $(".pld-x", tete).onclick = () => { etat.droiteFermee[etat.etape] = true; rendreEtapes(); rendreDroite(dossier() || item); };
  dr.classList.add("ouvert");

}

function rendreEtapes() {
  const item = dossier(); if (!item) return;
  const faits = etatsEtapes(item);
  const ref = item.bc ? "BC " + item.bc : item.pl ? "PL " + item.pl : item.devis ? "Devis " + item.devis : "Sans référence";
  $(".pl-tete").innerHTML = `
    <div class="pl-titre"><div style="flex:1"><h2>Planifier · ${esc(ref)}</h2><small>${esc(item.client || "")}${item.nature ? " · " + esc(item.nature) : ""}${item.adresse ? " · " + esc(item.adresse) : ""}</small></div>
      ${typeDroite(etat.etape) && etat.droiteFermee[etat.etape] ? `<button class="pl-voir-droite" data-a="droite">${typeDroite(etat.etape) === "pdf" ? "📄 Afficher le PDF" : "📅 Afficher l'agenda"}</button>` : ""}
      <button class="pl-fermer" data-a="fermer" title="Fermer (tout est déjà enregistré)">×</button></div>
    <div class="pl-etapes">${ETAPES.map((nom, k) => `<div class="pl-etape${k === etat.etape ? " active" : ""}${k < DERNIERE && faits[k] ? " faite" : ""}" data-etape="${k}"><span class="pl-num">${k < DERNIERE && faits[k] ? "✓" : k + 1}</span>${nom}</div>`).join("")}</div>`;
  $(".pl-tete [data-a=fermer]").onclick = fermer;
  const bd = $(".pl-tete [data-a=droite]"); if (bd) bd.onclick = () => { delete etat.droiteFermee[etat.etape]; rendreEtapes(); rendreDroite(dossier() || item); };
  document.querySelectorAll(".pl-etape").forEach(el => el.onclick = () => { etat.etape = Number(el.dataset.etape); etat.lignes = null; rendre(); });
}

function rendre() {
  if (!etat) return;
  const item = dossier();
  if (!item) { fermer(); return; }
  // On quitte (ou redessine) l'étape Dossier : la saisie pas encore enregistrée part avant
  viderDossier();
  viderPassages();
  $(".pl-corps").oninput = $(".pl-corps").onchange = null;
  rendreEtapes();
  [rendreDossier, rendrePassages, rendreNotifications, rendreRecap][etat.etape](item);
  rendreDroite(item);
}
function pied(html) { $(".pl-pied").innerHTML = html; }
function navigation(suivantLib, surSuivant) {
  pied(`${etat.etape > 0 ? `<button class="pl-btn" data-a="prec">← Précédent</button>` : ""}<span class="pl-espace"></span>
    ${etat.etape < DERNIERE ? `<button class="pl-btn lien" data-a="plustard">Plus tard</button>` : ""}
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
// Décidé le 15/11 : tous les champs de la fiche sont modifiables ici (sauf passages et
// techniciens, qui ont leur étape), avec le PDF de référence ouvert à droite.
const DOCS = [["pl", "PL", "N° affaire"], ["bc", "BC", "N° de bon de commande"], ["devis", "Devis", "N° de devis"]];
function rendreDossier(item) {
  const tels = Array.isArray(item.coordonnees) ? item.coordonnees : item.coordonnees ? [item.coordonnees] : [];
  const champTel = (val) => `<input class="pl-tel" value="${esc(val)}" placeholder="06…">`;
  const clients = (window._allClients || []).slice();
  if (item.client && !clients.includes(item.client)) clients.unshift(item.client);
  const champ = (lib, html, large) => `<div class="pl-champ${large ? " large" : ""}"><label>${lib}</label>${html}</div>`;
  const inp = (id, val, ph, type) => `<input id="${id}"${type ? ` type="${type}"` : ""} value="${esc(val)}" placeholder="${esc(ph || "")}">`;
  const doc = ([cle, lib, ph]) => {
    const url = item[cle + "Url"], f = etat.fichiers[cle];
    return champ(lib, `<div class="pl-doc">${inp("pl_" + cle, item[cle], ph)}
        <input type="file" accept=".pdf" id="plFile_${cle}" style="display:none">
        ${url || f ? `<button class="pl-btn petit" data-voir="${cle}">Voir</button>` : ""}
        <button class="pl-btn petit" data-choisir="${cle}">${url || f ? "Remplacer" : "Ajouter le PDF"}</button></div>
        ${f ? `<div class="pl-doc-nom">${esc(f.nom)} · ${f.envoye ? "enregistré ✓" : "envoi en cours…"}</div>` : ""}`);
  };
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Vérifie le dossier avec le document de référence à droite et corrige ce qu'il faut.</p>
    <div class="pl-grille">
      <div class="pl-section">Client</div>
      ${champ("Client", `<select id="plClient"><option value="">— Sélectionner —</option>${clients.map(c => `<option value="${esc(c)}"${c === item.client ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`)}
      ${champ("N° Chorus", inp("plChorus", item.chorus))}
      <div class="pl-section">Mission</div>
      ${champ("Nature de la mission", `<div id="plNatureWrap"></div>`)}
      ${champ("Date d'émission", inp("plDateEmission", item.dateEmission, "", "date"))}
      ${champ("Expéditeur", inp("plExpediteur", item.expediteur))}
      ${champ("Adresse", inp("plAdresse", item.adresse, "Adresse d'intervention"), true)}
      <div class="pl-section">Références</div>
      ${DOCS.map(doc).join("")}
      <div class="pl-section">Contact</div>
      ${champ("Nom du contact client", inp("plNom", item.nomClient))}
      ${champ(`<span style="display:flex;justify-content:space-between;align-items:center;">Téléphone(s)<button type="button" class="pl-btn petit" data-a="ajoutTel" style="padding:2px 9px;font-size:11px;">+ Ajouter</button></span>`,
        `<div id="plTels" style="display:flex;flex-direction:column;gap:6px;">${(tels.length ? tels : [""]).map(champTel).join("")}</div>`)}
      ${champ("Email client", inp("plEmail", item.emailClient, "", "email"), true)}
      <div class="pl-section">Notes</div>
      ${champ("Observations", `<textarea id="plObservations" placeholder="Détails, contexte, contraintes...">${esc(item.observations)}</textarea>`, true)}
      ${String(item.notes || "").trim() ? champ("Anciennes notes <span style=\"text-transform:none;font-weight:400;\">· lecture seule</span>", `<div class="pl-lecture" style="white-space:pre-wrap;font-size:12.5px;color:#4A6078;background:#F7F9FB;border-radius:8px;padding:8px 10px;">${esc(item.notes)}</div>`, true) : ""}
    </div>
    <div class="pl-actions"><button class="pl-btn" data-a="attente">Mettre en attente…</button><span class="pl-note">Si une information bloque la planification (locataire injoignable, accès…)</span></div>
    <div class="pl-actions" style="margin-top:6px;"><button class="pl-btn" data-a="annuler" style="color:#C0392B;border-color:#F5C6C0;background:#FDECEA;">Annuler la commande…</button><span class="pl-note">Le dossier part dans l'onglet Annulé</span></div>`;
  // Téléphones : un champ par numéro, comme la fiche
  $("[data-a=ajoutTel]").onclick = () => { $("#plTels").insertAdjacentHTML("beforeend", champTel("")); $("#plTels input:last-child").focus(); };
  // Liste des natures habituelle (config/naturesMission, avec « Ajouter une nature »)
  if (window.renderNatureField) window.renderNatureField("plNature", item.nature || "");
  else $("#plNatureWrap").innerHTML = inp("plNature", item.nature);
  // PDF : « Voir » l'affiche à droite ; « Ajouter / Remplacer » le montre aussitôt, il part au Storage en continuant
  document.querySelectorAll(".pl-corps [data-voir]").forEach(b => b.onclick = () => { etat.docVu = b.dataset.voir; delete etat.droiteFermee[0]; rendreEtapes(); rendreDroite(dossier() || item); });
  document.querySelectorAll(".pl-corps [data-choisir]").forEach(b => b.onclick = () => $("#plFile_" + b.dataset.choisir).click());
  DOCS.forEach(([cle]) => {
    $("#plFile_" + cle).onchange = async (ev) => {
      const file = ev.target.files[0]; if (!file) return;
      ev.stopPropagation();
      if (etat.fichiers[cle]) URL.revokeObjectURL(etat.fichiers[cle].blob);
      const f = etat.fichiers[cle] = { nom: file.name, blob: URL.createObjectURL(file), envoye: false };
      etat.docVu = cle; delete etat.droiteFermee[0];
      // On garde la saisie en cours : on ne redessine que la ligne du document et le panneau
      const ligne = $("#plFile_" + cle).closest(".pl-champ");
      let note = $(".pl-doc-nom", ligne);
      if (!note) { note = document.createElement("div"); note.className = "pl-doc-nom"; ligne.appendChild(note); }
      note.textContent = file.name + " · envoi en cours…";
      rendreEtapes(); rendreDroite(dossier() || item);
      // Envoi immédiat (même emplacement que la fiche classique : suivi/<type>/<horodatage>_<nom>)
      try {
        const url = await window._uploadPdf(file, `suivi/${cle}/${Date.now()}_${file.name}`);
        await window._updateSuivi(item.id, { [cle + "Url"]: url, updatedAt: new Date().toISOString() });
        f.envoye = true;
        if (note.isConnected) note.textContent = file.name + " · enregistré ✓";
        indiquerAuto("PDF enregistré ✓");
      } catch (e) {
        if (note.isConnected) { note.textContent = file.name + " · échec de l'envoi : " + e.message; note.style.color = "#E74C3C"; }
        showToast("Le PDF n'a pas pu être envoyé : " + e.message, true);
      }
    };
  });
  // Enregistrement automatique, comme la fiche : 1,2 s après la dernière frappe
  $(".pl-corps").oninput = $(".pl-corps").onchange = (ev) => {
    if (ev.target.type === "file") return;
    clearTimeout(minuterieDossier);
    minuterieDossier = setTimeout(() => { minuterieDossier = null; if (etat && etat.etape === 0 && $("#plClient")) enregistrerDossier(dossier() || item, true); }, 1200);
  };
  // Décidé le 15/11 : motif obligatoire, rangé dans son propre champ (affiché dans l'onglet
  // En attente), et non plus ajouté aux notes internes.
  $("[data-a=attente]").onclick = async () => {
    const motif = demanderMotif("Motif de la mise en attente (obligatoire) :\nex. locataire injoignable, code d'accès manquant…", "mettre le dossier en attente");
    if (!motif) return;
    viderDossier(); // la saisie en cours part avant
    const maintenant = new Date().toISOString();
    await window._updateSuivi(item.id, { statut: "En attente", motifAttente: motif, attenteDepuis: maintenant, updatedAt: maintenant });
    showToast("Dossier mis en attente");
    fermer();
  };
  // Décidé le 15/11 : annulation de la commande depuis l'étape Dossier, motif obligatoire.
  // Les rendez-vous agenda déjà posés sont retirés ; les formulaires Kizeo, eux, se suppriment à la main.
  $("[data-a=annuler]").onclick = async () => {
    const it = dossier() || item;
    const ps = passagesBruts(it).filter(p => p.statut !== "annule");
    const avecAgenda = ps.filter(p => Object.values(p.calEvents || {}).some(Boolean));
    // Nom du rapport tel qu'il apparaît dans Kizeo, pour retrouver chaque formulaire à supprimer
    const kizeo = ps.filter(p => p.kizeoPush).map(p => "• Passage " + p.num + (p.libelle ? " " + p.libelle : "") + (p.debut ? " du " + (window.fmtDate ? window.fmtDate(p.debut) : p.debut.substring(0, 10)) : "")
      + " : « " + (p.kizeoPush.libelle || p.titre || titreDefaut(it, p)) + " »" + (p.kizeoPush.technicien ? " (chez " + p.kizeoPush.technicien + ")" : ""));
    const avecKizeo = kizeo.length;
    const motif = demanderMotif("Motif de l'annulation de la commande (obligatoire) :\nex. annulée par le bailleur, doublon, locataire parti…", "annuler la commande");
    if (!motif) return;
    if (!confirm("Annuler définitivement cette commande ?\n\nMotif : " + motif
      + (avecAgenda.length ? "\n\n" + avecAgenda.length + " passage(s) dans l'agenda : les rendez-vous seront retirés." : "")
      + (avecKizeo ? "\n\n" + avecKizeo + " formulaire(s) Kizeo déjà envoyé(s), à supprimer à la main dans Kizeo :\n" + kizeo.join("\n") : ""))) return;
    viderDossier();
    etat.occupe = true;
    try {
      for (const p of avecAgenda) for (const [nom, ev] of Object.entries(p.calEvents || {})) {
        const t = techParNom(nom); if (!t || !t.email || !ev) continue;
        try { await requeteAgenda({ technicienEmail: t.email, operation: "delete", calEventId: ev }); } catch (e) { /* rendez-vous déjà absent */ }
      }
      const maintenant = new Date().toISOString();
      const maj = { statut: "Annulé", motifAnnulation: motif, annuleLe: maintenant, updatedAt: maintenant };
      if (avecAgenda.length) {
        const passages = passagesBruts(it).map(p => ({ ...p, calEvents: {}, calSync: "" }));
        maj.passages = passages; maj.calEventIds = passages.map(() => ({}));
      }
      await window._updateSuivi(it.id, maj);
      showToast("Commande annulée");
    } catch (e) {
      showToast("Erreur à l'annulation : " + e.message, true);
      return;
    } finally { if (etat) etat.occupe = false; }
    fermer();
  };
  navigation("Continuer →", () => { clearTimeout(minuterieDossier); minuterieDossier = null; return enregistrerDossier(dossier() || item); });
  $(".pl-pied .pl-espace").insertAdjacentHTML("afterend", `<span class="pl-note" id="plAuto" style="margin-right:8px;">Enregistrement automatique</span>`);
}
let minuterieDossier = null;
// Motif obligatoire : redemande tant que la réponse est vide, null si l'utilisateur annule
function demanderMotif(question, action) {
  for (;;) {
    const r = prompt(question);
    if (r === null) return null;
    if (r.trim()) return r.trim();
    alert("Le motif est obligatoire pour " + action + ".");
  }
}
// Saisie en attente d'enregistrement automatique : on l'enregistre tout de suite
// (changement d'étape, fermeture). Les valeurs sont lues avant que le formulaire disparaisse.
function viderDossier() {
  if (!minuterieDossier) return;
  clearTimeout(minuterieDossier); minuterieDossier = null;
  if (etat && $("#plClient")) enregistrerDossier(dossier(), true);
}
// erreur : message rouge qui reste affiché (passage incomplet, agenda en échec…)
function indiquerAuto(txt, erreur) {
  const el = $("#plAuto"); if (!el) return;
  el.textContent = txt; el.style.color = erreur ? "#C0392B" : "#1DA870"; el.style.fontWeight = erreur ? "600" : "";
  clearTimeout(el._t);
  if (!erreur) el._t = setTimeout(() => { if (el.isConnected) { el.textContent = "Enregistrement automatique"; el.style.color = ""; } }, 1800);
}
// silencieux = enregistrement automatique : pas de message, rien de bloquant
async function enregistrerDossier(item, silencieux) {
  if (!item) return;
  const v = (id) => ($("#" + id) ? $("#" + id).value.trim() : "");
  const saisie = {
    client: v("plClient"), chorus: v("plChorus"),
    nature: v("plNature") === "__new__" ? (item.nature || "") : v("plNature"),
    dateEmission: v("plDateEmission"), expediteur: v("plExpediteur"),
    pl: v("pl_pl"), bc: v("pl_bc"), devis: v("pl_devis"),
    adresse: v("plAdresse"), nomClient: v("plNom"), emailClient: v("plEmail"),
    observations: v("plObservations"), // notes internes : plus saisies ici, jamais écrasées
  };
  if (!saisie.client) {
    // Client vidé : jamais enregistré à vide ; en automatique on enregistre le reste
    if (!silencieux) { showToast("Le client est obligatoire.", true); return false; }
    delete saisie.client;
  }
  // Seuls les champs modifiés partent en base
  const maj = {};
  Object.entries(saisie).forEach(([k, val]) => { if (val !== String(item[k] ?? "").trim()) maj[k] = val; });
  const coords = [...document.querySelectorAll("#plTels .pl-tel")].map(i => i.value.trim()).filter(Boolean);
  const coordsAvant = Array.isArray(item.coordonnees) ? item.coordonnees : item.coordonnees ? [item.coordonnees] : [];
  if (JSON.stringify(coords) !== JSON.stringify(coordsAvant)) maj.coordonnees = coords;
  if (!Object.keys(maj).length) return;
  // Garde-fou : le formulaire Kizeo est choisi selon le client et la nature.
  // En automatique, un avertissement non bloquant ; sur « Continuer », une confirmation.
  if ((maj.client !== undefined || maj.nature !== undefined) && actifs(item).some(p => p.kizeoPush)) {
    const msg = "Le client ou la nature change alors qu'un formulaire Kizeo est déjà parti. Le formulaire envoyé n'est peut-être plus le bon : vérifie-le à l'étape Kizeo.";
    if (silencieux) showToast(msg, true);
    else if (!confirm(msg + "\n\nEnregistrer quand même ?")) return false;
  }
  if (etat) etat.occupe = true;
  try {
    maj.updatedAt = new Date().toISOString();
    await window._updateSuivi(item.id, maj);
    if (silencieux) indiquerAuto("Enregistré ✓");
  } catch (e) {
    showToast("Erreur à l'enregistrement : " + e.message, true);
    return false;
  } finally { if (etat) etat.occupe = false; }
  if (!silencieux) await pause(400); // laisse l'écoute temps réel rapporter la fiche à jour
}

// ── 2. Passages, agenda & Kizeo ────────────────────────────────────
// Décidé le 15/11 :
// - l'étape reprend la fiche classique passage par passage (n° modifiable, début et fin en
//   date + heure, techniciens, adresse, titre agenda, description) et ses contrôles (fin après
//   début, année plausible), plus un contrôle : jamais avant un passage de numéro inférieur ;
// - Passages, Agenda et Kizeo ne font qu'une étape. Chaque modification est enregistrée toute
//   seule et l'agenda Google suit (création, mise à jour, suppression des rendez-vous) ;
// - un passage peut avoir plusieurs rapports Kizeo (ex. cafards + punaises de lit). Le 1er est
//   porté par le passage ; chaque rapport de plus est un passage « jumeau » caché (même n°,
//   `jumeau: true`) qui reprend date, créneau et techniciens du passage, sans rendez-vous à lui.
//   Le serveur lui donne une référence Kizeo distincte, son rapport arrive à part ;
// - la description du rendez-vous se termine toujours par le nom des rapports à remplir ;
// - l'envoi à Kizeo se fait au clic (un formulaire parti ne se retire pas à distance).
const ANNEE_MIN = new Date().getFullYear() - 1, ANNEE_MAX = new Date().getFullYear() + 3;
const BORNE_MIN = ANNEE_MIN + "-01-01T00:00", BORNE_MAX = ANNEE_MAX + "-12-31T23:59";
const sansSuffixe = (s) => String(s || "").replace(/ \(\d+\)$/, ""); // « (2) » ajouté par le serveur à un renvoi
function rapportDepuis(item, p, num) {
  const kp = p.kizeoPush || null;
  const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", num) : null;
  return { pid: p.passageId || uuid(), ref: p, annule: p.statut === "annule",
    formId: String(p.kzForm ?? (kp ? kp.kizeoFormDocId : (lie ? lie.id : "")) ?? ""),
    dest: String(p.kzDest ?? (kp ? kp.recipientUserId : "") ?? ""),
    // Nom saisi ; pour un rapport parti avant le 15/11 (pas de kzNom), le nom déjà envoyé
    nom: p.kzNomSaisi ? (p.kzNom || "") : (kp && p.kzNom === undefined ? sansSuffixe(kp.libelle) : "") };
}
function lignesDepuis(item) {
  const bruts = passagesBruts(item);
  const L = bruts.filter(p => !p.jumeau).map(p => ({
    ref: p, pid: p.passageId || uuid(), num: p.num, annule: p.statut === "annule",
    debut: (p.debut || "").substring(0, 16), fin: (p.fin || "").substring(0, 16),
    techs: (p.techs || []).slice(), adresse: p.adresse || "", titre: p.titre || "", desc: p.desc || "",
    rapports: [],
  }));
  L.forEach(l => { const r = rapportDepuis(item, l.ref, l.num); r.pid = l.pid; l.rapports.push(r); });
  // Rapports de plus (jumeaux) : rangés sous leur passage
  bruts.filter(p => p.jumeau).forEach(p => {
    const l = L.find(x => x.num === p.num && !x.annule) || L.find(x => x.num === p.num);
    if (l) l.rapports.push(rapportDepuis(item, p, p.num));
    else { const n = { ref: null, pid: uuid(), num: p.num, annule: false, debut: (p.debut || "").substring(0, 16), fin: (p.fin || "").substring(0, 16), techs: (p.techs || []).slice(), adresse: p.adresse || "", titre: "", desc: "", rapports: [] }; n.rapports.push(rapportDepuis(item, p, p.num)); n.rapports[0].pid = n.pid; L.push(n); }
  });
  if (!L.length) L.push(nouvelleLigne(item, 1));
  return L;
}
function nouvelleLigne(item, num, modele) {
  const pid = uuid();
  const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", num) : null;
  return { ref: null, pid, num, annule: false, debut: modele ? modele.debut : "", fin: modele ? modele.fin : "", techs: modele ? modele.techs.slice() : [],
    adresse: (modele && modele.adresse) || "", titre: "", desc: "",
    rapports: [{ pid, ref: null, annule: false, formId: modele ? modele.rapports[0].formId : (lie ? String(lie.id) : ""), dest: "", nom: "" }] };
}
// Ajoute des minutes à une valeur datetime-local (AAAA-MM-JJTHH:MM), en heure locale
function decaler(v, minutes) {
  const d = new Date(v); if (isNaN(d.getTime())) return v;
  d.setMinutes(d.getMinutes() + minutes);
  const z = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + "T" + z(d.getHours()) + ":" + z(d.getMinutes());
}
function chargeTech(nom, date, idDossier) {
  if (!date) return 0;
  let n = 0;
  (window.interventions || []).forEach(i => {
    if (i.id === idDossier || i.statut === "Annulé") return;
    passagesBruts(i).forEach(p => { if (p.statut !== "annule" && !p.jumeau && (p.debut || "").startsWith(date) && (p.techs || []).includes(nom)) n++; });
  });
  return n;
}
const fmtDT = (v) => v ? v.substring(8, 10) + "/" + v.substring(5, 7) + "/" + v.substring(0, 4) + " " + v.substring(11, 16) : "";
// Problèmes d'un passage : affichés sous la carte, ils bloquent l'enregistrement
function problemesLigne(l, L) {
  if (l.annule) return [];
  const pb = [];
  if (!l.num || l.num < 1) pb.push("numéro de passage invalide");
  else if (L.some(a => a !== l && !a.annule && a.num === l.num && !(a.ref && a.ref.kizeoPush && l.ref && l.ref.kizeoPush))) pb.push("numéro déjà pris par un autre passage (pour un 2e rapport, utilise « + Ajouter un rapport »)");
  if (!l.debut) pb.push("date de début manquante");
  const an = (v) => parseInt(String(v).slice(0, 4), 10);
  if (l.debut && (an(l.debut) < ANNEE_MIN || an(l.debut) > ANNEE_MAX)) pb.push(`année du début invalide (attendu entre ${ANNEE_MIN} et ${ANNEE_MAX})`);
  if (l.fin && (an(l.fin) < ANNEE_MIN || an(l.fin) > ANNEE_MAX)) pb.push(`année de fin invalide (attendu entre ${ANNEE_MIN} et ${ANNEE_MAX})`);
  if (l.debut && l.fin && l.fin < l.debut) pb.push("la fin est avant le début");
  if (!l.techs.length) pb.push("aucun technicien");
  const avant = L.filter(a => !a.annule && a.debut && a.num < l.num && l.debut && l.debut < a.debut);
  if (avant.length) { const a = avant.sort((x, y) => y.debut.localeCompare(x.debut))[0]; pb.push(`daté avant le passage ${a.num} (${fmtDT(a.debut)})`); }
  return pb;
}
// ── Rapports Kizeo d'un passage ──
const formParId = (id) => (window._kizeoForms || []).find(f => String(f.id) === String(id));
const techsKizeo = (l) => l.techs.map(techParNom).filter(t => t && t.kizeoUserId);
// Destinataire : celui choisi s'il est encore sur le passage, sinon le 1er technicien du passage ayant un compte Kizeo
function destDe(l, r) { const tk = techsKizeo(l); return (tk.find(t => String(t.kizeoUserId) === String(r.dest)) || tk[0] || null); }
// Nom du rapport dans l'application du technicien : saisi, sinon titre agenda (+ formulaire à partir du 2e)
function nomRapport(item, l, r, k) {
  if (r.nom.trim()) return r.nom.trim();
  const base = l.titre.trim() || titreDefaut(item);
  const f = formParId(r.formId);
  return k === 0 ? base : base + " — " + ((f && f.nom) || "rapport " + (k + 1));
}
const rapportsActifs = (l) => l.rapports.filter(r => !r.annule && r.formId);
// État d'un rapport : envoyé, reçu, modifié depuis l'envoi (à renvoyer), à envoyer
function etatRapportKz(item, l, r, k) {
  const n = norm(item, { passageId: r.pid, num: l.num });
  const p = (dossier() ? passagesBruts(dossier()) : []).find(x => x.passageId === r.pid);
  const e = n ? window.etatKizeo(item, n) : "manque";
  if (e === "recu") return "recu";
  if (e === "manque" || !p || !p.kizeoPush) return "manque";
  const t = destDe(l, r);
  const kp = p.kizeoPush;
  if (String(kp.kizeoFormDocId) !== String(r.formId) || (t && String(kp.recipientUserId) !== String(t.kizeoUserId)) || sansSuffixe(kp.libelle) !== nomRapport(item, l, r, k)) return "modifie";
  return e === "ecart" ? "modifie" : "ok";
}
const LIB_KZ = { ok: ["ok", "✓ envoyé"], recu: ["ok", "✓ rapport reçu"], modifie: ["att", "modifié : à renvoyer"], manque: ["ko", "✕ à envoyer"] };
// Contenu du rendez-vous d'un passage principal (ce qui, s'il change, impose une mise à jour)
function descriptionAuto(item, adresse) {
  const tels = Array.isArray(item.coordonnees) ? item.coordonnees : item.coordonnees ? [item.coordonnees] : [];
  return [item.bc || item.pl ? "N° BC : " + (item.bc || item.pl) : "", item.nature ? "Nature : " + item.nature : "", item.nomClient ? "Client : " + item.nomClient : "",
    tels.length ? "Téléphone(s) : " + tels.join(" / ") : "", adresse ? "Adresse : " + adresse : "", item.observations ? "Observations : " + item.observations : ""].filter(Boolean).join("\n");
}
function contenuAgenda(item, p, ps) {
  const adresse = p.adresse || item.adresse || "";
  const noms = [p].concat(ps.filter(j => j.jumeau && j.statut !== "annule" && j.num === p.num)).filter(x => x.kzForm && x.kzNom).map(x => x.kzNom);
  const desc = (p.desc || descriptionAuto(item, adresse)) + (noms.length ? "\n\n" + (noms.length > 1 ? "Rapports Kizeo à remplir :" : "Rapport Kizeo à remplir :") + "\n" + noms.map(n => "• " + n).join("\n") : "");
  return { titre: p.titre || titreDefaut(item), adresse, desc };
}
const empreinteAgenda = (item, p, ps) => JSON.stringify([p.debut, p.fin, (p.techs || []).slice().sort(), contenuAgenda(item, p, ps)]);
function etatAgendaTech(item, p, ps, nom) {
  const t = techParNom(nom);
  if (!t || !t.email) return "sans";
  const ev = (p.calEvents || {})[nom];
  if (!ev) return "manque";
  const aJour = p.calEmpreinte ? p.calEmpreinte === empreinteAgenda(item, p, ps) : p.calSync === window.cleSyncAgenda(p.debut, p.fin, p.techs);
  return aJour ? "ok" : "maj";
}
const LIB_AGENDA = { ok: ["ok", "✓ agenda"], maj: ["att", "agenda à mettre à jour"], manque: ["ko", "✕ pas dans l'agenda"], sans: ["att", "pas d'agenda"] };

let minuteriePassages = null, sauvegardeEnCours = null, aRefaire = false;
function rendrePassages(item) {
  if (!etat.lignes) etat.lignes = lignesDepuis(item);
  const L = etat.lignes;
  const techs = techniciens().filter(t => nomTech(t));
  const forms = window._kizeoForms || [];
  const enBase = passagesBruts(dossier() || item);
  const dt = (f, v) => `<input type="datetime-local" data-f="${f}" value="${esc(v)}" min="${BORNE_MIN}" max="${BORNE_MAX}">`;
  const blocRapports = (l) => {
    const tk = techsKizeo(l);
    const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", l.num) : null;
    const lignes = l.rapports.map((r, k) => {
      if (r.annule) return "";
      const etatR = r.formId ? etatRapportKz(item, l, r, k) : null;
      const t = destDe(l, r);
      return `<div class="pl-rap" data-r="${k}">
        <span class="pl-rap-n">${k + 1}.</span>
        <select data-rf="formId"><option value="">— Aucun rapport Kizeo —</option>${forms.map(f => `<option value="${esc(f.id)}"${String(r.formId) === String(f.id) ? " selected" : ""}>${esc(f.nom || "Formulaire")}${lie && String(lie.id) === String(f.id) ? " (lié)" : ""}</option>`).join("")}</select>
        ${tk.length ? `<select data-rf="dest">${tk.map(x => `<option value="${esc(x.kizeoUserId)}"${t && String(t.kizeoUserId) === String(x.kizeoUserId) ? " selected" : ""}>${esc(nomTech(x))}</option>`).join("")}</select>` : `<span class="pl-manque" style="font-size:12px;">aucun technicien du passage n'a de compte Kizeo</span>`}
        <input data-rf="nom" value="${esc(r.nom)}" placeholder="${esc(nomRapport(item, l, { ...r, nom: "" }, k))}" title="Nom du rapport dans l'application du technicien">
        ${etatR ? etatHtml(...LIB_KZ[etatR]) : ""}
        ${k > 0 ? `<button class="pl-btn petit" data-a="retirerRap" title="Retirer ce rapport">✕</button>` : ""}
      </div>`;
    }).join("");
    const aEnvoyer = rapportsActifs(l).filter(r => { const k = l.rapports.indexOf(r); const e = etatRapportKz(item, l, r, k); return e === "manque" || e === "modifie"; }).length;
    return `<div class="pl-raps"><div class="pl-raps-tete"><b>Rapports Kizeo</b><span class="pl-note">un formulaire par rapport, envoyé sur le téléphone du technicien</span></div>${lignes}
      <div class="pl-raps-pied"><button class="pl-btn petit" data-a="ajoutRap">+ Ajouter un rapport</button><span class="pl-espace" style="flex:1"></span>
        <button class="pl-btn indigo petit" data-a="envoyerKz"${aEnvoyer ? "" : " disabled"}>${aEnvoyer ? "Envoyer sur Kizeo (" + aEnvoyer + ")" : "Rapports à jour sur Kizeo"}</button></div></div>`;
  };
  const carte = (l, k) => {
    const pb = problemesLigne(l, L);
    if (l.annule) return `<div class="pl-passage annule" data-k="${k}"><div class="pl-psg-l1" style="grid-template-columns:auto 1fr;"><span class="pl-cercle">${cercle(l.num)}</span><span class="pl-note">passage annulé${l.debut ? " · prévu le " + fmtDT(l.debut) : ""}</span></div></div>`;
    const p = enBase.find(x => x.passageId === l.pid);
    const agenda = p && p.statut !== "annule" && (p.techs || []).length ? (p.techs || []).map(nom => { const [c, t] = LIB_AGENDA[etatAgendaTech(item, p, enBase, nom)]; return etatHtml(c, esc(nom.split(" ")[0]) + " · " + t); }).join(" ") : "";
    return `<div class="pl-passage" data-k="${k}">
      <div class="pl-psg-l1">
        <div class="pl-psg-num"><label>Passage</label><div style="display:flex;align-items:center;gap:4px;"><input type="number" min="1" data-f="num" value="${esc(l.num)}"><span class="pl-cercle">${cercle(l.num)}</span></div></div>
        <div class="pl-champ"><label>Début</label>${dt("debut", l.debut)}</div>
        <div class="pl-champ"><label>Fin</label>${dt("fin", l.fin)}</div>
        <div class="pl-psg-actions"><button class="pl-btn petit" data-a="suppr" title="Supprimer ce passage">✕</button></div>
      </div>
      <div class="pl-champ"><label>Technicien(s)</label><div class="pl-techs">${techs.map(t => `<span class="pl-tech${l.techs.includes(nomTech(t)) ? " on" : ""}" data-t="${esc(nomTech(t))}">${esc(nomTech(t))}</span>`).join("")}</div>
        ${l.techs.map(t => { const c = chargeTech(t, (l.debut || "").substring(0, 10), item.id); return c ? `<div class="pl-charge">${esc(t.split(" ")[0])} a déjà ${c} passage${c > 1 ? "s" : ""} ce jour-là</div>` : ""; }).join("")}</div>
      <div class="pl-grille">
        <div class="pl-champ"><label>Titre agenda</label><input data-f="titre" value="${esc(l.titre)}" placeholder="${esc(titreDefaut(item))}"></div>
        <div class="pl-champ"><label>Adresse</label><input data-f="adresse" value="${esc(l.adresse)}" placeholder="${esc(item.adresse || "Adresse...")}"></div>
        <div class="pl-champ large"><label>Description <span style="text-transform:none;font-weight:400;">· le nom des rapports Kizeo est ajouté à la fin dans l'agenda</span></label><textarea data-f="desc" placeholder="Laisse vide pour la description automatique (BC, nature, contact, téléphones, adresse, observations)">${esc(l.desc)}</textarea></div>
      </div>
      ${blocRapports(l)}
      ${agenda ? `<div class="pl-psg-agenda">${agenda}</div>` : ""}
      ${pb.length ? `<div class="pl-psg-pb">⚠ ${pb.map(esc).join(" · ")}</div>` : ""}
    </div>`;
  };
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Chaque modification est enregistrée toute seule et l'agenda de chaque technicien suit : rendez-vous créé, déplacé ou retiré. Les rapports Kizeo partent au clic sur « Envoyer sur Kizeo ».</p>
    ${L.map(carte).join("")}
    <div class="pl-actions"><button class="pl-btn" data-a="ajout">+ Ajouter un passage</button>
      <button class="pl-btn" data-a="dupli">Dupliquer le dernier à +</button><input id="plEcart" type="number" min="1" value="15" style="width:60px;height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;"> jours</div>`;
  const ligneDe = (el) => L[Number(el.closest(".pl-passage").dataset.k)];
  const rapportDe = (el) => ligneDe(el).rapports[Number(el.closest(".pl-rap").dataset.r)];
  const change = (redessiner) => { if (redessiner) rendrePassages(item); planifierAutoPassages(); };
  document.querySelectorAll(".pl-corps [data-f]").forEach(inp => {
    const f = inp.dataset.f;
    // Texte : pas de redessin pendant la frappe ; n° et dates : redessin pour les contrôles
    if (["titre", "adresse", "desc"].includes(f)) { inp.oninput = () => { ligneDe(inp)[f] = inp.value; change(false); }; inp.onchange = () => rendrePassages(item); return; }
    inp.onchange = () => {
      const l = ligneDe(inp);
      if (f === "num") l.num = parseInt(inp.value, 10) || 0;
      else {
        l[f] = inp.value;
        // Comme la fiche : une fin avant le début est recalée sur le début (jamais l'inverse)
        if (f === "debut" && l.debut && !l.fin) l.fin = decaler(l.debut, 120);
        if (l.debut && l.fin && l.fin < l.debut) l.fin = l.debut;
      }
      change(true);
    };
  });
  document.querySelectorAll(".pl-corps [data-rf]").forEach(inp => {
    const f = inp.dataset.rf;
    if (f === "nom") { inp.oninput = () => { rapportDe(inp).nom = inp.value; change(false); }; inp.onchange = () => rendrePassages(item); return; }
    inp.onchange = () => { rapportDe(inp)[f] = inp.value; change(true); };
  });
  document.querySelectorAll(".pl-corps .pl-tech").forEach(ch => ch.onclick = () => {
    const l = ligneDe(ch); const t = ch.dataset.t;
    l.techs = l.techs.includes(t) ? l.techs.filter(x => x !== t) : l.techs.concat(t);
    change(true);
  });
  // Liste « nom (chez technicien) » des rapports déjà partis sur Kizeo
  const partis = (rs) => rs.map(r => enBase.find(p => p.passageId === r.pid)).filter(p => p && p.kizeoPush)
    .map(p => "• « " + (p.kizeoPush.libelle || "") + " »" + (p.kizeoPush.technicien ? " (chez " + p.kizeoPush.technicien + ")" : ""));
  document.querySelectorAll(".pl-corps [data-a=suppr]").forEach(b => b.onclick = () => {
    const l = ligneDe(b);
    const p = enBase.find(x => x.passageId === l.pid);
    const rdv = p && Object.values(p.calEvents || {}).some(Boolean);
    const kz = partis(l.rapports);
    if (p && !confirm("Supprimer le passage " + l.num + " ?" + (rdv ? "\n\nLe rendez-vous sera retiré de l'agenda." : "")
      + (kz.length ? "\n\nRapport(s) Kizeo déjà envoyé(s), à supprimer à la main dans Kizeo :\n" + kz.join("\n") : ""))) return;
    L.splice(L.indexOf(l), 1);
    change(true);
  });
  document.querySelectorAll(".pl-corps [data-a=ajoutRap]").forEach(b => b.onclick = () => {
    ligneDe(b).rapports.push({ pid: uuid(), ref: null, annule: false, formId: "", dest: "", nom: "" });
    change(true);
  });
  document.querySelectorAll(".pl-corps [data-a=retirerRap]").forEach(b => b.onclick = () => {
    const l = ligneDe(b), r = rapportDe(b);
    const kz = partis([r]);
    if (kz.length && !confirm("Retirer ce rapport ?\n\nIl est déjà parti sur Kizeo, à supprimer à la main dans Kizeo :\n" + kz.join("\n"))) return;
    l.rapports.splice(l.rapports.indexOf(r), 1);
    change(true);
  });
  document.querySelectorAll(".pl-corps [data-a=envoyerKz]").forEach(b => b.onclick = () => envoyerRapports(item, ligneDe(b), b));
  const prochainNum = () => Math.max(0, ...L.map(l => l.num || 0)) + 1;
  $("[data-a=ajout]").onclick = () => { const der = L.filter(l => !l.annule).slice(-1)[0]; const n = nouvelleLigne(item, prochainNum()); if (der) n.techs = der.techs.slice(); L.push(n); rendrePassages(item); };
  $("[data-a=dupli]").onclick = () => {
    const der = L.filter(l => !l.annule && l.debut).slice(-1)[0];
    if (!der) { showToast("Saisis d'abord la date d'un passage.", true); return; }
    const jours = (Number($("#plEcart").value) || 15) * 1440;
    const n = nouvelleLigne(item, prochainNum(), der);
    n.debut = decaler(der.debut, jours); n.fin = der.fin ? decaler(der.fin, jours) : "";
    // Les rapports du passage modèle sont repris (formulaires, destinataire), à envoyer
    n.rapports = der.rapports.filter(r => !r.annule).map((r, k) => ({ pid: k === 0 ? n.pid : uuid(), ref: null, annule: false, formId: r.formId, dest: r.dest, nom: "" }));
    L.push(n);
    change(true);
  };
  navigation("Continuer →", async () => {
    clearTimeout(minuteriePassages); minuteriePassages = null;
    const r = await enregistrerPassages(item, false);
    return r === false ? false : undefined;
  });
  $(".pl-pied .pl-espace").insertAdjacentHTML("afterend", `<span class="pl-note" id="plAuto" style="margin-right:8px;">Enregistrement automatique</span>`);
}
// Enregistrement automatique : 1,5 s après la dernière modification
function planifierAutoPassages() {
  clearTimeout(minuteriePassages);
  minuteriePassages = setTimeout(() => { minuteriePassages = null; if (etat && etat.etape === 1) enregistrerPassages(dossier(), true); }, 1500);
}
// Modification en attente : enregistrée tout de suite (changement d'étape, fermeture)
function viderPassages() {
  if (!minuteriePassages) return;
  clearTimeout(minuteriePassages); minuteriePassages = null;
  if (etat && etat.lignes) enregistrerPassages(dossier(), true);
}
// silencieux = automatique : un passage incomplet n'est pas enregistré, le bas de la fenêtre le signale
async function enregistrerPassages(item, silencieux) {
  if (!item || !etat || !etat.lignes) return;
  // Une sauvegarde à la fois ; une modification arrivée pendant ce temps relance après
  if (sauvegardeEnCours) { aRefaire = true; await sauvegardeEnCours; if (!silencieux) return enregistrerPassages(dossier() || item, false); return; }
  const L = etat.lignes;
  const vivants = L.filter(l => !l.annule);
  const enDefaut = vivants.map(l => ({ l, pb: problemesLigne(l, L) })).filter(x => x.pb.length);
  if (!vivants.length || enDefaut.length) {
    const msg = !vivants.length ? "ajoute au moins un passage" : "passage " + enDefaut[0].l.num + " : " + enDefaut[0].pb[0];
    if (silencieux) indiquerAuto("⚠ Non enregistré : " + msg, true); else showToast(msg.charAt(0).toUpperCase() + msg.slice(1) + ".", true);
    return false;
  }
  const passe = async () => {
    const frais = passagesBruts(dossier() || item);
    const parPid = Object.fromEntries(frais.filter(p => p.passageId).map(p => [p.passageId, p]));
    const passages = [];
    L.forEach(l => {
      l.rapports.forEach((r, k) => {
        // Base : la version en base (envoi Kizeo, rendez-vous, notifications faits entre-temps)
        const base = parPid[r.pid] ? { ...parPid[r.pid] } : { passageId: r.pid, statut: "", kizeoPush: null, calEvents: {}, notifs: null, manualRapport: null };
        const jumeau = k > 0;
        if (!l.annule && !r.annule) {
          base.debut = l.debut; base.fin = l.fin || l.debut; base.techs = l.techs.slice();
          base.adresse = l.adresse.trim() || item.adresse || "";
          base.titre = jumeau ? "" : l.titre.trim();
          base.desc = jumeau ? "" : l.desc.trim();
          // Rapport Kizeo préparé (formulaire, destinataire, nom) : sert à l'envoi et à la description de l'agenda
          const t = destDe(l, r);
          base.kzForm = r.formId || "";
          base.kzDest = t ? String(t.kizeoUserId) : "";
          base.kzNom = r.formId ? nomRapport(item, l, r, k) : "";
          base.kzNomSaisi = !!r.nom.trim();
          base.libelle = jumeau ? base.kzNom : "";
          if (jumeau) { base.calEvents = {}; base.calSync = ""; base.calEmpreinte = ""; }
        }
        base.num = l.num; base.jumeau = jumeau; base.passageId = r.pid;
        passages.push(base);
      });
    });
    passages.sort((a, b) => (a.num || 0) - (b.num || 0) || (a.jumeau ? 1 : 0) - (b.jumeau ? 1 : 0));
    // Agenda : rendez-vous des passages supprimés ôtés, les autres créés ou mis à jour
    const gardes = new Set(passages.map(p => p.passageId));
    const aRetirer = frais.filter(p => p.passageId && !gardes.has(p.passageId)).flatMap(p => Object.entries(p.calEvents || {}));
    const erreurs = await synchroniserAgenda(item, passages, aRetirer);
    const assignes = [...new Set(passages.filter(p => p.statut !== "annule").flatMap(p => p.techs || []))];
    if (etat) etat.occupe = true;
    try {
      await window._updateSuivi(item.id, { passages, calEventIds: passages.map(p => p.calEvents || {}), assignes, assigne: assignes[0] || "", updatedAt: new Date().toISOString() });
      // Comme la fiche : l'échéance d'un rapport Kizeo en attente suit le passage déplacé
      if (window._syncEcheancesReception) await window._syncEcheancesReception(item.id, passages);
    } finally { if (etat) etat.occupe = false; }
    L.forEach(l => { l.ref = passages.find(p => p.passageId === l.pid) || l.ref; l.rapports.forEach(r => { r.ref = passages.find(p => p.passageId === r.pid) || r.ref; }); });
    if (erreurs.length) { indiquerAuto("⚠ Agenda : " + erreurs[0], true); if (!silencieux) alert("Passages enregistrés, mais l'agenda n'a pas pu être mis à jour pour :\n\n" + erreurs.join("\n")); }
    else indiquerAuto("Enregistré ✓ · agenda à jour");
    rechargerAgenda();
  };
  sauvegardeEnCours = passe().catch(e => { indiquerAuto("⚠ Erreur : " + e.message, true); if (!silencieux) showToast("Erreur à l'enregistrement : " + e.message, true); return false; });
  const r = await sauvegardeEnCours;
  sauvegardeEnCours = null;
  if (aRefaire) { aRefaire = false; if (etat && etat.etape === 1) planifierAutoPassages(); }
  await pause(300); // laisse l'écoute temps réel rapporter la fiche à jour
  // États (agenda, Kizeo) à jour, sans perdre une frappe en cours
  if (etat && etat.etape === 1 && !minuteriePassages && !document.activeElement?.closest?.(".pl-corps")) rendrePassages(dossier() || item);
  else if (etat) rendreEtapes();
  return r;
}
// L'agenda affiché à droite se recharge pour montrer les rendez-vous à jour
function rechargerAgenda() {
  const dr = $("#plDroite"); const fr = dr && dr.classList.contains("ouvert") && dr.dataset.src === "agenda" ? $("iframe", dr) : null;
  if (fr) { const s = fr.src; fr.src = "about:blank"; setTimeout(() => { fr.src = s; }, 50); }
}
// Envoi au clic des rapports d'un passage (à envoyer, ou modifiés depuis l'envoi)
async function envoyerRapports(item, l, bouton) {
  clearTimeout(minuteriePassages); minuteriePassages = null;
  if ((await enregistrerPassages(dossier() || item, false)) === false) return; // les rapports doivent exister en base
  const it = dossier() || item;
  const aEnvoyer = rapportsActifs(l).map(r => ({ r, k: l.rapports.indexOf(r) })).map(x => ({ ...x, e: etatRapportKz(it, l, x.r, x.k) })).filter(x => x.e === "manque" || x.e === "modifie");
  if (!aEnvoyer.length) { showToast("Les rapports de ce passage sont déjà à jour sur Kizeo."); return; }
  const sansDest = aEnvoyer.find(x => !destDe(l, x.r));
  if (sansDest) { showToast("Aucun technicien du passage " + l.num + " n'a de compte Kizeo (page Techniciens).", true); return; }
  const bruts = passagesBruts(it);
  const anciens = aEnvoyer.filter(x => x.e === "modifie").map(x => bruts.find(p => p.passageId === x.r.pid)).filter(p => p && p.kizeoPush)
    .map(p => "• « " + p.kizeoPush.libelle + " »" + (p.kizeoPush.technicien ? " (chez " + p.kizeoPush.technicien + ")" : ""));
  if (!confirm("Envoyer " + aEnvoyer.length + " rapport(s) sur Kizeo pour le passage " + l.num + " ?\n\n" + aEnvoyer.map(x => "• « " + nomRapport(it, l, x.r, x.k) + " » → " + nomTech(destDe(l, x.r))).join("\n")
    + (anciens.length ? "\n\nAnciens formulaires restés sur le téléphone, à supprimer à la main dans Kizeo :\n" + anciens.join("\n") : ""))) return;
  if (bouton) { bouton.disabled = true; bouton.textContent = "Envoi à Kizeo…"; }
  etat.occupe = true;
  let ok = 0; const erreurs = [];
  for (const x of aEnvoyer) {
    const body = { suiviId: it.id, numPassage: l.num, passageId: x.r.pid, kizeoFormDocId: x.r.formId, recipientUserId: String(destDe(l, x.r).kizeoUserId), libelle: nomRapport(it, l, x.r, x.k) };
    try {
      const r = await fetch(URL_KIZEO, { method: "POST", headers: await window._authHeaders(), body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      ok++;
    } catch (e) { erreurs.push("« " + body.libelle + " » : " + e.message); }
  }
  if (etat) etat.occupe = false;
  showToast(ok ? `✅ ${ok} rapport(s) envoyé(s) sur Kizeo` : "Aucun rapport envoyé", !ok);
  if (erreurs.length) alert("Certains rapports n'ont pas pu partir :\n\n" + erreurs.join("\n"));
  await pause(800);
  if (etat && etat.etape === 1) rendrePassages(dossier() || item);
}

// ── Agenda (appelé par l'enregistrement des passages) ──────────────
async function requeteAgenda(payload) {
  const r = await fetch(URL_AGENDA, { method: "POST", headers: await window._authHeaders(), body: JSON.stringify(payload) });
  return r.json();
}
// Titre par défaut d'un rendez-vous ; ajoute un libellé s'il y en a un
const titreDefaut = (item, p) => [item.nature || "Intervention", item.client, item.bc ? "BC " + item.bc : item.pl ? "PL " + item.pl : "", p && p.libelle ? p.libelle : ""].filter(Boolean).join(" — ");
const nomPassage = (p) => (p.jumeau ? "↳ " : "") + cercle(p.num) + (p.libelle ? ' <span style="color:#0D1B2A;font-weight:600;">' + esc(p.libelle) + '</span>' : "");
// Met les passages (modifiés en place : calEvents, calSync, calEmpreinte) en accord avec l'agenda.
// Ne contacte Google que pour ce qui a changé. Retourne la liste des erreurs.
async function synchroniserAgenda(item, passages, aRetirer) {
  const erreurs = [];
  const supprimer = async (nom, ev) => { const t = techParNom(nom); if (t && t.email && ev) { try { await requeteAgenda({ technicienEmail: t.email, operation: "delete", calEventId: ev }); } catch (e) { /* déjà absent */ } } };
  for (const [nom, ev] of aRetirer) await supprimer(nom, ev);
  for (const p of passages) {
    const cal = { ...(p.calEvents || {}) };
    const actif = p.statut !== "annule" && !p.jumeau && p.debut;
    const voulus = actif ? (p.techs || []) : [];
    // Techniciens retirés, passage annulé ou rapport supplémentaire : rendez-vous ôté
    for (const nom of Object.keys(cal)) { if (nom === "_" || voulus.includes(nom)) continue; await supprimer(nom, cal[nom]); delete cal[nom]; }
    if (actif) {
      const emp = empreinteAgenda(item, p, passages);
      const c = contenuAgenda(item, p, passages);
      let echec = false;
      for (const nom of voulus) {
        const t = techParNom(nom);
        if (!t || !t.email) { erreurs.push(nom + " : pas d'agenda configuré (page Techniciens)"); continue; }
        if (cal[nom] && (p.calEmpreinte ? p.calEmpreinte === emp : p.calSync === window.cleSyncAgenda(p.debut, p.fin, p.techs))) continue; // déjà à jour
        const base = { technicienEmail: t.email, passages: [p.debut + "|" + (p.fin || "")], customSummary: c.titre, customDescription: c.desc, adresse: c.adresse, colorId: t.calendarColorId || null, nature: item.nature || "", nomClient: item.nomClient || "", bc: item.bc || item.pl || "", observations: item.observations || "", interventionId: item.id };
        try {
          const r = cal[nom] ? await requeteAgenda({ ...base, operation: "update", calEventId: cal[nom] }) : await requeteAgenda(base);
          if (r.success || r.created > 0 || r.updated > 0) { if (!cal[nom]) cal[nom] = (r.results && r.results[0] && r.results[0].eventId) || ""; }
          else { echec = true; erreurs.push(nom + " : " + ((r.errors && r.errors[0] && r.errors[0].error) || r.error || "refusé")); }
        } catch (e) { echec = true; erreurs.push(nom + " : " + e.message); }
      }
      // Échec : on ne marque pas « à jour », la prochaine sauvegarde réessaiera
      if (!echec) {
        p.calEmpreinte = voulus.every(nom => cal[nom]) ? emp : "";
        p.calSync = Object.keys(cal).length ? window.cleSyncAgenda(p.debut, p.fin, p.techs) : "";
      } else { p.calEmpreinte = ""; p.calSync = ""; }
    } else { p.calEmpreinte = ""; p.calSync = ""; }
    p.calEvents = cal;
  }
  return erreurs;
}

// ── 3. Notifications ───────────────────────────────────────────────
function etatNotif(item, champ) {
  const ns = actifs(item).filter(p => !p.jumeau).map(p => norm(item, p)).filter(Boolean);
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
  const ns = actifs(item).map(p => norm(item, p)).filter(Boolean);
  const m = (cls, t) => `<span class="pl-etat pl-${cls}">${t}</span>`;
  const lignes = ns.map(p => {
    const k0 = window.etatKizeo(item, p);
    // Jumeau : même visite, seul son rapport Kizeo est à part
    if (p.jumeau) return `<tr><td class="pl-cercle">${nomPassage(p)}</td><td>${m("na", "–")}</td><td>${k0 === "ok" || k0 === "recu" ? m("ok", "✓") : k0 === "ecart" ? m("att", "!") : m("ko", "✕")}</td><td>${m("na", "–")}</td><td>${m("na", "–")}</td></tr>`;
    const a = window.etatAgenda(p), k = k0;
    const c = window.notifPassage(item, p, "notifBailleur"), l = window.notifPassage(item, p, "notifLocataire");
    return `<tr><td class="pl-cercle">${nomPassage(p)} <span style="color:#0D1B2A;font-weight:400;">${window.fmtDate ? window.fmtDate(p.debut) : p.debut} · ${esc(p.techs.join(", "))}</span></td>
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
    // (de même pour un dossier replanifié après un passage annulé)
    if (["À traiter", "Passage annulé", "Nouveau", "", undefined, null].includes(item.statut) && ns.length) {
      await window._updateSuivi(item.id, { statut: "En cours", updatedAt: new Date().toISOString() });
      showToast("Dossier planifié · passé en « En cours »");
    }
    fermer();
  };
}

window.ouvrirPlanification = ouvrirPlanification;
// Lus par l'onglet Planification du Suivi (colonne Avancement, bouton Reprendre)
window.etatsEtapesPlanif = etatsEtapes;
window.etapeConseilleePlanif = etapeConseillee;
window.ETAPES_PLANIF = ETAPES_COURTES;
