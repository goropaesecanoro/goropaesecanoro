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
  collection, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Stato ─────────────────────────────────────
let currentSerata = 1;
let appConfig     = {};
let singers       = { 1: [...DEFAULT_SINGERS[1]], 2: [...DEFAULT_SINGERS[2]] };

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
      document.body.innerHTML =
        '<div style="font-family:monospace;background:#0D0D18;color:#F0EDE6;min-height:100vh;'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px">'
      + '<div style="color:#E85D5D;font-size:20px;margin-bottom:20px">DEBUG — accesso negato</div>'
      + '<pre style="background:#1E1E35;border:1px solid #C9A84C;border-radius:12px;padding:20px;'
      + 'font-size:14px;white-space:pre-wrap;word-break:break-all;max-width:440px;width:100%">'
      + debugInfo + '</pre>'
      + '<button onclick="window.location.href=\'index.html\'" '
      + 'style="margin-top:20px;background:#1E1E35;color:#F0EDE6;border:1px solid rgba(255,255,255,.2);'
      + 'border-radius:100px;padding:12px 24px;cursor:pointer;font-size:14px">← Torna al sito</button>'
      + '</div>';
      return;
    }

    await Promise.all([loadConfig(), loadAllSingers()]);
    renderAdminPanel(user);
    showScreen('screen-admin');
  });
}

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
async function loadConfig() {
  try {
    const snap = await getDoc(doc(db,'config','current'));
    appConfig     = snap.exists() ? snap.data() : {};
    currentSerata = appConfig.serata || 1;
  } catch(e) { currentSerata = 1; }
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
  await setDoc(doc(db,'singers',`s${serata}`), { list, updatedAt: serverTimestamp() });
  singers[serata] = list;
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
function renderAdminPanel(user) {
  const name = user.displayName || user.email || 'Admin';
  const init = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('admin-user-initials').textContent = init;
  document.getElementById('admin-user-name').textContent     = name.split(' ')[0];
  updateSerataLabel();
  updateSwitches();
  refreshRanking();
}

function updateSerataLabel() {
  const el = document.getElementById('current-serata-label');
  if (el) el.textContent = SERATA_LABELS[currentSerata];
  // Mostra/nascondi tasto classifica finale Z-score
  const zBtn = document.getElementById('btn-zscore-wrap');
  if (zBtn) zBtn.style.display = currentSerata === 3 ? '' : 'none';
}

function updateSwitches() {
  setSwitchState('toggle-voto',  appConfig.votoAperto !== false);
  setSwitchState('toggle-top5',  !!appConfig.mostraTop5);
  setSwitchState('toggle-svela', !!appConfig.svelaClassifica);
  const votoAperto = appConfig.votoAperto !== false;
  document.getElementById('toggle-top5-wrap')?.classList.toggle('disabled', votoAperto);
  document.getElementById('toggle-svela-wrap')?.classList.toggle('disabled', votoAperto || currentSerata !== 3);
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
}

// ══════════════════════════════════════════════
//  SWITCH HANDLERS
// ══════════════════════════════════════════════
async function toggleVoto(checked) {
  await saveConfig({ votoAperto: checked });
  if (checked) await saveConfig({ mostraTop5: false, svelaClassifica: false });
  updateSwitches();
  showToast(checked ? '🟢 Votazioni aperte' : '🔴 Votazioni chiuse');
}

async function toggleTop5(checked) {
  if (appConfig.votoAperto !== false) { showToast('Chiudi prima le votazioni'); return; }
  await saveConfig({ mostraTop5: checked });
  updateSwitches();
  showToast(checked ? 'Top 5 visibile al pubblico' : 'Top 5 nascosto');
}

async function toggleSvela(checked) {
  if (currentSerata !== 3) { showToast('Disponibile solo nella Finale'); return; }
  if (appConfig.votoAperto !== false) { showToast('Chiudi prima le votazioni'); return; }
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
    refreshRanking();
    showToast('Voti azzerati');
  } catch(e) { showToast('Errore durante il reset'); }
}

// ══════════════════════════════════════════════
//  SIGN OUT — directo, poi reload
// ══════════════════════════════════════════════
async function adminSignOut() {
  const { signOut } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  await signOut(auth);
  window.location.reload();
}

// ══════════════════════════════════════════════
//  OVERLAY HELPERS
// ══════════════════════════════════════════════
function openOverlay(id)  { const el = document.getElementById(id); if(el) el.style.display='flex'; }
function closeOverlay(id) { const el = document.getElementById(id); if(el) el.style.display='none'; }

// ══════════════════════════════════════════════
//  EXPOSE TO WINDOW
// ══════════════════════════════════════════════
window.openSerataChooser      = openSerataChooser;
window.selectPendingSerata    = selectPendingSerata;
window.confirmSerataChange    = confirmSerataChange;
window.closeOverlay           = closeOverlay;
window.toggleVoto             = e => toggleVoto(e.target.checked);
window.toggleTop5             = e => toggleTop5(e.target.checked);
window.toggleSvela            = e => toggleSvela(e.target.checked);
window.refreshRanking         = refreshRanking;
window.showFinalRanking           = showFinalRanking;
window.computeAndShowFinalRanking = computeAndShowFinalRanking;
window.exportCSV              = exportCSV;
window.confirmReset           = () => openOverlay('overlay-reset');
window.resetVotes             = resetVotes;
window.saveSingersAdmin       = saveSingers;
window.openSingersEditor = (s) => {
  // Mostra solo l'editor della serata selezionata, nasconde l'altro
  [1,2].forEach(n => {
    const el = document.getElementById(`singers-editor-s${n}`);
    if (el) el.style.display = n === s ? 'block' : 'none';
  });
  renderSingersEditor(s);
  openOverlay('overlay-singers');
};
window.saveSingersOverlay     = () => saveSingers(window._editingSerata);
window.signOutAdmin           = adminSignOut;
