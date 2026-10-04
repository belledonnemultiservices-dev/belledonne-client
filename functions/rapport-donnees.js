// ══════════════════════════════════════════════════════════════════
// LECTURE D'UN RAPPORT KIZEO DEPUIS LE JSON DE LA SOUMISSION
//
// Remplace la relecture du fichier Excel renvoyé par Kizeo. Le JSON est la
// source que Kizeo détient vraiment : plus de mise en page à reconnaître,
// donc plus de pièges de parsing (virgules dans les libellés, modèle qui ne
// commence pas à la même ligne). Le circuit campagnes lisait déjà le JSON
// pour ses données de reporting, c'est le même principe étendu aux rapports.
//
// Deux familles de formulaires, une seule structure en sortie :
//   - rapport à logement unique (ACTIS, AIH, SEM4V...) : des champs à plat
//   - rapport CCAS : les mêmes champs, répétés par chambre dans le subform
//     "tableau", chaque ligne ayant ses propres photos
// Un rapport sans subform sort avec `lignes: []`, un rapport CCAS avec une
// entrée par chambre. Les consommateurs (éditeur de relecture, générateur
// PDF) n'ont donc qu'un seul format à connaître.
//
// Les photos ne sont pas des liens mais des identifiants de média, à
// télécharger sur /forms/{formId}/data/{dataId}/medias/{media}. Ils ne sont
// pas résolus ici : `telechargerMedias` s'en charge séparément, pour que la
// lecture reste synchrone et testable sans réseau.
// ══════════════════════════════════════════════════════════════════

// Types Kizeo qui ne portent pas une valeur saisie : ils structurent le
// formulaire ou référencent un fichier, et sont traités à part.
const TYPES_PHOTO = new Set(["photo", "image", "drawing"]);
const TYPE_SIGNATURE = "signature";
const TYPE_SECTION = "section";
const TYPE_SUBFORM = "subform";

// Champs techniques posés par l'app au moment du push : ils n'ont rien à
// faire ni dans l'écran de relecture ni dans le PDF remis au client. Les
// clés varient d'un formulaire à l'autre (un « Rapport dératisation » porte
// `re_interne`, une coquille côté Kizeo), d'où la reconnaissance par motif
// plutôt que par liste fermée. L'appelant complète avec le mapping du
// formulaire, qui est la source de vérité.
const CLES_TECHNIQUES = new Set(["libelle", "separateur1"]);
const MOTIF_TECHNIQUE = /^re?f?_?interne$/i;

function estTechnique(cle, clesSupplementaires) {
  if (CLES_TECHNIQUES.has(cle)) return true;
  if (MOTIF_TECHNIQUE.test(String(cle).replace(/_/g, "_"))) return true;
  return clesSupplementaires ? clesSupplementaires.has(cle) : false;
}

// "T1:T1;T2:T2" ou "Blattes:Blattes" -> [{valeur, libelle}]. Le séparateur de
// paire est le PREMIER deux-points : un libellé peut lui-même en contenir
// ("Date / Heure :"), le découper naïvement les tronquerait.
function listeChoix(items) {
  if (!items) return [];
  return String(items)
    .split(/[;\n]/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const i = p.indexOf(":");
      if (i === -1) return { valeur: p, libelle: p };
      return { valeur: p.slice(0, i), libelle: p.slice(i + 1) || p.slice(0, i) };
    });
}

// Valeur d'un champ de soumission. Kizeo enveloppe tout dans { value, type },
// mais pas toujours : on accepte les deux formes.
function valeurBrute(champ) {
  if (champ === null || champ === undefined) return "";
  if (typeof champ === "object" && !Array.isArray(champ)) {
    return champ.value !== undefined ? champ.value : "";
  }
  return champ;
}

