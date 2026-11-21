// ══════════════════════════════════════════════════════════════════
// RAPPORT CONSOLIDÉ D'UNE DÉSINSECTISATION DE MONTÉE (21/11)
//
// Fusionne l'émargement du 1er passage et celui du 2nd (absents du 1er) en
// un seul PDF, avec la maquette des rapports d'intervention (rapport-pdf.js) :
//   - page 1 : identification, synthèse chiffrée, parties communes, tableau
//     récapitulatif (une ligne par logement, avec son n° de page) ;
//   - puis UNE PAGE PAR LOGEMENT : les deux passages côte à côte et ses
//     photos. Le n° de page de chaque logement est renvoyé (pagesLogements),
//     ce qui permet d'extraire plus tard la page d'un locataire précis.
//
// Les données viennent des rapports reçus (donnees, éventuellement corrigées
// en relecture) : une correction d'émargement se retrouve dans le consolidé
// dès qu'il est régénéré.
// ══════════════════════════════════════════════════════════════════

const fs = require("fs");
const PdfPrinter = require("pdfmake");
const M = require("./rapport-pdf");

const ORANGE = "#D9480F";
const ROUGE = "#C92A2A";

// Signature Kizeo : PNG transparent de la taille de l'écran du téléphone (ex. 1320 × 2868),
// dont le trait n'occupe qu'un coin. On la recadre sur son trait (plus une marge), sinon elle
// apparaît minuscule dans le PDF. En cas d'échec, l'image d'origine est gardée.
function recadrerSignature(buf) {
  return new Promise((resolve) => {
    try {
      if (!buf || buf[0] !== 0x89) return resolve(buf);
      const PNG = require("png-js"); // fourni avec pdfmake (pdfkit)
      const img = new PNG(buf);
      img.decode((px) => {
        try {
          const w = img.width, h = img.height;
          let x0 = w, y0 = h, x1 = -1, y1 = -1;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const encre = px[i + 3] > 40 && (px[i] + px[i + 1] + px[i + 2]) < 600; // pixel opaque et pas blanc
            if (encre) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
          if (x1 < 0) return resolve(buf);
          const marge = 24;
          x0 = Math.max(0, x0 - marge); y0 = Math.max(0, y0 - marge); x1 = Math.min(w - 1, x1 + marge); y1 = Math.min(h - 1, y1 + marge);
          const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
          const brut = Buffer.alloc((cw * 4 + 1) * ch);
          for (let y = 0; y < ch; y++) {
            brut[y * (cw * 4 + 1)] = 0;
            px.copy(brut, y * (cw * 4 + 1) + 1, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4);
          }
          resolve(pngRGBA(cw, ch, brut));
        } catch (e) { resolve(buf); }
      });
    } catch (e) { resolve(buf); }
  });
}
function pngRGBA(w, h, brut) {
  const zlib = require("zlib");
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const o of b) c = table[(c ^ o) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const bloc = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloc("IHDR", ihdr), bloc("IDAT", zlib.deflateSync(brut)), bloc("IEND", Buffer.alloc(0))]);
}

// Champ d'une ligne (logement) ou de l'en-tête, retrouvé par son identifiant Kizeo
// (identifiant suivi du libellé : un champ ajouté au formulaire est reconnu par l'un ou l'autre)
const champ = (champs, re) => { const c = (champs || []).find(x => re.test((x.cle || "") + " " + (x.libelle || ""))); return c ? String(c.valeur ?? "").trim() : ""; };
const statutNormal = (s) => { const v = String(s || "").toLowerCase(); return /accessible/.test(v) ? "inaccessible" : v.startsWith("abs") ? "absent" : v.startsWith("ref") ? "refus" : v.startsWith("pr") ? "present" : ""; };
const LIB_STATUT = { present: "Présent, traité", absent: "Absent", inaccessible: "Non accessible", refus: "Refus", "": "Non renseigné" };
const COULEUR_STATUT = (st) => st === "present" ? M.VERT : st === "absent" || st === "inaccessible" ? ORANGE : st === "refus" ? ROUGE : null;

