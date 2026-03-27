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
let _unsubVotes    = null; // listener real-time jury_votes
let _unsubSingers  = null; // listener real-time singers
let singers        = [];   // [{name, song}] della serata corrente
let judges         = [];   // [{name, isCritic}]
let draftVotes     = {};   // {judgeName: {singerName: {int, int2}}}
let lastRanking    = null; // risultato ultimo calcolo serata
let festivalRanking = null;

// ══════════════════════════════════════════════
//  WATCHER REVOCA DIRITTI + LOCK CONCORRENZA
// ══════════════════════════════════════════════
function startNotaioRightsWatcher(uid) {
  if (_unsubRights) _unsubRights();
  let initialLoad = true;
  _unsubRights = onSnapshot(doc(db, 'notai', uid), snap => {
    if (initialLoad) { initialLoad = false; return; }
    if (!snap.exists()) {
      showToast('⚠️ Accesso revocato. Disconnessione in corso…', 3000);
      setTimeout(async () => {
        if (_unsubRights) { _unsubRights(); _unsubRights = null; }
        await signOut(auth);
        showScreen('screen-notaio-login');
      }, 2500);
    } else {
      showToast('✅ Permessi aggiornati. Ricaricamento…', 2000);
      setTimeout(() => window.location.reload(), 2000);
    }
  }, () => {});
}

// ══════════════════════════════════════════════
//  WATCHER REAL-TIME — jury_votes
//  Aggiorna draftVotes in background, ma SOLO per
//  giudici diversi da quello in editing attivo.
// ══════════════════════════════════════════════
function startVotesWatcher() {
  if (_unsubVotes) _unsubVotes();
  _unsubVotes = onSnapshot(doc(db, 'jury_votes', `s${currentSerata}`), snap => {
    if (!snap.exists()) return;
    const remoteVotes = snap.data().votes || {};
    // Aggiorna solo i giudici non in editing
    let updated = false;
    Object.keys(remoteVotes).forEach(judgeName => {
      if (judgeName === selectedJudge) return; // non toccare il giudice in editing
      draftVotes[judgeName] = remoteVotes[judgeName];
      updated = true;
    });
    // Rimuovi giudici cancellati da remoto (solo se non in editing)
    Object.keys(draftVotes).forEach(judgeName => {
      if (judgeName === selectedJudge) return;
      if (!remoteVotes[judgeName]) {
        delete draftVotes[judgeName];
        updated = true;
      }
    });
    if (updated) renderJudgesPreview(); // aggiorna i pallini silenziosamente
  }, () => {});
}

// ══════════════════════════════════════════════
//  WATCHER REAL-TIME — singers
//  Aggiorna la lista cantanti solo se non c'è
//  un giudice in editing attivo.
// ══════════════════════════════════════════════
function startSingersWatcher() {
  if (_unsubSingers) _unsubSingers();
  const norm = list => (list || []).map(s => typeof s === 'string' ? { name: s, song: '' } : s);

  if (currentSerata === 3) {
    // Serata 3: ascolta s3 (ordine finale) con fallback s1+s2
    _unsubSingers = onSnapshot(doc(db, 'singers', 's3'), snap => {
      if (selectedJudge) return; // non aggiornare mentre si sta editando
      if (snap.exists() && snap.data().list?.length > 0) {
        singers = norm(snap.data().list);
      }
      // Se s3 vuoto non facciamo nulla: i dati iniziali sono già corretti
    }, () => {});
  } else {
    _unsubSingers = onSnapshot(doc(db, 'singers', `s${currentSerata}`), snap => {
      if (selectedJudge) return; // non aggiornare mentre si sta editando
      if (snap.exists()) {
        singers = norm(snap.data().list);
      }
    }, () => {});
  }
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
    _activeLockKey = key;
    return true;
  } catch(e) { return true; }
}

