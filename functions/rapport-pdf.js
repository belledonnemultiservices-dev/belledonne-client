// Reconstruction d'un rapport Kizeo en PDF structuré.
//
// Entrée : le buffer de l'export Excel de Kizeo, tel que reçu par
// receiveKizeoSubmission. Sortie : un buffer PDF avec l'en-tête du rapport puis
// une section par ligne du tableau (une chambre), photos comprises.
//
// Activé par formulaire, via la case "Reconstruire le rapport en PDF" de
// kizeo-config.html (champ `reconstruirePdf` du document kizeo-forms).
//
// Le fichier Kizeo est structuré ainsi :
//   A1            "Rapport"
//   A2 → "Tableau"  étiquette en A, valeur en B (libellé, adresse, produits...)
//   ligne "Tableau" + 1   les en-têtes de colonnes
//   lignes suivantes      une ligne par chambre
// Les colonnes image ne portent pas l'image mais un lien vers Kizeo.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PdfPrinter = require("pdfmake");

const VERT = "#1DA870";
const ENCRE = "#0D1B2A";
const GRIS = "#6B7C8F";
const TRAIT = "#D9E1E8";
const VIDE = "/";                 // valeur absente : le champ reste visible
const PHOTOS_PAR_LIGNE = 2;
const TAILLE_PHOTO = [245, 210];
const LONGUEUR_CHOIX_MAX = 45;
const LOGO = path.join(__dirname, "logo.png");

// pdfmake ne livre pas les .ttf sur disque : les Roboto sont dans son vfs, en
// base64, et PdfPrinter accepte des Buffers.
const VFS = (() => { const m = require("pdfmake/build/vfs_fonts.js"); return m.pdfMake ? m.pdfMake.vfs : m; })();
const ttf = (nom) => Buffer.from(VFS[nom], "base64");
const POLICES = {
  Roboto: {
    normal: ttf("Roboto-Regular.ttf"),
    bold: ttf("Roboto-Medium.ttf"),
    italics: ttf("Roboto-Italic.ttf"),
    bolditalics: ttf("Roboto-MediumItalic.ttf"),
  },
};

// Étiquettes lisibles : le fichier porte les identifiants techniques du
// formulaire Kizeo. Un identifiant inconnu est affiché tel quel.
const LIBELLES_ENTETE = {
  libelle: "Libellé",
  ref_interne: "Référence interne",
  type_de_traitement_: "Type de traitement",
  type_d_intervention_: "Type d'intervention",
  adresse: "Adresse",
  date_heure_: "Date et heure",
  n_bc_reference_: "N° BC / référence",
  produits_: "Produits utilisés",
  passage_numero_: "N° de passage",
  nom_locataire_representant_: "Nom locataire / représentant",
  type_de_logement_partie_commu: "Type de logement / partie commune",
};

function valeurCellule(cell) {
  const v = cell ? cell.value : null;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toLocaleString("fr-FR");
  if (typeof v === "object") {
    if (v.text !== undefined) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("").trim();
    if (v.result !== undefined) return String(v.result).trim();
  }
  return String(v).trim();
}

function lienCellule(cell) {
  const v = cell ? cell.value : null;
  return v && typeof v === "object" && v.hyperlink ? v.hyperlink : null;
}

// Colonnes photo du modèle : image1, image 2, Image 4... Le test porte sur le
// mot, pas sur la casse ni l'espace, pour rester tolérant aux renommages.
function estColonneImage(titre) {
  return /^image/i.test((titre || "").replace(/\s+/g, ""));
}

async function lireRapport(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("classeur vide");

  const entete = [];
  let signature = null;
  let ligneTableau = null;
  for (let r = 2; r <= ws.rowCount; r++) {
    const a = valeurCellule(ws.getRow(r).getCell("A"));
    if (a.toLowerCase() === "tableau") { ligneTableau = r; break; }
    if (!a) continue;
    const cellB = ws.getRow(r).getCell("B");
    const valeur = valeurCellule(cellB);
    const lien = lienCellule(cellB);
    if (/signature/i.test(a)) { signature = { libelle: a, valeur, lien }; continue; }
    entete.push({ cle: a, libelle: LIBELLES_ENTETE[a] || a, valeur });
  }
  if (!ligneTableau) throw new Error("ligne \"Tableau\" introuvable, le fichier ne suit pas le modèle attendu");

  const ligneTitres = ligneTableau + 1;
  const colonnes = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const titre = valeurCellule(ws.getRow(ligneTitres).getCell(c));
    if (titre) colonnes.push({ index: c, titre });
  }
  const colImages = colonnes.filter(c => estColonneImage(c.titre));
  const colChamps = colonnes.filter(c => !estColonneImage(c.titre));

  const chambres = [];
  for (let r = ligneTitres + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const champs = colChamps.map(c => ({ titre: c.titre, valeur: valeurCellule(row.getCell(c.index)) }));
    const images = colImages
      .map(c => ({ titre: c.titre, url: lienCellule(row.getCell(c.index)) }))
      .filter(i => i.url);
    if (!champs.some(f => f.valeur) && !images.length) continue; // ligne réservée, vide
    chambres.push({
      numero: champs[0] ? champs[0].valeur : "",
      champs: champs.slice(1),
      images,
    });
  }
  if (!chambres.length) throw new Error("aucune ligne remplie dans le tableau");

  return { entete, signature, chambres };
}

