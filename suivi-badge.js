import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const FC = {
  apiKey: "AIzaSyC4tyhE8qxOE2_6P8FPgS56XYJoTbR5qPY",
  authDomain: "belledonne-client.firebaseapp.com",
  projectId: "belledonne-client",
  storageBucket: "belledonne-client.firebasestorage.app",
  messagingSenderId: "737384028313",
  appId: "1:737384028313:web:700aee1467ac27d0c58008"
};

const app = getApps().length ? getApps()[0] : initializeApp(FC);
const auth = getAuth(app);
const db = getFirestore(app, "belledonne-client");

function setup() {
  const links = document.querySelectorAll('a[href="suivi.html"]');
  if (!links.length) return;

  const badges = Array.from(links).map(link => {
    const b = document.createElement('span');
    b.className = 'nav-badge';
    b.style.display = 'none';
    link.appendChild(b);
    return b;
  });

  // Liens strictement internes : masqués par défaut, réaffichés seulement pour l'admin.
  // Ils ne doivent JAMAIS apparaître (même vides) côté client.
  const internalLinks = document.querySelectorAll('a[href="suivi.html"], a[href="facturation.html"]');
  internalLinks.forEach(el => { el.style.display = 'none'; });

  onAuthStateChanged(auth, async user => {
    if (!user) return;

    // Le dépôt des rapports se fait désormais depuis le Suivi (par passage).
    // On retire donc le lien "Rapports" de la sidebar côté admin uniquement.
    // Le client (bailleur) garde son accès à la page rapports.html inchangé.
    let isAdmin = false;
    try {
      // Rôle depuis le custom claim (source de vérité), repli sur la collection users.
      const tok = await user.getIdTokenResult();
      let role = tok.claims && tok.claims.role ? tok.claims.role : null;
      if (user.email === 'belledonne.multiservices@gmail.com') role = 'admin';
      if (!role) {
        const snapU = await getDocs(query(collection(db, 'users'), where('uid', '==', user.uid)));
        role = snapU.empty ? 'client' : (snapU.docs[0].data().role || 'client');
      }
      isAdmin = (role === 'admin' || role === 'administrateur');
      if (isAdmin) {
        // Admin : on réaffiche les liens internes masqués par défaut.
        internalLinks.forEach(el => { el.style.display = ''; });
        document.querySelectorAll('a.nav-item[href="rapports.html"]').forEach(el => el.style.display = 'none');
        // Injecter le lien "Services & conso" dans la sidebar admin (si absent)
        if (!document.querySelector('a.nav-item[href="services.html"]')) {
          const anchor = document.querySelector('a.nav-item[href="imports.html"]') ||
                         document.querySelector('a.nav-item[href="techniciens.html"]');
          if (anchor && anchor.parentNode) {
            const a = document.createElement('a');
            a.className = 'nav-item';
            a.href = 'services.html';
            a.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg><span>Services &amp; conso</span>';
            anchor.parentNode.insertBefore(a, anchor.nextSibling);
          }
        }
        // Injecter le lien "Formulaires Kizeo" (config) dans la sidebar admin (si absent)
        if (!document.querySelector('a.nav-item[href="kizeo-config.html"]')) {
          const anchorK = document.querySelector('a.nav-item[href="imports.html"]') ||
                          document.querySelector('a.nav-item[href="techniciens.html"]');
          if (anchorK && anchorK.parentNode) {
            const a = document.createElement('a');
            a.className = 'nav-item';
            a.href = 'kizeo-config.html';
            a.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg><span>Formulaires Kizeo</span>';
            anchorK.parentNode.insertBefore(a, anchorK.nextSibling);
          }
        }
        // Injecter le lien "Gestion rapports" (suivi des demandes + réception Kizeo) dans la sidebar admin (si absent)
        // Juste sous "Suivi interventions".
        if (!document.querySelector('a.nav-item[href="gestion-rapports.html"]')) {
          const anchorR = document.querySelector('a.nav-item[href="suivi.html"]');
          if (anchorR && anchorR.parentNode) {
            const a = document.createElement('a');
            a.className = 'nav-item';
            a.href = 'gestion-rapports.html';
            a.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg><span>Gestion rapports</span>';
            anchorR.parentNode.insertBefore(a, anchorR.nextSibling);
          }
        }
      }
    } catch (e) { /* en cas d'échec, on ne masque rien */ }

    // Badge "À valider" : réservé aux admins (collection suivi cloisonnée admin-only).
    if (!isAdmin) return;
    onSnapshot(
      query(collection(db, 'suivi'), where('statut', '==', 'À valider')),
      snap => {
        const n = snap.size;
        badges.forEach(b => {
          b.textContent = n;
          b.style.display = n ? '' : 'none';
        });
      },
      err => console.error('suivi-badge:', err)
    );
  });
}

// ── Bandeau "Mode assistance" (impersonation) : affiché sur toute page si la
//    session courante a été ouverte par un admin via "Se connecter en tant que". ──
function assistBanner() {
  onAuthStateChanged(auth, async user => {
    if (!user) return;
    let claims = {};
    try { claims = (await user.getIdTokenResult()).claims || {}; } catch(e) { return; }
    if (!claims.impersonatedBy) return;
    if (document.getElementById('assist-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'assist-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#B91C1C;color:#fff;font-family:sans-serif;font-size:13px;font-weight:600;padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:16px;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
    bar.innerHTML = 'Mode assistance : connecté en tant que ' + (user.email || 'client') +
      ' <button id="assist-exit" style="background:#fff;color:#B91C1C;border:none;border-radius:6px;padding:4px 12px;font-weight:700;cursor:pointer;font-size:12px;">Quitter le mode assistance</button>';
    document.body.appendChild(bar);
    document.body.style.paddingTop = (document.body.style.paddingTop ? '' : '40px');
    document.getElementById('assist-exit').addEventListener('click', async () => {
      await signOut(auth);
      window.location.href = 'login.html';
    });
  });
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', () => { setup(); assistBanner(); })
  : (setup(), assistBanner());