// Date et heure de prise de vue d'une photo : informations EXIF du fichier (la plus ancienne
// des dates enregistrées = prise de vue), à défaut l'horodatage que Kizeo met dans le nom du média.
function horodatagePhoto(buf, media) {
  const fmt = (a, mo, j, h, mi) => `${j}/${mo}/${a} à ${h}h${mi}`;
  try {
    if (buf && buf[0] === 0xff && buf[1] === 0xd8) {
      const dates = (buf.slice(0, 131072).toString("latin1").match(/(20\d\d):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/g) || []).sort();
      if (dates.length) { const m = dates[0].match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/); return fmt(m[1], m[2], m[3], m[4], m[5]); }
    }
  } catch (e) { /* on passe au nom du média */ }
  const m = String(media || "").match(/_(20\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_/);
  return m ? fmt(m[1], m[2], m[3], m[4], m[5]) : "";
}
const legende = (base, p) => base + (p && p.horodatage ? " · photo prise le " + p.horodatage : "");

// Une ligne de rapport (donnees.lignes[i]) -> logement lisible
function lireLigne(l, i) {
  const champs = l.champs || [];
  return {
    ordre: i + 1,
    nom: String(l.titre || "").trim(),
    numero: champ(champs, /logement|lgmt/i),
    etage: champ(champs, /^etage/i),
    statut: statutNormal(champ(champs, /^statut/i)),
    niveau: champ(champs, /niveau/i),
    observation: champ(champs, /observation/i),
    motifRefus: champ(champs, /^motif(?!.*access)/i),
    motifInaccessible: champ(champs, /^motif.*access/i),
    photos: (l.photos || []).filter(p => p && p.url).map(p => ({ ...p })),
    signature: l.signature && l.signature.url ? { ...l.signature } : null,
  };
}

// Résultat final d'un logement après les deux passages
// Absents et non accessibles au 1er passage sont repris au 2nd (21/11) ; refus jamais.
function resultat(l) {
  const s1 = l.p1 ? l.p1.statut : "", s2 = l.p2 ? l.p2.statut : "";
  const nonTraite = { absent: "Absent", inaccessible: "Non accessible" };
  if (s1 === "present") return { cle: "traite1", texte: "Traité au 1er passage", couleur: M.VERT, traite: true };
  if (s1 === "refus") return { cle: "refus", texte: "Refus", couleur: ROUGE };
  if (s2 === "present") return { cle: "traite2", texte: "Traité au 2nd passage", couleur: M.VERT, traite: true };
  if (s2 === "refus") return { cle: "refus", texte: "Refus au 2nd passage", couleur: ROUGE };
  if (nonTraite[s2]) return { cle: s2, texte: nonTraite[s2] + (s1 === s2 ? " aux deux passages" : " au 2nd passage"), couleur: ORANGE };
  if (nonTraite[s1]) return { cle: s1, texte: nonTraite[s1] + (l.p2 === undefined ? " (pas de 2nd passage)" : ""), couleur: ORANGE };
  return { cle: "inconnu", texte: "Non renseigné", couleur: M.GRIS };
}

// Fusion des deux passages, logement par logement (clé : n° de logement, à défaut le nom)
function fusionner(r1, r2) {
  const cle = (x) => (x.numero || "").toLowerCase() || ("nom:" + x.nom.toLowerCase());
  const logements = [];
  const index = new Map();
  ((r1 && r1.lignes) || []).forEach((l, i) => { const x = lireLigne(l, i); const lg = { numero: x.numero, etage: x.etage, nom: x.nom, p1: x }; logements.push(lg); index.set(cle(x), lg); });
  ((r2 && r2.lignes) || []).forEach((l, i) => {
    const x = lireLigne(l, i);
    const lg = index.get(cle(x));
    if (lg) { lg.p2 = x; if (!lg.etage) lg.etage = x.etage; if (!lg.nom) lg.nom = x.nom; }
    else { const n = { numero: x.numero, etage: x.etage, nom: x.nom, p2: x }; logements.push(n); index.set(cle(x), n); }
  });
  // Pas de 2nd passage du tout (aucun absent) : on le note pour le libellé
  if (!r2) logements.forEach(lg => { lg.p2 = undefined; });
  const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? Infinity : n; };
  logements.sort((a, b) => num(a.numero) - num(b.numero) || String(a.numero).localeCompare(String(b.numero)));
  logements.forEach(lg => {
    lg.resultat = resultat(lg);
    // Niveau retenu : celui du passage où le logement a été traité (à défaut, le dernier renseigné)
    const traitant = lg.resultat.cle === "traite2" ? lg.p2 : lg.resultat.cle === "traite1" ? lg.p1 : null;
    lg.niveau = (traitant && traitant.niveau) || (lg.p2 && lg.p2.niveau) || (lg.p1 && lg.p1.niveau) || "";
    // Observations des deux passages, sans doublon
    lg.observation = [...new Set([lg.p1 && lg.p1.observation, lg.p2 && lg.p2.observation].map(o => String(o || "").trim()).filter(Boolean))].join(" / ");
  });
  return logements;
}

