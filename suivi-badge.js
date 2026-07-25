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
