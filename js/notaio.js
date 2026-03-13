// ══════════════════════════════════════════════
//  notaio.js — Pannello Notaio
//  Inserimento voti giuria tecnica + calcolo classifica
// ══════════════════════════════════════════════
import { auth, db, showScreen, showToast, generateStars, DEFAULT_SINGERS, POINTS, SERATA_LABELS }
  from './firebase-init.js';
import { GoogleAuthProvider, signInWithPopup, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, getDocs, setDoc, collection, serverTimestamp, onSnapshot, deleteDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Stato locale ──────────────────────────────
let currentUser    = null;
let currentSerata  = 1;
let _unsubRights   = null; // listener revoca diritti notaio
let singers        = [];   // [{name, song}] della serata corrente
let judges         = [];   // [{name, isCritic}]
let draftVotes     = {};   // {judgeName: {singerName: {int, int}}}
let lastRanking    = null; // risultato ultimo calcolo serata
let festivalRanking = null;

// ══════════════════════════════════════════════
//  WATCHER REVOCA DIRITTI + LOCK CONCORRENZA
// ══════════════════════════════════════════════
function startNotaioRightsWatcher(uid) {
  if (_unsubRights) _unsubRights();
  let initialLoad = true;
  _unsubRights = onSnapshot(doc(db, 'notai', uid), snap => {
    if (initialLoad) { initialLoad = false; return; } // ignora lo stato iniziale
    if (!snap.exists()) {
      showToast('⚠️ Accesso revocato. Disconnessione in corso…', 3000);
      setTimeout(async () => {
        if (_unsubRights) { _unsubRights(); _unsubRights = null; }
        await signOut(auth);
        showScreen('screen-notaio-login');
      }, 2500);
    } else {
      // Diritti concessi o aggiornati: ricarica per applicare i nuovi permessi
      showToast('✅ Permessi aggiornati. Ricaricamento…', 2000);
      setTimeout(() => window.location.reload(), 2000);
    }
  }, () => {});
}

const LOCK_TTL_MS = 120_000;

async function acquireJudgeLock(serata, judgeName) {
  const key = `jury_s${serata}_${judgeName.replace(/\s+/g,'_')}`;
  const ref  = doc(db, 'editing_locks', key);
  const now  = Date.now();
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      if (d.expiresAt > now && d.uid !== currentUser?.uid) {
        showToast(`⚠️ ${d.name} sta già inserendo voti per ${judgeName}`, 4000);
        return false;
      }
    }
    await setDoc(ref, {
      uid:       currentUser.uid,
      name:      currentUser.displayName || currentUser.email || 'Notaio',
      lockedAt:  now,
      expiresAt: now + LOCK_TTL_MS,
    });
    return true;
  } catch(e) { return true; }
}

async function releaseJudgeLock(serata, judgeName) {
  if (!judgeName) return;
  const key = `jury_s${serata}_${judgeName.replace(/\s+/g,'_')}`;
  try {
    const ref  = doc(db, 'editing_locks', key);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().uid === currentUser?.uid) await deleteDoc(ref);
  } catch(e) {}
}


// ── Boot ──────────────────────────────────────
generateStars();

auth.onAuthStateChanged(async user => {
  if (!user) {
    showScreen('screen-notaio-login');
    return;
  }
  // Verifica accesso notaio
  const snap = await getDoc(doc(db, 'notai', user.uid));
  if (!snap.exists()) {
    document.getElementById('screen-loading').innerHTML =
      '<div style="text-align:center;padding:40px 24px">'
      + '<div style="font-size:48px;margin-bottom:16px">⛔</div>'
      + '<h2 style="color:var(--gold)">Accesso negato</h2>'
      + '<p style="color:var(--muted);margin-top:8px">Il tuo account non è autorizzato come Notaio.</p>'
      + '<button onclick="window.location.href=\'index.html\'" '
      + 'style="margin-top:20px;background:#1E1E35;color:#F0EDE6;border:1px solid rgba(255,255,255,.2);'
      + 'border-radius:100px;padding:12px 24px;cursor:pointer;font-size:14px">← Torna al sito</button>'
      + '</div>';
    return;
  }
  currentUser = user;
  startNotaioRightsWatcher(user.uid);
  await initNotaio();
});

async function initNotaio() {
  const name = currentUser.displayName || currentUser.email || 'Notaio';
  const init = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('notaio-user-initials').textContent = init;
  document.getElementById('notaio-user-name').textContent     = name.split(' ')[0];

  // Carica config serata
  try {
    const cfg = await getDoc(doc(db,'config','current'));
    currentSerata = cfg.exists() ? (cfg.data().serata || 1) : 1;
  } catch(e) { currentSerata = 1; }

  document.getElementById('notaio-serata-label').textContent = SERATA_LABELS[currentSerata];

  // Mostra sezione festival solo in serata 3
  document.getElementById('festival-ranking-section').style.display =
    currentSerata === 3 ? '' : 'none';

  await loadSingers();
  await loadDraftVotes();
  await loadJudges();
  await checkExistingRanking();

  showScreen('screen-notaio');
}

