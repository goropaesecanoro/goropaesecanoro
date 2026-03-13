// ══════════════════════════════════════════════
//  admin.js — Pannello amministratore
// ══════════════════════════════════════════════
import {
  auth, db, showScreen, showToast,
  DEFAULT_SINGERS, POINTS, SERATA_LABELS
} from './firebase-init.js';
import { signOutUser } from './auth.js';
import { onAuthStateChanged }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, getDocs,
  collection, deleteDoc, serverTimestamp, query, orderBy, limit, where, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Stato ─────────────────────────────────────
let currentSerata = 1;
let appConfig     = {};
let singers       = { 1: [...DEFAULT_SINGERS[1]], 2: [...DEFAULT_SINGERS[2]] };
let rankingInterval   = null; // auto-refresh classifica live
let _unsubRights      = null; // listener revoca diritti

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
export async function initAdminApp() {
  onAuthStateChanged(auth, async user => {
    if (!user) { showScreen('screen-admin-login'); return; }

    let adminResult = false;
    let debugInfo   = '';
    try {
      const snap  = await getDoc(doc(db, 'admins', user.uid));
      adminResult = snap.exists();
      debugInfo   = 'uid: ' + user.uid + '\nexists: ' + snap.exists();
    } catch(e) {
      debugInfo = 'ERRORE: ' + e.code + '\n' + e.message + '\nuid: ' + user.uid;
    }

    if (!adminResult) {
      showScreen('screen-admin-login');
      const p = document.querySelector('#screen-admin-login p');
      if (p) p.innerHTML = '<span style="color:#E85D5D;font-weight:600">⚠️ Accesso non autorizzato.</span><br>Il tuo account non ha i permessi necessari.<br><span style="font-size:13px;opacity:.6">Contatta l\'organizzatore per richiedere l\'accesso.</span>';
      return;
    }

    await Promise.all([loadConfig(), loadAllSingers()]);
    // Mostra pulsante notaio se l'utente è anche notaio
    try {
      const notaioSnap = await getDoc(doc(db,'notai',user.uid));
      const btn = document.getElementById('btn-goto-notaio');
      if (btn) btn.style.display = notaioSnap.exists() ? '' : 'none';
    } catch(e) {}
    // Verifica superadmin
    let isSuperAdmin = false;
    try {
      const superSnap = await getDoc(doc(db,'superadmins',user.uid));
      isSuperAdmin = superSnap.exists();
    } catch(e) {}
    renderAdminPanel(user, isSuperAdmin);
    if (isSuperAdmin) initSuperAdmin();
    startRightsWatcher(user.uid);
    startJuryRankingWatcher();
    showScreen('screen-admin');
  });
}

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
let _unsubConfig = null;

async function loadConfig() {
  try {
    const snap = await getDoc(doc(db,'config','current'));
    appConfig     = snap.exists() ? snap.data() : {};
    currentSerata = appConfig.serata || 1;
  } catch(e) { currentSerata = 1; }
  if (_unsubConfig) return;
  _unsubConfig = onSnapshot(doc(db,'config','current'), snap => {
    if (!snap.exists()) return;
    const prev = appConfig.serata;
    appConfig = snap.data();
    currentSerata = appConfig.serata || 1;
    updateSerataLabel();
    updateSwitches();
    if (prev && prev !== currentSerata) {
      showToast('\u{1F504} Serata cambiata in ' + SERATA_LABELS[currentSerata] + ' da un altro admin', 4000);
      refreshRanking();
    }
  }, () => {});
}

async function saveConfig(updates) {
  appConfig = { ...appConfig, ...updates };
  await setDoc(doc(db,'config','current'), appConfig);
}

// ══════════════════════════════════════════════
//  CANTANTI
// ══════════════════════════════════════════════
async function loadAllSingers() {
  try {
    const [s1, s2] = await Promise.all([
      getDoc(doc(db,'singers','s1')),
      getDoc(doc(db,'singers','s2'))
    ]);
    if (s1.exists()) singers[1] = s1.data().list.map(s => typeof s==='string' ? {name:s,song:''} : s);
    if (s2.exists()) singers[2] = s2.data().list.map(s => typeof s==='string' ? {name:s,song:''} : s);
  } catch(e) {}
}

async function saveSingers(serata) {
  const rows = document.querySelectorAll(`#singers-editor-s${serata} .singer-edit-row`);
  const list = Array.from(rows).map(row => ({
    name: row.querySelector('.singer-edit-name').value.trim(),
    song: row.querySelector('.singer-edit-song').value.trim()
  })).filter(r => r.name);
  if (list.length === 0) { showToast('Inserisci almeno un cantante'); return; }

  // Scrivi la serata modificata
  await setDoc(doc(db,'singers',`s${serata}`), { list, updatedAt: serverTimestamp() });
  singers[serata] = list;

  // Riscrivi sempre s3 come concatenazione fresca s1+s2
  // L'ordine di esibizione sarà gestito da "Ordina Serata Finale"
  if (serata === 1 || serata === 2) {
    try {
      const otherKey  = serata === 1 ? 's2' : 's1';
      const otherSnap = await getDoc(doc(db,'singers', otherKey));
      const norm      = (l, sn) => (l||[]).map(s => typeof s==='string' ? {name:s,song:'',serataNum:sn} : {name:s.name,song:s.song||'',serataNum:sn});
      const otherList = otherSnap.exists() ? norm(otherSnap.data().list, serata===1 ? 2 : 1) : [];
      const s1list    = serata === 1 ? norm(list, 1) : otherList;
      const s2list    = serata === 2 ? norm(list, 2) : otherList;
      await setDoc(doc(db,'singers','s3'), { list: [...s1list, ...s2list], updatedAt: serverTimestamp() });
    } catch(e) { showToast('⚠️ s3 non aggiornato: ' + e.message); }
  }

  releaseLock(`singers_s${serata}`);
  showToast(`Cantanti Serata ${serata} salvati ✓`);
  closeOverlay('overlay-singers');
}