function synthese(logements) {
  const n = logements.length;
  const c = (k) => logements.filter(l => l.resultat.cle === k).length;
  const traites = logements.filter(l => l.resultat.traite).length;
  const niv = (re) => logements.filter(l => re.test(l.niveau || "")).length;
  return { logements: n, surinfestes: niv(/surinf/i), moyens: niv(/moyen/i), traites, traites1: c("traite1"), traites2: c("traite2"), absents: c("absent"), inaccessibles: c("inaccessible"), refus: c("refus"), taux: n ? Math.round((traites / n) * 100) : 0 };
}

// ── Mise en page ──────────────────────────────────────────────────
const trait = (epaisseur, couleur, marge) => ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: epaisseur, lineColor: couleur }], margin: marge });

function tuiles(s) {
  const tuile = (valeur, libelle, couleur) => ({
    stack: [{ text: String(valeur), fontSize: 18, bold: true, color: couleur || M.ENCRE }, { text: libelle, style: "cleChamp", margin: [0, 2, 0, 0] }],
    margin: [10, 8, 10, 8],
  });
  return {
    table: { widths: ["*", "*", "*", "*", "*"], body: [[
      tuile(s.traites + " / " + s.logements, "traités · " + s.taux + " %", M.VERT),
      tuile(s.traites2, "traités au 2nd passage"),
      tuile(s.absents, "absents non traités", s.absents ? ORANGE : null),
      tuile(s.inaccessibles, "non accessibles", s.inaccessibles ? ORANGE : null),
      tuile(s.refus, "refus", s.refus ? ROUGE : null),
    ]] },
    layout: { hLineWidth: () => 0, vLineWidth: (i) => (i > 0 && i < 5 ? 0.6 : 0), vLineColor: () => M.TRAIT, fillColor: () => "#F4F7F9", paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [0, 4, 0, 0],
  };
}

function pointsAttention(logements) {
  const rang = (n) => /surinf/i.test(n) ? 0 : /moyen/i.test(n) ? 1 : 9;
  const liste = logements.filter(l => rang(l.niveau) < 9).sort((a, b) => rang(a.niveau) - rang(b.niveau));
  const sy = synthese(logements);
  const tete = { text: `Niveau d'infestation : ${sy.surinfestes} logement${sy.surinfestes > 1 ? "s" : ""} en surinfestation, ${sy.moyens} en infestation moyenne`, style: "sousTitre", fontSize: 10, margin: [0, 14, 0, 6] };
  if (!liste.length) return [tete, { text: "Aucun logement en surinfestation ni en infestation moyenne.", style: "valChamp", color: M.GRIS }];
  return [tete, {
    table: { headerRows: 1, widths: [34, 30, 90, 70, "*"], body: [
      ["N°", "Étage", "Locataire", "Niveau", "Observation"].map(t => ({ text: t, style: "cleChamp", bold: true })),
      ...liste.map(l => [
        { text: l.numero || M.VIDE, bold: true }, { text: l.etage !== "" ? l.etage : M.VIDE }, { text: l.nom || M.VIDE },
        { text: l.niveau, bold: true, color: /surinf/i.test(l.niveau) ? ROUGE : ORANGE },
        { text: l.observation || M.VIDE, color: l.observation ? M.ENCRE : M.GRIS },
      ]),
    ] },
    layout: { hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === 1 ? 1 : 0.5), vLineWidth: () => 0, hLineColor: (i) => (i === 1 ? M.VERT : M.TRAIT),
      paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 4, paddingRight: () => 4 },
    fontSize: 8.5,
  }];
}

