const functions = require("firebase-functions");
const crypto = require("crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");

admin.initializeApp();

const gmailUser = functions.config().gmail.user;
const gmailPass = functions.config().gmail.pass;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailPass },
});

// ── SUPPRIMER UTILISATEUR FIREBASE AUTH ───────────────────────────
exports.deleteAuthUser = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const { uid } = req.body;
    if (!uid) { res.status(400).json({ error: "uid manquant" }); return; }

    try {
      await admin.auth().deleteUser(uid);
      console.log("Utilisateur supprime de Auth:", uid);
      res.status(200).json({ success: true });
    } catch(err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

// ── ENVOYER NOTIFICATION EMAIL ────────────────────────────────────
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

exports.sendNotification = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }

    const { to, subject, body, attachments } = req.body;
    if (!to || !subject || !body) {
      res.status(400).json({ error: "Champs manquants" });
      return;
    }

    try {
      const mailAttachments = [];
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          try {
            const buffer = await downloadFile(att.url);
            mailAttachments.push({
              filename: att.filename || "rapport.xlsx",
              content: buffer,
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            });
          } catch(e) {
            console.error("Erreur PJ:", att.url, e.message);
          }
        }
      }

      await transporter.sendMail({
        from: '"Belledonne Multiservices" <' + gmailUser + '>',
        to, subject, text: body,
        attachments: mailAttachments
      });

      console.log("Email envoye a " + to + " avec " + mailAttachments.length + " PJ");
      res.status(200).json({ success: true, attachments: mailAttachments.length });
    } catch(err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

// ── ENVOYER SMS VIA OVH ──────────────────────────────────────────
exports.sendSMS = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }

    const { to, message } = req.body;
    if (!to || !message) {
      res.status(400).json({ error: "Champs manquants: to, message" });
      return;
    }

    // Normalize phone to international format
    let phone = to.replace(/[\s\-\.]/g, "");
    if (phone.startsWith("0")) phone = "+33" + phone.slice(1);
    if (!phone.startsWith("+")) phone = "+33" + phone;

    // Strip accents to avoid signature issues with UTF-8
    const cleanMessage = message
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x00-\x7F]/g, "");

    const appKey      = functions.config().ovh.app_key;
    const appSecret   = functions.config().ovh.app_secret;
    const consumerKey = functions.config().ovh.consumer_key;
    const smsAccount  = functions.config().ovh.sms_account;

    // Get OVH server time first to avoid clock skew
    const timeRes = await new Promise((resolve, reject) => {
      https.get("https://eu.api.ovh.com/1.0/auth/time", (r) => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(parseInt(d)));
      }).on("error", reject);
    });

    const timestamp  = timeRes.toString();
    const urlPath    = "/1.0/sms/" + smsAccount + "/jobs";
    const fullUrl    = "https://eu.api.ovh.com" + urlPath;
    const body       = JSON.stringify({ message: cleanMessage, receivers: [phone], senderForResponse: true, priority: "high" });
    const bodyHash   = crypto.createHash("sha1").update(body).digest("hex");
    const sigStr     = [appSecret, consumerKey, "POST", fullUrl, bodyHash, timestamp].join("+");
    const signature  = "$1$" + crypto.createHash("sha1").update(sigStr).digest("hex");

    try {
      const result = await new Promise((resolve, reject) => {
        const options = {
          hostname: "eu.api.ovh.com",
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "X-Ovh-Application": appKey,
            "X-Ovh-Consumer": consumerKey,
            "X-Ovh-Signature": signature,
            "X-Ovh-Timestamp": timestamp,
          }
        };
        const r = https.request(options, (res2) => {
          let d = ""; res2.on("data", c => d += c);
          res2.on("end", () => resolve({ status: res2.statusCode, body: d }));
        });
        r.on("error", reject);
        r.write(body);
        r.end();
      });

      console.log("SMS status:", result.status, result.body);
      const parsed = JSON.parse(result.body);

      if (result.status === 200 || result.status === 201) {
        res.status(200).json({ success: true, details: parsed });
      } else {
        console.error("OVH error body:", result.body);
        console.error("Phone used:", phone);
        console.error("Message:", cleanMessage);
        res.status(200).json({ success: false, ovhStatus: result.status, ovhError: parsed, phone, messageLength: cleanMessage.length });
      }
    } catch(err) {
      console.error("Erreur SMS:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── AJOUTER PASSAGES AU GOOGLE CALENDAR DU TECHNICIEN ────────────
exports.addToCalendar = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }

    const { technicienEmail, passages, nature, nomClient, adresse, bc, observations, interventionId, operation, calEventId, colorId } = req.body;

    if (!technicienEmail) {
      res.status(400).json({ error: "technicienEmail requis" });
      return;
    }
    if (operation === 'delete') {
      if (!calEventId) { res.status(400).json({ error: "calEventId requis pour delete" }); return; }
      try {
        const { google } = require("googleapis");
        const serviceAccountKey = { type:"service_account", project_id:functions.config().gcal.project_id, private_key_id:functions.config().gcal.private_key_id, private_key:functions.config().gcal.private_key.replace(/\\n/g,"\n"), client_email:functions.config().gcal.client_email, client_id:functions.config().gcal.client_id, token_uri:"https://oauth2.googleapis.com/token" };
        const auth = new google.auth.GoogleAuth({ credentials:serviceAccountKey, scopes:["https://www.googleapis.com/auth/calendar"] });
        const calendar = google.calendar({ version:"v3", auth });
        await calendar.events.delete({ calendarId: technicienEmail, eventId: calEventId });
        res.status(200).json({ success: true, deleted: true });
      } catch(err) {
        // 404 = événement déjà absent du calendrier, on traite comme un succès
        if (err.code === 404 || err.status === 404 || (err.errors && err.errors[0]?.domain === 'calendar' && err.errors[0]?.reason === 'notFound')) {
          res.status(200).json({ success: true, deleted: true, alreadyGone: true });
        } else {
          res.status(500).json({ error: err.message });
        }
      }
      return;
    }
    if (!passages || !passages.length) {
      res.status(400).json({ error: "passages requis" });
      return;
    }

    try {
      const { google } = require("googleapis");

      // Authentification via Service Account avec délégation sur le calendrier du technicien
      const serviceAccountKey = {
        type: "service_account",
        project_id: functions.config().gcal.project_id,
        private_key_id: functions.config().gcal.private_key_id,
        private_key: functions.config().gcal.private_key.replace(/\\n/g, "\n"),
        client_email: functions.config().gcal.client_email,
        client_id: functions.config().gcal.client_id,
        token_uri: "https://oauth2.googleapis.com/token",
      };

      const auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });

      const calendar = google.calendar({ version: "v3", auth });

      const results = [];
      const errors = [];

      for (const passage of passages) {
        // Format attendu : "2024-06-15T08:00|2024-06-15T12:00"
        const parts = passage.split("|");
        const debut = parts[0];
        const fin = parts[1] || "";

        if (!debut) continue;

        // Si pas de fin, on met 1h par défaut
        // Les dates arrivent au format "YYYY-MM-DDTHH:MM" (datetime-local, heure locale Paris)
        // On les traite directement comme heure Europe/Paris via le timeZone du calendrier
        let startDt, endDt;
        try {
          // Ajouter ":00" si secondes manquantes pour compatibilité
          const debutStr = debut.length === 16 ? debut + ":00" : debut;
          const finStr = fin ? (fin.length === 16 ? fin + ":00" : fin) : "";
          startDt = debutStr; // On passe la date telle quelle, Google Calendar respecte timeZone
          endDt = finStr || (() => {
            // +1h : calculer manuellement sur la chaîne
            const d = new Date(debutStr);
            d.setHours(d.getHours() + 1);
            const pad = n => String(n).padStart(2,'0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
          })();
        } catch(e) {
          errors.push({ passage, error: "Format date invalide" });
          continue;
        }

        // Construction de la description de l'événement
        const { customSummary, customDescription } = req.body;
        const tels = Array.isArray(req.body.tels) ? req.body.tels : [];
        const description = customDescription !== undefined ? customDescription : [
          bc ? `N° BC : ${bc}` : "",
          nature ? `Nature : ${nature}` : "",
          nomClient ? `Client : ${nomClient}` : "",
          tels.length ? `Téléphone(s) : ${tels.join(" / ")}` : "",
          adresse ? `Adresse : ${adresse}` : "",
          observations ? `Observations : ${observations}` : "",
        ].filter(Boolean).join("\n");

        const event = {
          summary: customSummary || `${nature || "Intervention"} — ${nomClient || "Client"}`,
          location: adresse || "",
          description,
          start: { dateTime: startDt, timeZone: "Europe/Paris" },
          end: { dateTime: endDt, timeZone: "Europe/Paris" },
          colorId: colorId ? String(colorId) : "9",
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 60 },
            ],
          },
        };

        try {
          if (operation === 'update' && calEventId) {
            const patchResult = await calendar.events.patch({ calendarId: technicienEmail, eventId: calEventId, resource: event });
            results.push({ passage, eventId: patchResult.data.id });
            console.log("Événement mis à jour:", patchResult.data.id);
          } else {
            const insertResult = await calendar.events.insert({ calendarId: technicienEmail, resource: event });
            results.push({ passage, eventId: insertResult.data.id, htmlLink: insertResult.data.htmlLink });
            console.log("Événement créé:", insertResult.data.id, "pour", technicienEmail);
          }
        } catch(insertErr) {
          console.error("Erreur opération événement:", insertErr.message);
          errors.push({ passage, error: insertErr.message });
        }
      }

      res.status(200).json({
        success: results.length > 0,
        created: results.length,
        errors: errors.length,
        results,
        errors,
      });

    } catch(err) {
      console.error("Erreur addToCalendar:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── IMPORT EMAIL GÉNÉRIQUE (toutes les 15 min) ────────────────────

const EXTRACTION_TOOL = {
  name: "save_document_data",
  description: "Enregistre les données extraites du document PDF.",
  input_schema: {
    type: "object",
    properties: {
      data: {
        type: "object",
        description: "Les données extraites du document, toutes les valeurs en chaîne de caractères",
        additionalProperties: { type: "string" },
      },
    },
    required: ["data"],
  },
};

async function getOrCreateLabel(gmail, labelName) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = (res.data.labels || []).find(l => l.name === labelName);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id;
}

function flattenParts(payload, acc = []) {
  if (!payload) return acc;
  acc.push(payload);
  if (payload.parts) payload.parts.forEach(p => flattenParts(p, acc));
  return acc;
}

async function parsePdfWithClaude(anthropic, pdfBase64, filename, systemPrompt) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: systemPrompt,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "save_document_data" },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: `Extrais les données de ce document (${filename}) et appelle l'outil save_document_data.` },
      ],
    }],
  });
  const toolUse = response.content.find(b => b.type === "tool_use");
  if (!toolUse) throw new Error(`Claude n'a pas utilisé l'outil. stop_reason=${response.stop_reason}`);
  return toolUse.input.data || {};
}