function renderSingersEditor(serata) {
  const container = document.getElementById(`singers-editor-s${serata}`);
  if (!container) return;
  const list = singers[serata];
  // Normalizza: accetta sia stringhe che oggetti {name, song}
  const normalized = list.map(s => typeof s === 'string' ? {name:s, song:''} : s);
  container.innerHTML = normalized.map((s,i) => `
    <div class="singer-edit-row">
      <span class="singer-edit-num">${i+1}</span>
      <div class="singer-edit-fields">
        <input class="singer-edit-name" type="text" value="${s.name}" placeholder="Nome cantante">
        <input class="singer-edit-song" type="text" value="${s.song||''}" placeholder="♪ Titolo canzone">
      </div>
    </div>`).join('') + `
    <button class="btn-save-singers" onclick="saveSingersAdmin(${serata})">
      💾 Salva cantanti Serata ${serata}
    </button>`;
}

// ══════════════════════════════════════════════
//  RENDER PANNELLO
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
//  WATCHER REVOCA DIRITTI IN TEMPO REALE
// ══════════════════════════════════════════════
function startRightsWatcher(uid) {
  if (_unsubRights) _unsubRights();
  let initialLoad = true;
  _unsubRights = onSnapshot(doc(db, 'admins', uid), snap => {
    if (initialLoad) { initialLoad = false; return; } // ignora lo stato iniziale
    if (!snap.exists()) {
      showToast('⚠️ Accesso revocato. Disconnessione in corso…', 3000);
      setTimeout(async () => {
        if (_unsubRights) { _unsubRights(); _unsubRights = null; }
        const { signOut } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
        await signOut(auth);
        window.location.reload();
      }, 2500);
    } else {
      // Diritti concessi o aggiornati: ricarica per applicare i nuovi permessi
      showToast('✅ Permessi aggiornati. Ricaricamento…', 2000);
      setTimeout(() => window.location.reload(), 2000);
    }
  }, () => {});
}

function renderAdminPanel(user, isSuperAdmin = false) {
  const name = user.displayName || user.email || 'Admin';
  const init = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('admin-user-initials').textContent = init;
  document.getElementById('admin-user-name').textContent     = name.split(' ')[0];
  if (isSuperAdmin) {
    const lbl = document.getElementById('admin-title-label');
    const bdg = document.getElementById('admin-badge-label');
    if (lbl) lbl.textContent = 'Admin+';
    if (bdg) { bdg.textContent = 'Super Admin'; bdg.style.background = 'linear-gradient(135deg,#b36bff,#7b2fff)'; }
    document.getElementById('section-gestione-accessi').style.display = '';
  }
  updateSerataLabel();
  updateSwitches();
  refreshRanking();
  // Avvia auto-refresh se votazioni già aperte
  updateRankingAutoRefresh(appConfig.votoAperto !== false);
}

function updateSerataLabel() {
  // Reset auto-refresh sul cambio serata
  updateRankingAutoRefresh(appConfig.votoAperto !== false);
  const el = document.getElementById('current-serata-label');
  if (el) el.textContent = SERATA_LABELS[currentSerata];
  // Mostra/nascondi tasto classifica finale Z-score
  const zBtn = document.getElementById('btn-zscore-wrap');
  if (zBtn) zBtn.style.display = currentSerata === 3 ? '' : 'none';
  // Mostra/nascondi pulsante ordine finale
  const oBtn = document.getElementById('btn-ordine-finale');
  if (oBtn) oBtn.style.display = currentSerata === 3 ? '' : 'none';

  const is3 = currentSerata === 3;
  // Serate 1-2: mostra top5 pubblico, nascondi svela e top5finale
  document.getElementById('toggle-top5-wrap')?.style.setProperty('display', is3 ? 'none' : '');
  // Serata 3: mostra svela e top5finale, nascondi top5 pubblico
  document.getElementById('toggle-top5finale-wrap')?.style.setProperty('display', is3 ? '' : 'none');
  document.getElementById('toggle-svela-wrap')?.style.setProperty('display',      is3 ? '' : 'none');
}

function updateSwitches() {
  setSwitchState('toggle-voto',       appConfig.votoAperto !== false);
  setSwitchState('toggle-top5',       !!appConfig.mostraTop5);
  setSwitchState('toggle-top5finale', !!appConfig.mostraTop5Finale);
  setSwitchState('toggle-svela',      !!appConfig.svelaClassifica);
  const votoAperto = appConfig.votoAperto !== false;
  document.getElementById('toggle-top5-wrap')?.classList.toggle('disabled', votoAperto);
  document.getElementById('toggle-top5finale-wrap')?.classList.toggle('disabled', votoAperto);
  document.getElementById('toggle-svela-wrap')?.classList.toggle('disabled', votoAperto);
}

function setSwitchState(id, state) {
  const el = document.getElementById(id);
  if (el) el.checked = state;
}

// ══════════════════════════════════════════════
//  SERATA — con conferma overlay
// ══════════════════════════════════════════════
let pendingSerata = null;

function openSerataChooser() {
  // Aggiorna bottoni nell'overlay
  [1,2,3].forEach(i =>
    document.getElementById(`ov-s${i}`)?.classList.toggle('active', i === currentSerata)
  );
  pendingSerata = null;
  document.getElementById('btn-confirm-serata').disabled = true;
  openOverlay('overlay-serata');
}

function selectPendingSerata(n) {
  pendingSerata = n;
  [1,2,3].forEach(i => {
    const b = document.getElementById(`ov-s${i}`);
    if (b) b.classList.toggle('active', i === n);
  });
  document.getElementById('btn-confirm-serata').disabled = (n === currentSerata);
}

async function confirmSerataChange() {
  if (!pendingSerata || pendingSerata === currentSerata) return;
  closeOverlay('overlay-serata');
  currentSerata = pendingSerata;
  await saveConfig({ serata: currentSerata });
  updateSerataLabel();
  updateSwitches();
  refreshRanking();
  showToast(`✓ ${SERATA_LABELS[currentSerata]} attivata`);
  // Nascondi subito la sezione jury fino a verifica nuova serata
  const sec = document.getElementById('section-jury-ranking');
  if (sec) sec.style.display = 'none';
  if (window._juryListenerUpdate) window._juryListenerUpdate();
}

