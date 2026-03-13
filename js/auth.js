// ══════════════════════════════════════════════
//  auth.js — Google + Phone authentication
// ══════════════════════════════════════════════
import { auth, db, showScreen, showToast } from './firebase-init.js';
import {
  GoogleAuthProvider,
  PhoneAuthProvider,
  RecaptchaVerifier,
  signInWithPopup,
  signInWithPhoneNumber,
  signInWithCredential,
  signOut as fbSignOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let confirmResult = null;

// ── Google Login ──────────────────────────────
export async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') showToast('Accesso non riuscito. Riprova.');
  }
}

// ── Phone Login ───────────────────────────────
export function showPhoneAuth() {
  showScreen('screen-phone');
  document.getElementById('phone-step-1').style.display = '';
  document.getElementById('phone-step-2').style.display = 'none';
  document.body.classList.add('show-recaptcha');
  // Aggiorna il testo del pulsante se c'è un codice pendente
  const savedNum = sessionStorage.getItem('phoneAuthNumber');
  const btnHave  = document.getElementById('btn-have-code');
  if (btnHave) {
    btnHave.textContent = savedNum
      ? `Ho già il codice per ${savedNum}`
      : 'Ho già un codice';
  }
  initRecaptcha();
}

function initRecaptcha() {
  // Pulisci container e istanza precedente
  if (window._rcv) {
    try { window._rcv.clear(); } catch(e) {}
    window._rcv = null;
  }
  // Svuota il container per evitare "already rendered"
  const container = document.getElementById('recaptcha-container');
  if (container) container.innerHTML = '';

  window._rcv = new RecaptchaVerifier(auth, 'recaptcha-container', {
    size: 'invisible',
    callback: () => {},
    'error-callback': () => {
      showToast('reCAPTCHA non disponibile. Ricarica la pagina.');
      window._rcv = null;
    }
  });
}

export async function sendSMS() {
  const prefix = document.getElementById('phone-prefix').value.trim();
  const num    = document.getElementById('phone-number').value.trim().replace(/\s/g,'');
  if (num.length < 8) { showToast('Numero non valido'); return; }

  const fullNumber = prefix + num;
  const btn = document.getElementById('btn-send-sms');
  btn.disabled = true; btn.textContent = 'Invio…';

  try {
    if (!window._rcv) initRecaptcha();
    // Render esplicito — necessario prima di ogni tentativo
    await window._rcv.render().catch(() => {});
    confirmResult = await signInWithPhoneNumber(auth, fullNumber, window._rcv);
    document.getElementById('otp-sent-to').textContent = `Codice inviato al ${fullNumber}.`;
    // Salva il numero in sessionStorage così sopravvive a uscita/ritorno
    sessionStorage.setItem('phoneAuthNumber', fullNumber);
    sessionStorage.setItem('phoneAuthPending', '1');
    document.getElementById('phone-step-1').style.display = 'none';
    document.getElementById('phone-step-2').style.display = '';
    setupOTPInputs();
    document.getElementById('otp-0').focus();
  } catch(e) {
    console.error('Phone auth error:', e.code, e.message);
    let msg = 'Errore: ';
    if (e.code === 'auth/invalid-phone-number')  msg += 'numero non valido. Usa formato +39XXXXXXXXXX';
    else if (e.code === 'auth/too-many-requests') msg += 'troppi tentativi, riprova tra poco';
    else if (e.code === 'auth/captcha-check-failed') msg += 'reCAPTCHA fallito, ricarica la pagina';
    else if (e.code === 'auth/quota-exceeded')    msg += 'quota SMS esaurita';
    else if (e.code === 'auth/billing-not-enabled') msg += 'attiva il piano Blaze su Firebase Console per usare gli SMS';
    else msg += (e.code || e.message);
    showToast(msg, 5000);
    btn.disabled = false; btn.textContent = 'Invia SMS';
    // Ricrea il verifier — dopo un errore è consumato
    initRecaptcha();
  }
}

