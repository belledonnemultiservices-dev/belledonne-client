# Intégration Kizeo Forms — Spec technique

> Automatisation des rapports d'intervention : génération pré-remplie depuis le Suivi,
> réception temps réel via webhook, page de traitement, envoi client + archivage dans le Suivi.
> Statut : spec à valider avant développement.

---

## 1. Vue d'ensemble du flux

```
[Modal Suivi, un passage]
      │  bouton "Générer le rapport Kizeo"
      ▼
(CF) pushKizeoForm  ──POST /forms/{formId}/push──►  Mobile du technicien (formulaire pré-rempli)
                                                          │  le technicien complète + valide
                                                          ▼
                                              Kizeo enregistre la soumission
                                                          │  webhook "Recording"
                                                          ▼
(CF) kizeoWebhook  ◄──────────────────────────────────────
      │  lit ref_interne, télécharge PDF/Excel, dépose dans Storage
      ▼
Collection Firestore `reception-rapports`  (boîte de réception)
      ▼
[Page admin "Réception rapports"]
      │  ouvrir / (Excel: éditer via Google Sheets) / valider
      ▼
Envoi client (email et/ou espace client)  +  écriture dans collection `rapports`
                                               (rattaché client+bc+passage → visible dans le modal Suivi et rapports.html)
```

Filet de sécurité : **pull programmé** (CF `kizeoPull`, toutes les 15 min) qui récupère les soumissions non lues au cas où un webhook se perd.

---

## 2. Prérequis de configuration Kizeo (côté Yacine)

