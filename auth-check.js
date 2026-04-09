/**
 * auth-check.js
 * À inclure en <script type="module"> sur chaque page protégée.
 * - Redirige vers login.html si non connecté
 * - Masque les boutons d'ajout si rôle = "client"
 * - Retourne { user, profile } pour utilisation locale
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC4tyhE8qxOE2_6P8FPgS56XYJoTbR5qPY",
  authDomain: "belledonne-client.firebaseapp.com",
  projectId: "belledonne-client",
  storageBucket: "belledonne-client.firebasestorage.app",
  messagingSenderId: "737384028313",
  appId: "1:737384028313:web:700aee1467ac27d0c58008"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

export { auth, db };

export function checkAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) { window.location.href = 'login.html'; return; }

      // Récupérer le profil depuis Firestore
      let profile = { role: 'client', client: null };
      try {
        const snap = await getDocs(query(collection(db, 'users'), where('uid', '==', user.uid)));
        if (!snap.empty) profile = snap.docs[0].data();
      } catch(e) {}

      // Si client → masquer tous les boutons d'ajout/upload
      if (profile.role === 'client') {
        document.querySelectorAll(
          '.btn-open-modal, #btnAjouter, #btnOpenModal, #btnNewCampagne, .btn-admin-only'
        ).forEach(el => el.style.display = 'none');
      }

      // Exposer le profil globalement
      window.__userProfile = profile;
      window.__userAuth    = user;

      resolve({ user, profile });
    });
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = 'login.html';
}