// ══════════════════════════════════════════════
//  SWITCH HANDLERS
// ══════════════════════════════════════════════
async function toggleVoto(checked) {
  await saveConfig({ votoAperto: checked });
  if (checked) await saveConfig({ mostraTop5: false, svelaClassifica: false });
  updateSwitches();
  showToast(checked ? '🟢 Votazioni aperte' : '🔴 Votazioni chiuse');
  // Aggiorna classifica immediatamente + gestisci auto-refresh
  await refreshRanking();
  updateRankingAutoRefresh(checked);
}

function updateRankingAutoRefresh(votoAperto) {
  // Ferma sempre il timer esistente
  if (rankingInterval) { clearInterval(rankingInterval); rankingInterval = null; }
  // Avvia solo se votazioni aperte
  if (votoAperto) {
    rankingInterval = setInterval(() => refreshRanking(), 18000); // ogni 18 secondi
  }
}

function blockIfVotoAperto(checkbox, prevValue) {
  // Ripristina il checkbox al valore precedente e mostra toast
  setSwitchState(checkbox, prevValue);
  showToast('⚠️ Chiudi prima le votazioni', 3500);
}

async function toggleTop5(checked) {
  if (appConfig.votoAperto !== false) { blockIfVotoAperto('toggle-top5', !checked); return; }
  await saveConfig({ mostraTop5: checked });
  updateSwitches();
  showToast(checked ? '✓ Top 5 visibile al pubblico' : 'Top 5 nascosto');
}

async function toggleTop5Finale(checked) {
  if (appConfig.votoAperto !== false) { blockIfVotoAperto('toggle-top5finale', !checked); return; }
  await saveConfig({ mostraTop5Finale: checked });
  updateSwitches();
  if (checked) {
    try {
      const snap = await getDoc(doc(db,'jury_ranking','festival'));
      if (!snap.exists() || !snap.data().ranking?.length) {
        showToast('⚠️ Classifica festival non ancora calcolata dal Notaio', 5000);
      } else {
        showToast('✓ Top 5 finale visibile al pubblico');
      }
    } catch(e) {
      showToast('⚠️ Impossibile verificare la classifica festival', 4000);
    }
  } else {
    showToast('Top 5 finale nascosto');
  }
}

async function toggleSvela(checked) {
  if (appConfig.votoAperto !== false) { blockIfVotoAperto('toggle-svela', !checked); return; }
  await saveConfig({ svelaClassifica: checked });
  updateSwitches();
  showToast(checked ? '🏆 Classifica svelata al pubblico' : 'Classifica nascosta');
}

// ══════════════════════════════════════════════
//  CLASSIFICA LIVE (punteggi grezzi serata)
// ══════════════════════════════════════════════
async function refreshRanking() {
  const rows = document.getElementById('admin-ranking-rows');
  if (!rows) return;
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Caricamento…</div>';
  try {
    // Carica voti e cantanti da Firestore direttamente — non dipende da singers in memoria
    const [votesSnap, s1Snap, s2Snap] = await Promise.all([
      getDocs(collection(db, `votes_s${currentSerata}`)),
      getDoc(doc(db,'singers','s1')),
      getDoc(doc(db,'singers','s2'))
    ]);
    const allVotes = []; votesSnap.forEach(d => allVotes.push(d.data()));
    const norm = list => (list||[]).map(s => typeof s==='string' ? {name:s,song:''} : s);
    const list1 = s1Snap.exists() ? norm(s1Snap.data().list) : DEFAULT_SINGERS[1].map(s=>({name:String(s),song:''}));
    const list2 = s2Snap.exists() ? norm(s2Snap.data().list) : DEFAULT_SINGERS[2].map(s=>({name:String(s),song:''}));
    const activeObjs = currentSerata === 3 ? [...list1, ...list2]
                     : currentSerata === 2 ? list2 : list1;
    const songMap = {};
    activeObjs.forEach(s => { songMap[s.name] = s.song || ''; });
    const scores = {};
    activeObjs.forEach(s => scores[s.name] = 0);
    allVotes.forEach(({vote}) =>
      vote?.forEach((name,i) => {
        if (scores[name] === undefined) scores[name] = 0;
        scores[name] += POINTS[i];
      })
    );

    const ranking = Object.entries(scores).sort((a,b) => b[1]-a[1]);
    const maxPts  = ranking[0]?.[1] || 1;

    document.getElementById('stat-votes').textContent = allVotes.length;
    document.getElementById('stat-label').textContent = `Voti — ${SERATA_LABELS[currentSerata]}`;

    rows.innerHTML = '';
    ranking.forEach(([name,pts],i) => {
      const pct  = maxPts > 0 ? (pts/maxPts*100).toFixed(0) : 0;
      const song = songMap[name] || '';
      const r    = document.createElement('div');
      r.className = 'ranking-row';
      r.innerHTML = `
        <span class="r-pos">${i+1}</span>
        <div style="min-width:0">
          <div class="r-name">${name}</div>
          ${song ? `<div class="r-song">♪ ${song}</div>` : ''}
          <div class="r-bar-wrap"><div class="r-bar" style="width:${pct}%"></div></div>
        </div>
        <span class="r-pts">${pts}</span>`;
      rows.appendChild(r);
    });
  } catch(e) {
    rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Errore nel caricamento.</div>';
  }
}

// ══════════════════════════════════════════════
//  CLASSIFICA FINALE Z-SCORE
// ══════════════════════════════════════════════
// Restituisce { nomeCantante: posizione } basata sui punteggi grezzi (1 = primo)
// ── Helpers statistici ───────────────────────
function getRawScores(votes, singerList) {
  const raw = {};
  singerList.forEach(s => raw[typeof s==='string'?s:s.name] = 0);
  votes.forEach(({vote}) =>
    vote?.forEach((name,i) => { if (raw[name] !== undefined) raw[name] += POINTS[i]; })
  );
  return raw;
}

function getRankPositions(raw) {
  const sorted = Object.entries(raw).sort((a,b) => b[1]-a[1]);
  const pos = {};
  sorted.forEach(([name], i) => pos[name] = i + 1);
  return pos;
}