// Définition du formulaire : les libellés lisibles, les types et les choix
// vivent ici, pas dans la soumission (qui ne porte que les clés techniques).
// Retour : { champs: {cle: def}, colonnes: {cle: def}, nom }
function normaliserDefinition(formDef) {
  const f = (formDef && formDef.form) || formDef || {};
  const champs = f.fields || {};
  // Le tableau répétable est reconnu à son TYPE, pas à son nom : un nouveau
  // formulaire peut nommer le sien autrement que "tableau" sans que rien
  // n'ait à être touché ici.
  let colonnes = {}, cleSubform = null;
  for (const [cle, def] of Object.entries(champs)) {
    if (def && def.type === TYPE_SUBFORM && def.columns) { colonnes = def.columns; cleSubform = cle; break; }
  }
  return { nom: f.name || "", champs, colonnes, cleSubform };
}

function decrireChamp(cle, def, valeur) {
  const type = (def && def.type) || "text";
  return {
    cle,
    libelle: (def && def.caption) || cle,
    type,
    valeur: valeur === null || valeur === undefined ? "" : String(valeur),
    choix: listeChoix(def && def.items),
    multiple: !!(def && def.multiple),
  };
}

// Parcourt un jeu de champs (racine ou ligne de subform) et les range par
// nature : titres de section, valeurs éditables, photos, signature.
function trierChamps(valeurs, definitions, clesTechniques) {
  const resultat = { sections: [], champs: [], photos: [], signature: null };
  for (const [cle, def] of Object.entries(definitions)) {
    const type = (def && def.type) || "text";
    if (type === TYPE_SUBFORM) continue;           // traité à part
    if (estTechnique(cle, clesTechniques)) continue;

    const brute = valeurBrute(valeurs[cle]);

    if (type === TYPE_SECTION) {
      // Un titre de section n'a pas de valeur saisie : il ouvre un groupe et
      // sert de repère de position pour les champs qui suivent.
      resultat.sections.push({ cle, libelle: def.caption || cle, apres: resultat.champs.length });
      continue;
    }
    if (TYPES_PHOTO.has(type)) {
      const media = String(brute || "").trim();
      if (media) resultat.photos.push({ cle, libelle: def.caption || cle, media });
      continue;
    }
    if (type === TYPE_SIGNATURE) {
      const media = String(brute || "").trim();
      resultat.signature = media ? { cle, libelle: def.caption || cle, media } : null;
      continue;
    }
    resultat.champs.push(decrireChamp(cle, def, brute));
  }
  return resultat;
}

// Lecture complète d'une soumission.
//   submission : l'objet renvoyé par GET /forms/{formId}/data/{dataId}
//                (soit { data: {...} }, soit l'objet lui-même)
//   formDef    : GET /forms/{formId}
function lireSoumission(submission, formDef, mapping) {
  const s = (submission && submission.data) || submission || {};
  const valeurs = s.fields || {};
  const def = normaliserDefinition(formDef);

  // Le mapping du formulaire dit quel champ porte la référence interne :
  // plus fiable qu'un nom deviné, et valable quelle que soit son orthographe.
  const sup = new Set();
  if (mapping) {
    [mapping.refInterne, mapping.libelle].forEach(c => { if (c) sup.add(String(c)); });
  }

  const racine = trierChamps(valeurs, def.champs, sup);

  // Subform : une ligne par chambre, avec ses propres champs et photos.
  const lignes = [];
  const brutLignes = def.cleSubform ? valeurBrute(valeurs[def.cleSubform]) : null;
  if (Array.isArray(brutLignes) && Object.keys(def.colonnes).length) {
    brutLignes.forEach((ligne, i) => {
      const t = trierChamps(ligne || {}, def.colonnes, sup);
      // Première colonne = identifiant de la chambre (num_chambre). On la sort
      // du lot pour en faire le titre de la ligne dans l'éditeur et le PDF.
      const titre = t.champs.length ? t.champs[0] : null;
      lignes.push({
        index: i,
        titreCle: titre ? titre.cle : null,
        titre: titre ? titre.valeur : String(i + 1),
        champs: titre ? t.champs.slice(1) : t.champs,
        sections: t.sections,
        photos: t.photos,
      });
    });
  }

  return {
    formId: String(s.form_id || ""),
    dataId: String(s.id || ""),
    formNom: def.nom,
    technicienKizeoUserId: String(s.user_id || ""),
    recipientNom: s.recipient_name || "",
    dateSoumission: s.update_time || s.create_time || "",
    refInterne: String(valeurBrute(valeurs[(mapping && mapping.refInterne) || "ref_interne"]) || ""),
    libelle: String(valeurBrute(valeurs.libelle) || ""),
    entete: racine.champs,
    sections: racine.sections,
    photos: racine.photos,
    signature: racine.signature,
    lignes,
  };
}

