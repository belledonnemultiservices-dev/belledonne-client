// ══════════════════════════════════════════════════════════════════
// PDF D'UN RAPPORT À PARTIR DES DONNÉES RELUES
//
// Prend la structure produite par rapport-donnees.js (et corrigée par
// l'écran de relecture) et la rend avec la maquette déjà en service pour
// les CCAS : même en-tête, même grille à deux colonnes, mêmes planches
// photos. Les blocs viennent de rapport-pdf.js, il n'y a donc qu'une seule
// maquette à faire évoluer pour tous les clients.
//
// Deux formes de rapport, un seul rendu :
//   - avec chambres (CCAS) : une chambre par page, comme aujourd'hui
//   - sans chambres (ACTIS, AIH, SEM4V) : les champs d'identification en
//     en-tête, puis le reste groupé par section du formulaire
//
// Les photos ne sont plus des liens Kizeo mais des fichiers déposés dans
// notre Storage à la réception : elles restent lisibles quel que soit le
// délai entre la réception et la validation.
// ══════════════════════════════════════════════════════════════════

const M = require("./rapport-pdf");
const PdfPrinter = require("pdfmake");

// Un champ sans valeur n'est pas affiché dans le corps : sur un formulaire
// de 24 champs dont la moitié est facultative, les laisser remplirait le
// rapport de tirets. Les champs d'identification, eux, restent toujours
// visibles (une adresse manquante doit se voir).
const vide = (v) => !String(v == null ? "" : v).trim() || String(v).trim() === M.VIDE;

// Les sections du formulaire Kizeo donnent le découpage naturel du rapport.
// `apres` est le nombre de champs déjà rencontrés quand la section s'ouvre,
// ce qui suffit à répartir les champs sans deviner.
function grouperParSection(champs, sections) {
  if (!sections || !sections.length) return [{ titre: null, champs }];
  const bornes = sections
    .map(s => ({ titre: s.libelle, debut: s.apres }))
    .sort((a, b) => a.debut - b.debut);
  const groupes = [];
  // Ce qui précède la première section (rarement rempli, mais à ne pas perdre).
  if (bornes[0].debut > 0) groupes.push({ titre: null, champs: champs.slice(0, bornes[0].debut) });
  bornes.forEach((b, i) => {
    const fin = i + 1 < bornes.length ? bornes[i + 1].debut : champs.length;
    groupes.push({ titre: b.titre, champs: champs.slice(b.debut, fin) });
  });
  return groupes;
}

// Les champs d'identification : ceux du premier groupe, c'est-à-dire avant
// la deuxième section du formulaire. Sur un rapport ACTIS ce sont bien
// l'adresse, la date, le n° de BC, le locataire, le type de logement.
function decouper(rapport) {
  const groupes = grouperParSection(rapport.entete, rapport.sections);
  const identification = groupes.length ? groupes[0].champs : rapport.entete;
  const corps = groupes.slice(1).filter(g => g.champs.some(c => !vide(c.valeur)));
  return { identification, corps };
}

// Conversion vers le vocabulaire des blocs existants, qui parlent de
// `titre`/`valeur` et de `dataUri`.
const sansDeuxPoints = (t) => String(t || "").replace(/\s*:\s*$/, "").trim().toLowerCase();

// Un champ qui porte le nom de sa section ("Recommandations" sous le titre
// « Recommandations ») afficherait deux fois la même chose : on efface alors
// son libellé et on ne garde que la valeur.
const versChamps = (champs, titreSection) => champs
  .filter(c => !vide(c.valeur))
  .map(c => ({
    titre: sansDeuxPoints(c.libelle) === sansDeuxPoints(titreSection) ? "" : c.libelle,
    valeur: c.valeur,
  }));

const versImages = (photos) => photos.map(p => ({
  titre: p.libelle,
  dataUri: p.dataUri || null,
  erreur: p.erreur || (p.dataUri ? null : "indisponible"),
}));

