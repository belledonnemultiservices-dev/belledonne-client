import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
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
    try {
      const snapU = await getDocs(query(collection(db, 'users'), where('uid', '==', user.uid)));
      const role = snapU.empty ? 'client' : (snapU.docs[0].data().role || 'client');
      if (role === 'admin' || role === 'administrateur') {
        document.querySelectorAll('a.nav-item[href="rapports.html"]').forEach(el => el.style.display = 'none');
      }
    } catch (e) { /* en cas d'échec, on ne masque rien */ }

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

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', setup)
  : setup();
