const functions = require("firebase-functions");
const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");

const gmailUser = functions.config().gmail.user;
const gmailPass = functions.config().gmail.pass;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailPass },
});

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
