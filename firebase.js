// ── FIREBASE CONFIG ──────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, orderBy, doc, updateDoc, deleteDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

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
const storage = getStorage(app);

// ── AUTH ──────────────────────────────────────────────────────────

/** Connexion email/mdp */
async function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/** Déconnexion */
async function logout() {
  return signOut(auth);
}

/**
 * Garde de page : redirige vers login.html si l'utilisateur n'est pas connecté.
 * Résout avec l'utilisateur courant + ses métadonnées (client, role).
 */
function requireAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "login.html";
        return;
      }
      // Récupérer les infos du profil depuis Firestore
      try {
        const snap = await getDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
        if (!snap.empty) {
          const profile = snap.docs[0].data();
          resolve({ user, profile });
        } else {
          resolve({ user, profile: { client: null, role: "client" } });
        }
      } catch (e) {
        resolve({ user, profile: { client: null, role: "client" } });
      }
    });
  });
}

// ── FIRESTORE HELPERS ─────────────────────────────────────────────

/** Ajouter un document dans une collection */
async function addDocument(collectionName, data) {
  return addDoc(collection(db, collectionName), {
    ...data,
    createdAt: new Date().toISOString()
  });
}

/** Récupérer tous les documents filtrés par client */
async function getDocumentsByClient(collectionName, clientName) {
  const q = query(
    collection(db, collectionName),
    where("client", "==", clientName),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Mettre à jour un document */
async function updateDocument(collectionName, docId, data) {
  return updateDoc(doc(db, collectionName, docId), data);
}

/** Supprimer un document */
async function deleteDocument(collectionName, docId) {
  return deleteDoc(doc(db, collectionName, docId));
}

// ── STORAGE HELPERS ───────────────────────────────────────────────

/** Uploader un fichier PDF */
async function uploadFile(file, path) {
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

// ── EXPORTS ───────────────────────────────────────────────────────
export {
  auth, db, storage,
  login, logout, requireAuth,
  addDocument, getDocumentsByClient, updateDocument, deleteDocument,
  uploadFile
};
