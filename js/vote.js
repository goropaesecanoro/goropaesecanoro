// ══════════════════════════════════════════════
//  vote.js — Logica votazione e stato app
// ══════════════════════════════════════════════
import {
  auth, db, showScreen, showToast,
  DEFAULT_SINGERS, POINTS, SERATA_LABELS
} from './firebase-init.js';
import { isAdmin } from './auth.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, getDocs,
  collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Stato ─────────────────────────────────────
let currentUser   = null;
let currentSerata = 1;
let singers       = []; // [{name, song}]
let selections    = [null,null,null,null,null];
let appConfig     = {};
let unsubConfig   = null;

// Helper: normalizza entry singer — accetta sia stringa che oggetto
function normSinger(s) {
  return typeof s === 'string' ? { name: s, song: '' } : s;
}

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
export async function initVoteApp() {
  const { onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  unsubConfig = onSnapshot(doc(db,'config','current'), snap => {
    if (snap.exists()) {
      appConfig     = snap.data();
      currentSerata = appConfig.serata || 1;
      updateSerataUI();
      if (currentUser) evaluateState(currentUser);
    }
  });

  onAuthStateChanged(auth, async user => {
    currentUser = user;
    if (!user) { showScreen('screen-hero'); return; }
    await evaluateState(user);
  });
}

async function evaluateState(user) {
  if (await isAdmin(user.uid)) {
    window.location.href = 'admin.html';
    return;
  }
  await loadSingers();
  updateSerataUI();

  if (!appConfig.votoAperto) {
    await showClosedScreen();
    return;
  }

  const voteSnap = await getDoc(doc(db, `votes_s${currentSerata}`, user.uid));
  if (voteSnap.exists()) {
    renderSummaryTable('already-summary', voteSnap.data().vote);
    showScreen('screen-already');
  } else {
    setupVotingScreen(user);
    showScreen('screen-voting');
  }
}

// ══════════════════════════════════════════════
//  SCHERMATA CHIUSA
// ══════════════════════════════════════════════
async function showClosedScreen() {
  const randomNote = document.getElementById('closed-random-note');
  if (randomNote) randomNote.style.display = 'none';
  const dynEl = document.getElementById('closed-dynamic');
  if (dynEl) dynEl.innerHTML = '';

  if (appConfig.svelaClassifica && currentSerata === 3) {
    await renderReveal();
    showScreen('screen-reveal');
    return;
  }

  const el = document.getElementById('closed-dynamic');
  if (appConfig.mostraTop5) {
    const snap     = await getDocs(collection(db, `votes_s${currentSerata}`));
    const allVotes = []; snap.forEach(d => allVotes.push(d.data()));

    const scores = {};
    singers.forEach(s => scores[s.name] = 0);
    allVotes.forEach(({vote}) =>
      vote?.forEach((name,i) => { if (scores[name] !== undefined) scores[name] += POINTS[i]; })
    );
    const top5 = Object.entries(scores)
      .sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([name]) => name)
      .sort(() => Math.random() - 0.5);

    document.getElementById('closed-random-note').style.display = 'block';
    el.innerHTML = `
      <div class="top5-section">
        <div class="top5-label">I più apprezzati stasera</div>
        ${top5.map(name => `
          <div class="top5-card">
            <div class="top5-dot"></div>
            <div class="top5-name">${name}</div>
          </div>`).join('')}
      </div>`;
  } else {
    el.innerHTML = '';
  }
  showScreen('screen-closed');
}

async function renderReveal() {
  try {
    const saved = await getDoc(doc(db,'config','finalRanking'));
    if (saved.exists()) {
      const ranking = saved.data().ranking;
      const labels  = ['🥇','🥈','🥉','4°','5°','6°','7°','8°','9°','10°','11°','12°','13°','14°'];
      document.getElementById('reveal-ranking').innerHTML =
        ranking.map((c,i) => `
          <div class="summary-row">
            <span class="s-rank" style="font-size:20px">${labels[i]||''}</span>
            <span class="s-name">${c.name || c}</span>
          </div>`).join('');
      return;
    }
  } catch(e) {}

  const snap = await getDocs(collection(db,'votes_s3'));
  const allVotes = []; snap.forEach(d => allVotes.push(d.data()));
  const scores   = {}; singers.forEach(s => scores[s.name] = 0);
  allVotes.forEach(({vote}) =>
    vote?.forEach((name,i) => { if(scores[name]!==undefined) scores[name]+=POINTS[i]; })
  );
  const ranking = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  const labels  = ['🥇','🥈','🥉','4°','5°','6°','7°','8°','9°','10°','11°','12°','13°','14°'];
  document.getElementById('reveal-ranking').innerHTML =
    ranking.map(([name],i) => `
      <div class="summary-row">
        <span class="s-rank" style="font-size:20px">${labels[i]||''}</span>
        <span class="s-name">${name}</span>
      </div>`).join('');
}