function construire(rapport, logoDataUri) {
  const entete = (rapport.entete || []);
  const lignes = (rapport.lignes || []);

  if (lignes.length) {
    // Rapport à chambres : la maquette CCAS convient telle quelle.
    const data = {
      entete: decouper(rapport).identification.map(c => ({ libelle: c.libelle, valeur: c.valeur })),
      chambres: lignes.map(l => ({
        numero: l.titre,
        champs: versChamps(l.champs),
        images: versImages(l.photos || []),
      })),
      signature: rapport.signature || null,
    };
    return M.construireDocument(data, logoDataUri);
  }

  // Rapport à logement unique : pas de chambre, donc le corps du document
  // est fait des sections du formulaire. On réutilise construireDocument
  // avec zéro chambre, puis on insère les sections avant la signature.
  const { identification, corps } = decouper(rapport);
  const doc = M.construireDocument(
    { entete: identification.map(c => ({ libelle: c.libelle, valeur: c.valeur })), chambres: [], signature: rapport.signature || null },
    logoDataUri
  );

  const sections = [];
  corps.forEach(g => {
    const champs = versChamps(g.champs, g.titre);
    if (!champs.length) return;
    if (g.titre) {
      sections.push({ text: g.titre.replace(/\s*:\s*$/, ""), style: "titreChambre", fontSize: 12, margin: [0, 16, 0, 2] });
      sections.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: M.VERT }], margin: [0, 0, 0, 10] });
    }
    sections.push(M.blocChamps(champs));
  });
  const photos = versImages(rapport.photos || []);
  if (photos.length) sections.push(...M.blocPhotos(photos));

  // La signature est le dernier bloc posé par construireDocument : on insère
  // le corps juste avant, pour qu'elle reste en fin de document.
  const nbSignature = rapport.signature ? 2 : 0;
  doc.content.splice(doc.content.length - nbSignature, 0, ...sections);
  return doc;
}

/**
 * Fabrique le PDF d'un rapport à partir de ses données relues.
 * @param {object} rapport  structure de rapport-donnees.js, photos portant une `url`
 * @param {(url:string)=>Promise<Buffer>} chargerImage  récupère une image par son URL
 * @returns {Promise<{pdf: Buffer, nbLignes: number, photosManquantes: number}>}
 */
async function genererPdf(rapportEntree, chargerImage) {
  const fs = require("fs");
  // Copie de travail : les images sont encodées en base64 pour pdfmake, ce
  // qui pèse plusieurs Mo. Les poser sur l'objet reçu le rendrait trop gros
  // pour être réenregistré (limite de 1 Mo par document Firestore).
  const rapport = JSON.parse(JSON.stringify(rapportEntree));
  let logoDataUri = null;
  try { logoDataUri = "data:image/png;base64," + fs.readFileSync(M.LOGO).toString("base64"); }
  catch (e) { console.warn("rapport-pdf-json: logo introuvable, en-tête en texte"); }

  // pdfmake ne sait pas attendre : toutes les images sont résolues avant.
  // Une photo manquante ne bloque pas le rapport, elle est signalée en place.
  let photosManquantes = 0;
  const charger = async (p) => {
    if (!p || !p.url) { p.erreur = "aucun fichier"; photosManquantes++; return; }
    try {
      const buf = await chargerImage(p.url);
      const type = /\.png(\?|$)/i.test(p.url) || (buf[0] === 0x89) ? "image/png" : "image/jpeg";
      p.dataUri = `data:${type};base64,` + buf.toString("base64");
    } catch (e) { p.erreur = e.message; photosManquantes++; }
  };

  for (const p of rapport.photos || []) await charger(p);
  for (const l of rapport.lignes || []) for (const p of l.photos || []) await charger(p);
  if (rapport.signature) await charger(rapport.signature);

  const printer = new PdfPrinter(M.POLICES);
  const kit = printer.createPdfKitDocument(construire(rapport, logoDataUri));
  const pdf = await new Promise((resolve, reject) => {
    const morceaux = [];
    kit.on("data", d => morceaux.push(d));
    kit.on("end", () => resolve(Buffer.concat(morceaux)));
    kit.on("error", reject);
    kit.end();
  });

  return { pdf, nbLignes: (rapport.lignes || []).length, photosManquantes };
}

module.exports = { genererPdf, construire, grouperParSection, decouper };