async function parseDocWithClaude(anthropic, docBuffer, filename, systemPrompt) {
  const mammoth = require("mammoth");
  let text;
  try {
    const result = await mammoth.extractRawText({ buffer: docBuffer });
    text = result.value;
  } catch(e) {
    throw new Error(`Impossible de lire le fichier DOC (${filename}): ${e.message}`);
  }
  if (!text || text.trim().length < 20) {
    throw new Error(`Fichier DOC vide ou illisible: ${filename}`);
  }
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: systemPrompt,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "save_document_data" },
    messages: [{
      role: "user",
      content: [{ type: "text", text: `Extrais les données de ce document (${filename}) :\n\n${text}\n\nAppelle l'outil save_document_data avec le résultat.` }],
    }],
  });
  const toolUse = response.content.find(b => b.type === "tool_use");
  if (!toolUse) throw new Error(`Claude n'a pas utilisé l'outil. stop_reason=${response.stop_reason}`);
  return toolUse.input.data || {};
}

async function processEmailGeneric(gmail, anthropic, db, messageId, labelTraiteId, labelArchiveId, source, sourceId) {
  const email = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = email.data.payload.headers || [];
  const subject = (headers.find(h => h.name === "Subject") || {}).value || "";

  let docNumber = "";
  if (source.subjectNumberRegex) {
    try {
      const match = subject.match(new RegExp(source.subjectNumberRegex));
      if (match && match[1]) docNumber = match[1];
    } catch(e) {
      console.warn(`Source ${sourceId}: regex invalide "${source.subjectNumberRegex}"`);
    }
  }
  console.log(`Email ${messageId}: sujet="${subject}", N°="${docNumber}"`);

  const allParts = flattenParts(email.data.payload);

  const pdfPart = allParts.find(p =>
    (p.mimeType === "application/pdf" || (p.filename && p.filename.toUpperCase().endsWith(".PDF"))) &&
    p.body && p.body.attachmentId
  );
  const docPart = !pdfPart && allParts.find(p => {
    const fname = (p.filename || "").toUpperCase();
    return (p.mimeType === "application/msword" ||
            p.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
            fname.endsWith(".DOC") || fname.endsWith(".DOCX")) &&
           p.body && p.body.attachmentId;
  });
  const attachPart = pdfPart || docPart;

  const labelIds = [labelTraiteId];
  if (labelArchiveId) labelIds.push(labelArchiveId);

  if (!attachPart) {
    console.warn(`Email ${messageId}: aucune pièce jointe PDF/DOC, labellisation uniquement`);
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: labelIds, removeLabelIds: ["INBOX", "UNREAD"] } });
    return;
  }

  console.log(`Email ${messageId}: pièce jointe "${attachPart.filename}" — téléchargement...`);
  const att = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachPart.body.attachmentId });
  const fileBase64 = att.data.data.replace(/-/g, "+").replace(/_/g, "/");
  const fileBuffer = Buffer.from(fileBase64, "base64");

  console.log(`Email ${messageId}: extraction Claude...`);
  let extractedData;
  if (pdfPart) {
    extractedData = await parsePdfWithClaude(anthropic, fileBase64, attachPart.filename || "document.pdf", source.claudeSystemPrompt || "");
  } else {
    extractedData = await parseDocWithClaude(anthropic, fileBuffer, attachPart.filename || "document.doc", source.claudeSystemPrompt || "");
  }

  console.log(`Email ${messageId}: upload Storage...`);
  const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
  const storageFolder = source.pdfType === "PL" ? "suivi/pl" : "suivi/bc";
  const storagePath = `${storageFolder}/${Date.now()}_${(attachPart.filename || "doc").replace(/\s/g, "_")}`;
  const downloadToken = crypto.randomUUID();
  try {
    await bucket.file(storagePath).save(fileBuffer, {
      contentType: pdfPart ? "application/pdf" : "application/octet-stream",
      metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
    });
  } catch(e) {
    throw new Error(`Storage ERREUR: ${e.message}`);
  }
  const bcUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

  console.log(`Email ${messageId}: écriture Firestore...`);
  const finalBc = extractedData.bc || docNumber || "";
  try {
    const docRef = await db.collection("suivi").add({
      ...extractedData,
      bc: finalBc,
      bcUrl,
      statut: "À valider",
      source: "auto",
      sourceId,
      pdfType: source.pdfType || "BC",
      createdAt: new Date().toISOString(),
    });
    console.log(`Email ${messageId}: Firestore OK doc=${docRef.id}`);
  } catch(e) {
    throw new Error(`Firestore ERREUR: ${e.message}`);
  }

  await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: labelIds, removeLabelIds: ["INBOX", "UNREAD"] } });
  console.log(`✅ ${source.pdfType || "BC"} ${finalBc || "?"} importé — ${source.clientLabel}`);
}

