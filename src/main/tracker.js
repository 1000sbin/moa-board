// ─────────────────────────────────────────────
// 워크 트래커 자동 감지 엔진 (윈도우)
// active-win으로 최상단 창을 주기적으로 확인 →
// app_rule 매핑 → 카테고리별 세션 시간 누적
// ─────────────────────────────────────────────
const { powerMonitor } = require('electron');
const db = require('../db/db');

let activeWin = null; // 지연 로드 (ESM 대응)
let timer = null;
let current = null;   // { category, appName, startedAt, sessionId, lastTick }
let paused = false;

// 감지 루프가 실제로 본 프로그램들을 계속 수집 (규칙 UI 목록용)
// openWindows() 미지원 환경에서도 항상 작동하도록
const seenApps = new Map(); // key: procBase.toLowerCase(), val: {process, sampleTitle, lastSeen}

const POLL_MS = 5000; // 5초마다 최상단 창 확인

async function loadActiveWin() {
  if (!activeWin) {
    // active-win v8+ 는 ESM. dynamic import로 로드
    activeWin = (await import('active-win')).default;
  }
  return activeWin;
}

// 프로세스명/타이틀 → 카테고리 매핑
function matchCategory(win) {
  if (!win) return null;
  const proc = (win.owner && win.owner.name) ? win.owner.name : '';
  const title = win.title || '';
  const procBase = proc.replace(/\.exe$/i, ''); // 윈도우 .exe 제거

  // 감지된 프로그램을 "최근 본 앱" 목록에 기록 (자기 자신 제외)
  if (procBase && !/^electron$|moaboard/i.test(procBase)) {
    seenApps.set(procBase.toLowerCase(), {
      process: procBase,
      sampleTitle: title,
      lastSeen: Date.now(),
    });
  }

  const rules = db.get().prepare('SELECT * FROM app_rule').all();
  for (const r of rules) {
    const target = r.match_type === 'title' ? title : procBase;
    if (target && target.toLowerCase().includes(r.pattern.toLowerCase())) {
      console.log(`[detect] proc="${procBase}" -> ${r.category}`);
      return { category: r.category, icon: r.icon, appName: procBase || title };
    }
  }
  console.log(`[detect:unmapped] proc="${procBase}" title="${title}" -> etc`);
  return { category: '기타', icon: 'apps', appName: procBase || title || '알 수 없음' };
}

function startSession(match) {
  const now = new Date().toISOString();
  const info = db.get()
    .prepare('INSERT INTO work_session (category, app_name, started_at, seconds, source) VALUES (?,?,?,0,?)')
    .run(match.category, match.appName, now, 'auto');
  current = {
    category: match.category,
    icon: match.icon,
    appName: match.appName,
    startedAt: now,
    sessionId: info.lastInsertRowid,
    lastTick: Date.now(),
  };
}

function accumulate() {
  if (!current) return;
  const nowMs = Date.now();
  const delta = Math.round((nowMs - current.lastTick) / 1000);
  current.lastTick = nowMs;
  if (delta <= 0) return;
  db.get().prepare(
    'UPDATE work_session SET seconds = seconds + ?, ended_at = ? WHERE id = ?'
  ).run(delta, new Date().toISOString(), current.sessionId);
}

function endSession() {
  if (!current) return;
  accumulate();
  current = null;
}

async function tick(onUpdate) {
  if (paused) return;

  // idle 감지: 일정 시간 입력 없으면 세션 일시정지 (자리 비움)
  const idleThreshold = parseInt(
    db.get().prepare("SELECT value FROM setting WHERE key='idleThresholdSec'").get()?.value || '90',
    10
  );
  const idleSec = powerMonitor.getSystemIdleTime();
  if (idleSec >= idleThreshold) {
    endSession();
    if (onUpdate) onUpdate(getStatus());
    return;
  }

  try {
    const aw = await loadActiveWin();
    const win = await aw();
    const match = matchCategory(win);

    if (!current) {
      startSession(match);
    } else if (match.category !== current.category) {
      // 카테고리 바뀌면 이전 세션 닫고 새 세션
      endSession();
      startSession(match);
    } else {
      accumulate();
    }
  } catch (e) {
    // active-win 실패 시 조용히 넘어감
    // (윈도우: 대부분 바로 동작. 일부 보안 프로그램이 막을 수 있음)
  }
  if (onUpdate) onUpdate(getStatus());
}

