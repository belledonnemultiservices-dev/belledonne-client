// Panneau "Assistant" : questions en langage naturel sur les données de l'app.
// Chargé par suivi-badge.js pour les seuls comptes admin. Le raisonnement et la
// lecture des données se font dans le projet séparé belledonne-agent, qui n'a
// qu'un accès en lecture seule à cette base. Ce fichier ne touche à aucune donnée.

const URL_AGENT = "https://europe-west1-belledonne-agent.cloudfunctions.net/assistant";
const AVATAR = new URL("./assistant-avatar.jpg?v=3", import.meta.url).href; // ?v= à incrémenter à chaque nouvelle image
const CLE_CONV = "assistant-conversation-id";
const CLE_FIL = "assistant-fil";          // messages affichés, pour les retrouver d'une page à l'autre
const CLE_ETAT = "assistant-etat";        // "ouvert" ou "reduit"
const CLE_BROUILLON = "assistant-brouillon";

// sessionStorage peut être indisponible (navigation privée stricte) : jamais bloquant.
const lireSession = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
const ecrireSession = (k, v) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* ignoré */ } };

const EXEMPLES = [
  "Qu'est-ce que Wilfried a cette semaine ?",
  "Quels rapports Kizeo sont en retard ?",
  "Qu'est-ce qui reste à facturer ?",
  "Quelles interventions n'ont aucun passage planifié ?",
];

const CSS = `
#asst-btn{position:fixed;right:22px;bottom:22px;z-index:9998;display:flex;align-items:center;gap:12px;padding:6px 20px 6px 6px;border:none;border-radius:999px;background:#0D1B2A;color:#fff;font:600 15px 'DM Sans',sans-serif;box-shadow:0 6px 20px rgba(13,27,42,.25);cursor:pointer}
#asst-btn:hover{background:#1DA870}
#asst-btn img{width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #2ECC8F}
.asst-avatar{width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #2ECC8F;flex:none}
.asst-ligne{display:flex;align-items:flex-end;gap:9px;align-self:flex-start;max-width:94%}
.asst-ligne img{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none;border:1.5px solid #2ECC8F}
.asst-ligne .asst-msg{max-width:100%}
#asst-btn .asst-point{width:8px;height:8px;border-radius:50%;background:#2ECC8F;display:none}
#asst-btn.en-cours .asst-point{display:inline-block}
#asst-panel{position:fixed;right:22px;bottom:22px;z-index:9999;width:420px;max-width:calc(100vw - 32px);height:620px;max-height:calc(100vh - 44px);display:none;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(13,27,42,.28);font-family:'DM Sans',sans-serif;color:#0D1B2A;overflow:hidden}
#asst-panel.ouvert{display:flex}
.asst-tete{display:flex;align-items:center;gap:8px;padding:14px 16px;background:#0D1B2A;color:#fff}
.asst-tete b{flex:1;font:700 15px 'Syne','DM Sans',sans-serif}
.asst-tete small{display:block;font:400 11px 'DM Sans',sans-serif;color:#8FA4B8}
.asst-tete button{background:none;border:none;color:#fff;cursor:pointer;font-size:12px;padding:4px 8px;border-radius:6px;line-height:1}
.asst-tete button[data-a="reduire"],.asst-tete button[data-a="fermer"]{font-size:15px;width:28px;height:28px;padding:0}
.asst-tete button:hover{background:rgba(255,255,255,.12)}
.asst-fil{flex:1;overflow-y:auto;padding:16px;background:#F2F5F8;display:flex;flex-direction:column;gap:10px}
.asst-msg{max-width:88%;padding:10px 13px;border-radius:12px;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.asst-moi{align-self:flex-end;background:#0D1B2A;color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}
.asst-lui{align-self:flex-start;background:#fff;border:1px solid rgba(13,27,42,.09);border-bottom-left-radius:4px}
.asst-lui p{margin:0 0 6px}.asst-lui p:last-child{margin:0}
.asst-lui ul{margin:4px 0 6px;padding-left:18px}.asst-lui li{margin:2px 0}
.asst-lui table{border-collapse:collapse;margin:6px 0;font-size:12px;display:block;overflow-x:auto}
.asst-lui th,.asst-lui td{border:1px solid rgba(13,27,42,.12);padding:4px 7px;text-align:left;white-space:nowrap}
.asst-lui th{background:#E8F9F2}
.asst-err{align-self:flex-start;background:#FDECEC;color:#B42318;border-radius:10px;padding:9px 12px;font-size:13px}
.asst-attente{align-self:flex-start;color:#8FA4B8;font-size:13px;font-style:italic}
.asst-exemples{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.asst-exemples button{text-align:left;background:#fff;border:1px solid rgba(13,27,42,.09);border-radius:10px;padding:8px 11px;font:13px 'DM Sans',sans-serif;color:#4A6078;cursor:pointer}
.asst-exemples button:hover{border-color:#2ECC8F;color:#0D1B2A}
.asst-saisie{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(13,27,42,.09);background:#fff}
.asst-saisie textarea{flex:1;resize:none;border:1px solid rgba(13,27,42,.15);border-radius:10px;padding:9px 11px;font:13.5px 'DM Sans',sans-serif;max-height:110px;outline:none}
.asst-saisie textarea:focus{border-color:#2ECC8F}
.asst-saisie button{border:none;border-radius:10px;background:#2ECC8F;color:#fff;font:600 13px 'DM Sans',sans-serif;padding:0 16px;cursor:pointer}
.asst-saisie button:disabled{background:#8FA4B8;cursor:default}
@media (max-width:520px){#asst-panel{right:8px;bottom:8px;height:calc(100vh - 16px)}}
`;