async function processSource(gmail, anthropic, db, source, sourceRef) {
  const labelTraiteId = await getOrCreateLabel(gmail, source.gmailLabelTraite);
  let labelArchiveId = null;
  if (source.gmailDossierArchive) {
    labelArchiveId = await getOrCreateLabel(gmail, source.gmailDossierArchive);
  }

  const fromFilter = (source.senderEmails || []).map(e => `from:${e}`).join(" OR ");
  let q = `(${fromFilter}) -label:${source.gmailLabelTraite}`;
  if (source.subjectContains) q += ` subject:"${source.subjectContains}"`;
  if (source.startDate) q += ` after:${source.startDate.replace(/-/g, "/")}`;

  const searchRes = await gmail.users.messages.list({ userId: "me", q, maxResults: 20 });
  const messages = searchRes.data.messages || [];
  console.log(`Source ${sourceRef.id}: ${messages.length} email(s) à traiter`);

  let processed = 0;
  for (const msg of messages) {
    try {
      await processEmailGeneric(gmail, anthropic, db, msg.id, labelTraiteId, labelArchiveId, source, sourceRef.id);
      processed++;
    } catch(e) {
      console.error(`Source ${sourceRef.id} - Email ${msg.id}:`, e.message);
    }
  }

  await sourceRef.update({
    lastRun: new Date().toISOString(),
    totalProcessed: (source.totalProcessed || 0) + processed,
  });

  return processed;
}