async function checkExistingRanking() {
  try {
    // Serata corrente
    const snap = await getDoc(doc(db,'jury_ranking',`s${currentSerata}`));
    if (snap.exists() && snap.data().ranking?.length > 0) {
      const data = snap.data();
      lastRanking = {
        serataScores:    data.ranking,
        judgeStats:      data.judgeStats || {},
        judgesWithVotes: Object.keys(data.judgeStats || {}),
        criticRanking:   data.criticRanking || null,
      };
      document.getElementById('btn-show-jury').style.display    = '';
      document.getElementById('btn-show-ranking').style.display = '';
      document.getElementById('btn-show-top3').style.display    = currentSerata === 3 ? 'none' : '';
    }
    // Festival (solo serata 3)
    if (currentSerata === 3) {
      const fsnap = await getDoc(doc(db,'jury_ranking','festival'));
      if (fsnap.exists() && fsnap.data().ranking?.length > 0) {
        festivalRanking = fsnap.data().ranking;
        document.getElementById('btn-show-festival').style.display = '';
        const csnap = await getDoc(doc(db,'jury_ranking','s3'));
        if (csnap.exists() && csnap.data().criticRanking?.length > 0) {
          document.getElementById('btn-show-critica').style.display = '';
        }
      }
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════
//  CANTANTI
// ══════════════════════════════════════════════
async function loadSingers() {
  const norm = list => (list||[]).map(s => typeof s==='string' ? {name:s,song:''} : s);
  try {
    if (currentSerata === 3) {
      const [s1, s2, s3] = await Promise.all([
        getDoc(doc(db,'singers','s1')),
        getDoc(doc(db,'singers','s2')),
        getDoc(doc(db,'singers','s3'))
      ]);
      if (s3.exists() && s3.data().list?.length > 0) {
        singers = norm(s3.data().list);
      } else {
        const l1 = s1.exists() ? norm(s1.data().list) : DEFAULT_SINGERS[1];
        const l2 = s2.exists() ? norm(s2.data().list) : DEFAULT_SINGERS[2];
        singers = [...l1, ...l2];
      }
    } else {
      const snap = await getDoc(doc(db,'singers',`s${currentSerata}`));
      singers = snap.exists() ? norm(snap.data().list) : DEFAULT_SINGERS[currentSerata].map(s=>({name:String(s),song:''}));
    }
  } catch(e) {
    singers = (DEFAULT_SINGERS[currentSerata]||[]).map(s=>({name:String(s),song:''}));
  }
}

// ══════════════════════════════════════════════
//  GIUDICI
// ══════════════════════════════════════════════
async function loadJudges() {
  try {
    const snap = await getDoc(doc(db,'judges',`s${currentSerata}`));
    judges = snap.exists() ? (snap.data().list || []) : [];
  } catch(e) { judges = []; }
  renderJudgesPreview();
  renderJudgeSelector();
}

let selectedJudge = '';

function renderJudgesPreview() {
  const el = document.getElementById('judges-list-preview');
  if (judges.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:13px">Nessun giudice configurato — usa ✎ Modifica</div>';
    return;
  }
  // Normale prima, critica in fondo
  const normal = judges.filter(j => !j.isCritic);
  const critic = judges.filter(j => j.isCritic);
  const ordered = [...normal, ...critic];

  el.innerHTML = ordered.map(j => {
    const votes  = draftVotes[j.name] || {};
    const filled = singers.filter(s => { const v=votes[s.name]; return v&&v.int>0&&v.int2>0; }).length;
    const total  = singers.length;
    const done   = filled === total && total > 0;
    const sel    = selectedJudge === j.name;
    const name   = j.name.replace(/'/g, "\'");
    return `<div class="judge-select-row ${done?'done':''} ${sel?'selected':''} ${j.isCritic?'critic-row':''}"
      onclick="selectJudge('${name}')">
      <span class="judge-select-dot ${done?'done':''}"></span>
      <span class="judge-select-name">${j.isCritic ? '⭐ ' : ''}${j.name}</span>
      ${j.isCritic ? '<span class="critic-badge" style="font-size:10px">Critica</span>' : ''}
      <span class="judge-select-count">${filled}/${total}</span>
    </div>`;
  }).join('');
}

// Mantieni il select nascosto per compatibilità interna, aggiornalo in sync
function syncHiddenSelector(judgeName) {
  const sel = document.getElementById('judge-selector');
  sel.value = judgeName;
}

function renderJudgeSelector() {
  const sel = document.getElementById('judge-selector');
  sel.innerHTML = '<option value="">— Seleziona giudice —</option>'
    + judges.map(j => `<option value="${j.name}">${j.name}</option>`).join('');
  renderJudgesPreview();
}

function renderJudgesCompletion() {
  renderJudgesPreview();
}

async function selectJudge(judgeName) {
  // Secondo tap sullo stesso giudice — chiudi e rilascia lock
  if (selectedJudge === judgeName) {
    await releaseJudgeLock(currentSerata, selectedJudge);
    selectedJudge = '';
    syncHiddenSelector('');
    renderJudgesPreview();
    const grid    = document.getElementById('votes-grid');
    const actions = document.getElementById('votes-actions');
    if (grid)    grid.style.display    = 'none';
    if (actions) actions.style.display = 'none';
    return;
  }
  // Rilascia eventuale lock precedente
  if (selectedJudge) await releaseJudgeLock(currentSerata, selectedJudge);
  // Acquisisci lock sul nuovo giudice
  const locked = await acquireJudgeLock(currentSerata, judgeName);
  if (!locked) return;
  selectedJudge = judgeName;
  syncHiddenSelector(judgeName);
  renderJudgesPreview();
  onJudgeSelected();
  setTimeout(() => {
    document.getElementById('votes-grid')?.scrollIntoView({behavior:'smooth', block:'nearest'});
  }, 100);
}

// ── Editor giudici overlay ────────────────────
function openJudgesEditor() {
  const list = document.getElementById('judges-editor-list');
  list.innerHTML = '';
  const toRender = judges.length > 0 ? judges : [{name:'',isCritic:false}];
  toRender.forEach(j => addJudgeRow(j.name, j.isCritic));
  openOverlay('overlay-judges');
}

function addJudgeRow(name='', isCritic=false) {
  const list = document.getElementById('judges-editor-list');
  const row  = document.createElement('div');
  row.className = 'judge-edit-row';
  row.innerHTML = `
    <button class="critic-toggle ${isCritic ? 'active' : ''}" title="Giudice Critica" onclick="toggleCriticBtn(this)">★</button>
    <input class="n-input judge-name-input" type="text" placeholder="Nome giudice" value="${name}">
    <button class="judge-remove-btn" onclick="this.parentElement.remove()">✕</button>`;
  list.appendChild(row);
}

function toggleCriticBtn(btn) {
  const wasActive = btn.classList.contains('active');
  // Rimuovi da tutti
  document.querySelectorAll('.critic-toggle').forEach(b => b.classList.remove('active'));
  // Toggle: se era attivo lo disattiva, altrimenti attiva questo
  if (!wasActive) btn.classList.add('active');
}

async function saveJudges() {
  const rows = document.querySelectorAll('.judge-edit-row');
  const list = Array.from(rows).map(r => ({
    name:     r.querySelector('.judge-name-input').value.trim(),
    isCritic: r.querySelector('.critic-toggle').classList.contains('active')
  })).filter(j => j.name);

  if (list.length === 0) { showToast('Inserisci almeno un giudice'); return; }

  // Garantisce al massimo un critico
  const critics = list.filter(j => j.isCritic);
  if (critics.length > 1) {
    list.forEach(j => j.isCritic = false);
    list[list.findIndex(j => j.name === critics[0].name)].isCritic = true;
  }

  try {
    await setDoc(doc(db,'judges',`s${currentSerata}`), { list, updatedAt: serverTimestamp() });
    judges = list;
    renderJudgesPreview();
    renderJudgeSelector();
    closeOverlay('overlay-judges');
    showToast('✓ Giudici salvati');
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  INSERIMENTO VOTI
// ══════════════════════════════════════════════
async function loadDraftVotes() {
  try {
    const snap = await getDoc(doc(db,'jury_votes',`s${currentSerata}`));
    draftVotes = snap.exists() ? (snap.data().votes || {}) : {};
  } catch(e) { draftVotes = {}; }
}

function onJudgeSelected() {
  const judgeName = selectedJudge || document.getElementById('judge-selector').value;
  const grid      = document.getElementById('votes-grid');
  const actions   = document.getElementById('votes-actions');

  if (!judgeName) {
    grid.style.display    = 'none';
    if (actions) actions.style.display = 'none';
    return;
  }

  renderVotesGrid(judgeName);
  grid.style.display    = '';
  if (actions) actions.style.display = 'flex';
}

function renderVotesGrid(judgeName) {
  const grid    = document.getElementById('votes-grid');
  const existing = draftVotes[judgeName] || {};

  grid.innerHTML = `
    <div class="votes-grid-header">
      <div class="vg-singer">Cantante</div>
      <div class="vg-score">Inton.<br><span>1–10</span></div>
      <div class="vg-score">Interp.<br><span>1–10</span></div>
    </div>
    ${singers.map((s,i) => {
      const v = existing[s.name] || {int:0, int2:0};
      return `
      <div class="votes-grid-row ${i%2===0 ? 'even' : ''}">
        <div class="vg-singer-info">
          <div class="vg-name">${s.name}</div>
          ${s.song ? `<div class="vg-song">♪ ${s.song}</div>` : ''}
        </div>
        <div class="vg-score">
          <input class="score-input" type="number" min="1" max="10" inputmode="numeric" pattern="[0-9]*"
            data-singer="${s.name}" data-field="int"
            value="${v.int || ''}" placeholder="—"
            oninput="onScoreInput(this)" onblur="onScoreBlur(this)">
        </div>
        <div class="vg-score">
          <input class="score-input" type="number" min="1" max="10" inputmode="numeric" pattern="[0-9]*"
            data-singer="${s.name}" data-field="int2"
            value="${v.int2 || ''}" placeholder="—"
            oninput="onScoreInput(this)" onblur="onScoreBlur(this)">
        </div>
      </div>`;
    }).join('')}`;
}

function onScoreInput(input) {
  // Rimuovi qualsiasi carattere non numerico
  input.value = input.value.replace(/[^0-9]/g, '');

  let val = parseInt(input.value);
  if (isNaN(val) || input.value === '') {
    // Valore vuoto — pulisci dal draft ma non bloccare l'input
    const judgeName = selectedJudge || document.getElementById('judge-selector').value;
    const singer = input.dataset.singer;
    const field  = input.dataset.field;
    if (draftVotes[judgeName]?.[singer]) draftVotes[judgeName][singer][field] = 0;
    renderJudgesPreview();
    return;
  }
  // Clamp solo se > 10 (non clampare mentre si sta digitando "1" per poi scrivere "10")
  if (val > 10) { input.value = '10'; val = 10; }
  // Non correggere a 1 subito — l'utente potrebbe stare ancora digitando
  // Il clamp a min viene fatto al salvataggio e al blur
  const judgeName = selectedJudge || document.getElementById('judge-selector').value;
  const singer    = input.dataset.singer;
  const field     = input.dataset.field;

  if (!draftVotes[judgeName]) draftVotes[judgeName] = {};
  if (!draftVotes[judgeName][singer]) draftVotes[judgeName][singer] = {int:0, int2:0};
  draftVotes[judgeName][singer][field] = val;

  // Highlight riga completata
  const row = input.closest('.votes-grid-row');
  const v   = draftVotes[judgeName][singer];
  row?.classList.toggle('complete', v.int > 0 && v.int2 > 0);

  renderJudgesCompletion();
}

function onScoreBlur(input) {
  let val = parseInt(input.value);
  if (!isNaN(val) && val < 1) { input.value = '1'; val = 1; }
  if (!isNaN(val)) {
    const judgeName = selectedJudge || document.getElementById('judge-selector').value;
    if (judgeName && input.dataset.singer) {
      if (!draftVotes[judgeName]) draftVotes[judgeName] = {};
      if (!draftVotes[judgeName][input.dataset.singer]) draftVotes[judgeName][input.dataset.singer] = {int:0,int2:0};
      draftVotes[judgeName][input.dataset.singer][input.dataset.field] = val;
      renderJudgesPreview();
    }
  }
}

async function clearJudgeVotes() {
  const judgeName = selectedJudge;
  if (!judgeName) return;
  closeOverlay('overlay-clear-votes');
  // Cancella dal draft locale
  delete draftVotes[judgeName];
  // Salva su Firestore
  try {
    await setDoc(doc(db,'jury_votes',`s${currentSerata}`), {
      votes: draftVotes,
      updatedAt: serverTimestamp()
    });
    // Cancella TUTTA la classifica (serata + festival) per forzare ricalcolo
    await Promise.all([
      deleteDoc(doc(db,'jury_ranking',`s${currentSerata}`)).catch(()=>{}),
      deleteDoc(doc(db,'jury_ranking','festival')).catch(()=>{}),
    ]);
    // Ri-renderizza griglia vuota e lista
    renderVotesGrid(judgeName);
    renderJudgesPreview();
    showToast(`✓ Voti di ${judgeName} eliminati — ricaricamento in corso…`);
    setTimeout(() => window.location.reload(), 2000);
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

async function saveJudgeVotes() {
  const judgeName = selectedJudge || document.getElementById('judge-selector').value;
  if (!judgeName) return;

  // Valida che tutti i cantanti abbiano voti
  const votes = draftVotes[judgeName] || {};
  const incomplete = singers.filter(s => {
    const v = votes[s.name];
    return !v || !(v.int > 0) || !(v.int2 > 0);
  });

  if (incomplete.length > 0) {
    showToast(`⚠️ Mancano voti per: ${incomplete.map(s=>s.name).join(', ')}`);
    return;
  }

  try {
    // Cancella classifiche esistenti: ogni modifica ai voti richiede ricalcolo obbligatorio
    await Promise.all([
      deleteDoc(doc(db,'jury_ranking',`s${currentSerata}`)).catch(()=>{}),
      deleteDoc(doc(db,'jury_ranking','festival')).catch(()=>{}),
    ]);
    await setDoc(doc(db,'jury_votes',`s${currentSerata}`), {
      votes: draftVotes,
      updatedAt: serverTimestamp()
    });
    renderJudgesCompletion();
    showToast(`✓ Voti di ${judgeName} salvati — ricaricamento in corso…`);
    setTimeout(() => window.location.reload(), 2000);
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  CALCOLO CLASSIFICA — Z-score per giudice
// ══════════════════════════════════════════════
async function computeRanking() {
  // Ricarica voti freschi da Firestore
  try {
    const snap = await getDoc(doc(db,'jury_votes',`s${currentSerata}`));
    draftVotes = snap.exists() ? (snap.data().votes || {}) : draftVotes;
  } catch(e) {}

  // Verifica che almeno un giudice abbia voti completi
  const judgesWithVotes = judges.filter(j => {
    const v = draftVotes[j.name] || {};
    return singers.every(s => v[s.name]?.int > 0 && v[s.name]?.int2 > 0);
  });

  if (judgesWithVotes.length === 0) {
    showToast('⚠️ Nessun giudice ha completato tutti i voti');
    return;
  }

  // Z-score per giudice
  const zPerJudge = {};
  const judgeStats = {};

  judgesWithVotes.forEach(j => {
    const rawScores = singers.map(s => {
      const v = draftVotes[j.name][s.name];
      return (v.int || 0) + (v.int2 || 0);
    });
    const mean = rawScores.reduce((a,b)=>a+b,0) / rawScores.length;
    const ds   = Math.sqrt(rawScores.reduce((a,b)=>a+(b-mean)**2,0) / rawScores.length);
    judgeStats[j.name] = { mean: mean.toFixed(2), ds: ds.toFixed(2), range: `${Math.min(...rawScores)}-${Math.max(...rawScores)}` };
    zPerJudge[j.name] = singers.map((s,i) => ds > 0 ? (rawScores[i]-mean)/ds : 0);
  });

  // Media Z-score aggregata per cantante
  const zAggregated = singers.map((_,i) => {
    const zvals = judgesWithVotes.map(j => zPerJudge[j.name][i]);
    return zvals.reduce((a,b)=>a+b,0) / zvals.length;
  });

  // Riscaling lineare → range 2-20
  const zMin = Math.min(...zAggregated);
  const zMax = Math.max(...zAggregated);
  const techScores = singers.map((_,i) =>
    zMax > zMin ? parseFloat((2 + (zAggregated[i]-zMin)/(zMax-zMin)*18).toFixed(4)) : 11
  );

  // Bonus pubblico dalla classifica pubblica della serata
  const publicBonus = await computePublicBonus();

  // Punteggio serata
  const serataScores = singers.map((s,i) => ({
    name:       s.name,
    song:       s.song || '',
    tech:       techScores[i],                              // float 4 decimali
    bonus:      publicBonus[s.name] || 0,
    total:      parseFloat((techScores[i] + (publicBonus[s.name] || 0)).toFixed(4)),
    zAgg:       zAggregated[i],                             // float grezzo per tie-break
  })).sort((a,b) => b.total - a.total || b.zAgg - a.zAgg);

  // Calcola classifica critica separata (solo dal giudice critica)
  const criticJudge = judges.find(j => j.isCritic);
  let criticRanking = null;
  if (criticJudge && draftVotes[criticJudge.name]) {
    const criticVotes = draftVotes[criticJudge.name];
    criticRanking = singers.map(s => ({
      name:  s.name,
      song:  s.song || '',
      score: (criticVotes[s.name]?.int || 0) + (criticVotes[s.name]?.int2 || 0)
    })).sort((a,b) => b.score - a.score);
  }

  lastRanking = { serataScores, judgeStats, judgesWithVotes: judgesWithVotes.map(j=>j.name), criticRanking };

  // Salva in Firestore
  try {
    await setDoc(doc(db,'jury_ranking',`s${currentSerata}`), {
      ranking: serataScores,
      criticRanking,
      judgeStats,
      computedAt: serverTimestamp()
    });
  } catch(e) {}

  document.getElementById('btn-show-jury').style.display    = '';
  document.getElementById('btn-show-ranking').style.display = '';
  document.getElementById('btn-show-top3').style.display    = currentSerata === 3 ? 'none' : '';

  showToast(`✓ Classifica calcolata (${judgesWithVotes.length} giudici)`);
}

async function computePublicBonus() {
  const bonus = {};
  try {
    const snap = await getDocs(collection(db, `votes_s${currentSerata}`));
    const allVotes = [];
    snap.forEach(d => allVotes.push(d.data()));

    const scores = {};
    singers.forEach(s => scores[s.name] = 0);
    allVotes.forEach(({vote}) =>
      vote?.forEach((name,i) => { if(scores[name]!==undefined) scores[name] += POINTS[i]; })
    );

    const ranked = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
    const bonusPoints = [5,4,3,2,1];
    ranked.slice(0,5).forEach(([name],i) => { bonus[name] = bonusPoints[i]; });
  } catch(e) {}
  return bonus;
}

// ══════════════════════════════════════════════
//  OVERLAY CLASSIFICA SERATA
// ══════════════════════════════════════════════
// ── Ranking olimpico: ex-aequo con posizione condivisa ──────────────
function assignOlympicRanks(sorted, scoreKey) {
  const medals = ['🥇','🥈','🥉'];
  let pos = 1;
  const result = [];
  for (let i = 0; i < sorted.length; ) {
    const score = sorted[i][scoreKey];
    // Trova tutti i pari merito
    let j = i;
    while (j < sorted.length && sorted[j][scoreKey] === score) j++;
    const count   = j - i;
    const isExAequo = count > 1;
    const label   = count === 1
      ? (medals[pos-1] || `${pos}°`)
      : (medals[pos-1] ? `${medals[pos-1]}` : `${pos}°`);
    for (let k = i; k < j; k++) {
      result.push({
        ...sorted[k],
        rankLabel: label,
        exAequo:   isExAequo,
        rankNum:   pos
      });
    }
    pos += count; // salta le posizioni occupate
    i = j;
  }
  return result;
}

async function openRankingOverlay(mode = 'full') {
  // Se lastRanking non è in memoria (es. dopo reload), caricalo da Firestore
  if (!lastRanking) {
    try {
      const snap = await getDoc(doc(db,'jury_ranking',`s${currentSerata}`));
      if (!snap.exists()) { showToast('Calcola prima la classifica'); return; }
      const data = snap.data();
      // Ricostruisci lastRanking dalla struttura salvata
      lastRanking = {
        serataScores:     data.ranking || [],
        judgeStats:       data.judgeStats || {},
        judgesWithVotes:  Object.keys(data.judgeStats || {}),
        criticRanking:    data.criticRanking || null,
      };
      // Mostra i pulsanti
      document.getElementById('btn-show-jury').style.display    = '';
      document.getElementById('btn-show-ranking').style.display = '';
      document.getElementById('btn-show-top3').style.display    = currentSerata === 3 ? 'none' : '';
    } catch(e) { showToast('Errore caricamento classifica'); return; }
  }
  const { serataScores, judgeStats, judgesWithVotes } = lastRanking;
  const labels = ['🥇','🥈','🥉','4°','5°','6°','7°','8°','9°','10°','11°','12°','13°','14°'];
  const isJury = mode === 'jury';

  // Ordina per la metrica corretta, tie-break su zAgg grezzo
  const sorted = [...serataScores].sort((a,b) =>
    isJury ? (b.tech - a.tech || b.zAgg - a.zAgg)
           : (b.total - a.total || b.zAgg - a.zAgg)
  );
  const ranked = assignOlympicRanks(sorted, isJury ? 'tech' : 'total');

  document.getElementById('ranking-overlay-title').textContent = isJury
    ? `Giuria tecnica — ${SERATA_LABELS[currentSerata]}`
    : `Classifica completa — ${SERATA_LABELS[currentSerata]}`;

  document.getElementById('ranking-overlay-sub').innerHTML =
    (isJury ? 'Solo voti giuria · Z-score per giudice · range 2–20' : 'Giuria tecnica + bonus pubblico · range 2–25')
    + `<br><span style="opacity:.6;font-size:11px">Giudici: ${judgesWithVotes.join(', ')}</span>`;

  document.getElementById('ranking-overlay-rows').innerHTML = isJury ? `
    <div class="n-ranking-head" style="grid-template-columns:44px 1fr 60px">
      <span>#</span><span>Cantante</span><span>Tec</span>
    </div>
    ${ranked.map(c => `
    <div class="n-ranking-row ${c.exAequo ? 'ex-aequo' : ''}" style="grid-template-columns:44px 1fr 60px">
      <span class="n-r-pos">${c.rankLabel}</span>
      <div class="s-info">
        <div class="s-name">${c.name}</div>
        ${c.song ? `<div class="s-song">♪ ${c.song}</div>` : ''}
        ${c.exAequo ? '<div class="ex-aequo-badge">ex-aequo</div>' : ''}
      </div>
      <span class="n-r-total">${c.tech.toFixed(2)}</span>
    </div>`).join('')}` : `
    <div class="n-ranking-head" style="grid-template-columns:44px 1fr 44px 44px 54px">
      <span>#</span><span>Cantante</span><span>Tec</span><span>Pub</span><span>Tot</span>
    </div>
    ${ranked.map(c => `
    <div class="n-ranking-row ${c.exAequo ? 'ex-aequo' : ''}" style="grid-template-columns:44px 1fr 44px 44px 54px">
      <span class="n-r-pos">${c.rankLabel}</span>
      <div class="s-info">
        <div class="s-name">${c.name}</div>
        ${c.song ? `<div class="s-song">♪ ${c.song}</div>` : ''}
        ${c.exAequo ? '<div class="ex-aequo-badge">ex-aequo</div>' : ''}
      </div>
      <span class="n-r-score">${c.tech.toFixed(2)}</span>
      <span class="n-r-bonus">+${c.bonus}</span>
      <span class="n-r-total">${c.total.toFixed(2)}</span>
    </div>`).join('')}`;

  openOverlay('overlay-ranking');
}

// ══════════════════════════════════════════════
//  TOP 3 RANDOMIZZATI PER CONDUTTORI
// ══════════════════════════════════════════════
async function showTop3Random() {
  if (!lastRanking) {
    try {
      const snap = await getDoc(doc(db,'jury_ranking',`s${currentSerata}`));
      if (!snap.exists()) { showToast('Calcola prima la classifica'); return; }
      const data = snap.data();
      lastRanking = { serataScores: data.ranking||[], judgeStats: data.judgeStats||{}, judgesWithVotes: Object.keys(data.judgeStats||{}), criticRanking: data.criticRanking||null };
      document.getElementById('btn-show-jury').style.display    = '';
      document.getElementById('btn-show-ranking').style.display = '';
      document.getElementById('btn-show-top3').style.display    = currentSerata === 3 ? 'none' : '';
    } catch(e) { showToast('Calcola prima la classifica'); return; }
  }
  const top3 = lastRanking.serataScores.slice(0,3)
    .map(c => c.name)
    .sort(() => Math.random() - 0.5);

  const colors = ['#FFD700','#C0C0C0','#CD7F32'];
  document.getElementById('top3-names').innerHTML = top3.map((name,i) => `
    <div style="padding:16px;background:var(--surf2);border-radius:var(--r);border:1px solid ${colors[i]}33">
      <div style="font-size:22px;font-family:'Playfair Display',serif;font-weight:900;color:${colors[i]}">${name}</div>
    </div>`).join('');

  openOverlay('overlay-top3');
}

// ══════════════════════════════════════════════
//  CLASSIFICA FINALE FESTIVAL (serata 3)
// ══════════════════════════════════════════════
async function computeFestivalRanking() {
  try {
    const [r1, r2, r3] = await Promise.all([
      getDoc(doc(db,'jury_ranking','s1')),
      getDoc(doc(db,'jury_ranking','s2')),
      getDoc(doc(db,'jury_ranking','s3'))
    ]);

    if (!r1.exists() || !r2.exists() || !r3.exists()) {
      showToast('⚠️ Mancano le classifiche di alcune serate. Calcola prima la classifica di ogni serata.');
      return;
    }

    const scores = {};

    [r1,r2,r3].forEach((snap,si) => {
      snap.data().ranking.forEach(c => {
        if (!scores[c.name]) scores[c.name] = { name:c.name, song:c.song||'', s:[0,0,0] };
        scores[c.name].s[si] = c.total;
      });
    });

    festivalRanking = Object.values(scores).map(c => ({
      ...c,
      total: c.s[0] + c.s[1] + c.s[2]
    })).sort((a,b) => b.total - a.total);

    // Carica classifica critica dalla serata 3
    const criticRanking = r3.data().criticRanking || null;

    await setDoc(doc(db,'jury_ranking','festival'), {
      ranking: festivalRanking,
      criticRanking,
      computedAt: serverTimestamp()
    });

    document.getElementById('btn-show-festival').style.display = '';
    if (r3.data().criticRanking?.length > 0) {
      document.getElementById('btn-show-critica').style.display = '';
    }

    showToast('✓ Classifica festival calcolata');
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

function openFestivalOverlay() {
  if (!festivalRanking) return;

  const fmt = v => (typeof v === 'number' && v > 0) ? v.toFixed(2) : '—';
  const ranked = assignOlympicRanks(
    [...festivalRanking].sort((a,b) => b.total - a.total),
    'total'
  );

  document.getElementById('festival-overlay-rows').innerHTML = `
    <div class="n-ranking-head" style="grid-template-columns:44px 1fr 44px 44px 44px 56px">
      <span>#</span><span>Cantante</span><span>S1</span><span>S2</span><span>S3</span><span>Tot</span>
    </div>
    ${ranked.map(c => `
    <div class="n-ranking-row ${c.exAequo ? 'ex-aequo' : ''}" style="grid-template-columns:44px 1fr 44px 44px 44px 56px">
      <span class="n-r-pos">${c.rankLabel}</span>
      <div class="s-info">
        <div class="s-name">${c.name}</div>
        ${c.song ? `<div class="s-song">♪ ${c.song}</div>` : ''}
        ${c.exAequo ? '<div class="ex-aequo-badge">ex-aequo</div>' : ''}
      </div>
      <span class="n-r-score" style="font-size:12px">${fmt(c.s[0])}</span>
      <span class="n-r-score" style="font-size:12px">${fmt(c.s[1])}</span>
      <span class="n-r-score" style="font-size:12px">${fmt(c.s[2])}</span>
      <span class="n-r-total">${fmt(c.total)}</span>
    </div>`).join('')}`;

  openOverlay('overlay-festival');
}

async function openCriticaOverlay() {
  try {
    const snap = await getDoc(doc(db,'jury_ranking','s3'));
    const criticRanking = snap.exists() ? snap.data().criticRanking : null;
    if (!criticRanking?.length) { showToast('Nessuna classifica critica disponibile'); return; }

    const ranked = assignOlympicRanks(
      [...criticRanking].sort((a,b) => b.score - a.score),
      'score'
    );
    document.getElementById('critica-overlay-rows').innerHTML =
      ranked.map(c => `
      <div class="n-ranking-row ${c.exAequo ? 'ex-aequo' : ''}" style="grid-template-columns:44px 1fr 50px">
        <span class="n-r-pos">${c.rankLabel}</span>
        <div class="s-info">
          <div class="s-name">${c.name}</div>
          ${c.song ? `<div class="s-song">♪ ${c.song}</div>` : ''}
          ${c.exAequo ? '<div class="ex-aequo-badge">ex-aequo</div>' : ''}
        </div>
        <span class="n-r-total">${c.score}</span>
      </div>`).join('');

    openOverlay('overlay-critica');
  } catch(e) {
    showToast('Errore caricamento classifica critica');
  }
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
// Swipe sinistro o verso il basso sulla overlay-box = chiudi
function attachSwipeClose(box, overlayId) {
  let startX = null, startY = null;
  const onStart = e => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY;
  };
  const onEnd = e => {
    if (startX === null) return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Swipe sinistro (dx < -60) con movimento prevalentemente orizzontale
    if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.2) closeOverlay(overlayId);
    startX = null; startY = null;
  };
  // Rimuovi listener precedenti se già attaccati
  box._swipeStart && box.removeEventListener('touchstart', box._swipeStart);
  box._swipeEnd   && box.removeEventListener('touchend',   box._swipeEnd);
  box._swipeStart = onStart; box._swipeEnd = onEnd;
  box.addEventListener('touchstart', onStart, { passive: true });
  box.addEventListener('touchend',   onEnd,   { passive: true });
}

function openOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'flex';
  const box = el.querySelector('.overlay-box');
  if (box) box.scrollTop = 0;
  // Tap sul backdrop (fuori dalla box) = chiudi
  el._backdropHandler = e => { if (e.target === el) closeOverlay(id); };
  el.addEventListener('click', el._backdropHandler);
  // Swipe sinistro sulla box = chiudi
  if (box) attachSwipeClose(box, id);
}
function closeOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'none';
  if (el._backdropHandler) { el.removeEventListener('click', el._backdropHandler); delete el._backdropHandler; }
}

async function signOutNotaio() {
  await signOut(auth);
  window.location.reload();
}

async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') showToast('Accesso non riuscito. Riprova.');
  }
}

// ── Expose ────────────────────────────────────
window.openJudgesEditor    = openJudgesEditor;
window.selectJudge         = selectJudge;
window.addJudgeRow         = addJudgeRow;
window.toggleCriticBtn     = toggleCriticBtn;
window.saveJudges          = saveJudges;
window.onJudgeSelected     = onJudgeSelected;
window.onScoreInput        = onScoreInput;
window.saveJudgeVotes      = saveJudgeVotes;
window.clearJudgeVotes     = clearJudgeVotes;
window.onScoreBlur         = onScoreBlur;
window.computeRanking      = computeRanking;
window.openRankingOverlay  = openRankingOverlay;
window.showTop3Random      = showTop3Random;
window.computeFestivalRanking = computeFestivalRanking;
window.openFestivalOverlay = openFestivalOverlay;
window.openCriticaOverlay  = openCriticaOverlay;
window.openOverlay         = openOverlay;
window.closeOverlay        = closeOverlay;
window.signOutNotaio       = signOutNotaio;
window.signInWithGoogle    = signInWithGoogle;