1. **Champ `ref_interne`** à ajouter une fois dans chaque formulaire de rapport (texte, masquable). L'app y écrit un identifiant **unique** du passage `{suiviId}::{numPassage}`. C'est lui qui fait le lien fiable (le technicien n'y touche pas). Les champs Référence/N° passage existants restent pré-remplis pour l'affichage seulement.
2. **Correspondance techniciens** : récupérer le `user_id` Kizeo de chaque technicien et le stocker dans sa fiche (collection `techniciens`, champ `kizeoUserId`).
3. **`formId`** des formulaires de rapport (via `GET /forms`).
4. **Webhook** configuré dans l'interface Kizeo : déclencheur *Recording*, URL = endpoint de `kizeoWebhook`, header personnalisé `X-Kizeo-Secret: <secret>`.
5. **Clé API** Kizeo (déjà en possession de Yacine) → stockée dans Secret Manager.

---

## 3. Secrets (Secret Manager, comme l'existant)

| Secret | Contenu |
|---|---|
| `KIZEO_API_TOKEN` | Token API Kizeo (header `Authorization`, brut, sans `Bearer`) |
| `KIZEO_WEBHOOK_SECRET` | Secret aléatoire vérifié en header entrant du webhook |
| `GDRIVE_SA` | Clé JSON du Service Account (réutiliser/étendre celui de Calendar, +scope Drive) |

Base API Kizeo : `https://forms.kizeo.com/rest/v3/`. Auth : header `Authorization: <KIZEO_API_TOKEN>`.

---

## 4. Modèle de données

### 4.1 Nouvelle collection `reception-rapports` (boîte de réception, admin only)

```
{
  // provenance Kizeo
  kizeoDataId      : "987654",              // _id de la soumission Kizeo (clé stable)
  kizeoFormId      : "123456",
  refInterne       : "abc123::2",           // lien : {suiviId}::{numPassage} lu dans ref_interne
  reference        : "320995",              // N° BC/PL/devis (affichage)
  arriveeAt        : "2026-08-04T14:32:00Z",// date/heure d'arrivée (= tri de la page)
  technicien       : "Nom technicien",      // depuis _recipient_name
  origine          : "webhook" | "pull",

  // rattachement résolu
  suiviId          : "abc123",              // doc suivi correspondant (null si non résolu)
  client           : "ACTIS",
  bc               : "320995",
  numPassage       : 2,
  passageLabel     : "2ème passage",

  // fichier
  type             : "pdf" | "excel",
  fileUrl          : "https://.../reception/...",     // fichier tel que reçu de Kizeo
  gsheetId         : null,                  // si excel converti en Google Sheet pour édition
  gsheetUrl        : null,

  // workflow
  statut           : "a-traiter" | "envoye" | "archive",
  createdAt, updatedAt
}
```

- **Tri de la page** = `arriveeAt` (les uns à la suite des autres par date/heure d'arrivée).
- `ref_interne` absent/illisible (formulaire lancé hors app) → `suiviId=null`, ligne affichée en "à rattacher manuellement".

### 4.2 Collection `rapports` (existante, inchangée)

À la validation, on y écrit avec le format déjà en place :
`{ client, bc, passage: passageLabel, pdfUrl, createdAt, ... }`.
Fichier copié dans `rapports/{client}/{ts}_{nom}` (chemin actuel). Aucune modification du format → `rapports.html` et le modal Suivi se mettent à jour automatiquement.

### 4.3 Collection `techniciens` (existante) — ajout

Champ `kizeoUserId` (string) par technicien.

### 4.4 Nouvelle collection `kizeo-forms` (config des formulaires, admin only)

Les formulaires Kizeo ne sont **jamais en dur dans le code** : ils sont gérés depuis un configurateur (même principe que `email-sources`). Plusieurs formulaires possibles.

```
{
  nom        : "Rapport dératisation",     // libellé lisible affiché dans le modal
  formId     : "123456",                   // id du formulaire Kizeo
  actif      : true,
  exportId   : "789",                      // export Excel à utiliser (optionnel, si type Excel)
  typeSortie : "pdf" | "excel",
  // mapping : donnée de l'app  ->  field_id du champ Kizeo (chargé via l'API)
  mapping    : {
    refInterne : "ref_interne",  // OBLIGATOIRE — lien unique
    reference  : "num_bc",       // optionnel (pré-remplissage/affichage)
    passage    : "num_passage",  // optionnel
    client     : "client",
    adresse    : "adresse",
    date       : "date_intervention"
  },
  createdAt, updatedAt
}
```

---

## 5. Cloud Functions

### 5.0 `kizeoListFields` (HTTP, admin only) — pour le configurateur

Entrée : `{ formId }`.
`GET /forms/{formId}` → renvoie la définition du formulaire → extrait la liste des champs `{ field_id, libellé, type }`.
Sert au configurateur pour proposer le mapping en menus déroulants (aucun `field_id` saisi à la main).

### 5.1 `pushKizeoForm` (HTTP, admin only — jeton Firebase + rôle admin)

Appelée depuis le modal Suivi.
Entrée : `{ suiviId, numPassage, kizeoFormDocId }` (le formulaire choisi dans le menu déroulant du modal).
Traitement :
1. Lit la config `kizeo-forms/{kizeoFormDocId}` → `formId` + `mapping`.
2. Lit le doc `suivi/{suiviId}` → client, bc, adresse, date du passage, technicien assigné au passage.
3. Résout `kizeoUserId` du technicien (fiche `techniciens`). Erreur explicite si absent.
4. Construit `fields` à partir du `mapping` : `refInterne` = `"<suiviId>::<numPassage>"` (obligatoire), + reference/passage/client/adresse/date si mappés (pré-remplissage).
5. `POST /forms/{formId}/push` avec `{ recipient_user_id, fields }`.
6. Retour : ok / message d'erreur affiché dans le modal.

### 5.2 `kizeoWebhook` (HTTP public, sécurisé par header secret)

1. Vérifie `X-Kizeo-Secret === KIZEO_WEBHOOK_SECRET` → sinon 401.
2. Lit `eventType` (traite `finished`/recording) + `form_id` + `id` (dataId).
3. `GET /forms/{formId}/data/{dataId}` → lit le champ `ref_interne` (via `mapping.refInterne`) + `_recipient_name`.
4. Parse `ref_interne` → `suiviId`, `numPassage`. Résout `client` via `suivi/{suiviId}`. **Illisible/absent/intervention introuvable → soumission ignorée** (décision du 2026-08-06 : seuls les rapports générés depuis le bouton "Générer le rapport Kizeo" du Suivi doivent apparaître dans la boîte de réception, pas les remplissages manuels du même formulaire dans Kizeo).
5. Télécharge le fichier :
   - PDF : `GET /forms/{formId}/data/{dataId}/pdf`
   - Excel : `GET /forms/{formId}/exports` puis `GET /forms/{formId}/data/{dataId}/exports/{exportId}`
6. Dépose le fichier dans Storage `reception/{client|_inconnu}/{ts}_{nom}`.
7. Crée le doc `reception-rapports` (statut `a-traiter`, `arriveeAt = now`, `origine=webhook`).
8. Idempotence : si un doc avec ce `kizeoDataId` existe déjà, on met à jour au lieu de dupliquer (gère les renvois de webhook et les modifications côté Kizeo).

### 5.3 `kizeoPull` (planifiée, toutes les 15 min — filet de sécurité)

`GET /forms/{formId}/data/unread/{action}/{limit}` (action = canal de lecture dédié, ex. `espace-client`) → même traitement que le webhook (points 3→8, `origine=pull`) → `POST /forms/{formId}/markasreadbyaction/{action}`.

### 5.4 `excelToSheet` + `sheetToStorage` (HTTP, admin only) — édition Excel via Google

- `excelToSheet(receptionId)` : copie le fichier Excel sur Google Drive en le convertissant en **Google Sheet** (Drive API `files.create` avec `mimeType=application/vnd.google-apps.spreadsheet`), stocke `gsheetId`/`gsheetUrl` sur le doc. Ouvre un onglet Sheets pour édition.
- `sheetToStorage(receptionId)` : à l'enregistrement, ré-exporte le Sheet en `.xlsx` (Drive API `files.export`), remplace `fileUrl` dans Storage.
- Prérequis : **API Google Drive activée** + dossier Drive partagé au Service Account. (Le SA Calendar existant sera étendu avec le scope Drive, ou un SA dédié.)

---

## 5bis. Configurateur de formulaires Kizeo (page admin `kizeo-config.html`)

Même esprit que `imports.html` (config `email-sources`).
- CRUD sur `kizeo-forms` : ajouter/modifier/supprimer, toggle actif.
- Saisie du `formId` + nom + type de sortie (PDF/Excel) + `exportId`.
- Bouton **"Charger les champs"** → appelle `kizeoListFields` → affiche les champs du formulaire → mapping via menus déroulants (reference et passage obligatoires, client/adresse/date optionnels).
- Lien sidebar admin only.

## 6. Page admin "Réception rapports" (nouveau fichier `reception.html`)

- Nom distinct de la page client "Rapports d'intervention" ([rapports.html](rapports.html)).
- Lien sidebar **admin only** (via [suivi-badge.js](suivi-badge.js), même logique que les autres liens internes).
- Liste en temps réel (`onSnapshot` sur `reception-rapports`, `orderBy arriveeAt`), la plus récente en haut, colonnes : date/heure d'arrivée, client, BC, passage, technicien, type (PDF/Excel), statut.
- Actions par ligne :
  - **Ouvrir** : PDF → visionneuse ; Excel → bouton "Éditer" (déclenche `excelToSheet`, ouvre Google Sheets) puis "Enregistrer" (`sheetToStorage`).
  - **Remplacer le fichier** (upload manuel d'une nouvelle version — cas PDF corrigé dans Kizeo et re-téléchargé).
  - **Rattacher** (si `suiviId=null` : choisir manuellement l'intervention/passage).
  - **Envoyer au client** : email (réutilise la mécanique de notif rapport existante, templates + PJ) et/ou dépôt espace client → **écrit dans `rapports`** (client+bc+passageLabel+pdfUrl) → passe le doc réception en `statut=envoye`.
- Un rapport `envoye` reste consultable (filtre par statut), et il apparaît désormais dans le modal Suivi du passage + `rapports.html` côté client.

---

## 7. Sécurité

- `pushKizeoForm`, `excelToSheet`, `sheetToStorage` : HTTP sécurisées jeton Firebase + rôle admin (helper `verifyAdmin` existant).
- `kizeoWebhook` : public par nature (appelé par Kizeo), protégé par le header secret `X-Kizeo-Secret`. **Limite assumée** : pas de signature HMAC native chez Kizeo, donc secret partagé uniquement (à faire tourner si compromis).
- Règles Firestore : `reception-rapports` = admin only (comme `suivi`/`facturation`).
- Règles Storage : préfixe `reception/` = admin only.
- Tous les secrets en Secret Manager, jamais en Firestore ni en clair.

---

Dans le modal d'une intervention (par passage), on ajoute :
- un **menu déroulant** listant les formulaires `kizeo-forms` actifs ;
- un bouton **"Générer le rapport Kizeo"** → appelle `pushKizeoForm({ suiviId, numPassage, kizeoFormDocId })`.

## 8. Découpage de développement proposé

1. **[Fait]** **Socle & config** : secrets, client API Kizeo côté Functions, `kizeoListFields`, configurateur `kizeo-config.html` + collection `kizeo-forms`, champ `kizeoUserId` sur les techniciens. Actions Kizeo côté Yacine : récupérer les `user_id` techniciens (aucun nouveau champ de formulaire à créer).
2. **[Fait]** **Aller** : `pushKizeoForm` + menu déroulant + bouton dans le modal Suivi. Test : push reçu sur le mobile technicien.
3. **[Fait, validé 2026-08-06]** **Retour** : `kizeoWebhook` + collection `reception-rapports` + `kizeoPull`. Test bout en bout OK : soumission mobile → doc `reception-rapports` créé (suiviId/client/bc/passage résolus) + fichier en Storage.
   - **Format réel du payload webhook Kizeo** (différent de ce qu'anticipait la spec) : `{ id: "<dataId>", eventType: "finished", data: { form_id: "...", fields: {...}, recipient_user_id, ... } }`. Le `dataId` est à la racine, le `formId` est dans `data.form_id`. Code corrigé en conséquence.
   - `technicien` (`_recipient_name`) revient vide dans la réponse `GET /forms/{formId}/data/{dataId}` — à creuser si besoin plus tard (non bloquant).
   - Webhook configuré côté Kizeo : déclencheur "Enregistrement", méthode POST, header `X-Kizeo-Secret`.
4. **Page** `reception.html` : liste + ouverture PDF + envoi client + archivage dans `rapports`.
5. **Excel/Drive** : `excelToSheet` / `sheetToStorage` + API Drive.
6. **Finitions** : rattachement manuel, filtres, statuts, idempotence, gestion d'erreurs.

---

## 9. Points ouverts à confirmer avant/pendant le dev

- **Un rapport = un passage** : confirmé.
- **Plusieurs formulaires** gérés via configurateur `kizeo-forms` : confirmé.
- `field_id` : chargés automatiquement via `kizeoListFields`, pas de saisie manuelle.
- Réutilisation du **SA Calendar** pour Drive (+scope Drive), ou SA dédié : à trancher au lot 5.