// ══════════════════════════════════════════════
//  CANTANTI
// ══════════════════════════════════════════════
async function loadSingers() {
  try {
    if (currentSerata === 3) {
      const [s1, s2] = await Promise.all([
        getDoc(doc(db,'singers','s1')),
        getDoc(doc(db,'singers','s2'))
      ]);
      const list1 = s1.exists() ? s1.data().list : DEFAULT_SINGERS[1];
      const list2 = s2.exists() ? s2.data().list : DEFAULT_SINGERS[2];
      singers = [...list1, ...list2].map(normSinger);
    } else {
      const snap = await getDoc(doc(db,'singers',`s${currentSerata}`));
      const list = snap.exists() ? snap.data().list : DEFAULT_SINGERS[currentSerata];
      singers = list.map(normSinger);
    }
  } catch(e) {
    const fallback = currentSerata === 3
      ? [...DEFAULT_SINGERS[1], ...DEFAULT_SINGERS[2]]
      : (DEFAULT_SINGERS[currentSerata] || []);
    singers = fallback.map(normSinger);
  }
}

// ══════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════
function updateSerataUI() {
  const lbl = SERATA_LABELS[currentSerata] || '';
  const h   = document.getElementById('hero-serata-label');
  if (h) h.textContent = appConfig.votoAperto !== false
    ? `In corso: ${lbl}` : `${lbl} — Votazioni chiuse`;
  const v = document.getElementById('serata-label-voting');
  if (v) v.textContent = lbl;
}

function setupVotingScreen(user) {
  const name    = user.displayName || user.phoneNumber || user.email || 'Ospite';
  const isPhone = name.startsWith('+');
  document.getElementById('user-initials').textContent =
    isPhone ? '📱' : name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('user-name-short').textContent =
    isPhone ? ('…'+name.slice(-4)) : name.split(' ')[0];

  selections = [null,null,null,null,null];
  renderSingers();
  renderSlots();
  updateAll();
}

// ── Card cantante con nome + canzone ──────────
function renderSingers() {
  const grid = document.getElementById('singers-grid');
  grid.innerHTML = '';
  singers.forEach((s,i) => {
    const ini = s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const d   = document.createElement('div');
    d.className = 'singer-card'; d.id = `sc-${i}`;
    d.onclick   = () => toggleSinger(i);
    d.innerHTML = `
      <div class="singer-avatar av-${(i%16)+1}">${ini}</div>
      <div class="singer-info">
        <div class="singer-name">${s.name}</div>
        ${s.song ? `<div class="singer-song">♪ ${s.song}</div>` : ''}
      </div>
      <div class="singer-rank-badge" id="srb-${i}"></div>`;
    grid.appendChild(d);
  });
}

// ── Slot riepilogo ────────────────────────────
function renderSlots() {
  const c = document.getElementById('slots');
  c.innerHTML = '';
  ['1°','2°','3°','4°','5°'].forEach((lbl,i) => {
    const d = document.createElement('div');
    d.className = 'slot slot-medal-' + (i+1); d.dataset.pos = i;
    d.innerHTML = `
      <div class="slot-medal">${getMedal(i)}</div>
      <div class="slot-info">
        <span class="slot-name slot-empty">—</span>
        <span class="slot-song"></span>
      </div>
      <button class="slot-remove" onclick="removeFromSlot(${i})" aria-label="Rimuovi">✕</button>`;
    c.appendChild(d);
  });
}

function getMedal(i) {
  return ['🥇','🥈','🥉','4°','5°'][i];
}

// ══════════════════════════════════════════════
//  SELEZIONE
// ══════════════════════════════════════════════
function toggleSinger(idx) {
  const pos = selections.indexOf(idx);
  if (pos !== -1) {
    selections[pos] = null;
  } else {
    const next = selections.indexOf(null);
    if (next === -1) { showToast('Hai già scelto 5 cantanti'); return; }
    selections[next] = idx;
  }
  updateAll();
}

