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
        ${top5.map(name => {
          const song = singers.find(s=>s.name===name)?.song || '';
          return `
          <div class="top5-card">
            <div class="top5-dot"></div>
            <div class="s-info">
              <div class="s-name">${name}</div>
              ${song ? `<div class="s-song">♪ ${song}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
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
      // Costruisci songMap da singers caricati
      const songMap = {};
      singers.forEach(s => { songMap[s.name] = s.song || ''; });
      document.getElementById('reveal-ranking').innerHTML =
        ranking.map((c,i) => {
          const name = c.name || c;
          const song = songMap[name] || '';
          return `
          <div class="summary-row">
            <span class="s-rank" style="font-size:20px">${labels[i]||''}</span>
            <div class="s-info">
              <div class="s-name">${name}</div>
              ${song ? `<div class="s-song">♪ ${song}</div>` : ''}
            </div>
          </div>`;
        }).join('');
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
  const songMap2 = {};
  singers.forEach(s => { songMap2[s.name] = s.song || ''; });
  document.getElementById('reveal-ranking').innerHTML =
    ranking.map(([name],i) => {
      const song = songMap2[name] || '';
      return `
      <div class="summary-row">
        <span class="s-rank" style="font-size:20px">${labels[i]||''}</span>
        <div class="s-info">
          <div class="s-name">${name}</div>
          ${song ? `<div class="s-song">♪ ${song}</div>` : ''}
        </div>
      </div>`;
    }).join('');
}

// ══════════════════════════════════════════════
//  CANTANTI
// ══════════════════════════════════════════════
async function loadSingers() {
  try {
    if (currentSerata === 3) {
      const [s1, s2, s3] = await Promise.all([
        getDoc(doc(db,'singers','s1')),
        getDoc(doc(db,'singers','s2')),
        getDoc(doc(db,'singers','s3'))
      ]);
      if (s3.exists() && s3.data().list?.length > 0) {
        // Usa ordine finale salvato dall'admin
        singers = s3.data().list.map(normSinger);
      } else {
        // Fallback: S1 + S2 in ordine naturale
        const list1 = s1.exists() ? s1.data().list : DEFAULT_SINGERS[1];
        const list2 = s2.exists() ? s2.data().list : DEFAULT_SINGERS[2];
        singers = [...list1, ...list2].map(normSinger);
      }
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

// ── Summary table (nome + canzone) ───────────
export function renderSummaryTable(id, vote) {
  const medals  = ['🥇','🥈','🥉','4°','5°'];
  // Mappa nome→canzone dai singers caricati (se disponibili)
  const songMap = {};
  singers.forEach(s => { songMap[s.name] = s.song || ''; });

  document.getElementById(id).innerHTML =
    `<div class="summary-label">Il tuo voto — ${SERATA_LABELS[currentSerata]}</div>` +
    vote.map((name,i) => `
      <div class="summary-row">
        <span class="s-rank" style="font-size:22px">${medals[i]}</span>
        <div class="s-info">
          <span class="s-name">${name}</span>
          ${songMap[name] ? `<span class="s-song">♪ ${songMap[name]}</span>` : ''}
        </div>
      </div>`).join('');
}

// ══════════════════════════════════════════════
//  OVERLAY CONFERMA VOTO
// ══════════════════════════════════════════════
function showConfirmOverlay() {
  const medals  = ['🥇','🥈','🥉','4°','5°'];
  const preview = document.getElementById('confirm-vote-preview');
  preview.innerHTML = selections.map((idx,i) => `
    <div class="summary-row">
      <span class="s-rank" style="font-size:20px">${medals[i]}</span>
      <div class="s-info">
        <div class="s-name">${singers[idx].name}</div>
        ${singers[idx].song ? `<div class="s-song">♪ ${singers[idx].song}</div>` : ''}
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