function calcZScores(raw) {
  const vals = Object.values(raw);
  const mean = vals.reduce((a,b) => a+b, 0) / vals.length;
  const std  = Math.sqrt(vals.reduce((a,b) => a + (b-mean)**2, 0) / vals.length);
  const zMap = {};
  Object.keys(raw).forEach(s => zMap[s] = std > 0 ? (raw[s] - mean) / std : 0);
  return zMap;
}

// Clip Z-score a ±2.0 per limitare outlier
const Z_CLIP = 2.0;
function clip(z) { return Math.max(-Z_CLIP, Math.min(Z_CLIP, z)); }

// Peso per affidabilità statistica: √(n_votanti / n_max)
// Stima votanti da punteggio totale grezzo (max 5pt per votante)
function estVoters(raw) {
  return Object.values(raw).reduce((a,b) => a+b, 0) / 5;
}

// ── Mostra classifica salvata — non ricalcola ──
async function showFinalRanking() {
  openOverlay('overlay-final');
  const rows = document.getElementById('admin-final-rows');
  if (!rows) return;
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Caricamento…</div>';
  try {
    const saved = await getDoc(doc(db,'config','finalRanking'));
    if (saved.exists() && saved.data().ranking?.length > 0) {
      renderFinalRows(rows, saved.data().ranking);
    } else {
      rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Nessuna classifica salvata.<br><br>Chiudi e usa <b style=\'color:var(--gold)\'>Calcola classifica</b> per generarla.</div>';
    }
  } catch(e) {
    rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Errore: ' + e.message + '</div>';
  }
}

// ── Ricalcola da zero, salva, mostra ──
async function computeAndShowFinalRanking() {
  openOverlay('overlay-final');
  const rows = document.getElementById('admin-final-rows');
  if (!rows) return;
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Calcolo in corso…</div>';

  try {
    const [snap1, snap2, snap3] = await Promise.all([
      getDocs(collection(db,'votes_s1')),
      getDocs(collection(db,'votes_s2')),
      getDocs(collection(db,'votes_s3'))
    ]);
    const v1=[], v2=[], v3=[];
    snap1.forEach(d=>v1.push(d.data()));
    snap2.forEach(d=>v2.push(d.data()));
    snap3.forEach(d=>v3.push(d.data()));

    // Punteggi grezzi
    const raw1 = getRawScores(v1, singers[1]);
    const raw2 = getRawScores(v2, singers[2]);
    const raw3 = getRawScores(v3, [...singers[1], ...singers[2]]);

    // Z-score per serata
    const z1 = calcZScores(raw1);
    const z2 = calcZScores(raw2);
    const z3 = calcZScores(raw3);

    // Posizioni per punteggio grezzo
    const pos1 = getRankPositions(raw1);
    const pos2 = getRankPositions(raw2);
    const pos3 = getRankPositions(raw3);

    // Pesi affidabilità: √(n_votanti / n_max)
    const n1 = estVoters(raw1);
    const n2 = estVoters(raw2);
    const n3 = estVoters(raw3);
    const nMax = Math.max(n1, n2, n3);
    const w1 = Math.sqrt(n1 / nMax);
    const w2 = Math.sqrt(n2 / nMax);
    const w3 = Math.sqrt(n3 / nMax);

    // Combina: clip + peso per ogni serata
    const allSingers = [...singers[1], ...singers[2]].map(s=>s.name);
    const combined = allSingers.map(name => {
      const inS1    = singers[1].map(s=>s.name).includes(name);
      const zs1     = inS1 ? clip(z1[name]||0) * w1 : null;
      const zs2     = !inS1 ? clip(z2[name]||0) * w2 : null;
      const zs3     = clip(z3[name]||0) * w3;
      const zTot    = (zs1 ?? 0) + (zs2 ?? 0) + zs3;
      return {
        name,
        zTot,
        zs1, zs2, zs3,
        posSerata: inS1 ? pos1[name] : pos2[name],
        posFinale: pos3[name],
        serataNum: inS1 ? 1 : 2
      };
    }).sort((a,b) => b.zTot - a.zTot);

    // Costruisci dati completi con posizioni serata
    const rankingData = combined.map(c => ({
      name:    c.name,
      zTot:    c.zTot,
      posSerata:  c.posSerata,   // posizione in serata 1 o 2 (tra 7)
      posFinale:  c.posFinale,   // posizione in serata 3 (tra 14)
      serataNum:  singers[1].map(s=>s.name).includes(c.name) ? 1 : 2
    }));

    // Forza sovrascrittura su Firestore con merge:false (default setDoc)
    await setDoc(doc(db,'config','finalRanking'), {
      ranking:     rankingData,
      computedAt:  serverTimestamp()
    });

    renderFinalRows(rows, rankingData);

  } catch(e) {
    rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Errore: ' + e.message + '</div>';
  }
}

function renderFinalRows(rows, ranking) {
  rows.innerHTML = '';
  // Mappa nome→canzone da singers caricati
  const songMap = {};
  [...singers[1], ...singers[2]].forEach(s => { songMap[s.name] = s.song || ''; });

  ranking.forEach((c,i) => {
    const serataLabel = c.serataNum ? `Ser.${c.serataNum}: ${c.posSerata}°` : '';
    const finaleLabel = c.posFinale  ? `Finale: ${c.posFinale}°`            : '';
    const subLine     = [serataLabel, finaleLabel].filter(Boolean).join('  |  ');
    const song        = songMap[c.name] || '';
    const r = document.createElement('div');
    r.className = 'ranking-row-final';
    r.innerHTML = `
      <span class="r-pos">${i+1}</span>
      <div style="min-width:0">
        <div class="r-name">${c.name}</div>
        ${song ? `<div class="r-song">♪ ${song}</div>` : ''}
        ${subLine ? `<div class="r-subline">${subLine}</div>` : ''}
      </div>
      <span class="r-zscore">${Number(c.zTot).toFixed(2)}</span>`;
    rows.appendChild(r);
  });
}