function tableauRecap(logements, pages, aP2) {
  const entete = ["N°", "Étage", "Locataire", "1er passage", ...(aP2 ? ["2nd passage"] : []), "Résultat", "Infestation", "Page"]
    .map(t => ({ text: t, style: "cleChamp", bold: true }));
  const corps = logements.map((l, i) => [
    { text: l.numero || M.VIDE, bold: true },
    { text: l.etage !== "" ? l.etage : M.VIDE },
    { text: l.nom || M.VIDE },
    { text: l.p1 ? LIB_STATUT[l.p1.statut] : M.VIDE },
    ...(aP2 ? [{ text: l.p2 ? LIB_STATUT[l.p2.statut] : "—", color: l.p2 ? M.ENCRE : M.GRIS }] : []),
    { text: l.resultat.texte, color: l.resultat.couleur, bold: true },
    { text: l.niveau || M.VIDE, color: /surinf/i.test(l.niveau) ? ROUGE : /moyen/i.test(l.niveau) ? ORANGE : M.ENCRE, bold: /surinf|moyen/i.test(l.niveau) },
    { text: pages[i] ? String(pages[i]) : "", alignment: "right", color: M.GRIS },
  ]);
  return {
    table: { headerRows: 1, widths: [30, 30, "*", 64, ...(aP2 ? [64] : []), 96, 58, 26], body: [entete, ...corps] },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === 1 ? 1 : 0.5),
      vLineWidth: () => 0, hLineColor: (i) => (i === 1 ? M.VERT : M.TRAIT),
      fillColor: (i) => (i > 0 && i % 2 === 0 ? "#FAFBFC" : null),
      paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 4, paddingRight: () => 4,
    },
    fontSize: 8.5,
  };
}

function colonnePassage(titre, x, infos) {
  if (x === undefined) return { stack: [{ text: titre, style: "sousTitre", margin: [0, 0, 0, 6] }, { text: "Pas de 2nd passage pour ce logement.", style: "valChamp", color: M.GRIS, italics: true }] };
  if (!x) return { stack: [{ text: titre, style: "sousTitre", margin: [0, 0, 0, 6] }, { text: "Non concerné : logement traité ou refusé au 1er passage.", style: "valChamp", color: M.GRIS, italics: true }] };
  const ligne = (cle, val, couleur) => ({ stack: [{ text: cle, style: "cleChamp" }, { text: val || M.VIDE, style: "valChamp", color: couleur || M.ENCRE }], margin: [0, 0, 0, 7] });
  const couleur = COULEUR_STATUT(x.statut);
  return {
    stack: [
      { text: titre, style: "sousTitre", margin: [0, 0, 0, 2] },
      { text: infos || "", style: "legende", margin: [0, 0, 0, 8] },
      ligne("Statut", LIB_STATUT[x.statut], couleur),
      ligne("Niveau d'infestation", x.niveau),
      ...(x.statut === "refus" || x.motifRefus ? [ligne("Motif du refus", x.motifRefus)] : []),
      ...(x.statut === "inaccessible" || x.motifInaccessible ? [ligne("Motif de non-accessibilité", x.motifInaccessible)] : []),
      ligne("Observation", x.observation),
      ...(x.signature ? [{ text: "Signature du locataire", style: "cleChamp" },
        x.signature.dataUri ? { image: x.signature.dataUri, fit: [170, 70], margin: [0, 3, 0, 0] } : { text: "Signature non récupérée", style: "valChamp", italics: true, color: M.GRIS }] : []),
    ],
  };
}