exports.processIncomingBC = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .pubsub.schedule("every 15 minutes")
  .timeZone("Europe/Paris")
  .onRun(async () => {
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const { google } = require("googleapis");
    const Anthropic = require("@anthropic-ai/sdk");

    const oAuth2Client = new google.auth.OAuth2(
      functions.config().gmail.oauth_client_id,
      functions.config().gmail.oauth_client_secret
    );
    oAuth2Client.setCredentials({ refresh_token: functions.config().gmail.oauth_refresh_token });
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    const anthropic = new Anthropic({ apiKey: functions.config().anthropic.api_key });

    let sourcesSnap;
    try {
      sourcesSnap = await db.collection("email-sources").where("enabled", "==", true).get();
    } catch(e) {
      console.error("Erreur lecture email-sources:", e.message);
      return;
    }

    if (sourcesSnap.empty) {
      console.log("processIncomingBC: aucune source active dans email-sources.");
      return;
    }

    const now = new Date();

    for (const sourceDoc of sourcesSnap.docs) {
      const source = sourceDoc.data();

      // Pour les fréquences > 15 min, vérifier si assez de temps s'est écoulé
      if (source.lastRun && (source.checkFrequencyMinutes || 15) > 15) {
        const minutesSinceLast = (now - new Date(source.lastRun)) / 60000;
        if (minutesSinceLast < source.checkFrequencyMinutes) {
          console.log(`Source ${sourceDoc.id}: skip (${Math.round(minutesSinceLast)}min / ${source.checkFrequencyMinutes}min requis)`);
          continue;
        }
      }

      try {
        const processed = await processSource(gmail, anthropic, db, source, sourceDoc.ref);
        console.log(`Source ${sourceDoc.id}: ${processed} document(s) importé(s).`);
      } catch(e) {
        console.error(`Source ${sourceDoc.id}: erreur:`, e.message);
      }
    }
  });