function removeFromSlot(pos) {
  selections[pos] = null;
  updateAll();
}

function updateAll() {
  selections.forEach((idx,i) => {
    const slot   = document.querySelector(`.slot[data-pos="${i}"]`);
    if (!slot) return;
    const nameEl = slot.querySelector('.slot-name');
    const songEl = slot.querySelector('.slot-song');
    if (idx !== null) {
      slot.classList.add('filled');
      nameEl.textContent = singers[idx].name;
      nameEl.classList.remove('slot-empty');
      if (songEl) songEl.textContent = singers[idx].song ? `♪ ${singers[idx].song}` : '';
    } else {
      slot.classList.remove('filled');
      nameEl.textContent = '—';
      nameEl.classList.add('slot-empty');
      if (songEl) songEl.textContent = '';
    }
  });

  const anyNull = selections.includes(null);
  singers.forEach((_,i) => {
    const card  = document.getElementById(`sc-${i}`);
    const badge = document.getElementById(`srb-${i}`);
    if (!card) return;
    const pos = selections.indexOf(i);
    if (pos !== -1) {
      card.classList.add('selected');
      card.classList.remove('full');
      badge.textContent = pos + 1;
    } else {
      card.classList.remove('selected');
      card.classList.toggle('full', !anyNull);
      badge.textContent = '';
    }
  });

  updateProgress();
}

function updateProgress() {
  const filled = selections.filter(s => s !== null).length;
  document.getElementById('progress-fill').style.width = (filled/5*100)+'%';
  document.getElementById('progress-text').textContent = `${filled} di 5 selezionati`;
  document.getElementById('btn-submit').disabled = filled < 5 || selections.includes(null);
}

// ══════════════════════════════════════════════
//  SUBMIT — salva solo i nomi (compatibile con Z-score)
// ══════════════════════════════════════════════
async function submitVote() {
  if (!currentUser) return;
  const vote = selections.map(i => singers[i].name);
  const btn  = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Salvataggio…';
  try {
    await setDoc(doc(db, `votes_s${currentSerata}`, currentUser.uid), {
      vote, uid: currentUser.uid, serata: currentSerata,
      name: currentUser.displayName || currentUser.phoneNumber || currentUser.email || 'Ospite',
      timestamp: serverTimestamp()
    });
    renderSummaryTable('thanks-summary', vote);
    showScreen('screen-thanks');
  } catch(e) {
    showToast('Errore durante il salvataggio. Riprova.');
    btn.disabled = false; btn.textContent = 'Conferma il voto 🎤';
  }
}

// ── Summary table (solo nomi, dopo il voto) ───
export function renderSummaryTable(id, vote) {
  const medals = ['🥇','🥈','🥉','4°','5°'];
  document.getElementById(id).innerHTML =
    `<div class="summary-label">Il tuo voto — ${SERATA_LABELS[currentSerata]}</div>` +
    vote.map((name,i) => `
      <div class="summary-row">
        <span class="s-rank" style="font-size:22px">${medals[i]}</span>
        <span class="s-name">${name}</span>
      </div>`).join('');
}

// ══════════════════════════════════════════════
//  OVERLAY CONFERMA VOTO
// ══════════════════════════════════════════════
function showConfirmOverlay() {
  const medals  = ['🥇','🥈','🥉','4°','5°'];
  const preview = document.getElementById('confirm-vote-preview');
  preview.innerHTML = selections.map((idx,i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:20px;width:32px;text-align:center">${medals[i]}</span>
      <div>
        <div style="font-size:14px;font-weight:500">${singers[idx].name}</div>
        ${singers[idx].song ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">♪ ${singers[idx].song}</div>` : ''}
      </div>
    </div>`).join('');
  document.getElementById('overlay-confirm-vote').style.display = 'flex';
}

function closeConfirmOverlay() {
  document.getElementById('overlay-confirm-vote').style.display = 'none';
}

// ── Expose ────────────────────────────────────
window.showConfirmOverlay  = showConfirmOverlay;
window.closeConfirmOverlay = closeConfirmOverlay;
window.confirmAndSend      = () => { closeConfirmOverlay(); submitVote(); };
window.toggleSinger        = toggleSinger;
window.removeFromSlot      = removeFromSlot;
window.submitVote          = submitVote;