function pageLogement(l, i, passages) {
  // Pas de nom de technicien dans le rapport (21/11)
  const [i1, i2] = passages.map(p => p ? (p.date || "") : "");
  const photos = [
    ...(l.p1 ? l.p1.photos.map(p => ({ ...p, titre: legende("1er passage", p) })) : []),
    ...(l.p2 ? l.p2.photos.map(p => ({ ...p, titre: legende("2nd passage", p) })) : []),
  ];
  return [
    // Saut de page séparé du titre : pdfmake ne signale pas la page d'un bloc qui porte lui-même le saut
    { text: "", pageBreak: "after" },
    { text: "Logement n° " + (l.numero || M.VIDE) + (l.etage !== "" ? "  ·  étage " + l.etage : ""), style: "titreChambre", fontSize: 14, id: "logement-" + i, margin: [0, 0, 0, 2] },
    { columns: [{ text: l.nom || "Locataire non renseigné", fontSize: 10.5, color: M.GRIS }, { text: l.resultat.texte, bold: true, color: l.resultat.couleur, alignment: "right", fontSize: 10.5 }] },
    trait(1, M.VERT, [0, 6, 0, 14]),
    { columns: [colonnePassage("1er passage", l.p1 || null, i1), colonnePassage("2nd passage", l.p2, i2)], columnGap: 24 },
    ...(photos.length ? M.blocPhotos(photos) : [{ text: "Aucune photo pour ce logement.", style: "legende", margin: [0, 12, 0, 0] }]),
  ];
}

function document(info, logements, pages, logoDataUri) {
  const s = synthese(logements);
  const aP2 = !!info.passages[1];
  const entete = [
    { libelle: "Client", valeur: info.client },
    { libelle: "N° BC / référence", valeur: info.bc },
    { libelle: "Adresse", valeur: info.adresse },
    { libelle: "Intervention", valeur: info.nature || "" },
    ...(info.affichage ? [{ libelle: "Pose des affiches", valeur: info.affichage.date || "" }] : []),
    { libelle: "1er passage", valeur: (info.passages[0] && info.passages[0].date) || "" },
    { libelle: "2nd passage", valeur: aP2 ? info.passages[1].date : "Non nécessaire (aucun logement à repasser)" },
  ];
  const doc = M.construireDocument({ entete, chambres: [], signature: null }, logoDataUri);
  const pc = info.partiesCommunes || [];
  doc.content.push(
    // Page 1 (21/11) : synthèse, cas importants, puis résultat par logement juste en dessous
    { text: "Synthèse", style: "titreChambre", margin: [0, 18, 0, 2] }, trait(1, M.VERT, [0, 0, 0, 8]),
    tuiles(s),
    ...pointsAttention(logements),
    { text: "Résultat par logement", style: "titreChambre", margin: [0, 18, 0, 2] }, trait(1, M.VERT, [0, 0, 0, 6]),
    tableauRecap(logements, pages, aP2),
    { text: "Le détail de chaque logement, avec ses photos, figure sur une page dédiée (colonne « Page »).", style: "legende", margin: [0, 6, 0, 0] },
    // Page « Affichage » (21/11) : date et heure de pose, observation, photos horodatées
    ...(info.affichage ? [
      { text: "", pageBreak: "after" },
      { text: "Pose des affiches", style: "titreChambre", fontSize: 14, margin: [0, 0, 0, 2] }, trait(1, M.VERT, [0, 0, 0, 8]),
      M.blocChamps([{ titre: "Affiches posées le", valeur: info.affichage.date || "" }, { titre: "Observation", valeur: info.affichage.observation || "" }]),
      ...((info.photosAffichage || []).length ? M.blocPhotos(info.photosAffichage) : [{ text: "Aucune photo de la pose.", style: "legende", margin: [0, 10, 0, 0] }]),
    ] : []),
    // Puis une page pour les parties communes
    ...(pc.length || (info.photosPartiesCommunes || []).length ? [
      { text: "", pageBreak: "after" },
      { text: "Parties communes", style: "titreChambre", fontSize: 14, margin: [0, 0, 0, 2] }, trait(1, M.VERT, [0, 0, 0, 8]),
      M.blocChamps(pc.map(c => ({ titre: c.libelle, valeur: c.valeur }))),
      ...(info.photosPartiesCommunes && info.photosPartiesCommunes.length ? M.blocPhotos(info.photosPartiesCommunes) : []),
    ] : []),
    ...logements.flatMap((l, i) => pageLogement(l, i, info.passages)),
  );
  return doc;
}