// ══════════════════════════════════════════════
//  EXPORT CSV
// ══════════════════════════════════════════════
async function exportCSV() {
  try {
    const snap = await getDocs(collection(db, `votes_s${currentSerata}`));
    if (snap.empty) { showToast('Nessun voto da esportare'); return; }
    let csv = `Serata,UID,Nome,1°,2°,3°,4°,5°,Timestamp\n`;
    snap.forEach(d => {
      const v  = d.data();
      const ts = v.timestamp?.toDate?.().toLocaleString('it-IT') || '–';
      csv += `"${SERATA_LABELS[currentSerata]}","${v.uid}","${v.name}",${v.vote.map(n=>`"${n}"`).join(',')},${ts}\n`;
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
    a.download = `goro_voti_s${currentSerata}_2026.csv`;
    a.click();
  } catch(e) { showToast('Errore esportazione'); }
}

// ══════════════════════════════════════════════
//  RESET VOTI
// ══════════════════════════════════════════════
async function resetVotes() {
  closeOverlay('overlay-reset');
  try {
    const snap = await getDocs(collection(db, `votes_s${currentSerata}`));
    await Promise.all(snap.docs.map(d => deleteDoc(doc(db, `votes_s${currentSerata}`, d.id))));
    await deleteDoc(doc(db,'jury_ranking',`s${currentSerata}`)).catch(()=>{});
    refreshRanking();
    showToast('Voti azzerati ✓');
  } catch(e) { showToast('Errore durante il reset'); }
}


// ══════════════════════════════════════════════
//  ORDINE SERATA FINALE — drag & drop
// ══════════════════════════════════════════════
let _finalOrderList = []; // [{name, song, serataNum}]

async function openFinalOrderEditor() {
  const locked = await acquireLock('final_order');
  if (!locked) return;
  // S3 è sempre aggiornato da saveSingers — lo leggiamo direttamente
  // e aggiungiamo serataNum per visualizzazione (S1=primi 7, S2=secondi 7)
  const s3Snap = await getDoc(doc(db,'singers','s3'));
  const norm = l => (l||[]).map((s,i) => typeof s==='string'
    ? {name:s, song:'', serataNum:0}
    : {name:s.name, song:s.song||'', serataNum:s.serataNum||0});
  _finalOrderList = s3Snap.exists() ? norm(s3Snap.data().list) : [
    ...DEFAULT_SINGERS[1].map(s=>({name:String(s),song:'',serataNum:1})),
    ...DEFAULT_SINGERS[2].map(s=>({name:String(s),song:'',serataNum:2}))
  ];

  renderFinalOrderList();
  openOverlay('overlay-order');
}

let _selectedOrderIdx = null;

function renderFinalOrderList() {
  const container = document.getElementById('order-list');
  container.innerHTML = '';
  _finalOrderList.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'order-row';
    row.dataset.idx = i;
    const isSelected = _selectedOrderIdx === i;
    if (isSelected) row.classList.add('order-selected');
    row.innerHTML = `
      <div class="order-num">${i+1}</div>
      <div class="s-info" style="flex:1;min-width:0">
        <div class="s-name">${s.name}</div>
        ${s.song ? `<div class="s-song">♪ ${s.song}</div>` : ''}
      </div>
      <div class="order-serata">S${s.serataNum||'?'}</div>`;

    row.addEventListener('click', () => {
      if (_selectedOrderIdx === null) {
        // Prima selezione
        _selectedOrderIdx = i;
        renderFinalOrderList();
      } else if (_selectedOrderIdx === i) {
        // Deseleziona
        _selectedOrderIdx = null;
        renderFinalOrderList();
      } else {
        // Sposta: inserisci il selezionato nella posizione toccata
        const fromIdx = _selectedOrderIdx;
        const toIdx   = i;
        const moved   = _finalOrderList.splice(fromIdx, 1)[0];
        _finalOrderList.splice(toIdx, 0, moved);
        _selectedOrderIdx = null;
        renderFinalOrderList();
      }
    });

    container.appendChild(row);
  });
}

async function saveFinalOrder() {
  try {
    const list = _finalOrderList.map(({name, song, serataNum}) => ({name, song, serataNum: serataNum||0}));
    await setDoc(doc(db,'singers','s3'), { list, updatedAt: serverTimestamp() });
    releaseLock('final_order');
    showToast('✓ Ordine finale salvato');
    closeOverlay('overlay-order');
    // Aggiorna singers in memoria
    singers[1] = singers[1]; // invariato
    singers[2] = singers[2]; // invariato
  } catch(e) {
    showToast('Errore nel salvataggio: ' + e.message);
  }
}

// ══════════════════════════════════════════════
//  SIGN OUT — directo, poi reload
// ══════════════════════════════════════════════
async function adminSignOut() {
  await releaseAllLocks().catch(() => {});
  if (_unsubRights) { _unsubRights(); _unsubRights = null; }
  const { signOut } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  await signOut(auth);
  window.location.reload();
}

// ══════════════════════════════════════════════
//  OVERLAY HELPERS
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
    // Swipe sinistra→destra come Android back (dx > 60)
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) closeOverlay(overlayId);
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

// ══════════════════════════════════════════════
//  EXPOSE TO WINDOW
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
//  SUPER-ADMIN — GESTIONE ACCESSI
// ══════════════════════════════════════════════
let allProfiles   = [];   // cache profili caricati
let pendingAction = null; // { uid, role, action: 'assign'|'revoke' }

async function initSuperAdmin() {
  await refreshProfiles(false);
}

async function refreshProfiles(showFeedback = true) {
  const btn = document.querySelector('#section-gestione-accessi .admin-section-title button');
  if (btn) { btn.style.opacity = '.4'; btn.style.pointerEvents = 'none'; }
  try {
    const [profilesSnap, adminsSnap, notaiSnap] = await Promise.all([
      getDocs(collection(db, 'user_profiles')),
      getDocs(collection(db, 'admins')),
      getDocs(collection(db, 'notai')),
    ]);
    const adminUids = new Set(adminsSnap.docs.map(d => d.id));
    const notaiUids = new Set(notaiSnap.docs.map(d => d.id));
    allProfiles = [];
    profilesSnap.forEach(d => allProfiles.push({
      uid:      d.id,
      ...d.data(),
      isAdmin:  adminUids.has(d.id),
      isNotaio: notaiUids.has(d.id),
    }));
    if (showFeedback) {
      showToast(`✓ ${allProfiles.length} profili caricati`);
      // Aggiorna i risultati visibili se c'è una ricerca attiva
      const q = document.getElementById('access-search')?.value || '';
      if (q.length >= 2) searchUsers(q);
    }
  } catch(e) {
    showToast('Errore caricamento profili utente');
  } finally {
    if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
  }
}