// Tous les médias d'un rapport, à plat, avec leur emplacement d'origine :
// l'appelant sait où replacer le fichier téléchargé.
function listerMedias(rapport) {
  const out = [];
  rapport.photos.forEach(p => out.push({ ...p, ligne: null }));
  if (rapport.signature) out.push({ ...rapport.signature, ligne: null, signature: true });
  rapport.lignes.forEach(l => l.photos.forEach(p => out.push({ ...p, ligne: l.index })));
  return out;
}

// Kizeo rend les photos en JPEG mais les signatures en PNG : on lit les
// premiers octets plutôt que de supposer, sinon le fichier déposé porte un
// type qui ne correspond pas à son contenu.
function typeImage(buffer) {
  if (!buffer || buffer.length < 4) return "application/octet-stream";
  const t = buffer.slice(0, 4).toString("hex");
  if (t.startsWith("ffd8")) return "image/jpeg";
  if (t === "89504e47") return "image/png";
  if (t === "47494638") return "image/gif";
  if (t === "52494646") return "image/webp"; // RIFF....WEBP
  return "application/octet-stream";
}

// Télécharge chaque média et le confie à `deposer(media, buffer, contentType)`,
// qui renvoie l'URL durable à stocker. Les photos deviennent ainsi des
// fichiers à nous : l'écran de relecture peut s'ouvrir des jours après la
// réception sans dépendre de la durée de vie des médias chez Kizeo.
// Un média introuvable n'interrompt rien, il est signalé dans `erreurs`.
async function telechargerMedias(rapport, { kizeoGet, deposer }) {
  const medias = listerMedias(rapport);
  const erreurs = [];
  let nb = 0;

  for (const m of medias) {
    try {
      const r = await kizeoGet(`/forms/${encodeURIComponent(rapport.formId)}/data/${encodeURIComponent(rapport.dataId)}/medias/${encodeURIComponent(m.media)}`);
      if (r.status !== 200 || !r.body || !r.body.length) throw new Error(`Kizeo a répondu ${r.status}`);
      const url = await deposer(m, r.body, typeImage(r.body));
      // Replacement à l'identique dans la structure lue.
      const cible = m.signature
        ? rapport.signature
        : (m.ligne === null
            ? rapport.photos.find(p => p.cle === m.cle)
            : rapport.lignes[m.ligne].photos.find(p => p.cle === m.cle));
      if (cible) { cible.url = url; nb++; }
    } catch (e) {
      erreurs.push({ cle: m.cle, ligne: m.ligne, raison: e.message });
    }
  }
  return { nb, erreurs };
}

module.exports = { lireSoumission, listerMedias, telechargerMedias, listeChoix, typeImage };

// Les listes de choix sont identiques d'une ligne de tableau à l'autre : les
// répéter dans chaque champ gonfle inutilement le document. Sur un CCAS de
// 20 chambres, 18 champs et une dizaine d'options chacun, on frôlerait la
// limite de 1 Mo d'un document Firestore. On les sort donc une seule fois
// dans un catalogue indexé par clé de champ, et l'éditeur les y retrouve.
function compacter(rapport) {
  const catalogue = {};
  const nettoyer = (champs) => champs.map(({ choix, ...reste }) => {
    if (choix && choix.length && !catalogue[reste.cle]) catalogue[reste.cle] = choix;
    return reste;
  });
  return {
    rapport: {
      ...rapport,
      entete: nettoyer(rapport.entete),
      lignes: rapport.lignes.map(l => ({ ...l, champs: nettoyer(l.champs) })),
    },
    catalogue,
  };
}

module.exports.compacter = compacter;
