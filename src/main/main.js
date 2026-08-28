// ─────────────────────────────────────────────
// 모아보드 — Electron 메인 프로세스
// 창 관리 · 트레이 상주 · 자동 시작 · IPC(DB 브릿지)
// ─────────────────────────────────────────────
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const db = require('../db/db');
const tracker = require('./tracker');

// (node:sqlite가 실험 기능 경고를 낼 수 있으나 동작에는 문제 없음)

let win = null;
let tray = null;
let isQuiting = false;

const isDev = process.argv.includes('--dev');

// 단일 인스턴스 보장 (상시 켜지는 앱이니 중복 실행 방지)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const MIN_W = 900, MIN_H = 600;

  // 저장된 창 상태 불러오기 (있으면 그대로, 없으면 세로 70% 계산)
  let bounds = null;
  try {
    const saved = db.get().prepare("SELECT value FROM setting WHERE key='windowBounds'").get();
    if (saved && saved.value) bounds = JSON.parse(saved.value);
  } catch (_) {}

  let winW, winH, winX, winY, useCenter = true;
  if (bounds && bounds.width && bounds.height) {
    // 저장된 크기/위치 사용
    winW = Math.max(bounds.width, MIN_W);
    winH = Math.max(bounds.height, MIN_H);
    // 위치가 화면 안에 있는지 확인 (모니터 바뀌었을 때 대비)
    if (typeof bounds.x === 'number' && typeof bounds.y === 'number' &&
        bounds.x >= -50 && bounds.y >= -50 &&
        bounds.x < workAreaSize.width - 100 && bounds.y < workAreaSize.height - 100) {
      winX = bounds.x; winY = bounds.y; useCenter = false;
    }
  } else {
    // 첫 실행: 세로 화면의 70%
    winH = Math.round(workAreaSize.height * 0.70);
    winW = Math.round(winH * 1.55);
    winW = Math.min(winW, Math.round(workAreaSize.width * 0.90));
    winH = Math.max(winH, MIN_H);
    winW = Math.max(winW, MIN_W);
  }

  win = new BrowserWindow({
    width: winW,
    height: winH,
    ...(useCenter ? { center: true } : { x: winX, y: winY }),
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,               // 커스텀 타이틀바
    backgroundColor: '#f7f7f8',
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startedHidden) win.show();  // 부팅 자동시작이면 숨긴 채 시작
  });

  // 창 크기/위치 저장 (리사이즈·이동 멈춘 뒤 저장 — 디바운스)
  let saveTimer = null;
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getBounds();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        db.get().prepare(
          "INSERT INTO setting(key,value) VALUES('windowBounds',?) ON CONFLICT(key) DO UPDATE SET value=?"
        ).run(JSON.stringify(b), JSON.stringify(b));
      } catch (_) {}
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // 닫기 → 종료 대신 트레이로 숨김 (상주)
  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  // 아이콘 없으면 빈 이미지로라도 트레이 생성
  let icon = nativeImage.createEmpty();
  try {
    const p = path.join(__dirname, '..', 'renderer', 'assets', 'tray.png');
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      // 윈도우 트레이는 16px 기준 (고DPI는 자동 처리)
      icon = img.resize({ width: 16, height: 16, quality: 'best' });
    }
  } catch (_) {}

  tray = new Tray(icon);
  tray.setToolTip('모아보드');
  const menu = Menu.buildFromTemplate([
    { label: '열기', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    {
      label: '작업 감지 일시정지',
      type: 'checkbox',
      click: (item) => tracker.setPaused(item.checked),
    },
    { type: 'separator' },
    { label: '종료', click: () => { isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// 윈도우 로그인 시 자동 시작 (시작프로그램 등록)
function applyAutoLaunch() {
  const row = db.get().prepare("SELECT value FROM setting WHERE key='autoLaunch'").get();
  const enabled = !row || row.value === '1';
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ['--hidden'],   // 부팅 시엔 트레이로 조용히 시작
  });
}

// 부팅 자동시작으로 켜졌는지 (그럼 창 숨긴 채 트레이로만)
const startedHidden = process.argv.includes('--hidden');

// ── IPC: 워크 트래커 상태를 렌더러로 push ──
function pushTracker(status) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('tracker:update', status);
  }
}

app.whenReady().then(() => {
  db.init(app.getPath('userData'));
  applyAutoLaunch();
  createWindow();
  createTray();
  tracker.start(pushTracker);
  registerIpc();
  setupAutoUpdate();
});

// ── 자동 업데이트 (깃허브 릴리스에서 새 버전 감지) ──
let _autoUpdater = null;
function setupAutoUpdate() {
  // 개발 모드(--dev)나 패키징 안 된 상태에선 스킵
  if (isDev || !app.isPackaged) return;
  let autoUpdater, log;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_) {
    return; // 모듈 없으면 조용히 스킵
  }
  // 로그 파일 남기기 (electron-log가 있으면)
  try {
    log = require('electron-log');
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    log.info('=== 앱 시작, 자동 업데이트 로거 연결됨 ===');
  } catch (_) { /* 로그 모듈 없어도 계속 */ }

  _autoUpdater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // 렌더러로 상태 보내기 (진단 UI에서 표시)
  const send = (status, data) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:status', { status, data });
  };
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', info && info.version));
  autoUpdater.on('update-not-available', (info) => send('latest', info && info.version));
  autoUpdater.on('download-progress', (p) => send('downloading', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => {
    if (tray) tray.setToolTip('모아보드 · 업데이트 준비됨 (재시작 시 적용)');
    send('ready', info && info.version);
    if (win && !win.isDestroyed()) win.webContents.send('update:ready', info && info.version);
  });
  autoUpdater.on('error', (err) => send('error', String(err && err.message || err)));

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.on('window-all-closed', (e) => {
  // 상주 앱: 창 다 닫혀도 종료 안 함 (맥 제외 로직 불필요)
});
app.on('before-quit', () => { isQuiting = true; tracker.stop(); });

// ─────────────────────────────────────────────
// IPC 핸들러 — 렌더러에서 DB에 접근하는 통로
// ─────────────────────────────────────────────
function registerIpc() {
  const D = () => db.get();

  // 창 컨트롤
  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:hide', () => win.hide());
  ipcMain.on('win:close', () => win.hide());

  // 트래커
  ipcMain.handle('tracker:status', () => tracker.getStatus());
  ipcMain.handle('tracker:setPaused', (_e, p) => { tracker.setPaused(p); return tracker.getStatus(); });
  ipcMain.handle('tracker:runningApps', () => tracker.listRunningApps());
  ipcMain.handle('tracker:categories', () => tracker.listCategories());

  // 앱 규칙
  ipcMain.handle('rules:list', () => D().prepare('SELECT * FROM app_rule ORDER BY id').all());
  ipcMain.handle('rules:add', (_e, r) =>
    D().prepare('INSERT INTO app_rule (match_type,pattern,category,icon) VALUES (?,?,?,?)')
       .run(r.match_type || 'process', r.pattern, r.category, r.icon || 'apps').lastInsertRowid);
  ipcMain.handle('rules:delete', (_e, id) => D().prepare('DELETE FROM app_rule WHERE id=?').run(id).changes);

  // 할 일
  ipcMain.handle('todo:list', () => {
    // 미완료 전부 + 완료된 것 중 '오늘 완료'만 표시
    const rows = D().prepare(`
      SELECT * FROM todo
      WHERE done = 0
         OR (done = 1 AND date(done_at) = date('now','localtime'))
      ORDER BY done, sort_order, id
    `).all();
    const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
    return rows.map(t => {
      // 이월: 미완료인데 만든 날짜가 오늘보다 이전
      const created = (t.created_at || '').slice(0, 10);
      const carried = !t.done && created && created < today;
      return { ...t, carried };
    });
  });
  ipcMain.handle('todo:add', (_e, t) =>
    D().prepare('INSERT INTO todo (title,category,due_date) VALUES (?,?,?)')
       .run(t.title, t.category || null, t.due_date || null).lastInsertRowid);
  ipcMain.handle('todo:toggle', (_e, id) => {
    const cur = D().prepare('SELECT done FROM todo WHERE id=?').get(id);
    if (!cur) return 0;
    if (cur.done) {
      // 완료 → 미완료: done_at 지움
      return D().prepare('UPDATE todo SET done=0, done_at=NULL WHERE id=?').run(id).changes;
    } else {
      // 미완료 → 완료: 완료 시각 기록
      return D().prepare("UPDATE todo SET done=1, done_at=datetime('now','localtime') WHERE id=?").run(id).changes;
    }
  });
  ipcMain.handle('todo:update', (_e, t) =>
    D().prepare('UPDATE todo SET title=?, category=? WHERE id=?')
       .run(t.title, t.category || null, t.id).changes);
  ipcMain.handle('todo:delete', (_e, id) =>
    D().prepare('DELETE FROM todo WHERE id=?').run(id).changes);
  // 특정 날짜(YYYY-MM-DD)에 완료한 할 일 목록
  ipcMain.handle('todo:doneOn', (_e, ymd) =>
    D().prepare(`
      SELECT * FROM todo
      WHERE done=1 AND date(done_at) = ?
      ORDER BY done_at
    `).all(ymd));

  // 일정 / D-day
  ipcMain.handle('event:list', (_e, month) => {
    if (month) {
      // 그달에 시작하거나, 기간 일정이 그달에 걸치는 것 모두 포함
      const first = month + '-01';
      const last = month + '-31';
      return D().prepare(`
        SELECT * FROM event
        WHERE (date LIKE ?)
           OR (end_date IS NOT NULL AND date <= ? AND end_date >= ?)
        ORDER BY date, time
      `).all(month + '%', last, first);
    }
    return D().prepare('SELECT * FROM event ORDER BY date,time').all();
  });
  ipcMain.handle('event:add', (_e, ev) =>
    D().prepare('INSERT INTO event (title,category,date,end_date,time,is_deadline,memo) VALUES (?,?,?,?,?,?,?)')
       .run(ev.title, ev.category || null, ev.date, ev.end_date || null, ev.time || null, ev.is_deadline ? 1 : 0, ev.memo || null).lastInsertRowid);
  ipcMain.handle('event:update', (_e, ev) =>
    D().prepare('UPDATE event SET title=?, category=?, date=?, end_date=?, time=?, is_deadline=?, memo=? WHERE id=?')
       .run(ev.title, ev.category || null, ev.date, ev.end_date || null, ev.time || null, ev.is_deadline ? 1 : 0, ev.memo || null, ev.id).changes);
  ipcMain.handle('event:delete', (_e, id) => D().prepare('DELETE FROM event WHERE id=?').run(id).changes);
  // D-day: 오늘 이후 마감만
  ipcMain.handle('event:ddays', () => {
    const today = new Date().toLocaleDateString('sv');
    return D().prepare("SELECT * FROM event WHERE is_deadline=1 AND date >= ? ORDER BY date").all(today);
  });

  // 습관
  ipcMain.handle('habit:list', () => D().prepare('SELECT * FROM habit ORDER BY sort_order,id').all());
  ipcMain.handle('habit:add', (_e, h) =>
    D().prepare('INSERT INTO habit (name,icon) VALUES (?,?)').run(h.name, h.icon || 'check').lastInsertRowid);
  ipcMain.handle('habit:toggle', (_e, { habitId, date }) => {
    const exist = D().prepare('SELECT id FROM habit_log WHERE habit_id=? AND date=?').get(habitId, date);
    if (exist) { D().prepare('DELETE FROM habit_log WHERE id=?').run(exist.id); return false; }
    D().prepare('INSERT INTO habit_log (habit_id,date) VALUES (?,?)').run(habitId, date); return true;
  });
  ipcMain.handle('habit:weekLog', (_e, { from, to }) =>
    D().prepare('SELECT habit_id,date FROM habit_log WHERE date BETWEEN ? AND ?').all(from, to));
  ipcMain.handle('habit:delete', (_e, id) => {
    D().prepare('DELETE FROM habit_log WHERE habit_id=?').run(id);
    return D().prepare('DELETE FROM habit WHERE id=?').run(id).changes;
  });

  // 월간 목표
  const monthGoalProgress = (g) => {
    // 진행률(0~100) 계산. 시간형은 work_session에서 자동 집계
    if (g.type === 'time') {
      const secs = D().prepare(`
        SELECT COALESCE(SUM(seconds),0) s FROM work_session
        WHERE category = ? AND strftime('%Y-%m', started_at, 'localtime') = ?
      `).get(g.category || '', g.month).s;
      const hours = secs / 3600;
      return { ...g, current: Math.round(hours * 10) / 10, pct: g.target ? Math.min(100, Math.round(hours / g.target * 100)) : 0 };
    }
    if (g.type === 'check') {
      return { ...g, pct: g.current >= 1 ? 100 : 0 };
    }
    // count
    return { ...g, pct: g.target ? Math.min(100, Math.round(g.current / g.target * 100)) : 0 };
  };
  ipcMain.handle('mgoal:list', (_e, month) => {
    const rows = D().prepare('SELECT * FROM month_goal WHERE month=? ORDER BY sort_order,id').all(month);
    return rows.map(monthGoalProgress);
  });
  ipcMain.handle('mgoal:add', (_e, g) =>
    D().prepare('INSERT INTO month_goal (month,title,type,target,current,category,icon) VALUES (?,?,?,?,?,?,?)')
       .run(g.month, g.title, g.type || 'count', g.target || 1, g.current || 0, g.category || null, g.icon || 'flag').lastInsertRowid);
  ipcMain.handle('mgoal:update', (_e, g) =>
    D().prepare('UPDATE month_goal SET title=?, type=?, target=?, current=?, category=?, icon=? WHERE id=?')
       .run(g.title, g.type, g.target, g.current, g.category || null, g.icon || 'flag', g.id).changes);
  // 수치형 +/- 증감
  ipcMain.handle('mgoal:step', (_e, { id, delta }) => {
    const g = D().prepare('SELECT * FROM month_goal WHERE id=?').get(id);
    if (!g) return null;
    let cur = (g.current || 0) + delta;
    if (cur < 0) cur = 0;
    D().prepare('UPDATE month_goal SET current=? WHERE id=?').run(cur, id);
    return monthGoalProgress({ ...g, current: cur });
  });
  ipcMain.handle('mgoal:delete', (_e, id) => D().prepare('DELETE FROM month_goal WHERE id=?').run(id).changes);

  // 메모
  ipcMain.handle('memo:list', () => D().prepare('SELECT * FROM memo WHERE COALESCE(archived,0)=0 ORDER BY sort_order, updated_at DESC').all());
  ipcMain.handle('memo:listArchived', () => D().prepare('SELECT * FROM memo WHERE archived=1 ORDER BY updated_at DESC').all());
  ipcMain.handle('memo:save', (_e, m) => {
    if (m.id) {
      D().prepare("UPDATE memo SET title=?,body=?,tag=?,updated_at=datetime('now','localtime') WHERE id=?")
         .run(m.title, m.body, m.tag, m.id);
      return m.id;
    }
    return D().prepare('INSERT INTO memo (title,body,tag) VALUES (?,?,?)')
              .run(m.title, m.body, m.tag).lastInsertRowid;
  });
  // 보관/복원 토글 (archived 0<->1)
  ipcMain.handle('memo:archive', (_e, { id, archived }) =>
    D().prepare('UPDATE memo SET archived=? WHERE id=?').run(archived ? 1 : 0, id).changes);
  ipcMain.handle('memo:delete', (_e, id) => D().prepare('DELETE FROM memo WHERE id=?').run(id).changes);

  // 연간 목표 (진행률 = 마일스톤 완료율 자동)
  ipcMain.handle('goal:list', () => {
    const goals = D().prepare('SELECT * FROM goal ORDER BY sort_order, id').all();
    const ms = D().prepare('SELECT * FROM milestone ORDER BY goal_id,sort_order,id').all();
    return goals.map(g => {
      const mine = ms.filter(m => m.goal_id === g.id);
      const doneN = mine.filter(m => m.done).length;
      const pct = mine.length ? Math.round(doneN / mine.length * 100) : 0;
      return { ...g, milestones: mine, pct, doneN, totalN: mine.length };
    });
  });
  ipcMain.handle('goal:add', (_e, g) =>
    D().prepare('INSERT INTO goal (title,subtitle,year) VALUES (?,?,?)')
       .run(g.title, g.subtitle || null, g.year || new Date().getFullYear()).lastInsertRowid);
  ipcMain.handle('goal:update', (_e, g) =>
    D().prepare('UPDATE goal SET title=?, subtitle=? WHERE id=?')
       .run(g.title, g.subtitle || null, g.id).changes);
  ipcMain.handle('goal:delete', (_e, id) => {
    D().prepare('DELETE FROM milestone WHERE goal_id=?').run(id);
    return D().prepare('DELETE FROM goal WHERE id=?').run(id).changes;
  });
  // 마일스톤
  ipcMain.handle('milestone:add', (_e, m) =>
    D().prepare('INSERT INTO milestone (goal_id,title,due_label) VALUES (?,?,?)')
       .run(m.goal_id, m.title, m.due_label || null).lastInsertRowid);
  ipcMain.handle('milestone:toggle', (_e, id) =>
    D().prepare('UPDATE milestone SET done = 1 - done WHERE id=?').run(id).changes);
  ipcMain.handle('milestone:update', (_e, m) =>
    D().prepare('UPDATE milestone SET title=?, due_label=? WHERE id=?')
       .run(m.title, m.due_label || null, m.id).changes);
  ipcMain.handle('milestone:reorder', (_e, ids) => {
    const stmt = D().prepare('UPDATE milestone SET sort_order=? WHERE id=?');
    ids.forEach((id, i) => stmt.run(i, id));
    return true;
  });
  ipcMain.handle('milestone:delete', (_e, id) => D().prepare('DELETE FROM milestone WHERE id=?').run(id).changes);

  // 월별 회고: 특정 월(YYYY-MM)의 날짜별 작업시간 + 완료 할일 집계
  ipcMain.handle('review:month', (_e, ym) => {
    // 작업시간: started_at은 UTC(ISO)로 저장되므로 localtime 변환
    const workRows = D().prepare(`
      SELECT date(started_at, 'localtime') AS ymd,
             category,
             COALESCE(SUM(seconds),0) AS secs
      FROM work_session
      WHERE strftime('%Y-%m', started_at, 'localtime') = ?
      GROUP BY ymd, category
    `).all(ym);
    // 완료 할일: done_at은 이미 localtime으로 저장되므로 변환 없이
    const todoRows = D().prepare(`
      SELECT date(done_at) AS ymd, title, category
      FROM todo
      WHERE done=1 AND strftime('%Y-%m', done_at) = ?
      ORDER BY done_at
    `).all(ym);
    // 날짜별로 합치기
    const byDay = {};
    for (const r of workRows) {
      if (!byDay[r.ymd]) byDay[r.ymd] = { ymd: r.ymd, secs: 0, byCat: {}, todos: 0, todoList: [] };
      byDay[r.ymd].secs += r.secs;
      byDay[r.ymd].byCat[r.category] = (byDay[r.ymd].byCat[r.category] || 0) + r.secs;
    }
    for (const r of todoRows) {
      if (!byDay[r.ymd]) byDay[r.ymd] = { ymd: r.ymd, secs: 0, byCat: {}, todos: 0, todoList: [] };
      byDay[r.ymd].todos += 1;
      byDay[r.ymd].todoList.push({ title: r.title, category: r.category });
    }
    // 월 합계
    const totalSecs = workRows.reduce((a, r) => a + r.secs, 0);
    const totalTodos = todoRows.length;
    const catTotals = {};
    for (const r of workRows) catTotals[r.category] = (catTotals[r.category] || 0) + r.secs;
    return { days: byDay, totalSecs, totalTodos, catTotals };
  });

  // 드래그 순서 저장 (id 배열을 받아 순서대로 sort_order 부여)
  const makeReorder = (table) => (_e, ids) => {
    const stmt = D().prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`);
    ids.forEach((id, i) => stmt.run(i, id));
    return true;
  };
  ipcMain.handle('memo:reorder', makeReorder('memo'));
  ipcMain.handle('mgoal:reorder', makeReorder('month_goal'));
  ipcMain.handle('goal:reorder', makeReorder('goal'));

  // 앱 버전 + 자동 업데이트 수동 확인
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:isPackaged', () => app.isPackaged);
  ipcMain.handle('update:check', async () => {
    if (!_autoUpdater) {
      // 개발 모드거나 업데이터 없음
      return { ok: false, reason: !app.isPackaged ? 'dev' : 'no-updater' };
    }
    try {
      const r = await _autoUpdater.checkForUpdates();
      return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
    } catch (e) {
      return { ok: false, reason: 'error', message: String(e && e.message || e) };
    }
  });

  // 설정
  ipcMain.handle('setting:get', (_e, key) => D().prepare('SELECT value FROM setting WHERE key=?').get(key)?.value);
  ipcMain.handle('setting:set', (_e, { key, value }) => {
    D().prepare('INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?')
       .run(key, value, value);
    if (key === 'autoLaunch') applyAutoLaunch();
    return true;
  });
}