const echapper = (s) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enLigne = (s) => echapper(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");

// Markdown minimal : paragraphes, listes, gras, tableaux simples. Tout est échappé avant.
function versHtml(texte) {
  const lignes = texte.split("\n");
  let html = "", liste = false, i = 0;
  const fermerListe = () => { if (liste) { html += "</ul>"; liste = false; } };
  while (i < lignes.length) {
    const l = lignes[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lignes.length && /^\s*\|[\s:|-]+\|\s*$/.test(lignes[i + 1])) {
      fermerListe();
      const cellules = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map(c => enLigne(c.trim()));
      html += "<table><tr>" + cellules(l).map(c => `<th>${c}</th>`).join("") + "</tr>";
      i += 2;
      while (i < lignes.length && /^\s*\|.*\|\s*$/.test(lignes[i])) { html += "<tr>" + cellules(lignes[i]).map(c => `<td>${c}</td>`).join("") + "</tr>"; i++; }
      html += "</table>";
      continue;
    }
    const puce = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (puce) { if (!liste) { html += "<ul>"; liste = true; } html += `<li>${enLigne(puce[1])}</li>`; }
    else if (!l.trim()) fermerListe();
    else { fermerListe(); html += `<p>${enLigne(l.replace(/^#+\s*/, ""))}</p>`; }
    i++;
  }
  fermerListe();
  return html;
}

export function monterAssistant(auth) {
  if (document.getElementById("asst-btn")) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "asst-btn";
  btn.innerHTML = `<img src="${AVATAR}" alt="">Assistant<span class="asst-point" title="Conversation en cours"></span>`;

  const panel = document.createElement("div");
  panel.id = "asst-panel";
  panel.innerHTML = `
    <div class="asst-tete"><img class="asst-avatar" src="${AVATAR}" alt=""><b>Assistant<small>Lecture seule · questions sur vos données</small></b>
      <button data-a="nouveau" title="Nouvelle conversation">Nouveau</button>
      <button data-a="reduire" title="Réduire (la conversation est gardée)">—</button>
      <button data-a="fermer" title="Fermer et effacer la conversation">✕</button></div>
    <div class="asst-fil"></div>
    <div class="asst-saisie"><textarea rows="1" placeholder="Pose ta question…"></textarea><button>Envoyer</button></div>`;
  document.body.append(btn, panel);

  const fil = panel.querySelector(".asst-fil");
  const zone = panel.querySelector("textarea");
  const envoyer = panel.querySelector(".asst-saisie button");
  let conversationId = lireSession(CLE_CONV);
  let enCours = false;
  let historique = []; // [{classe, html}] des messages échangés, rejoués au changement de page

  const afficher = (classe, html) => {
    const d = document.createElement("div");
    d.className = classe;
    d.innerHTML = html;
    // Les réponses de l'assistant portent son visage, comme dans une messagerie.
    if (classe.includes("asst-lui")) {
      const ligne = document.createElement("div");
      ligne.className = "asst-ligne";
      ligne.innerHTML = `<img src="${AVATAR}" alt="">`;
      ligne.appendChild(d);
      fil.appendChild(ligne);
    } else {
      fil.appendChild(d);
    }
    fil.scrollTop = fil.scrollHeight;
    return d;
  };
  // Message gardé dans l'historique (questions, réponses, erreurs), contrairement à l'accueil et à l'attente.
  const ajouter = (classe, html) => {
    historique.push({ classe, html });
    ecrireSession(CLE_FIL, JSON.stringify(historique));
    btn.classList.add("en-cours");
    return afficher(classe, html);
  };

  function accueil() {
    fil.innerHTML = "";
    historique = [];
    ecrireSession(CLE_FIL, null);
    btn.classList.remove("en-cours");
    afficher("asst-msg asst-lui", "<p>Bonjour 👋 Je lis les données de l'app : planning, interventions, rapports Kizeo, campagnes, garanties, facturation et devis. Je ne modifie rien.</p>");
    const ex = afficher("asst-exemples", EXEMPLES.map(q => `<button>${echapper(q)}</button>`).join(""));
    ex.querySelectorAll("button").forEach(b => b.addEventListener("click", () => poser(b.textContent)));
  }

  function restaurer() {
    let sauve = [];
    try { sauve = JSON.parse(lireSession(CLE_FIL) || "[]"); } catch (e) { sauve = []; }
    if (!sauve.length) { accueil(); return; }
    fil.innerHTML = "";
    historique = sauve;
    afficher("asst-msg asst-lui", "<p>Bonjour 👋 Je lis les données de l'app : planning, interventions, rapports Kizeo, campagnes, garanties, facturation et devis. Je ne modifie rien.</p>");
    sauve.forEach(m => afficher(m.classe, m.html));
    btn.classList.add("en-cours");
  }

  const ouvrir = () => { panel.classList.add("ouvert"); btn.style.display = "none"; ecrireSession(CLE_ETAT, "ouvert"); fil.scrollTop = fil.scrollHeight; zone.focus(); };
  const reduire = () => { panel.classList.remove("ouvert"); btn.style.display = ""; ecrireSession(CLE_ETAT, "reduit"); };

  async function poser(question) {
    question = question.trim();
    if (!question || enCours) return;
    enCours = true; envoyer.disabled = true; zone.value = ""; ecrireSession(CLE_BROUILLON, null);
    fil.querySelector(".asst-exemples")?.remove();
    ajouter("asst-msg asst-moi", echapper(question));
    const attente = afficher("asst-attente", "L'assistant consulte les données…");
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Session expirée, reconnecte-toi.");
      const rep = await fetch(URL_AGENT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + await user.getIdToken() },
        body: JSON.stringify({ question, conversationId }),
      });
      const data = await rep.json().catch(() => ({}));
      if (!rep.ok) throw new Error(data.erreur || "Erreur " + rep.status);
      conversationId = data.conversationId || null;
      ecrireSession(CLE_CONV, conversationId);
      attente.remove();
      ajouter("asst-msg asst-lui", versHtml(data.reponse || ""));
      if (data.avertissement) afficher("asst-attente", echapper(data.avertissement));
    } catch (e) {
      attente.remove();
      ajouter("asst-err", echapper(e.message || "Erreur inattendue"));
    } finally {
      enCours = false; envoyer.disabled = false; zone.focus();
    }
  }

  const nouvelleConversation = () => {
    conversationId = null;
    ecrireSession(CLE_CONV, null);
    accueil();
  };

  btn.addEventListener("click", ouvrir);
  panel.querySelector('[data-a="reduire"]').addEventListener("click", reduire);
  panel.querySelector('[data-a="fermer"]').addEventListener("click", () => {
    nouvelleConversation();
    zone.value = ""; ecrireSession(CLE_BROUILLON, null);
    reduire();
  });
  panel.querySelector('[data-a="nouveau"]').addEventListener("click", nouvelleConversation);
  envoyer.addEventListener("click", () => poser(zone.value));
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); poser(zone.value); } });
  zone.addEventListener("input", () => {
    zone.style.height = "auto"; zone.style.height = Math.min(zone.scrollHeight, 110) + "px";
    ecrireSession(CLE_BROUILLON, zone.value || null);
  });

  // Reprise de l'état laissé sur la page précédente : fil, brouillon, panneau ouvert ou réduit.
  restaurer();
  zone.value = lireSession(CLE_BROUILLON) || "";
  if (lireSession(CLE_ETAT) === "ouvert") ouvrir();
}
