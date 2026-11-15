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
/* Fonds (15/11) : une teinte légère par passage, en alternance ; à l'intérieur, les blocs
   techniciens alternent blanc et blanc teinté pour se distinguer sur ce fond */
.pl-passage.teinte-0{background:#F1F5FD;border-color:#D6E0F5;}
.pl-passage.teinte-1{background:#FDF5EC;border-color:#F0DCC4;}
.pl-passage.teinte-2{background:#EFF8F3;border-color:#CFE8DA;}
.pl-passage.teinte-3{background:#F5F1FC;border-color:#E0D5F3;}
.pl-tbloc{border:1px solid rgba(13,27,42,.10);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px;background:#fff;}
.pl-tbloc.alt{background:#F5F7FA;border-color:rgba(13,27,42,.16);}
.pl-tbloc .pl-raps{background:rgba(67,56,202,.04);}
.pl-tbloc-tete{display:flex;align-items:center;gap:10px;font-size:13.5px;color:#312E81;}
.pl-rap-etat,.pl-rap-act{display:flex;gap:6px;align-items:center;white-space:nowrap;}
.pl-doublon{font-size:12px;font-weight:600;color:#B45309;background:#FFF4E5;border-radius:7px;padding:5px 9px;margin-top:5px;}
.pl-exp-form{margin-top:8px;padding:10px 12px;border:1px solid #E0E7FF;border-radius:9px;background:#F8F9FF;}
.pl-raps{border:1px solid #E0E7FF;background:#F8F9FF;border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
.pl-raps-tete{display:flex;gap:10px;align-items:baseline;font-size:13px;}
.pl-rap{display:grid;grid-template-columns:22px minmax(150px,1fr) minmax(170px,1.4fr) auto auto;gap:8px;align-items:center;}
.pl-rap select,.pl-rap input{height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;font:13px 'DM Sans',sans-serif;min-width:0;width:100%;box-sizing:border-box;background:#fff;}
.pl-rap-n{font-weight:700;color:#4338CA;font-size:13px;}
.pl-raps-pied{display:flex;gap:8px;align-items:center;}
@media (max-width:900px){.pl-rap{grid-template-columns:22px 1fr;}}
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
// Brouillon de saisie manuelle refermé sans client, sans référence, sans PDF ni passage : supprimé
function brouillonVide(it) {
  if (!it || !it.brouillon) return false;
  const val = (id, k) => ($("#" + id) ? $("#" + id).value.trim() : String(it[k] || "").trim());
  return !val("plClient", "client") && !val("pl_bc", "bc") && !val("pl_pl", "pl") && !val("pl_devis", "devis")
    && !it.bcUrl && !it.plUrl && !it.devisUrl && !passagesBruts(it).length && !Object.keys((etat && etat.fichiers) || {}).length;
}
function fermer() {
  const it = etat ? dossier() : null;
  if (brouillonVide(it)) {
    clearTimeout(minuterieDossier); minuterieDossier = null;
    window._deleteSuivi(it.id).then(() => { window.interventions = (window.interventions || []).filter(i => i.id !== it.id); if (window.filterTable) window.filterTable(); }).catch(() => {});
    showToast("Saisie vide abandonnée");
  }
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
      ${champ("Expéditeur <span style=\"text-transform:none;font-weight:400;\">· contact du client, coché d'office à la notification</span>", `<div id="plExpWrap"><div class="pl-note">Chargement des contacts…</div></div>`, true)}
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
  // Expéditeur : liste des contacts du client (Contacts clients), ou nouveau contact
  remplirExpediteur(item, item.client || "");
  $("#plClient").addEventListener("change", (e) => remplirExpediteur({ ...item, expediteurContactId: "" }, e.target.value));
  // Doublon : n° de BC, PL ou devis déjà présent dans le Suivi (pour un import, c'est l'étape Validation)
  const alerteDoublon = (cle) => {
    const champ = $("#pl_" + cle); if (!champ) return;
    const ligne = champ.closest(".pl-champ");
    let n = $(".pl-doublon", ligne);
    const v = champ.value.trim().toLowerCase();
    const autres = v ? (window.interventions || []).filter(o => o.id !== item.id && [o.bc, o.pl, o.devis].some(x => String(x || "").trim().toLowerCase() === v)) : [];
    if (!autres.length) { if (n) n.remove(); return; }
    if (!n) { n = document.createElement("div"); n.className = "pl-doublon"; ligne.appendChild(n); }
    n.textContent = "⚠ Existe déjà dans le Suivi : " + autres.slice(0, 3).map(o => [o.client || "—", o.adresse || "sans adresse", window.LIB_ETAPE && window.fileDe ? window.LIB_ETAPE[window.fileDe(o)] : o.statut].join(" · ")).join(" | ");
  };
  DOCS.forEach(([cle]) => { const c = $("#pl_" + cle); if (c) { c.addEventListener("input", () => alerteDoublon(cle)); alerteDoublon(cle); } });
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
        const passages = passagesBruts(it).map(p => ({ ...p, calEvents: {}, calSync: "", calEmpreinte: "", calEmpreintes: {} }));
        maj.passages = passages; maj.calEventIds = passages.map(() => ({}));
      }
      await window._updateSuivi(it.id, maj);
      // Les rapports encore attendus quittent Gestion rapports (les rapports déjà revenus restent)
      const attendus = ps.filter(p => p.kizeoPush && p.passageId).map(p => p.passageId);
      if (attendus.length && window._supprimerAttentesRapport) await window._supprimerAttentesRapport(it.id, attendus);
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
// ── Expéditeur = un contact du client (décidé le 15/11) ──
// Même base que la page Contacts & Notifications > Contacts clients. L'expéditeur est coché
// d'office parmi les destinataires quand on notifie le client.
const nomContact = (c) => ((c.prenom || "") + " " + (c.nom || "")).trim() || c.email;
async function contactsDuClient(client) {
  etat.contacts = etat.contacts || {};
  if (!etat.contacts[client]) {
    const liste = client && window._loadRapportContacts ? await window._loadRapportContacts(client) : [];
    etat.contacts[client] = window._contactsUniques ? window._contactsUniques(liste) : liste;
  }
  return etat.contacts[client];
}
async function remplirExpediteur(item, client) {
  const wrap = $("#plExpWrap"); if (!wrap) return;
  let contacts = [];
  try { contacts = await contactsDuClient(client); } catch (e) { /* liste vide */ }
  if (!$("#plExpWrap") || !etat) return;
  const trouve = window._contactExpediteur ? window._contactExpediteur(item, contacts) : null;
  const texte = String(item.expediteur || "").trim();
  const choix = trouve ? trouve.id : texte ? "__texte__" : "";
  wrap.innerHTML = `<div style="display:flex;gap:8px;align-items:center;">
      <select id="plExpSel" style="flex:1;">
        <option value="">— Aucun —</option>
        ${!trouve && texte ? `<option value="__texte__" selected>« ${esc(texte)} » (pas dans les contacts)</option>` : ""}
        ${contacts.map(c => `<option value="${esc(c.id)}"${c.id === choix ? " selected" : ""}>${esc(nomContact(c))}${c.role ? " · " + esc(c.role) : ""} (${esc(c.email)})</option>`).join("")}
        <option value="__nouveau__">＋ Nouveau contact…</option>
      </select>
      ${!trouve && texte ? `<button type="button" class="pl-btn petit" data-a="expAjout">Ajouter aux contacts</button>` : ""}
    </div>
    <div id="plExpForm" class="pl-exp-form" style="display:none;">
      <div class="pl-grille">
        <div class="pl-champ"><label>Prénom</label><input id="plExpPrenom"></div>
        <div class="pl-champ"><label>Nom</label><input id="plExpNom"></div>
        <div class="pl-champ"><label>Email *</label><input id="plExpEmail" type="email" placeholder="pour pouvoir le notifier"></div>
        <div class="pl-champ"><label>Rôle</label><input id="plExpRole" placeholder="ex. Chargé de secteur"></div>
        <div class="pl-champ"><label>Téléphone</label><input id="plExpTel"></div>
      </div>
      <div class="pl-actions" style="margin:8px 0 0;"><button type="button" class="pl-btn indigo petit" data-a="expCreer">Ajouter le contact à ${esc(client || "ce client")}</button><button type="button" class="pl-btn lien" data-a="expAnnuler">Annuler</button></div>
    </div>`;
  wrap.dataset.client = client;
  const sel = $("#plExpSel"), form = $("#plExpForm");
  const ouvrir = (prerempli) => {
    form.style.display = "block";
    // « ETAME MBAPPE Thomson » : les mots en majuscules font le nom, les autres le prénom
    if (prerempli) {
      const mots = prerempli.replace(/[^\s<>]+@[^\s<>]+/, "").split(/\s+/).filter(Boolean);
      const maj = mots.filter(m => m.length > 1 && m === m.toUpperCase());
      $("#plExpNom").value = (maj.length ? maj : mots.slice(-1)).join(" ");
      $("#plExpPrenom").value = mots.filter(m => !(maj.length ? maj : mots.slice(-1)).includes(m)).join(" ");
      const mail = (prerempli.match(/[^\s<>]+@[^\s<>]+/) || [])[0]; if (mail) $("#plExpEmail").value = mail;
    }
    $("#plExpEmail").focus();
  };
  sel.onchange = () => { if (sel.value === "__nouveau__") ouvrir(""); else form.style.display = "none"; };
  const ba = $("[data-a=expAjout]", wrap); if (ba) ba.onclick = () => { sel.value = "__nouveau__"; ouvrir(texte); };
  $("[data-a=expAnnuler]", wrap).onclick = () => { form.style.display = "none"; sel.value = choix; };
  $("[data-a=expCreer]", wrap).onclick = async (ev) => {
    const prenom = $("#plExpPrenom").value.trim(), nom = $("#plExpNom").value.trim(), email = $("#plExpEmail").value.trim();
    if (!/.+@.+\..+/.test(email)) { showToast("Email du contact invalide.", true); return; }
    if (!prenom && !nom) { showToast("Renseigne au moins un nom ou un prénom.", true); return; }
    if (!client) { showToast("Choisis d'abord le client.", true); return; }
    // Email déjà connu pour ce client : on reprend le contact existant, pas de doublon
    let c = contacts.find(x => (x.email || "").toLowerCase() === email.toLowerCase());
    if (!c) {
      ev.target.disabled = true; ev.target.textContent = "Ajout…";
      try {
        const data = { prenom, nom, email, role: $("#plExpRole").value.trim(), telephone: $("#plExpTel").value.trim(), client };
        c = { id: await window._addContact(data), ...data };
        contacts.push(c);
        showToast("Contact ajouté aux Contacts clients de " + client);
      } catch (e) { showToast("Erreur à l'ajout du contact : " + e.message, true); ev.target.disabled = false; ev.target.textContent = "Ajouter le contact"; return; }
    } else showToast("Ce contact existait déjà : il est sélectionné.");
    await remplirExpediteur({ ...item, expediteurContactId: c.id }, client);
    // Enregistré aussitôt
    if (etat && etat.etape === 0) enregistrerDossier(dossier() || item, true);
  };
}
// Expéditeur choisi, prêt à enregistrer ; null tant que la liste charge ou qu'un nouveau contact est en cours
function lireExpediteur(item) {
  const sel = $("#plExpSel"); if (!sel) return null;
  const v = sel.value;
  if (v === "__nouveau__") return null;
  if (v === "") return { expediteur: "", expediteurContactId: "", expediteurEmail: "" };
  if (v === "__texte__") return { expediteur: String(item.expediteur || "").trim(), expediteurContactId: "", expediteurEmail: String(item.expediteurEmail || "").trim() };
  const c = ((etat.contacts || {})[$("#plExpWrap").dataset.client] || []).find(x => x.id === v);
  return c ? { expediteur: nomContact(c), expediteurContactId: c.id, expediteurEmail: c.email || "" } : null;
}
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
    dateEmission: v("plDateEmission"),
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
  // Expéditeur (contact du client) : nom affiché, identifiant et email du contact
  const ex = lireExpediteur(item);
  if (ex) Object.entries(ex).forEach(([k, val]) => { if (val !== String(item[k] ?? "").trim()) maj[k] = val; });
  if (item.brouillon && ((maj.client ?? item.client) || (maj.bc ?? item.bc) || (maj.pl ?? item.pl) || (maj.devis ?? item.devis))) maj.brouillon = false;
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
//   date + heure, techniciens) et ses contrôles (fin après début, année plausible), plus un
//   contrôle : jamais avant un passage de numéro inférieur ;
// - Passages, Agenda et Kizeo ne font qu'une étape. Chaque modification est enregistrée toute
//   seule et l'agenda Google suit (création, mise à jour, suppression des rendez-vous) ;
// - tout est organisé par technicien : chacun a son rendez-vous (titre, adresse, description à
//   lui, `agendaTech[nom]`) et ses rapports Kizeo. La description de son rendez-vous se termine
//   par le nom de SES rapports ; le nom de son 1er rapport reprend son titre agenda ;
// - un passage peut avoir plusieurs rapports. Le 1er est porté par le passage ; chaque rapport de
//   plus est un passage « jumeau » caché (même n°, `jumeau: true`) qui reprend date, créneau et
//   techniciens, sans rendez-vous à lui. Le serveur lui donne une référence Kizeo distincte ;
// - chaque rapport s'envoie au clic, ligne par ligne (un formulaire parti ne se retire pas à distance).
const ANNEE_MIN = new Date().getFullYear() - 1, ANNEE_MAX = new Date().getFullYear() + 3;
const BORNE_MIN = ANNEE_MIN + "-01-01T00:00", BORNE_MAX = ANNEE_MAX + "-12-31T23:59";
const sansSuffixe = (s) => String(s || "").replace(/ \(\d+\)$/, ""); // « (2) » ajouté par le serveur à un renvoi
const agendaVide = () => ({ titre: "", adresse: "", desc: "" });
// Technicien d'un rapport : celui enregistré, sinon celui qui l'a reçu, sinon le 1er du passage
function techDuRapport(p, techs) {
  if (p.kzTech && techs.includes(p.kzTech)) return p.kzTech;
  const id = p.kzDest || (p.kizeoPush ? p.kizeoPush.recipientUserId : "");
  const t = id ? techs.find(n => { const x = techParNom(n); return x && String(x.kizeoUserId) === String(id); }) : null;
  return t || techs[0] || "";
}
function rapportDepuis(item, p, num, techs, agenda) {
  const kp = p.kizeoPush || null;
  const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", num) : null;
  const tech = techDuRapport(p, techs);
  const titreTech = ((agenda[tech] || {}).titre || "").trim() || titreDefaut(item);
  return { pid: p.passageId || uuid(), ref: p, annule: p.statut === "annule", tech,
    formId: String(p.kzForm ?? (kp ? kp.kizeoFormDocId : (lie ? lie.id : "")) ?? ""),
    // Nom saisi à la main ; pour un rapport parti avant le 15/11 (pas de kzNom), le nom déjà envoyé
    nom: p.kzNomSaisi ? (p.kzNom || "") : (kp && p.kzNom === undefined ? sansSuffixe(kp.libelle) : ""),
    manuel: !!p.kzNomSaisi || (!!kp && p.kzNom === undefined && sansSuffixe(kp.libelle) !== titreTech) };
}
function lignesDepuis(item) {
  const bruts = passagesBruts(item);
  const L = bruts.filter(p => !p.jumeau).map(p => {
    const techs = (p.techs || []).slice();
    // Rendez-vous par technicien ; un passage d'avant reprend son titre, son adresse et sa description pour chacun
    const agenda = {};
    techs.forEach(n => { const a = (p.agendaTech || {})[n]; agenda[n] = a ? { titre: a.titre || "", adresse: a.adresse || "", desc: a.desc || "" } : { titre: p.titre || "", adresse: p.adresse || "", desc: p.desc || "" }; });
    return { ref: p, pid: p.passageId || uuid(), num: p.num, annule: p.statut === "annule",
      debut: (p.debut || "").substring(0, 16), fin: (p.fin || "").substring(0, 16), techs, agenda, rapports: [] };
  });
  L.forEach(l => { const r = rapportDepuis(item, l.ref, l.num, l.techs, l.agenda); r.pid = l.pid; l.rapports.push(r); });
  // Rapports de plus (jumeaux) : rangés sous leur passage
  bruts.filter(p => p.jumeau).forEach(p => {
    const l = L.find(x => x.num === p.num && !x.annule) || L.find(x => x.num === p.num);
    if (l) l.rapports.push(rapportDepuis(item, p, p.num, l.techs, l.agenda));
  });
  if (!L.length) L.push(nouvelleLigne(item, 1));
  return L;
}
function nouvelleLigne(item, num, modele) {
  const pid = uuid();
  const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", num) : null;
  const techs = modele ? modele.techs.slice() : [];
  const agenda = {}; techs.forEach(n => { agenda[n] = modele && modele.agenda[n] ? { ...modele.agenda[n] } : agendaVide(); });
  const rapports = modele
    ? modele.rapports.filter(r => !r.annule).map((r, k) => ({ pid: k === 0 ? pid : uuid(), ref: null, annule: false, tech: r.tech, formId: r.formId, nom: "", manuel: false }))
    : [{ pid, ref: null, annule: false, tech: techs[0] || "", formId: lie ? String(lie.id) : "", nom: "", manuel: false }];
  if (!rapports.length) rapports.push({ pid, ref: null, annule: false, tech: techs[0] || "", formId: "", nom: "", manuel: false });
  rapports[0].pid = pid;
  return { ref: null, pid, num, annule: false, debut: modele ? modele.debut : "", fin: modele ? modele.fin : "", techs, agenda, rapports };
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
// Passage vierge : ajouté mais jamais rempli (ni date, ni technicien) ; ignoré à l'enregistrement
const vierge = (l) => !l.annule && !l.ref && !l.debut && !l.techs.length;
function problemesLigne(l, L) {
  if (l.annule || vierge(l)) return [];
  L = L.filter(a => !vierge(a));
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
// ── Rapports Kizeo ──
const formParId = (id) => (window._kizeoForms || []).find(f => String(f.id) === String(id));
// Destinataire Kizeo d'un rapport : son technicien, s'il a un compte Kizeo
function destDe(l, r) { const t = r.tech ? techParNom(r.tech) : null; return t && t.kizeoUserId ? t : null; }
const titreAuto = (item, l, nom) => (((l.agenda || {})[nom] || {}).titre || "").trim() || titreDefaut(item);
// Le 1er rapport d'un technicien reprend son titre agenda tant qu'on ne l'a pas modifié ; les suivants se nomment à la main
const premierDuTech = (l, r) => l.rapports.filter(x => !x.annule && x.tech === r.tech)[0] === r;
function nomRapport(item, l, r) {
  if (premierDuTech(l, r)) return r.manuel && r.nom.trim() ? r.nom.trim() : titreAuto(item, l, r.tech);
  return r.nom.trim();
}
// État d'un rapport : envoyé, reçu, modifié depuis l'envoi (à renvoyer), à envoyer
function etatRapportKz(item, l, r) {
  const n = norm(item, { passageId: r.pid, num: l.num });
  const p = (dossier() ? passagesBruts(dossier()) : []).find(x => x.passageId === r.pid);
  const e = n ? window.etatKizeo(item, n) : "manque";
  if (e === "recu") return "recu";
  if (e === "manque" || !p || !p.kizeoPush) return "manque";
  const t = destDe(l, r);
  const kp = p.kizeoPush;
  if (String(kp.kizeoFormDocId) !== String(r.formId) || !t || String(kp.recipientUserId) !== String(t.kizeoUserId) || sansSuffixe(kp.libelle) !== nomRapport(item, l, r)) return "modifie";
  return "ok";
}
const LIB_KZ = { ok: ["ok", "✓ envoyé"], recu: ["ok", "✓ rapport reçu"], modifie: ["att", "modifié : à renvoyer"], manque: ["ko", "✕ à envoyer"] };
// ── Agenda ──
function descriptionAuto(item, adresse) {
  const tels = Array.isArray(item.coordonnees) ? item.coordonnees : item.coordonnees ? [item.coordonnees] : [];
  return [item.bc || item.pl ? "N° BC : " + (item.bc || item.pl) : "", item.nature ? "Nature : " + item.nature : "", item.nomClient ? "Client : " + item.nomClient : "",
    tels.length ? "Téléphone(s) : " + tels.join(" / ") : "", adresse ? "Adresse : " + adresse : ""].filter(Boolean).join("\n");
}
// Rendez-vous d'un technicien sur un passage principal : son titre, son adresse, sa description
// (sinon automatique) + observations du dossier, toujours + ses rapports Kizeo
function contenuAgenda(item, p, ps, nom) {
  const a = (p.agendaTech || {})[nom] || { titre: p.titre, adresse: p.adresse, desc: p.desc };
  const adresse = (a.adresse || "").trim() || item.adresse || "";
  let desc = (a.desc || "").trim() || descriptionAuto(item, adresse);
  const obs = String(item.observations || "").trim();
  if (obs && !desc.includes(obs)) desc += (desc ? "\n" : "") + "Observations : " + obs;
  const t = nom ? techParNom(nom) : null;
  const noms = [p].concat(ps.filter(j => j.jumeau && j.statut !== "annule" && j.num === p.num))
    .filter(x => x.kzForm && x.kzNom && (x.kzTech ? x.kzTech === nom : (t && t.kizeoUserId && String(x.kzDest) === String(t.kizeoUserId)))).map(x => x.kzNom);
  if (noms.length) desc += "\n\n" + (noms.length > 1 ? "Rapports Kizeo à remplir :" : "Rapport Kizeo à remplir :") + "\n" + noms.map(n => "• " + n).join("\n");
  return { titre: (a.titre || "").trim() || titreDefaut(item), adresse, desc };
}
const empreinteAgenda = (item, p, ps, nom) => JSON.stringify([p.debut, p.fin, (p.techs || []).slice().sort(), contenuAgenda(item, p, ps, nom)]);
// Rendez-vous d'un technicien à jour ? Empreinte par technicien (calEmpreintes) ; un passage
// synchronisé avant (calEmpreinte unique) est à refaire ; un passage de la fiche classique se juge sur calSync.
function agendaAJour(item, p, ps, nom) {
  const e = (p.calEmpreintes || {})[nom];
  if (e) return e === empreinteAgenda(item, p, ps, nom);
  if (p.calEmpreinte) return false;
  return p.calSync === window.cleSyncAgenda(p.debut, p.fin, p.techs);
}
function etatAgendaTech(item, p, ps, nom) {
  const t = techParNom(nom);
  if (!t || !t.email) return "sans";
  if (!(p.calEvents || {})[nom]) return "manque";
  return agendaAJour(item, p, ps, nom) ? "ok" : "maj";
}
const LIB_AGENDA = { ok: ["ok", "✓ agenda à jour"], maj: ["att", "agenda à mettre à jour"], manque: ["ko", "✕ pas dans l'agenda"], sans: ["att", "pas d'agenda (page Techniciens)"] };

let minuteriePassages = null, sauvegardeEnCours = null, aRefaire = false;
function rendrePassages(item) {
  if (!etat.lignes) etat.lignes = lignesDepuis(item);
  const L = etat.lignes;
  const techs = techniciens().filter(t => nomTech(t));
  const forms = window._kizeoForms || [];
  const enBase = passagesBruts(dossier() || item);
  const dt = (f, v) => `<input type="datetime-local" data-f="${f}" value="${esc(v)}" min="${BORNE_MIN}" max="${BORNE_MAX}">`;
  // Ligne d'un rapport, dans le bloc de son technicien
  const ligneRapport = (l, r, i) => {
    const k = l.rapports.indexOf(r);
    const lie = window._findKizeoFormLie ? window._findKizeoFormLie(item.nature || "", item.client || "", l.num) : null;
    const etatR = r.formId ? etatRapportKz(item, l, r) : null;
    const premier = premierDuTech(l, r);
    const nom = nomRapport(item, l, r);
    const action = !r.formId || !destDe(l, r) ? "" : etatR === "manque" ? `<button class="pl-btn indigo petit" data-a="envoyerRap">Envoyer</button>` : etatR === "modifie" ? `<button class="pl-btn indigo petit" data-a="envoyerRap">Renvoyer</button><button class="pl-btn petit" data-a="annulerModif" title="Revenir à ce qui a été envoyé sur Kizeo (formulaire, technicien, nom)">↺ Annuler</button>` : "";
    return `<div class="pl-rap" data-r="${k}">
      <span class="pl-rap-n">${i + 1}.</span>
      <select data-rf="formId"><option value="">— Aucun rapport Kizeo —</option>${forms.map(f => `<option value="${esc(f.id)}"${String(r.formId) === String(f.id) ? " selected" : ""}>${esc(f.nom || "Formulaire")}${lie && String(lie.id) === String(f.id) ? " (lié)" : ""}</option>`).join("")}</select>
      <input data-rf="nom" value="${esc(premier ? nom : r.nom)}" placeholder="${premier ? "" : "Nom du rapport (à saisir)"}" title="${premier ? "Reprend le titre agenda tant que tu ne le modifies pas" : "Nom du rapport dans l'application du technicien"}"${r.formId && !nom ? ' style="border-color:#E74C3C;"' : ""}>
      <span class="pl-rap-etat">${etatR ? etatHtml(...LIB_KZ[etatR]) : ""}</span>
      <span class="pl-rap-act">${action}${r.formId || k > 0 ? `<button class="pl-btn petit" data-a="retirerRap" title="Supprimer ce rapport">✕</button>` : ""}</span>
    </div>`;
  };
  // Bloc d'un technicien : son rendez-vous et ses rapports
  const blocTech = (l, nom, p, i) => {
    const a = l.agenda[nom] || (l.agenda[nom] = agendaVide());
    const t = techParNom(nom);
    const etatA = p && p.statut !== "annule" && (p.techs || []).includes(nom) ? etatAgendaTech(item, p, enBase, nom) : null;
    const raps = l.rapports.filter(r => !r.annule && r.tech === nom);
    return `<div class="pl-tbloc${i % 2 ? " alt" : ""}" data-tech="${esc(nom)}">
      <div class="pl-tbloc-tete"><b>${esc(nom)}</b>${etatA ? etatHtml(...LIB_AGENDA[etatA]) : ""}</div>
      <div class="pl-grille">
        <div class="pl-champ"><label>Titre agenda</label><input data-af="titre" value="${esc(a.titre)}" placeholder="${esc(titreDefaut(item))}"></div>
        <div class="pl-champ"><label>Adresse</label><input data-af="adresse" value="${esc(a.adresse)}" placeholder="${esc(item.adresse || "Adresse...")}"></div>
        <div class="pl-champ large"><label>Description <span style="text-transform:none;font-weight:400;">· les observations du dossier et le nom de ses rapports Kizeo sont ajoutés dans l'agenda</span></label><textarea data-af="desc" placeholder="Laisse vide pour la description automatique (BC, nature, contact, téléphones, adresse)">${esc(a.desc)}</textarea></div>
      </div>
      <div class="pl-raps"><div class="pl-raps-tete"><b>Rapports Kizeo</b>${t && t.kizeoUserId ? "" : '<span class="pl-manque" style="font-size:12px;">pas de compte Kizeo (page Techniciens) : envoi impossible</span>'}</div>
        ${raps.map((r, i) => ligneRapport(l, r, i)).join("")}
        <div class="pl-raps-pied"><button class="pl-btn petit" data-a="ajoutRap">+ Ajouter un rapport</button></div></div>
    </div>`;
  };
  const carte = (l, k) => {
    const pb = problemesLigne(l, L);
    if (l.annule) return `<div class="pl-passage annule" data-k="${k}"><div class="pl-psg-l1" style="grid-template-columns:auto 1fr;"><span class="pl-cercle">${cercle(l.num)}</span><span class="pl-note">passage annulé${l.debut ? " · prévu le " + fmtDT(l.debut) : ""}</span></div></div>`;
    const p = enBase.find(x => x.passageId === l.pid);
    return `<div class="pl-passage teinte-${k % 4}" data-k="${k}">
      <div class="pl-psg-l1">
        <div class="pl-psg-num"><label>Passage</label><div style="display:flex;align-items:center;gap:4px;"><input type="number" min="1" data-f="num" value="${esc(l.num)}"><span class="pl-cercle">${cercle(l.num)}</span></div></div>
        <div class="pl-champ"><label>Début</label>${dt("debut", l.debut)}</div>
        <div class="pl-champ"><label>Fin</label>${dt("fin", l.fin)}</div>
        <div class="pl-psg-actions"><button class="pl-btn petit" data-a="suppr" title="Supprimer ce passage">✕</button></div>
      </div>
      <div class="pl-champ"><label>Technicien(s)</label><div class="pl-techs">${techs.map(t => `<span class="pl-tech${l.techs.includes(nomTech(t)) ? " on" : ""}" data-t="${esc(nomTech(t))}">${esc(nomTech(t))}</span>`).join("")}</div>
        ${l.techs.map(t => { const c = chargeTech(t, (l.debut || "").substring(0, 10), item.id); return c ? `<div class="pl-charge">${esc(t.split(" ")[0])} a déjà ${c} passage${c > 1 ? "s" : ""} ce jour-là</div>` : ""; }).join("")}</div>
      ${l.techs.map((nom, i) => blocTech(l, nom, p, i)).join("")}
      ${pb.length ? `<div class="pl-psg-pb">⚠ ${pb.map(esc).join(" · ")}</div>` : ""}
    </div>`;
  };
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">Chaque modification est enregistrée toute seule et l'agenda de chaque technicien suit : rendez-vous créé, déplacé ou retiré. Chaque rapport Kizeo s'envoie avec son bouton.</p>
    ${L.map(carte).join("") || '<p class="pl-note" style="margin:6px 0 12px;">Aucun passage pour ce dossier. Le dossier reste en Planification tant qu\'il n\'a pas de passage.</p>'}
    <div class="pl-actions"><button class="pl-btn" data-a="ajout">+ Ajouter un passage</button>
      <button class="pl-btn" data-a="dupli">Dupliquer le dernier à +</button><input id="plEcart" type="number" min="1" value="15" style="width:60px;height:34px;border:1px solid rgba(13,27,42,.15);border-radius:7px;padding:0 8px;"> jours</div>`;
  const ligneDe = (el) => L[Number(el.closest(".pl-passage").dataset.k)];
  const techDe = (el) => el.closest(".pl-tbloc").dataset.tech;
  const rapportDe = (el) => ligneDe(el).rapports[Number(el.closest(".pl-rap").dataset.r)];
  const change = (redessiner) => { if (redessiner) rendrePassages(item); planifierAutoPassages(); };
  // Passage : n° et dates (redessin pour les contrôles)
  document.querySelectorAll(".pl-corps [data-f]").forEach(inp => {
    const f = inp.dataset.f;
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
  // Rendez-vous d'un technicien : titre, adresse, description (pas de redessin pendant la frappe)
  document.querySelectorAll(".pl-corps [data-af]").forEach(inp => {
    const f = inp.dataset.af;
    inp.oninput = () => {
      const l = ligneDe(inp), nom = techDe(inp);
      (l.agenda[nom] = l.agenda[nom] || agendaVide())[f] = inp.value;
      // Le nom de son 1er rapport suit son titre agenda en direct (s'il n'a pas été modifié à la main)
      if (f === "titre") {
        const r = l.rapports.find(x => !x.annule && x.tech === nom);
        if (r && !r.manuel) { const c = inp.closest(".pl-tbloc").querySelector('.pl-rap[data-r="' + l.rapports.indexOf(r) + '"] [data-rf="nom"]'); if (c) c.value = titreAuto(item, l, nom); }
      }
      change(false);
    };
    inp.onchange = () => rendrePassages(item);
  });
  document.querySelectorAll(".pl-corps [data-rf]").forEach(inp => {
    const f = inp.dataset.rf;
    if (f === "nom") {
      inp.oninput = () => {
        const l = ligneDe(inp), r = rapportDe(inp);
        r.nom = inp.value;
        // 1er rapport du technicien : redevient automatique (titre agenda) si on l'efface ou retape le titre
        if (premierDuTech(l, r)) r.manuel = !!inp.value.trim() && inp.value.trim() !== titreAuto(item, l, r.tech);
        change(false);
      };
      inp.onchange = () => rendrePassages(item); return;
    }
    inp.onchange = () => { rapportDe(inp)[f] = inp.value; change(true); };
  });
  // Liste « nom (chez technicien) » des rapports déjà partis sur Kizeo
  const partis = (rs) => rs.map(r => enBase.find(p => p.passageId === r.pid)).filter(p => p && p.kizeoPush)
    .map(p => "• « " + (p.kizeoPush.libelle || "") + " »" + (p.kizeoPush.technicien ? " (chez " + p.kizeoPush.technicien + ")" : ""));
  document.querySelectorAll(".pl-corps .pl-tech").forEach(ch => ch.onclick = () => {
    const l = ligneDe(ch); const t = ch.dataset.t;
    if (!l.techs.includes(t)) {
      l.techs.push(t); l.agenda[t] = l.agenda[t] || agendaVide();
      // Le rapport du passage sans technicien valable revient au nouveau
      if (!l.techs.includes(l.rapports[0].tech) || !l.rapports[0].tech) l.rapports[0].tech = t;
      change(true); return;
    }
    // Décocher : son rendez-vous est retiré, ses rapports aussi (ceux déjà partis restent à supprimer dans Kizeo)
    const siens = l.rapports.filter(r => !r.annule && r.tech === t);
    const p = enBase.find(x => x.passageId === l.pid);
    const kz = partis(siens);
    const rdv = p && (p.calEvents || {})[t];
    if ((kz.length || rdv) && !confirm("Retirer " + t + " du passage " + l.num + " ?" + (rdv ? "\n\nSon rendez-vous sera retiré de l'agenda." : "")
      + (kz.length ? "\n\nRapport(s) Kizeo déjà envoyé(s), à supprimer à la main dans Kizeo :\n" + kz.join("\n") : ""))) return;
    l.techs = l.techs.filter(x => x !== t);
    delete l.agenda[t];
    // Le rapport porté par le passage ne se supprime pas : il passe au 1er technicien restant, sans formulaire s'il était parti
    l.rapports = l.rapports.filter((r, k) => k === 0 || r.tech !== t);
    if (l.rapports[0].tech === t) { l.rapports[0].tech = l.techs[0] || ""; l.rapports[0].nom = ""; l.rapports[0].manuel = false; }
    change(true);
  });
  document.querySelectorAll(".pl-corps [data-a=suppr]").forEach(b => b.onclick = () => {
    const l = ligneDe(b);
    const p = enBase.find(x => x.passageId === l.pid);
    const rdv = p && Object.values(p.calEvents || {}).some(Boolean);
    const kz = partis(l.rapports);
    if (p && !confirm("Supprimer le passage " + l.num + " ?" + (rdv ? "\n\nLes rendez-vous seront retirés de l'agenda." : "")
      + (kz.length ? "\n\nRapport(s) Kizeo déjà envoyé(s), à supprimer à la main dans Kizeo :\n" + kz.join("\n") : ""))) return;
    L.splice(L.indexOf(l), 1);
    change(true);
  });
  document.querySelectorAll(".pl-corps [data-a=ajoutRap]").forEach(b => b.onclick = () => {
    const l = ligneDe(b), nom = techDe(b);
    // Le rapport porté par le passage, s'il est encore vide et sans technicien valable, sert en premier
    const r0 = l.rapports[0];
    if (!r0.formId && (!r0.tech || !l.techs.includes(r0.tech) || r0.tech === nom) && !(r0.ref && r0.ref.kizeoPush)) { r0.tech = nom; change(true); return; }
    l.rapports.push({ pid: uuid(), ref: null, annule: false, tech: nom, formId: "", nom: "", manuel: false });
    change(true);
  });
  // Suppression d'un rapport (15/11) : la ligne part, l'agenda est mis à jour (son nom disparaît
  // de la description), la ligne « en attente technicien » de Gestion rapports est retirée.
  // Le formulaire déjà sur le téléphone se supprime à la main dans Kizeo.
  document.querySelectorAll(".pl-corps [data-a=retirerRap]").forEach(b => b.onclick = () => {
    const l = ligneDe(b), r = rapportDe(b);
    if (etatRapportKz(item, l, r) === "recu") { showToast("Ce rapport est déjà revenu du technicien : il se gère dans Gestion rapports.", true); return; }
    const kz = partis([r]);
    const nom = nomRapport(item, l, r) || "sans nom";
    if (!confirm("Supprimer le rapport « " + nom + " » ?" + (kz.length ? "\n\nIl est déjà parti sur Kizeo : supprime-le aussi à la main dans l'application Kizeo :\n" + kz.join("\n") : ""))) return;
    if (l.rapports.indexOf(r) === 0) {
      // Le rapport porté par le passage : le passage reste, sans rapport Kizeo
      r.formId = ""; r.nom = ""; r.manuel = false; r.effacerEnvoi = true;
    } else l.rapports.splice(l.rapports.indexOf(r), 1);
    change(true);
  });
  // Modification abandonnée : le rapport reprend ce qui est parti sur Kizeo
  document.querySelectorAll(".pl-corps [data-a=annulerModif]").forEach(b => b.onclick = () => {
    const l = ligneDe(b), r = rapportDe(b);
    const kp = (enBase.find(p => p.passageId === r.pid) || {}).kizeoPush;
    if (!kp) return;
    r.formId = String(kp.kizeoFormDocId || "");
    const recu = l.techs.find(n => { const x = techParNom(n); return x && String(x.kizeoUserId) === String(kp.recipientUserId); });
    if (recu) r.tech = recu;
    const nomEnvoye = sansSuffixe(kp.libelle);
    if (premierDuTech(l, r)) { r.manuel = nomEnvoye !== titreAuto(item, l, r.tech); r.nom = r.manuel ? nomEnvoye : ""; }
    else r.nom = nomEnvoye;
    change(true);
    if (!recu) showToast("Rapport remis comme envoyé, mais " + (kp.technicien || "son destinataire") + " n'est plus sur ce passage : remets-le dans les techniciens ou renvoie le rapport.", true);
  });
  document.querySelectorAll(".pl-corps [data-a=envoyerRap]").forEach(b => b.onclick = () => envoyerRapport(item, ligneDe(b), rapportDe(b), b));
  const prochainNum = () => Math.max(0, ...L.map(l => l.num || 0)) + 1;
  $("[data-a=ajout]").onclick = () => {
    const der = L.filter(l => !l.annule).slice(-1)[0];
    const n = nouvelleLigne(item, prochainNum());
    if (der) { n.techs = der.techs.slice(); n.techs.forEach(t => { n.agenda[t] = agendaVide(); }); n.rapports[0].tech = n.techs[0] || ""; }
    L.push(n); rendrePassages(item);
  };
  $("[data-a=dupli]").onclick = () => {
    const der = L.filter(l => !l.annule && l.debut).slice(-1)[0];
    if (!der) { showToast("Saisis d'abord la date d'un passage.", true); return; }
    const jours = (Number($("#plEcart").value) || 15) * 1440;
    const n = nouvelleLigne(item, prochainNum(), der);
    n.debut = decaler(der.debut, jours); n.fin = der.fin ? decaler(der.fin, jours) : "";
    L.push(n);
    change(true);
  };
  navigation("Continuer →", async () => {
    clearTimeout(minuteriePassages); minuteriePassages = null;
    const r = await enregistrerPassages(item, false);
    return r === false ? false : undefined;
  });
  $(".pl-pied .pl-espace").insertAdjacentHTML("afterend", `<span class="pl-note" id="plAuto" style="margin-right:8px;">Enregistrement automatique</span>`);
  // En arrivant sur l'étape : un rendez-vous dépassé (observations, contact ou adresse changés à
  // l'étape Dossier, ou passage synchronisé avec l'ancienne description) est remis à jour
  if (!etat.syncInitiale) {
    etat.syncInitiale = true;
    if (enBase.some(p => !p.jumeau && p.statut !== "annule" && (p.techs || []).some(n => etatAgendaTech(item, p, enBase, n) === "maj"))) planifierAutoPassages();
  }
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
  // Aucun passage : permis (tous supprimés) ; le dossier ne pourra simplement pas passer en Pilotage
  const vivants = L.filter(l => !l.annule);
  const enDefaut = vivants.map(l => ({ l, pb: problemesLigne(l, L) })).filter(x => x.pb.length);
  if (enDefaut.length) {
    const msg = "passage " + enDefaut[0].l.num + " : " + enDefaut[0].pb[0];
    if (silencieux) indiquerAuto("⚠ Non enregistré : " + msg, true); else showToast(msg.charAt(0).toUpperCase() + msg.slice(1) + ".", true);
    return false;
  }
  const passe = async () => {
    const frais = passagesBruts(dossier() || item);
    const parPid = Object.fromEntries(frais.filter(p => p.passageId).map(p => [p.passageId, p]));
    const passages = [];
    const effaces = []; // rapports supprimés dont le formulaire était parti
    L.filter(l => !vierge(l)).forEach(l => {
      // Rendez-vous de chaque technicien ; le 1er technicien alimente aussi titre/adresse/description
      // du passage, lus par le reste de l'app (vue Semaine, ancienne fiche)
      const agendaTech = {};
      l.techs.forEach(n => { const a = l.agenda[n] || agendaVide(); agendaTech[n] = { titre: a.titre.trim(), adresse: a.adresse.trim(), desc: a.desc.trim() }; });
      const a0 = agendaTech[l.techs[0]] || agendaVide();
      l.rapports.forEach((r, k) => {
        // Base : la version en base (envoi Kizeo, rendez-vous, notifications faits entre-temps)
        const base = parPid[r.pid] ? { ...parPid[r.pid] } : { passageId: r.pid, statut: "", kizeoPush: null, calEvents: {}, notifs: null, manualRapport: null };
        const jumeau = k > 0;
        if (!l.annule && !r.annule) {
          base.debut = l.debut; base.fin = l.fin || l.debut; base.techs = l.techs.slice();
          base.adresse = a0.adresse || item.adresse || "";
          base.titre = jumeau ? "" : a0.titre;
          base.desc = jumeau ? "" : a0.desc;
          base.agendaTech = jumeau ? {} : agendaTech;
          // Rapport Kizeo préparé (formulaire, technicien, nom) : sert à l'envoi et à la description de l'agenda
          const t = destDe(l, r);
          base.kzForm = r.formId || "";
          base.kzTech = r.tech || "";
          base.kzDest = t ? String(t.kizeoUserId) : "";
          base.kzNom = r.formId ? nomRapport(item, l, r) : "";
          base.kzNomSaisi = premierDuTech(l, r) ? !!(r.manuel && r.nom.trim()) : true;
          if (r.effacerEnvoi) { if (base.kizeoPush) effaces.push(r.pid); base.kizeoPush = null; }
          base.libelle = jumeau ? base.kzNom : "";
          if (jumeau) { base.calEvents = {}; base.calSync = ""; base.calEmpreinte = ""; base.calEmpreintes = {}; }
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
      // Rapports supprimés (ligne, passage ou technicien retiré) : plus de ligne « en attente technicien »
      const partisRetires = frais.filter(p => p.passageId && p.kizeoPush && !gardes.has(p.passageId)).map(p => p.passageId).concat(effaces);
      if (partisRetires.length && window._supprimerAttentesRapport) await window._supprimerAttentesRapport(item.id, partisRetires);
    } finally { if (etat) etat.occupe = false; }
    L.forEach(l => l.rapports.forEach(r => { delete r.effacerEnvoi; }));
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
// Envoi au clic d'UN rapport (à envoyer, ou modifié depuis l'envoi)
async function envoyerRapport(item, l, r, bouton) {
  clearTimeout(minuteriePassages); minuteriePassages = null;
  if ((await enregistrerPassages(dossier() || item, false)) === false) return; // le rapport doit exister en base
  const it = dossier() || item;
  const e = etatRapportKz(it, l, r);
  if (e !== "manque" && e !== "modifie") { showToast("Ce rapport est déjà à jour sur Kizeo."); return; }
  const nom = nomRapport(it, l, r);
  if (!nom) { showToast("Donne un nom à ce rapport avant de l'envoyer.", true); return; }
  const t = destDe(l, r);
  if (!t) { showToast((r.tech || "Ce technicien") + " n'a pas de compte Kizeo (page Techniciens).", true); return; }
  const ancien = e === "modifie" ? (passagesBruts(it).find(p => p.passageId === r.pid) || {}).kizeoPush : null;
  if (!confirm((ancien ? "Renvoyer" : "Envoyer") + " le rapport « " + nom + " » à " + nomTech(t) + " sur Kizeo ?"
    + (ancien ? "\n\nL'ancien formulaire reste sur le téléphone, à supprimer à la main dans Kizeo :\n• « " + ancien.libelle + " »" + (ancien.technicien ? " (chez " + ancien.technicien + ")" : "") : ""))) return;
  if (bouton) { bouton.disabled = true; bouton.textContent = "Envoi…"; }
  etat.occupe = true;
  try {
    const body = { suiviId: it.id, numPassage: l.num, passageId: r.pid, kizeoFormDocId: r.formId, recipientUserId: String(t.kizeoUserId), libelle: nom };
    const res = await fetch(URL_KIZEO, { method: "POST", headers: await window._authHeaders(), body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "HTTP " + res.status);
    showToast("✅ Rapport « " + nom + " » envoyé à " + nomTech(t));
  } catch (err) {
    showToast("Le rapport n'a pas pu partir : " + err.message, true);
  } finally { if (etat) etat.occupe = false; }
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
// Met les passages (modifiés en place : calEvents, calSync, calEmpreintes) en accord avec l'agenda.
// Un rendez-vous par technicien, avec son contenu. Ne contacte Google que pour ce qui a changé.
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
    const emps = {};
    if (actif) {
      let echec = false;
      for (const nom of voulus) {
        const t = techParNom(nom);
        if (!t || !t.email) { erreurs.push(nom + " : pas d'agenda configuré (page Techniciens)"); continue; }
        const emp = empreinteAgenda(item, p, passages, nom);
        const c = contenuAgenda(item, p, passages, nom);
        if (cal[nom] && agendaAJour(item, p, passages, nom)) { emps[nom] = emp; continue; } // déjà à jour
        const base = { technicienEmail: t.email, passages: [p.debut + "|" + (p.fin || "")], customSummary: c.titre, customDescription: c.desc, adresse: c.adresse, colorId: t.calendarColorId || null, nature: item.nature || "", nomClient: item.nomClient || "", bc: item.bc || item.pl || "", observations: item.observations || "", interventionId: item.id };
        try {
          const r = cal[nom] ? await requeteAgenda({ ...base, operation: "update", calEventId: cal[nom] }) : await requeteAgenda(base);
          if (r.success || r.created > 0 || r.updated > 0) { if (!cal[nom]) cal[nom] = (r.results && r.results[0] && r.results[0].eventId) || ""; if (cal[nom]) emps[nom] = emp; }
          else { echec = true; erreurs.push(nom + " : " + ((r.errors && r.errors[0] && r.errors[0].error) || r.error || "refusé")); }
        } catch (e) { echec = true; erreurs.push(nom + " : " + e.message); }
      }
      // Échec : le technicien concerné n'est pas marqué « à jour », la prochaine sauvegarde réessaiera
      p.calSync = !echec && Object.keys(cal).length ? window.cleSyncAgenda(p.debut, p.fin, p.techs) : "";
    } else p.calSync = "";
    p.calEmpreintes = emps; p.calEmpreinte = "";
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
  const manque = manquesPlanification(item);
  const manqueNotif = manquesNotification(item);
  $(".pl-corps").innerHTML = `
    <p class="pl-intro">${toutOk ? "Tout est prêt : les passages sont planifiés, dans l'agenda, sur Kizeo, et le client et le locataire sont prévenus." : manque.length ? "Le dossier ne peut pas encore passer en Pilotage : l'étape Passages, agenda & Kizeo n'est pas terminée." : "Les passages sont prêts. Il reste à prévenir le client ou le locataire (tu peux le faire maintenant ou plus tard)."}</p>
    <table class="pl-table pl-recap"><thead><tr><th>Passage</th><th>Agenda</th><th>Kizeo</th><th>Client</th><th>Locataire</th></tr></thead><tbody>${lignes.join("") || '<tr><td colspan="5">Aucun passage</td></tr>'}</tbody></table>
    ${manque.length ? `<div class="pl-psg-pb" style="margin-top:12px;">À terminer avant de passer en Pilotage :<br>${manque.map(x => "• " + esc(x)).join("<br>")}</div>` : ""}
    ${!manque.length && manqueNotif.length ? `<div class="pl-psg-pb" style="margin-top:12px;background:#FFF4E5;color:#B45309;">Rappel :<br>${manqueNotif.map(x => "• " + esc(x)).join("<br>")}</div>` : ""}
    <p class="pl-note" style="margin-top:12px;">Les rapports (reçu, envoyé au client) se suivront après l'intervention, dans le Pilotage quotidien.</p>`;
  pied(`<button class="pl-btn" data-a="prec">← Précédent</button><span class="pl-espace"></span>${manque.length ? `<button class="pl-btn" data-a="aller">Reprendre l'étape Passages →</button>` : ""}<button class="pl-btn prim" data-a="fin">Terminer</button>`);
  $(".pl-pied [data-a=prec]").onclick = () => { etat.etape--; rendre(); };
  const ba = $(".pl-pied [data-a=aller]"); if (ba) ba.onclick = () => { etat.etape = 1; etat.lignes = null; rendre(); };
  // Décidé le 15/11 : le dossier passe « En cours » (Pilotage) si et seulement si l'étape Passages,
  // agenda & Kizeo est entièrement validée. Notifications manquantes : bascule après un rappel.
  $(".pl-pied [data-a=fin]").onclick = async () => {
    const it = dossier() || item;
    const m1 = manquesPlanification(it);
    if (m1.length) { alert("Le dossier reste en Planification tant que l'étape Passages, agenda & Kizeo n'est pas terminée :\n\n" + m1.map(x => "• " + x).join("\n")); return; }
    const m2 = manquesNotification(it);
    if (m2.length && !confirm("Rappel :\n\n" + m2.map(x => "• " + x).join("\n") + "\n\nPasser quand même le dossier en Pilotage ? Tu pourras notifier depuis le Pilotage quotidien.")) return;
    // Planification faite : le dossier passe de « À traiter » à « En cours »
    // (de même pour un dossier replanifié après un passage annulé)
    if (["À traiter", "Passage annulé", "Nouveau", "", undefined, null].includes(it.statut)) {
      await window._updateSuivi(it.id, { statut: "En cours", updatedAt: new Date().toISOString() });
      showToast("Dossier planifié · passé en Pilotage quotidien");
    }
    fermer();
  };
}
// Ce qui manque à l'étape Passages, agenda & Kizeo (vide = étape validée)
function manquesPlanification(item) {
  const m = [];
  if (!(item.adresse && (item.bc || item.pl || item.devis))) m.push("Dossier : adresse ou référence (BC, PL, devis) manquante");
  const bruts = passagesBruts(item);
  const ps = actifs(item);
  const pr = ps.filter(p => !p.jumeau);
  if (!pr.length) { m.push("Aucun passage daté"); return m; }
  pr.forEach(p => {
    const n = norm(item, p);
    if (!(p.techs || []).length) m.push("Passage " + p.num + " : aucun technicien");
    else if (n && window.etatAgenda(n) !== "ok") m.push("Passage " + p.num + " : rendez-vous agenda pas à jour");
  });
  ps.forEach(p => {
    const b = bruts.find(x => x.passageId && x.passageId === p.passageId) || p;
    const veut = b.kzForm === undefined || !!b.kzForm || !!b.kizeoPush;
    const n = norm(item, p);
    const e = n ? window.etatKizeo(item, n) : "manque";
    if (veut && e !== "ok" && e !== "recu") m.push("Passage " + p.num + " : rapport Kizeo " + (b.kzNom ? "« " + b.kzNom + " » " : "") + (e === "ecart" ? "chez le mauvais technicien (à renvoyer)" : "pas envoyé"));
  });
  return m;
}
// Notifications manquantes (rappel, non bloquant)
function manquesNotification(item) {
  const ns = actifs(item).filter(p => !p.jumeau).map(p => norm(item, p)).filter(Boolean);
  if (!ns.length) return [];
  const m = [];
  if (!ns.every(p => window.notifOk(window.notifPassage(item, p, "notifBailleur")))) m.push("le client n'est pas notifié" + (ns.some(p => (window.notifPassage(item, p, "notifBailleur") || {}).change) ? " (date modifiée depuis la notification)" : ""));
  if (item.emailClient && !ns.every(p => window.notifOk(window.notifPassage(item, p, "notifLocataire")))) m.push("le locataire n'est pas notifié");
  return m;
}

window.ouvrirPlanification = ouvrirPlanification;
// Menu ⋯ du Suivi : annulation de la commande (étape Dossier, bouton déclenché d'office)
window.annulerCommandePlanif = (id) => { ouvrirPlanification(id, 0); setTimeout(() => { const b = $("[data-a=annuler]"); if (b) b.click(); }, 50); };
// Lus par l'onglet Planification du Suivi (colonne Avancement, bouton Reprendre)
window.etatsEtapesPlanif = etatsEtapes;
window.etapeConseilleePlanif = etapeConseillee;
window.ETAPES_PLANIF = ETAPES_COURTES;