function setupOTPInputs() {
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById(`otp-${i}`);
    el.value = '';
    el.oninput = e => {
      if (e.target.value.length === 1 && i < 5)
        document.getElementById(`otp-${i+1}`).focus();
      if (getOTPCode().length === 6) verifyOTP();
    };
    el.onkeydown = e => {
      if (e.key === 'Backspace' && !el.value && i > 0)
        document.getElementById(`otp-${i-1}`).focus();
    };
  }
}

function getOTPCode() {
  return Array.from({length:6}, (_,i) =>
    document.getElementById(`otp-${i}`).value).join('');
}

export async function verifyOTP() {
  const code = getOTPCode();
  if (code.length < 6) { showToast('Inserisci tutte le 6 cifre'); return; }
  const btn = document.getElementById('btn-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifica…';
  try {
    const cred = PhoneAuthProvider.credential(confirmResult.verificationId, code);
    await signInWithCredential(auth, cred);
    sessionStorage.removeItem('phoneAuthPending');
    sessionStorage.removeItem('phoneAuthNumber');
  } catch(e) {
    showToast('Codice non corretto. Riprova.');
    btn.disabled = false; btn.textContent = 'Verifica e accedi';
    for (let i = 0; i < 6; i++) document.getElementById(`otp-${i}`).value = '';
    document.getElementById('otp-0').focus();
  }
}

export function backToPhoneStep1() {
  document.getElementById('phone-step-1').style.display = '';
  document.getElementById('phone-step-2').style.display = 'none';
  const btn = document.getElementById('btn-send-sms');
  btn.disabled = false; btn.textContent = 'Invia SMS con codice';
  // Non cancellare sessionStorage qui — l'utente potrebbe voler riusare il codice
}

export function showHaveCode() {
  // Prova prima il numero nel campo, poi il sessionStorage
  const prefix    = document.getElementById('phone-prefix')?.value.trim() || '+39';
  const numInput  = document.getElementById('phone-number')?.value.trim().replace(/\s/g,'') || '';
  const savedNum  = sessionStorage.getItem('phoneAuthNumber');
  const fullNumber = numInput.length >= 8 ? prefix + numInput : savedNum;
  if (!fullNumber) {
    showToast('Inserisci prima il numero di telefono');
    document.getElementById('phone-number')?.focus();
    return;
  }
  // Mostra direttamente lo step inserimento codice
  document.getElementById('phone-step-1').style.display = 'none';
  document.getElementById('phone-step-2').style.display = '';
  document.getElementById('otp-sent-to').textContent =
    `Inserisci il codice ricevuto per ${fullNumber}.`;
  setupOTPInputs();
  document.getElementById('otp-0').focus();
}

function hideRecaptchaBadge() {
  document.body.classList.remove('show-recaptcha');
}

// ── Sign Out ──────────────────────────────────
export async function signOutUser() {
  await fbSignOut(auth);
  hideRecaptchaBadge();
  showScreen('screen-hero');
}

// ── Admin check ───────────────────────────────
export async function isAdmin(uid) {
  try {
    const snap = await getDoc(doc(db, 'admins', uid));
    return snap.exists();
  } catch(e) { return false; }
}

// ── Expose to window ──────────────────────────
window.signInWithGoogle  = signInWithGoogle;
window.showPhoneAuth     = showPhoneAuth;
window.sendSMS           = sendSMS;
window.verifyOTP         = verifyOTP;
window.backToPhoneStep1  = () => { hideRecaptchaBadge(); backToPhoneStep1(); };
window.signOutUser       = signOutUser;
window.showHaveCode      = showHaveCode;

// Aggancia il pulsante "Ho già un codice" via addEventListener
// (più affidabile di onclick="" con ES modules)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-have-code')
    ?.addEventListener('click', showHaveCode);
});