async function releaseJudgeLock(serata, judgeName) {
  const key = _activeLockKey || `jury_s${serata}_${(judgeName||'').replace(/\s+/g,'_')}`;
  _activeLockKey = null;
  if (!key || key === `jury_s${serata}_`) return;
  try {
    await deleteDoc(doc(db, 'editing_locks', key));
  } catch(e) {}
}


// ── Boot ──────────────────────────────────────
generateStars();

auth.onAuthStateChanged(async user => {
  if (!user) {
    showScreen('screen-notaio-login');
    return;
  }
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

  try {
    const cfg = await getDoc(doc(db,'config','current'));
    currentSerata = cfg.exists() ? (cfg.data().serata || 1) : 1;
  } catch(e) { currentSerata = 1; }

  document.getElementById('notaio-serata-label').textContent = SERATA_LABELS[currentSerata];

  document.getElementById('festival-ranking-section').style.display =
    currentSerata === 3 ? '' : 'none';

  await loadSingers();
  await loadDraftVotes();
  await loadJudges();
  await checkExistingRanking();

  // Avvia i watcher real-time DOPO il caricamento iniziale
  startVotesWatcher();
  startSingersWatcher();

  showScreen('screen-notaio');
}

async function checkExistingRanking() {
  try {
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

let selectedJudge   = '';
let _activeLockKey  = null;

function renderJudgesPreview() {
  const el = document.getElementById('judges-list-preview');
  if (judges.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:13px">Nessun giudice configurato — usa ✎ Modifica</div>';
    return;
  }
  const normal = judges.filter(j => !j.isCritic);
  const critic = judges.filter(j => j.isCritic);
  const ordered = [...normal, ...critic];

  el.innerHTML = ordered.map(j => {
    const votes  = draftVotes[j.name] || {};
    const filled = singers.filter(s => { const v=votes[s.name]; return v&&v.int>0&&v.int2>0; }).length;
    const total  = singers.length;
    const done   = filled === total && total > 0;
    const sel    = selectedJudge === j.name;
    const name   = j.name.replace(/'/g, "\\'");
    return `<div class="judge-select-row ${done?'done':''} ${sel?'selected':''} ${j.isCritic?'critic-row':''}"
      onclick="selectJudge('${name}')">
      <span class="judge-select-dot ${done?'done':''}"></span>
      <span class="judge-select-name">${j.isCritic ? '⭐ ' : ''}${j.name}</span>
      ${j.isCritic ? '<span class="critic-badge" style="font-size:10px">Critica</span>' : ''}
      <span class="judge-select-count">${filled}/${total}</span>
    </div>`;
  }).join('');
}

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
  if (selectedJudge === judgeName) {
    await releaseJudgeLock(currentSerata, selectedJudge);
    selectedJudge  = '';
    _activeLockKey = null;
    syncHiddenSelector('');
    renderJudgesPreview();
    const grid    = document.getElementById('votes-grid');
    const actions = document.getElementById('votes-actions');
    if (grid)    grid.style.display    = 'none';
    if (actions) actions.style.display = 'none';
    return;
  }
  if (selectedJudge) await releaseJudgeLock(currentSerata, selectedJudge);
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
  document.querySelectorAll('.critic-toggle').forEach(b => b.classList.remove('active'));
  if (!wasActive) btn.classList.add('active');
}

async function saveJudges() {
  const rows = document.querySelectorAll('.judge-edit-row');
  const list = Array.from(rows).map(r => ({
    name:     r.querySelector('.judge-name-input').value.trim(),
    isCritic: r.querySelector('.critic-toggle').classList.contains('active')
  })).filter(j => j.name);

  if (list.length === 0) { showToast('Inserisci almeno un giudice'); return; }

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
  input.value = input.value.replace(/[^0-9]/g, '');

  let val = parseInt(input.value);
  if (isNaN(val) || input.value === '') {
    const judgeName = selectedJudge || document.getElementById('judge-selector').value;
    const singer = input.dataset.singer;
    const field  = input.dataset.field;
    if (draftVotes[judgeName]?.[singer]) draftVotes[judgeName][singer][field] = 0;
    renderJudgesPreview();
    return;
  }
  if (val > 10) { input.value = '10'; val = 10; }
  const judgeName = selectedJudge || document.getElementById('judge-selector').value;
  const singer    = input.dataset.singer;
  const field     = input.dataset.field;

  if (!draftVotes[judgeName]) draftVotes[judgeName] = {};
  if (!draftVotes[judgeName][singer]) draftVotes[judgeName][singer] = {int:0, int2:0};
  draftVotes[judgeName][singer][field] = val;

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
  delete draftVotes[judgeName];
  try {
    await setDoc(doc(db,'jury_votes',`s${currentSerata}`), {
      votes: draftVotes,
      updatedAt: serverTimestamp()
    });
    await Promise.all([
      deleteDoc(doc(db,'jury_ranking',`s${currentSerata}`)).catch(()=>{}),
      deleteDoc(doc(db,'jury_ranking','festival')).catch(()=>{}),
    ]);
    await releaseJudgeLock(currentSerata, judgeName);
    showToast(`✓ Voti di ${judgeName} eliminati — ricaricamento in corso…`);
    setTimeout(() => window.location.reload(), 2000);
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

async function saveJudgeVotes() {
  const judgeName = selectedJudge || document.getElementById('judge-selector').value;
  if (!judgeName) return;

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
    await Promise.all([
      deleteDoc(doc(db,'jury_ranking',`s${currentSerata}`)).catch(()=>{}),
      deleteDoc(doc(db,'jury_ranking','festival')).catch(()=>{}),
    ]);
    await setDoc(doc(db,'jury_votes',`s${currentSerata}`), {
      votes: draftVotes,
      updatedAt: serverTimestamp()
    });
    // Deseleziona il giudice e rilascia il lock — nessun reload
    selectedJudge  = '';
    _activeLockKey = null;
    await releaseJudgeLock(currentSerata, judgeName);
    syncHiddenSelector('');
    const grid    = document.getElementById('votes-grid');
    const actions = document.getElementById('votes-actions');
    if (grid)    grid.style.display    = 'none';
    if (actions) actions.style.display = 'none';
    renderJudgesCompletion();
    showToast(`✓ Voti di ${judgeName} salvati`);
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  CALCOLO CLASSIFICA — Z-score per giudice
// ══════════════════════════════════════════════
async function computeRanking() {
  try {
    const snap = await getDoc(doc(db,'jury_votes',`s${currentSerata}`));
    draftVotes = snap.exists() ? (snap.data().votes || {}) : draftVotes;
  } catch(e) {}

  const judgesWithVotes = judges.filter(j => {
    const v = draftVotes[j.name] || {};
    return singers.every(s => v[s.name]?.int > 0 && v[s.name]?.int2 > 0);
  });

  if (judgesWithVotes.length === 0) {
    showToast('⚠️ Nessun giudice ha completato tutti i voti');
    return;
  }

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

  const zAggregated = singers.map((_,i) => {
    const zvals = judgesWithVotes.map(j => zPerJudge[j.name][i]);
    return zvals.reduce((a,b)=>a+b,0) / zvals.length;
  });

  const zMin = Math.min(...zAggregated);
  const zMax = Math.max(...zAggregated);
  const techScores = singers.map((_,i) =>
    zMax > zMin ? 2 + ((zAggregated[i] - zMin) / (zMax - zMin)) * 18 : 10
  );

  // Bonus pubblico
  let publicBonus = {};
  try {
    const pvSnap = await getDocs(collection(db, `votes_s${currentSerata}`));
    const allVotes = [];
    pvSnap.forEach(d => allVotes.push(d.data()));
    singers.forEach(s => { publicBonus[s.name] = 0; });
    allVotes.forEach(v => {
      if (!Array.isArray(v.vote)) return;
      v.vote.forEach((name, pos) => {
        if (publicBonus[name] !== undefined) publicBonus[name] += (POINTS[pos] || 0);
      });
    });
  } catch(e) { singers.forEach(s => { publicBonus[s.name] = 0; }); }

  // Normalizza bonus pubblico su scala 0-5
  const bonusVals = Object.values(publicBonus);
  const bonusMax  = Math.max(...bonusVals, 1);
  const bonusNorm = {};
  singers.forEach(s => { bonusNorm[s.name] = (publicBonus[s.name] / bonusMax) * 5; });

  // Classifica serata
  const serataScores = singers.map((s,i) => ({
    name:       s.name,
    techScore:  +techScores[i].toFixed(3),
    bonus:      +bonusNorm[s.name].toFixed(3),
    total:      +(techScores[i] + bonusNorm[s.name]).toFixed(3),
  })).sort((a,b) => b.total - a.total);

  // Assegna rank con ex-aequo
  let rank = 1;
  serataScores.forEach((r,i) => {
    if (i > 0 && r.total === serataScores[i-1].total) {
      r.rank = serataScores[i-1].rank;
      r.exAequo = true;
      serataScores[i-1].exAequo = true;
    } else {
      r.rank = rank;
    }
    rank++;
    r.rankLabel = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}°`;
  });

  // Classifica critica (solo il giudice critica)
  const criticJudge = judgesWithVotes.find(j => j.isCritic);
  let criticRanking = null;
  if (criticJudge) {
    criticRanking = singers.map((s,i) => ({
      name:      s.name,
      techScore: +(zPerJudge[criticJudge.name][i]).toFixed(3),
    })).sort((a,b) => b.techScore - a.techScore);
    let cr = 1;
    criticRanking.forEach((r,i) => {
      if (i > 0 && r.techScore === criticRanking[i-1].techScore) {
        r.rank = criticRanking[i-1].rank; r.exAequo = true; criticRanking[i-1].exAequo = true;
      } else { r.rank = cr; }
      cr++;
      r.rankLabel = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}°`;
    });
  }

  lastRanking = { serataScores, judgeStats, judgesWithVotes: judgesWithVotes.map(j=>j.name), criticRanking };

  try {
    await setDoc(doc(db,'jury_ranking',`s${currentSerata}`), {
      ranking:       serataScores,
      judgeStats,
      criticRanking: criticRanking || null,
      calculatedAt:  serverTimestamp(),
    });
  } catch(e) {}

  document.getElementById('btn-show-jury').style.display    = '';
  document.getElementById('btn-show-ranking').style.display = '';
  document.getElementById('btn-show-top3').style.display    = currentSerata === 3 ? 'none' : '';
  showToast('✓ Classifica calcolata');
  openRankingOverlay('full');
}

// ══════════════════════════════════════════════
//  CLASSIFICA FESTIVAL (serata 3)
// ══════════════════════════════════════════════
async function computeFestivalRanking() {
  if (currentSerata !== 3) return;
  try {
    const [r1snap, r2snap, r3snap] = await Promise.all([
      getDoc(doc(db,'jury_ranking','s1')),
      getDoc(doc(db,'jury_ranking','s2')),
      getDoc(doc(db,'jury_ranking','s3')),
    ]);
    if (!r1snap.exists() || !r2snap.exists() || !r3snap.exists()) {
      showToast('⚠️ Calcola prima le classifiche di tutte e tre le serate');
      return;
    }
    const r1 = r1snap.data().ranking || [];
    const r2 = r2snap.data().ranking || [];
    const r3 = r3snap.data().ranking || [];

    const scoreMap = {};
    [...r1, ...r2, ...r3].forEach(r => {
      if (!scoreMap[r.name]) scoreMap[r.name] = 0;
      scoreMap[r.name] += r.total || 0;
    });

    const festRanking = Object.entries(scoreMap)
      .map(([name, total]) => ({ name, total: +total.toFixed(3) }))
      .sort((a,b) => b.total - a.total);

    let rank = 1;
    festRanking.forEach((r,i) => {
      if (i > 0 && r.total === festRanking[i-1].total) {
        r.rank = festRanking[i-1].rank; r.exAequo = true; festRanking[i-1].exAequo = true;
      } else { r.rank = rank; }
      rank++;
      r.rankLabel = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}°`;
    });

    festivalRanking = festRanking;
    await setDoc(doc(db,'jury_ranking','festival'), { ranking: festRanking, calculatedAt: serverTimestamp() });
    document.getElementById('btn-show-festival').style.display = '';
    showToast('✓ Classifica festival calcolata');
    openFestivalOverlay();
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  OVERLAY CLASSIFICHE
// ══════════════════════════════════════════════
function openRankingOverlay(mode) {
  if (!lastRanking) return;
  const { serataScores, judgeStats, judgesWithVotes } = lastRanking;
  const rows = document.getElementById('ranking-overlay-rows');
  if (!rows) return;

  if (mode === 'jury') {
    rows.innerHTML = serataScores.map(r => `
      <div class="rank-row">
        <div class="rank-pos">${r.rankLabel}</div>
        <div class="rank-name">${r.name}${r.exAequo ? ' <span class="ex-aequo-badge">ex-aequo</span>' : ''}</div>
        <div class="rank-score">${r.techScore.toFixed(1)}</div>
      </div>`).join('');
  } else {
    rows.innerHTML = serataScores.map(r => `
      <div class="rank-row">
        <div class="rank-pos">${r.rankLabel}</div>
        <div class="rank-name">${r.name}${r.exAequo ? ' <span class="ex-aequo-badge">ex-aequo</span>' : ''}</div>
        <div class="rank-score">${r.total.toFixed(1)}</div>
      </div>`).join('');
  }

  const statsEl = document.getElementById('ranking-judge-stats');
  if (statsEl) {
    statsEl.innerHTML = judgesWithVotes.map(jn => {
      const s = judgeStats[jn] || {};
      return `<div class="judge-stat-row"><b>${jn}</b> — media: ${s.mean}, σ: ${s.ds}, range: ${s.range}</div>`;
    }).join('');
  }

  openOverlay('overlay-ranking');
}

function showTop3Random() {
  if (!lastRanking) return;
  const top3 = lastRanking.serataScores.slice(0,3).map(r => r.name).sort(() => Math.random() - 0.5);
  const el = document.getElementById('top3-names');
  if (el) el.innerHTML = top3.map((n,i) => `<div class="top3-item" style="animation-delay:${i*0.3}s">${n}</div>`).join('');
  openOverlay('overlay-top3');
}

function openFestivalOverlay() {
  if (!festivalRanking) return;
  const rows = document.getElementById('festival-overlay-rows');
  if (!rows) return;
  rows.innerHTML = festivalRanking.map(r => `
    <div class="rank-row">
      <div class="rank-pos">${r.rankLabel}</div>
      <div class="rank-name">${r.name}${r.exAequo ? ' <span class="ex-aequo-badge">ex-aequo</span>' : ''}</div>
      <div class="rank-score">${r.total.toFixed(1)}</div>
    </div>`).join('');
  openOverlay('overlay-festival');
}

async function openCriticaOverlay() {
  try {
    const snap = await getDoc(doc(db,'jury_ranking','s3'));
    const criticRanking = snap.exists() ? (snap.data().criticRanking || []) : [];
    const rows = document.getElementById('critica-overlay-rows');
    if (!rows) return;
    if (criticRanking.length === 0) {
      rows.innerHTML = '<div style="color:var(--muted);padding:16px;text-align:center">Nessun giudice critica configurato</div>';
    } else {
      rows.innerHTML = criticRanking.map(r => `
        <div class="rank-row">
          <div class="rank-pos">${r.rankLabel}</div>
          <div class="rank-name">${r.name}${r.exAequo ? ' <span class="ex-aequo-badge">ex-aequo</span>' : ''}</div>
          <div class="rank-score">${r.techScore.toFixed(2)}</div>
        </div>`).join('');
    }
    openOverlay('overlay-critica');
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  BACKUP JSON — voti pubblico + giuria
// ══════════════════════════════════════════════
async function exportBackupJSON() {
  const btn = document.getElementById('btn-backup-json');
  if (btn) { btn.textContent = '⏳ Download in corso…'; btn.disabled = true; }
  try {
    // Voti pubblico
    const publicSnap = await getDocs(collection(db, `votes_s${currentSerata}`));
    const publicVotes = [];
    publicSnap.forEach(d => publicVotes.push({ _docId: d.id, ...d.data() }));

    // Voti giuria
    const jurySnap = await getDoc(doc(db, 'jury_votes', `s${currentSerata}`));
    const juryVotes = jurySnap.exists() ? jurySnap.data() : {};

    // Giudici
    const judgesSnap = await getDoc(doc(db, 'judges', `s${currentSerata}`));
    const judgesData = judgesSnap.exists() ? judgesSnap.data() : {};

    // Cantanti
    const singersSnap = await getDoc(doc(db, 'singers', `s${currentSerata}`));
    const singersData = singersSnap.exists() ? singersSnap.data() : {};

    // Classifica calcolata (se presente)
    const rankingSnap = await getDoc(doc(db, 'jury_ranking', `s${currentSerata}`));
    const rankingData = rankingSnap.exists() ? rankingSnap.data() : null;

    const backup = {
      _meta: {
        generatedAt:  new Date().toISOString(),
        serata:       currentSerata,
        serataLabel:  SERATA_LABELS[currentSerata],
        publicVotes:  publicVotes.length,
        juryJudges:   (judgesData.list || []).length,
      },
      singers:      singersData,
      judges:       judgesData,
      jury_votes:   juryVotes,
      public_votes: publicVotes,
      jury_ranking: rankingData,
    };

    const json     = JSON.stringify(backup, null, 2);
    const blob     = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url      = URL.createObjectURL(blob);
    const ts       = new Date().toISOString().slice(0,16).replace('T','_').replace(':','h');
    const filename = `backup_goro_s${currentSerata}_${ts}.json`;
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`✓ Backup scaricato: ${filename}`);
  } catch(e) {
    showToast('Errore backup: ' + e.message);
  } finally {
    if (btn) { btn.textContent = '💾 Scarica backup JSON serata'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════
//  OVERLAY HELPERS
// ══════════════════════════════════════════════
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
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) closeOverlay(overlayId);
    startX = null; startY = null;
  };
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
  el._backdropHandler = e => { if (e.target === el) closeOverlay(id); };
  el.addEventListener('click', el._backdropHandler);
  if (box) attachSwipeClose(box, id);
}

function closeOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'none';
  if (el._backdropHandler) { el.removeEventListener('click', el._backdropHandler); delete el._backdropHandler; }
  // Rilascia il lock se si chiude l'overlay giudici in qualsiasi modo
  if (id === 'overlay-judges' && selectedJudge) {
    releaseJudgeLock(currentSerata, selectedJudge).catch(() => {});
    selectedJudge = '';
    renderJudgesPreview();
  }
}

async function signOutNotaio() {
  if (_unsubVotes)   { _unsubVotes();   _unsubVotes   = null; }
  if (_unsubSingers) { _unsubSingers(); _unsubSingers = null; }
  if (_unsubRights)  { _unsubRights();  _unsubRights  = null; }
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
window.exportBackupJSON    = exportBackupJSON;
