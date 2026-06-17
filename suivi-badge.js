import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const FC = {
  apiKey: "AIzaSyC4tyhE8qxOE2_6P8FPgS56XYJoTbR5qPY",
  authDomain: "belledonne-client.firebaseapp.com",
  projectId: "belledonne-client",
  storageBucket: "belledonne-client.firebasestorage.app",
  messagingSenderId: "737384028313",
  appId: "1:737384028313:web:700aee1467ac27d0c58008"
};

const app = getApps().length ? getApps()[0] : initializeApp(FC);
const db = getFirestore(app, "belledonne-client");

const KEY = 'bel_suivi_seen';
const getLastSeen = () => localStorage.getItem(KEY) || '2020-01-01T00:00:00.000Z';
const markSeen = () => localStorage.setItem(KEY, new Date().toISOString());

function setup() {
  // Sur suivi.html : marquer tout comme vu immédiatement, pas de badge nécessaire
  if (window.location.pathname.endsWith('suivi.html')) {
    markSeen();
    return;
  }

  const links = document.querySelectorAll('a[href="suivi.html"]');
  if (!links.length) return;

  const badges = Array.from(links).map(link => {
    const b = document.createElement('span');
    b.className = 'nav-badge';
    b.style.display = 'none';
    link.appendChild(b);
    link.addEventListener('click', markSeen);
    return b;
  });

  onSnapshot(
    query(collection(db, 'suivi'), where('source', '==', 'auto'), where('createdAt', '>', getLastSeen())),
    snap => {
      const n = snap.size;
      badges.forEach(b => {
        b.textContent = n;
        b.style.display = n ? '' : 'none';
      });
    }
  );
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', setup)
  : setup();