// 현재 상태 + 오늘 카테고리별 합계
function getStatus() {
  const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD (로컬)
  const totals = db.get().prepare(`
    SELECT category, SUM(seconds) AS secs
    FROM work_session
    WHERE date(started_at, 'localtime') = ?
    GROUP BY category
    ORDER BY secs DESC
  `).all(today);

  const totalSecs = totals.reduce((a, b) => a + (b.secs || 0), 0);

  let currentSessionSecs = 0;
  let currentCategoryTodaySecs = 0;
  if (current) {
    const row = db.get().prepare('SELECT seconds FROM work_session WHERE id=?').get(current.sessionId);
    currentSessionSecs = row ? row.seconds : 0;
    // 현재 카테고리의 오늘 총 누적 (여러 세션 합산)
    const cat = totals.find(t => t.category === current.category);
    currentCategoryTodaySecs = cat ? cat.secs : currentSessionSecs;
  }

  return {
    active: !!current && !paused,
    paused,
    current: current ? {
      category: current.category,
      icon: current.icon,
      appName: current.appName,
      seconds: currentSessionSecs,             // 이번 세션
      categoryTodaySeconds: currentCategoryTodaySecs, // 이 카테고리 오늘 총 누적
    } : null,
    todayTotals: totals,   // [{category, secs}]
    todayTotalSecs: totalSecs,
  };
}

function start(onUpdate) {
  if (timer) return;
  timer = setInterval(() => tick(onUpdate), POLL_MS);
  tick(onUpdate); // 즉시 1회
}
function stop() {
  clearInterval(timer);
  timer = null;
  endSession();
}
function setPaused(p) {
  paused = p;
  if (p) endSession();
}

// 현재 열려있는 창들에서 "프로그램 목록"을 추출 (규칙 추가 UI용)
// 프로세스명 기준 중복 제거. 사용자가 프로세스명 몰라도 목록에서 고르면 됨.
async function listRunningApps() {
  const seen = new Map();
  const rules = db.get().prepare('SELECT pattern,category FROM app_rule').all();

  const addApp = (procBase, title) => {
    if (!procBase) return;
    if (/^electron$|moaboard/i.test(procBase)) return;
    const key = procBase.toLowerCase();
    if (seen.has(key)) return;
    let mapped = null;
    for (const r of rules) {
      if (key.includes(r.pattern.toLowerCase())) { mapped = r.category; break; }
    }
    seen.set(key, { process: procBase, sampleTitle: title || '', mappedCategory: mapped });
  };

  // 1) openWindows() 지원되면 그걸로 (한 번에 다 가져오기)
  try {
    const aw = await loadActiveWin();
    if (typeof aw.openWindows === 'function') {
      const wins = await Promise.resolve(aw.openWindows());
      for (const w of wins) {
        const proc = (w.owner && w.owner.name) ? w.owner.name : '';
        addApp(proc.replace(/\.exe$/i, ''), w.title);
      }
    }
  } catch (_) {}

  // 2) 그동안 감지 루프가 본 프로그램들 합치기 (openWindows 미지원 환경의 핵심 경로)
  //    최근 본 순으로 정렬
  const recents = Array.from(seenApps.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  for (const r of recents) {
    addApp(r.process, r.sampleTitle);
  }

  const result = Array.from(seen.values());
  console.log('[rulesUI] apps:', result.map(r => r.process).join(', ') || '(none yet)');
  return result;
}

// 현재 등록된 카테고리 목록 (규칙에서 distinct)
function listCategories() {
  const rows = db.get().prepare('SELECT DISTINCT category FROM app_rule ORDER BY category').all();
  return rows.map(r => r.category);
}

module.exports = { start, stop, setPaused, getStatus, listRunningApps, listCategories };