// Kizeo colle les choix multiples avec ", ". Le piège : certains libellés de
// choix contiennent eux-mêmes des virgules (les recommandations sont des
// phrases entières). On ne passe donc en puces que si tous les morceaux sont
// courts ET commencent par une majuscule ou un chiffre, signe d'une vraie liste
// de choix. Sans ces deux garde-fous, "Non, pas à ce stade" se retrouvait coupé
// en deux puces et les recommandations étaient hachées.
function enPuces(val) {
  if (!val.includes(",")) return null;
  const parts = val.split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.some(p => p.length > LONGUEUR_CHOIX_MAX)) return null;
  if (parts.some(p => !/^[A-ZÀ-ÖØ-Þ0-9]/.test(p))) return null;
  return parts;
}

// Une photo qui ne répond pas ne fait pas échouer le rapport : elle est
// signalée à sa place dans le PDF.
async function telechargerImage(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const resp = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const type = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!/^image\//.test(type)) throw new Error("type inattendu : " + type);
    const buf = Buffer.from(await resp.arrayBuffer());
    return "data:" + type + ";base64," + buf.toString("base64");
  } finally { clearTimeout(t); }
}

function blocEntete(entete, logoDataUri) {
  const lignes = entete.map(e => [
    { text: e.libelle, style: "cleEntete" },
    { text: e.valeur || VIDE, style: "valEntete" },
  ]);
  return [
    logoDataUri
      ? { image: logoDataUri, width: 190, alignment: "center", margin: [0, 0, 0, 14] }
      : { text: "BELLEDONNE MULTISERVICES", style: "titre", alignment: "center", margin: [0, 0, 0, 14] },
    { text: "Rapport d'intervention", style: "titre", alignment: "center" },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: VERT }], margin: [0, 8, 0, 14] },
    {
      table: { widths: [150, "*"], body: lignes },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.6),
        vLineWidth: () => 0,
        hLineColor: () => TRAIT,
        paddingTop: () => 6, paddingBottom: () => 6, paddingLeft: () => 0, paddingRight: () => 0,
      },
    },
  ];
}

function blocChamps(champs) {
  const cellule = (f) => {
    const val = (f.valeur || "").trim();
    const puces = enPuces(val);
    return {
      stack: [
        { text: f.titre.replace(/\s*:\s*$/, ""), style: "cleChamp" },
        puces
          ? { ul: puces, style: "valChamp", margin: [0, 2, 0, 0] }
          : { text: val || VIDE, style: "valChamp" },
      ],
      margin: [0, 0, 0, 7],
    };
  };
  const body = [];
  for (let i = 0; i < champs.length; i += 2) {
    body.push([cellule(champs[i]), champs[i + 1] ? cellule(champs[i + 1]) : {}]);
  }
  return {
    table: { widths: ["*", "*"], body },
    layout: {
      hLineWidth: () => 0, vLineWidth: () => 0,
      paddingTop: () => 0, paddingBottom: () => 0,
      paddingLeft: (i) => (i === 0 ? 0 : 12), paddingRight: (i) => (i === 0 ? 12 : 0),
    },
  };
}

function blocPhotos(images) {
  if (!images.length) return [];
  const cases = images.map(img =>
    img.dataUri
      ? { stack: [{ image: img.dataUri, fit: TAILLE_PHOTO, alignment: "center" }, { text: img.titre, style: "legende", alignment: "center" }], margin: [0, 0, 0, 10] }
      : { stack: [{ text: "Photo non récupérée", style: "valChamp", italics: true }, { text: img.titre + (img.erreur ? " — " + img.erreur : ""), style: "legende" }], margin: [0, 0, 0, 10] }
  );
  const body = [];
  for (let i = 0; i < cases.length; i += PHOTOS_PAR_LIGNE) {
    const ligne = cases.slice(i, i + PHOTOS_PAR_LIGNE);
    while (ligne.length < PHOTOS_PAR_LIGNE) ligne.push({});
    body.push(ligne);
  }
  const layout = {
    hLineWidth: () => 0, vLineWidth: () => 0,
    paddingTop: () => 0, paddingBottom: () => 0,
    paddingLeft: (i) => (i === 0 ? 0 : 6), paddingRight: (i, node) => (i === node.table.widths.length - 1 ? 0 : 6),
  };
  const grille = (lignes) => ({ table: { widths: Array(PHOTOS_PAR_LIGNE).fill("*"), body: lignes }, layout });
  // Le titre "Photos" reste collé à la première rangée, sinon il se retrouve
  // seul en bas de page quand les photos basculent sur la suivante.
  return [
    { stack: [{ text: "Photos", style: "sousTitre", margin: [0, 6, 0, 6] }, grille(body.slice(0, 1))], unbreakable: true },
    ...(body.length > 1 ? [grille(body.slice(1))] : []),
  ];
}