async function rendre(definition) {
  const printer = new PdfPrinter(M.POLICES);
  const pagesVues = {};
  // pdfmake donne la page réelle de chaque bloc identifié : c'est elle qui sert d'index par logement
  definition.pageBreakBefore = (noeud) => { if (noeud.id && noeud.id.startsWith("logement-") && noeud.startPosition) pagesVues[noeud.id] = noeud.startPosition.pageNumber; return false; };
  const kit = printer.createPdfKitDocument(definition);
  const pdf = await new Promise((resolve, reject) => {
    const morceaux = [];
    kit.on("data", d => morceaux.push(d)); kit.on("end", () => resolve(Buffer.concat(morceaux))); kit.on("error", reject);
    kit.end();
  });
  return { pdf, pagesVues };
}

/**
 * @param {object} info  { client, bc, adresse, passages: [{date, technicien, rapport}, {…}|null] }
 *                       rapport = donnees d'un reception-rapports (lignes, entete, photos)
 * @param {(url:string)=>Promise<Buffer>} chargerImage
 * @returns {Promise<{pdf: Buffer, pagesLogements: object[], synthese: object, photosManquantes: number}>}
 */
async function genererConsolide(info, chargerImage) {
  const r1 = info.passages[0] && info.passages[0].rapport;
  const r2 = info.passages[1] && info.passages[1].rapport;
  const logements = fusionner(r1, r2);

  // Parties communes : champs de l'en-tête des deux émargements (hors date, n° de passage, adresse)
  const pc = [];
  [[r1, "1er passage"], [r2, "2nd passage"]].forEach(([r, lib]) => {
    ((r && r.entete) || []).filter(c => /partie|commun/i.test((c.cle || "") + " " + (c.libelle || ""))).forEach(c => pc.push({ libelle: c.libelle.replace(/\s*:\s*$/, "") + " (" + lib + ")", valeur: c.valeur }));
  });
  const photosPC = [[r1, "1er passage"], [r2, "2nd passage"]].flatMap(([r, lib]) => ((r && r.photos) || []).filter(p => p && p.url).map(p => ({ ...p, passageLib: lib })));

  // Images chargées avant la mise en page (pdfmake ne sait pas attendre)
  let photosManquantes = 0;
  const charger = async (p, signature) => {
    try { let buf = await chargerImage(p.url); if (!signature) p.horodatage = horodatagePhoto(buf, p.media); if (signature) buf = await recadrerSignature(buf); p.dataUri = `data:${buf[0] === 0x89 ? "image/png" : "image/jpeg"};base64,` + buf.toString("base64"); }
    catch (e) { p.erreur = e.message; photosManquantes++; }
  };
  for (const p of photosPC) { await charger(p); p.titre = legende("Parties communes · " + p.passageLib, p); }
  const photosAff = ((info.affichage && info.affichage.rapport && info.affichage.rapport.photos) || []).filter(p => p && p.url).map(p => ({ ...p }));
  for (const p of photosAff) { await charger(p); p.titre = legende("Affiches posées", p); }
  for (const l of logements) for (const x of [l.p1, l.p2]) if (x) { for (const p of x.photos) await charger(p); if (x.signature) await charger(x.signature, true); }

  let logo = null;
  try { logo = "data:image/png;base64," + fs.readFileSync(M.LOGO).toString("base64"); } catch (e) { /* en-tête en texte */ }
  const infoDoc = { ...info, partiesCommunes: pc, photosPartiesCommunes: photosPC, photosAffichage: photosAff };

  // 1re passe pour connaître la page de chaque logement, 2de passe pour l'écrire dans le tableau
  // (colonne de largeur fixe : la mise en page ne bouge pas entre les deux passes)
  const p1 = await rendre(document(infoDoc, logements, [], logo));
  const pages = logements.map((l, i) => p1.pagesVues["logement-" + i] || null);
  const p2 = await rendre(document(infoDoc, logements, pages, logo));
  const pagesFinales = logements.map((l, i) => p2.pagesVues["logement-" + i] || pages[i] || null);

  return {
    pdf: p2.pdf,
    pagesLogements: logements.map((l, i) => ({ numero: l.numero, etage: l.etage, nom: l.nom, resultat: l.resultat.texte, page: pagesFinales[i] })),
    synthese: synthese(logements),
    photosManquantes,
  };
}

module.exports = { genererConsolide, fusionner, synthese, recadrerSignature };
