// ══════════════════════════════════════════════
//  firebase-init.js — Config e inizializzazione
// ══════════════════════════════════════════════
import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Credenziali Firebase ──────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAFvDuG0glouoEhN1Hqrd68c6F30A11su4",
  authDomain:        "goro-paese-canoro-2026.firebaseapp.com",
  projectId:         "goro-paese-canoro-2026",
  storageBucket:     "goro-paese-canoro-2026.firebasestorage.app",
  messagingSenderId: "782054899768",
  appId:             "1:782054899768:web:84473d4d299c4f42fa26cd"
};

// ── Cantanti di default (fallback se Firestore non risponde) ──
// Modificali anche qui come backup, ma la fonte principale è Firestore
export const DEFAULT_SINGERS = {
  1: [
    "Cantante S1-1", "Cantante S1-2", "Cantante S1-3",
    "Cantante S1-4", "Cantante S1-5", "Cantante S1-6", "Cantante S1-7"
  ],
  2: [
    "Cantante S2-1", "Cantante S2-2", "Cantante S2-3",
    "Cantante S2-4", "Cantante S2-5", "Cantante S2-6", "Cantante S2-7"
  ]
};

export const POINTS        = [5, 4, 3, 2, 1];
export const SERATA_LABELS = { 1: "Serata 1", 2: "Serata 2", 3: "Serata Finale" };

// ── Init ──────────────────────────────────────
const app = initializeApp(FIREBASE_CONFIG);

export const auth = getAuth(app);
export const db   = getFirestore(app);

// ── Helpers condivisi ─────────────────────────

/** Mostra una schermata, nasconde le altre */
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

/** Toast notification */
export function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

/** SHA-256 hash (per password admin) */
export async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/** Logout forzato via ?logout nell'URL */
if (new URLSearchParams(window.location.search).has('logout')) {
  import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js")
    .then(({ signOut, onAuthStateChanged }) => {
      // Aspetta che Firebase sia pronto prima di fare signOut
      onAuthStateChanged(auth, user => {
        if (user) {
          signOut(auth).then(() => window.location.replace(window.location.pathname));
        } else {
          window.location.replace(window.location.pathname);
        }
      });
    });
}

/** Genera stelle decorative */
export function generateStars() {
  const c = document.getElementById('stars');
  if (!c) return;
  for (let i = 0; i < 55; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*100}%;--d:${2+Math.random()*4}s;--delay:${Math.random()*5}s;--op:${.3+Math.random()*.5}`;
    c.appendChild(s);
  }
}