// Une chambre par page, sauf la première qui enchaîne sous l'en-tête.
function blocChambre(ch, premiere) {
  return [
    {
      text: "Chambre " + (ch.numero || VIDE),
      style: "titreChambre",
      pageBreak: premiere ? undefined : "before",
      margin: [0, premiere ? 22 : 0, 0, 2],
    },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: VERT }], margin: [0, 0, 0, 12] },
    blocChamps(ch.champs),
    ...blocPhotos(ch.images),
  ];
}

function construireDocument(data, logoDataUri) {
  const contenu = [
    ...blocEntete(data.entete, logoDataUri),
    ...data.chambres.flatMap((ch, i) => blocChambre(ch, i === 0)),
  ];
  if (data.signature) {
    contenu.push({ text: "Signature du technicien", style: "sousTitre", margin: [0, 18, 0, 8] });
    contenu.push(
      data.signature.dataUri
        ? { image: data.signature.dataUri, fit: [200, 90] }
        : { text: "Signature non récupérée" + (data.signature.erreur ? " — " + data.signature.erreur : ""), style: "valChamp", italics: true }
    );
  }
  return {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: "Roboto", fontSize: 9.5, color: ENCRE },
    styles: {
      titre: { fontSize: 17, bold: true, color: ENCRE },
      titreChambre: { fontSize: 14, bold: true, color: VERT },
      sousTitre: { fontSize: 11, bold: true, color: ENCRE },
      cleEntete: { fontSize: 9, color: GRIS },
      valEntete: { fontSize: 10, bold: true },
      cleChamp: { fontSize: 8, color: GRIS, characterSpacing: 0.3 },
      valChamp: { fontSize: 9.5 },
      legende: { fontSize: 7.5, color: GRIS, margin: [0, 3, 0, 0] },
    },
    footer: (page, total) => ({
      columns: [
        { text: "Belledonne Multiservices", fontSize: 7.5, color: GRIS, margin: [40, 0, 0, 0] },
        { text: page + " / " + total, fontSize: 7.5, color: GRIS, alignment: "right", margin: [0, 0, 40, 0] },
      ],
      margin: [0, 12, 0, 0],
    }),
    content: contenu,
  };
}

/**
 * Transforme l'export Excel Kizeo en PDF.
 * Lève une erreur si le fichier ne suit pas le modèle attendu : l'appelant
 * retombe alors sur l'Excel, pour ne jamais perdre un rapport.
 * @param {Buffer} excelBuffer
 * @returns {Promise<{pdf: Buffer, nbChambres: number, photosManquantes: number}>}
 */
async function reconstruireEnPdf(excelBuffer) {
  const data = await lireRapport(excelBuffer);

  let logoDataUri = null;
  try { logoDataUri = "data:image/png;base64," + fs.readFileSync(LOGO).toString("base64"); }
  catch (e) { console.warn("rapport-pdf: logo introuvable, en-tête en texte"); }

  // Photos téléchargées en amont : pdfmake ne sait pas attendre.
  let photosManquantes = 0;
  for (const ch of data.chambres) {
    for (const img of ch.images) {
      try { img.dataUri = await telechargerImage(img.url); }
      catch (e) { img.erreur = e.message; photosManquantes++; }
    }
  }
  if (data.signature && data.signature.lien) {
    try { data.signature.dataUri = await telechargerImage(data.signature.lien); }
    catch (e) { data.signature.erreur = e.message; }
  }

  const printer = new PdfPrinter(POLICES);
  const doc = printer.createPdfKitDocument(construireDocument(data, logoDataUri));
  const pdf = await new Promise((resolve, reject) => {
    const morceaux = [];
    doc.on("data", d => morceaux.push(d));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.end();
  });

  return { pdf, nbChambres: data.chambres.length, photosManquantes };
}

module.exports = { reconstruireEnPdf };