function searchUsers(q) {
  const hint = document.getElementById('access-hint');
  const res  = document.getElementById('access-results');
  q = q.trim().toLowerCase();
  if (q.length < 2) {
    res.innerHTML = '';
    hint.style.display = '';
    return;
  }
  hint.style.display = 'none';

  const matches = allProfiles.filter(p => {
    const name  = (p.displayName || '').toLowerCase();
    const email = (p.email || '').toLowerCase();
    const phone = (p.phoneNumber || '').toLowerCase();
    return name.includes(q) || email.includes(q) || phone.includes(q);
  });

  if (!matches.length) {
    res.innerHTML = '<p style="font-size:13px;color:var(--muted);text-align:center">Nessun utente trovato</p>';
    return;
  }

  res.innerHTML = matches.map(p => {
    const label    = p.displayName || p.phoneNumber || p.email || p.uid;
    const sub      = p.displayName ? (p.email || p.phoneNumber || '') : '';
    const isAdmin  = p.isAdmin  || false;
    const isNotaio = p.isNotaio || false;
    return `
    <div class="access-card" data-uid="${p.uid}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="s-name" style="font-size:14px">${label}</span>
          ${isAdmin  ? '<span class="role-badge admin-badge">Admin</span>'  : ''}
          ${isNotaio ? '<span class="role-badge notaio-badge">Notaio</span>' : ''}
        </div>
        ${sub ? `<div class="s-song" style="font-size:12px;margin-top:2px">${sub}</div>` : ''}
        ${!p.displayName && p.phoneNumber ? `<button class="btn-edit-name" onclick="editProfileName('${p.uid}','${label}')">✏️ Aggiungi nome</button>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
        <button class="btn-role ${isAdmin ? 'btn-role-revoke' : 'btn-role-assign'}"
          onclick="confirmRoleAction('${p.uid}','admin','${isAdmin ? 'revoke' : 'assign'}','${label}')">
          ${isAdmin ? '✕ Admin' : '+ Admin'}
        </button>
        <button class="btn-role ${isNotaio ? 'btn-role-revoke' : 'btn-role-assign'}"
          onclick="confirmRoleAction('${p.uid}','notaio','${isNotaio ? 'revoke' : 'assign'}','${label}')">
          ${isNotaio ? '✕ Notaio' : '+ Notaio'}
        </button>
      </div>
    </div>`;
  }).join('');
}

function confirmRoleAction(uid, role, action, label) {
  pendingAction = { uid, role, action };
  const roleLabel = role === 'admin' ? 'Admin' : 'Notaio';
  document.getElementById('access-confirm-title').textContent =
    action === 'assign' ? `Assegna ruolo ${roleLabel}` : `Revoca ruolo ${roleLabel}`;
  let bodyText;
  if (action === 'assign' && role === 'notaio')
    bodyText = `Vuoi assegnare il ruolo Notaio a ${label}? Verrà assegnato anche il ruolo Admin automaticamente.`;
  else if (action === 'revoke' && role === 'admin')
    bodyText = `Vuoi revocare il ruolo Admin a ${label}? Verrà rimosso anche il ruolo Notaio se presente.`;
  else if (action === 'assign')
    bodyText = `Vuoi assegnare il ruolo ${roleLabel} a ${label}?`;
  else
    bodyText = `Vuoi revocare il ruolo ${roleLabel} a ${label}?`;
  document.getElementById('access-confirm-body').textContent = bodyText;
  const btn = document.getElementById('access-confirm-btn');
  btn.textContent = action === 'assign' ? 'Sì, assegna' : 'Sì, revoca';
  btn.style.background = action === 'revoke'
    ? 'linear-gradient(135deg,#E85D5D,#a03030)' : '';
  btn.style.color = action === 'revoke' ? '#fff' : '';
  openOverlay('overlay-access-confirm');
}

async function executeRoleAction() {
  if (!pendingAction) return;
  closeOverlay('overlay-access-confirm');
  const { uid, role, action } = pendingAction;
  pendingAction = null;
  try {
    if (action === 'assign') {
      await setDoc(doc(db, role === 'notaio' ? 'notai' : 'admins', uid), { assignedAt: serverTimestamp() });
      // Notaio implica sempre anche Admin
      if (role === 'notaio') {
        await setDoc(doc(db, 'admins', uid), { assignedAt: serverTimestamp() });
      }
    } else {
      await deleteDoc(doc(db, role === 'notaio' ? 'notai' : 'admins', uid));
      // Revocare Admin rimuove anche Notaio automaticamente
      if (role === 'admin') {
        await deleteDoc(doc(db, 'notai', uid)).catch(() => {});
      }
    }
    // Aggiorna cache locale
    const p = allProfiles.find(x => x.uid === uid);
    if (p) {
      if (role === 'notaio') {
        p.isNotaio = action === 'assign';
        if (action === 'assign') p.isAdmin = true;
      } else {
        p.isAdmin = action === 'assign';
        if (action === 'revoke') p.isNotaio = false;
      }
    }
    showToast(action === 'assign' ? '✓ Ruolo assegnato' : '✓ Ruolo revocato');
    searchUsers(document.getElementById('access-search').value);
  } catch(e) {
    showToast('Errore: ' + e.message);
  }
}

// Modifica nome manuale per utenti con solo telefono
function editProfileName(uid, currentLabel) {
  const name = prompt(`Nome da associare a ${currentLabel}:`, '');
  if (!name?.trim()) return;
  setDoc(doc(db,'user_profiles',uid), { displayName: name.trim() }, { merge: true })
    .then(() => {
      const p = allProfiles.find(x => x.uid === uid);
      if (p) p.displayName = name.trim();
      showToast('✓ Nome salvato');
      searchUsers(document.getElementById('access-search').value);
    })
    .catch(e => showToast('Errore: ' + e.message));
}


window.openSerataChooser      = openSerataChooser;
window.selectPendingSerata    = selectPendingSerata;
window.confirmSerataChange    = confirmSerataChange;
window.closeOverlay           = closeOverlay;
window.toggleVoto             = e => toggleVoto(e.target.checked);
window.toggleTop5             = e => toggleTop5(e.target.checked);
window.toggleTop5Finale       = e => toggleTop5Finale(e.target.checked);
window.toggleSvela            = e => toggleSvela(e.target.checked);
window.refreshRanking         = refreshRanking;
window.showFinalRanking           = showFinalRanking;
window.computeAndShowFinalRanking = computeAndShowFinalRanking;
window.exportCSV              = exportCSV;
window.confirmReset           = () => openOverlay('overlay-reset');
window.resetVotes             = resetVotes;

// ══════════════════════════════════════════════
//  LOCK EDITOR CONCORRENTE
// ══════════════════════════════════════════════
const LOCK_TTL_MS = 120_000;

async function acquireLock(key) {
  const ref = doc(db, 'editing_locks', key);
  const now = Date.now();
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      if (d.expiresAt > now && d.uid !== auth.currentUser?.uid) {
        const ago = Math.round((now - d.lockedAt) / 1000);
        showToast(`⚠️ ${d.name} sta già modificando questo contenuto (${ago}s fa)`, 4000);
        return false;
      }
    }
    await setDoc(ref, {
      uid:       auth.currentUser.uid,
      name:      auth.currentUser.displayName || auth.currentUser.email || 'Admin',
      lockedAt:  now,
      expiresAt: now + LOCK_TTL_MS,
    });
    return true;
  } catch(e) { return true; }
}

async function releaseLock(key) {
  try {
    const ref  = doc(db, 'editing_locks', key);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().uid === auth.currentUser?.uid) await deleteDoc(ref);
  } catch(e) {}
}

async function releaseAllLocks() {
  const keys = ['singers_s1', 'singers_s2', 'final_order'];
  await Promise.all(keys.map(k => releaseLock(k)));
}

async function forceUnlockAll() {
  try {
    const snap = await getDocs(collection(db, 'editing_locks'));
    if (snap.empty) { showToast('Nessun lock attivo'); return; }
    await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'editing_locks', d.id))));
    showToast(`🔓 ${snap.size} lock rimoss${snap.size === 1 ? 'o' : 'i'}`);
  } catch(e) { showToast('Errore: ' + e.message); }
}


// ══════════════════════════════════════════════
//  CLASSIFICA TECNICA IN ADMIN — listener + render
// ══════════════════════════════════════════════
let _unsubJuryRanking = null;

function startJuryRankingWatcher() {
  if (_unsubJuryRanking) return;
  // Ascolta sia la serata corrente che il festival
  const checkAndShow = async () => {
    const serata = currentSerata;
    const key    = serata === 3 ? 'festival' : `s${serata}`;
    try {
      const snap = await getDoc(doc(db,'jury_ranking', key));
      const sec  = document.getElementById('section-jury-ranking');
      if (!sec) return;
      if (snap.exists() && snap.data().ranking?.length) {
        sec.style.display = '';
        // Aggiorna label pulsanti in base alla serata
        const btnFull = document.getElementById('btn-admin-jury-full');
        const btnTop3 = document.getElementById('btn-admin-top3');
        if (serata === 3) {
          if (btnFull) btnFull.textContent = '🏆 Mostra classifica definitiva (tecnica + pubblico)';
          if (btnTop3) btnTop3.textContent = '🎤 Mostra top 3 critica per i conduttori';
        } else {
          if (btnFull) btnFull.textContent = '📊 Mostra classifica tecnica + bonus pubblico';
          if (btnTop3) btnTop3.textContent = '🎤 Mostra top 3 per i conduttori';
        }
      } else {
        sec.style.display = 'none';
      }
    } catch(e) {}
  };

  // Snapshot live su jury_ranking per la serata corrente
  const updateListener = () => {
    if (_unsubJuryRanking) { _unsubJuryRanking(); _unsubJuryRanking = null; }
    const key = currentSerata === 3 ? 'festival' : `s${currentSerata}`;
    let _listenerFirstFire = true; // primo scatto = stato attuale, non una novità
    let _hadRanking = false;       // classifica era già presente al momento dell'attach
    _unsubJuryRanking = onSnapshot(doc(db,'jury_ranking', key), snap => {
      const sec = document.getElementById('section-jury-ranking');
      if (!sec) return;
      const hasRanking = snap.exists() && snap.data().ranking?.length > 0;
      if (hasRanking) {
        sec.style.display = '';
        const btnFull = document.getElementById('btn-admin-jury-full');
        const btnTop3 = document.getElementById('btn-admin-top3');
        if (currentSerata === 3) {
          if (btnFull) btnFull.textContent = '🏆 Mostra classifica definitiva (tecnica + pubblico)';
          if (btnTop3) btnTop3.textContent = '🎤 Mostra top 3 critica per i conduttori';
        } else {
          if (btnFull) btnFull.textContent = '📊 Mostra classifica tecnica + bonus pubblico';
          if (btnTop3) btnTop3.textContent = '🎤 Mostra top 3 per i conduttori';
        }
        // Toast solo se la classifica è APPENA comparsa (non c'era al caricamento)
        if (!_listenerFirstFire && !_hadRanking) {
          showToast('📊 Classifiche disponibili! Vedi sezione Classifica giuria tecnica', 180000);
        }
        _hadRanking = true;
      } else {
        sec.style.display = 'none';
        _hadRanking = false;
      }
      _listenerFirstFire = false;
    }, () => {});
  };

  updateListener();
  // Quando cambia serata, rinnova il listener
  window._juryListenerUpdate = updateListener;
}

// ── Ranking olimpico per admin (ex-aequo con posizione condivisa) ──
function assignOlympicRanksAdmin(sorted) {
  const medals = ['🥇','🥈','🥉'];
  let pos = 1;
  const result = [];
  for (let i = 0; i < sorted.length; ) {
    const score = sorted[i].total ?? sorted[i].score ?? sorted[i].totalScore ?? 0;
    let j = i;
    while (j < sorted.length && (sorted[j].total ?? sorted[j].score ?? sorted[j].totalScore ?? 0) === score) j++;
    const count     = j - i;
    const isExAequo = count > 1;
    const label     = medals[pos-1] || `${pos}°`;
    for (let k = i; k < j; k++) {
      result.push({ ...sorted[k], rankLabel: isExAequo ? `${pos}°` : label, exAequo: isExAequo, rankNum: pos });
    }
    pos += count;
    i = j;
  }
  return result;
}

async function adminShowJuryRanking() {
  openOverlay('overlay-admin-jury');
  const rows  = document.getElementById('overlay-admin-jury-rows');
  const title = document.getElementById('overlay-admin-jury-title');
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Caricamento…</div>';
  const key = currentSerata === 3 ? 'festival' : `s${currentSerata}`;
  const label = currentSerata === 3 ? 'Classifica definitiva (tecnica + pubblico)' : `Classifica tecnica — ${SERATA_LABELS[currentSerata]}`;
  if (title) title.textContent = (currentSerata === 3 ? '🏆 ' : '📊 ') + label;
  try {
    const snap = await getDoc(doc(db,'jury_ranking', key));
    if (!snap.exists() || !snap.data().ranking?.length) {
      rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Classifica non ancora calcolata dal Notaio.</div>';
      return;
    }
    const ranking = snap.data().ranking;
    rows.innerHTML = '';
    const ranked = assignOlympicRanksAdmin(ranking);
    const card = document.createElement('div');
    card.className = 'ranking-card';
    card.innerHTML = `<div class="ranking-head"><span>#</span><span>Cantante</span><span></span></div>`;
    ranked.forEach(r => {
      const row = document.createElement('div');
      row.className = 'ranking-row' + (r.exAequo ? ' ex-aequo' : '');
      const name = r.name || r.singer || '';
      const song = r.song || '';
      row.innerHTML = `
        <span class="r-pos">${r.rankLabel}</span>
        <div style="min-width:0">
          <div class="r-name">${name}</div>
          ${song ? `<div class="r-song">♪ ${song}</div>` : ''}
          ${r.exAequo ? `<div class="ex-aequo-badge">ex-aequo</div>` : ''}
        </div>
        <span></span>`;
      card.appendChild(row);
    });
    rows.appendChild(card);
  } catch(e) {
    rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Errore: ' + e.message + '</div>';
  }
}

async function adminShowTop3() {
  openOverlay('overlay-admin-top3');
  const rows     = document.getElementById('overlay-top3-rows');
  const title    = document.getElementById('overlay-top3-title');
  const subtitle = document.getElementById('overlay-top3-subtitle');
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Caricamento…</div>';

  const isFinale = currentSerata === 3;
  if (title) title.textContent = isFinale ? '🎤 Top 3 critica' : '🎤 Top 3 — ' + SERATA_LABELS[currentSerata];
  if (subtitle) subtitle.textContent = isFinale
    ? 'I tre migliori della giuria critica — in ordine di classifica'
    : 'I tre nomi in ordine casuale per la rivelazione sul palco';

  try {
    let top3names;

    if (isFinale) {
      // Serata 3: usa criticRanking da jury_ranking/festival, in ordine corretto
      const snap = await getDoc(doc(db,'jury_ranking','festival'));
      if (!snap.exists()) {
        rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Classifica festival non ancora calcolata.</div>';
        return;
      }
      const data = snap.data();
      const source = data.criticRanking?.length ? data.criticRanking : data.ranking;
      if (!source?.length) {
        rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Classifica critica non disponibile.</div>';
        return;
      }
      top3names = source.slice(0,3).map(r => r.name || r.singer || '');
      // Ordine corretto con medaglie
      const ranked3 = assignOlympicRanksAdmin(source.slice(0,3));
      const medalEmoji = ['🥇','🥈','🥉'];
      rows.innerHTML = ranked3.map((r, i) => `
        <div style="margin-bottom:16px">
          <div style="font-size:36px;margin-bottom:4px">${r.exAequo ? r.rankLabel : (medalEmoji[i]||r.rankLabel)}</div>
          <div style="font-size:20px;font-weight:700;color:var(--text)">${r.name||r.singer||''}</div>
          ${r.exAequo ? `<div class="ex-aequo-badge" style="margin:4px auto 0;display:inline-block">ex-aequo</div>` : ''}
        </div>`).join('');
    } else {
      // Serate 1/2: shuffle come in notaio — i nomi appaiono in ordine casuale senza medaglie
      const snap = await getDoc(doc(db,'jury_ranking',`s${currentSerata}`));
      if (!snap.exists() || !snap.data().ranking?.length) {
        rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Classifica non ancora calcolata.</div>';
        return;
      }
      const shuffled = snap.data().ranking.slice(0,3)
        .map(r => r.name || r.singer || '')
        .sort(() => Math.random() - 0.5);
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      rows.innerHTML = shuffled.map((name, i) => `
        <div style="padding:16px;background:var(--surf2);border-radius:var(--r);border:1px solid ${colors[i]}33;margin-bottom:12px">
          <div style="font-size:22px;font-family:'Playfair Display',serif;font-weight:900;color:${colors[i]}">${name}</div>
        </div>`).join('');
    }
  } catch(e) {
    rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">Errore: ' + e.message + '</div>';
  }
}

window.saveSingersAdmin       = saveSingers;
window.openSingersEditor = async (s) => {
  window._editingSerata = s;
  const locked = await acquireLock(`singers_s${s}`);
  if (!locked) return;
  [1,2].forEach(n => {
    const el = document.getElementById(`singers-editor-s${n}`);
    if (el) el.style.display = n === s ? 'block' : 'none';
  });
  renderSingersEditor(s);
  openOverlay('overlay-singers');
};
window.saveSingersOverlay     = () => saveSingers(window._editingSerata);
window.signOutAdmin           = adminSignOut;
window.searchUsers            = searchUsers;
window.refreshProfiles        = refreshProfiles;
window.forceUnlockAll         = forceUnlockAll;
window.adminShowJuryRanking    = adminShowJuryRanking;
window.adminShowTop3           = adminShowTop3;
window.confirmRoleAction      = confirmRoleAction;
window.executeRoleAction      = executeRoleAction;
window.editProfileName        = editProfileName;
window.openFinalOrderEditor   = openFinalOrderEditor;
window.saveFinalOrder         = saveFinalOrder;
