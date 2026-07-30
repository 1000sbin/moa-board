// ─────────────────────────────────────────────
// 로컬 SQLite 데이터베이스 (모든 원본 데이터)
// 서버 없음 · 파일 하나로 저장 (userData/moaboard.db)
// Node 내장 SQLite(node:sqlite) 사용 → 빌드 도구 불필요
// ─────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

let db = null;

function init(userDataPath) {
  const dbPath = path.join(userDataPath, 'moaboard.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL'); // 성능 + 안정성
  createTables();
  seedDefaults();
  return db;
}

function createTables() {
  db.exec(`
    -- 프로그램 → 작업 카테고리 매핑 규칙
    CREATE TABLE IF NOT EXISTS app_rule (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type    TEXT NOT NULL DEFAULT 'process', -- process | title
      pattern       TEXT NOT NULL,                    -- 예: 'CLIPStudioPaint', 'Code'
      category      TEXT NOT NULL,                    -- 예: '그림 작업', '코딩'
      icon          TEXT DEFAULT 'apps',
      created_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 작업 세션 (자동 감지로 쌓이는 시간 기록)
    CREATE TABLE IF NOT EXISTS work_session (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      category      TEXT NOT NULL,
      app_name      TEXT,              -- 감지된 실제 프로그램
      started_at    TEXT NOT NULL,     -- ISO datetime
      ended_at      TEXT,              -- 진행 중이면 NULL
      seconds       INTEGER DEFAULT 0, -- 누적 초
      source        TEXT DEFAULT 'auto' -- auto | manual
    );

    -- 할 일
    CREATE TABLE IF NOT EXISTS todo (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      category      TEXT,
      done          INTEGER DEFAULT 0,
      due_date      TEXT,              -- YYYY-MM-DD (선택)
      sort_order    INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 일정 / 마감 (D-day 계산에 사용)
    CREATE TABLE IF NOT EXISTS event (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      category      TEXT,              -- 커미션 | 코딩 | ...
      date          TEXT NOT NULL,     -- YYYY-MM-DD
      time          TEXT,              -- HH:MM (선택)
      is_deadline   INTEGER DEFAULT 0, -- 1이면 D-day 대상
      memo          TEXT,
      gcal_id       TEXT,              -- 구글캘린더 읽기연동 시 원본 id (읽기전용)
      source        TEXT DEFAULT 'local' -- local | gcal
    );

    -- 습관 트래커 (커스텀)
    CREATE TABLE IF NOT EXISTS habit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      icon          TEXT DEFAULT 'check',
      sort_order    INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS habit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id      INTEGER NOT NULL,
      date          TEXT NOT NULL,     -- YYYY-MM-DD
      UNIQUE(habit_id, date)
    );

    -- 메모
    CREATE TABLE IF NOT EXISTS memo (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT,
      body          TEXT,
      tag           TEXT,
      updated_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 연간 목표 + 마일스톤
    CREATE TABLE IF NOT EXISTS goal (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      subtitle      TEXT,
      year          INTEGER,
      progress      INTEGER DEFAULT 0  -- 0~100
    );
    CREATE TABLE IF NOT EXISTS milestone (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id       INTEGER NOT NULL,
      title         TEXT NOT NULL,
      done          INTEGER DEFAULT 0,
      due_label     TEXT,
      sort_order    INTEGER DEFAULT 0
    );

    -- 월간 목표 (타입: count 수치 / time 작업시간 / check 체크)
    CREATE TABLE IF NOT EXISTS month_goal (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      month         TEXT NOT NULL,          -- YYYY-MM
      title         TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'count', -- count | time | check
      target        REAL DEFAULT 1,         -- 목표값 (count: 횟수, time: 시간(시))
      current       REAL DEFAULT 0,         -- 현재값 (count 수동, check 0/1)
      category      TEXT,                   -- time 타입일 때 워크트래커 카테고리
      icon          TEXT DEFAULT 'flag',
      sort_order    INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 앱 설정 (테마·포인트컬러·자동시작 등) key-value
    CREATE TABLE IF NOT EXISTS setting (
      key           TEXT PRIMARY KEY,
      value         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_started ON work_session(started_at);
    CREATE INDEX IF NOT EXISTS idx_event_date ON event(date);
    CREATE INDEX IF NOT EXISTS idx_habitlog_date ON habit_log(date);
  `);
}

// 배포 시 false로 바꾸면 기본 규칙 없이 시작 (사용자가 직접 등록)
// 개발/테스트 중엔 true가 편함
const SEED_DEFAULT_RULES = false;

function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) n FROM app_rule').get().n;
  if (SEED_DEFAULT_RULES && count === 0) {
    const ins = db.prepare(
      'INSERT INTO app_rule (match_type, pattern, category, icon) VALUES (?,?,?,?)'
    );
    // 기본 규칙 (윈도우/맥 프로세스명 기준 — 편집 가능)
    const rules = [
      ['process', 'CLIP STUDIO',     '그림 작업', 'brush'],   // 실제 프로세스명 (공백·대문자)
      ['process', 'CLIPStudioPaint', '그림 작업', 'brush'],
      ['process', 'CLIPStudio',      '그림 작업', 'brush'],
      ['process', 'clipstudio',      '그림 작업', 'brush'],
      ['process', 'Photoshop',       '그림 작업', 'brush'],
      ['process', 'Paint Tool SAI',  '그림 작업', 'brush'],
      ['process', 'sai2',            '그림 작업', 'brush'],
      ['process', 'Krita',           '그림 작업', 'brush'],
      ['process', 'Code',            '코딩',     'code'],   // VS Code
      ['process', 'devenv',          '코딩',     'code'],   // Visual Studio
      ['process', 'WINWORD',         '글/기획',  'draw'],
      ['process', 'Hword',           '글/기획',  'draw'],   // 한글
      ['process', 'chrome',          '리서치',   'language'],
      ['process', 'firefox',         '리서치',   'language'],
      ['process', 'msedge',          '리서치',   'language'],
    ];
    db.exec('BEGIN');
    try {
      rules.forEach(r => ins.run(...r));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 기본 습관 (배포 시 SEED_DEFAULT_RULES와 함께 꺼짐)
  const habitCount = db.prepare('SELECT COUNT(*) n FROM habit').get().n;
  if (SEED_DEFAULT_RULES && habitCount === 0) {
    const hins = db.prepare('INSERT INTO habit (name,icon,sort_order) VALUES (?,?,?)');
    [['물','water_drop',0],['운동','directions_run',1],['그림','brush',2]].forEach(h => hins.run(...h));
  }

  // 기본 설정
  const setIfMissing = (k, v) => {
    const row = db.prepare('SELECT 1 FROM setting WHERE key=?').get(k);
    if (!row) db.prepare('INSERT INTO setting(key,value) VALUES(?,?)').run(k, v);
  };
  setIfMissing('theme', 'straw');
  setIfMissing('pointColor', '#ff4d8d');
  setIfMissing('autoLaunch', '1');
  setIfMissing('idleThresholdSec', '90'); // 이 시간 이상 입력 없으면 세션 일시정지
}

function get() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

module.exports = { init, get };
