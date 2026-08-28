// ─────────────────────────────────────────────
// preload — 렌더러에 안전한 API만 노출 (contextIsolation)
// window.moa.* 로 접근
// ─────────────────────────────────────────────
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moa', {
  // 창 컨트롤
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    hide: () => ipcRenderer.send('win:hide'),
    close: () => ipcRenderer.send('win:close'),
  },

  // 자동 업데이트: 새 버전 다운로드 완료 알림
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, version) => cb(version)),

  // 워크 트래커
  tracker: {
    status: () => ipcRenderer.invoke('tracker:status'),
    setPaused: (p) => ipcRenderer.invoke('tracker:setPaused', p),
    onUpdate: (cb) => ipcRenderer.on('tracker:update', (_e, s) => cb(s)),
    runningApps: () => ipcRenderer.invoke('tracker:runningApps'),
    categories: () => ipcRenderer.invoke('tracker:categories'),
  },

  // 규칙
  rules: {
    list: () => ipcRenderer.invoke('rules:list'),
    add: (r) => ipcRenderer.invoke('rules:add', r),
    remove: (id) => ipcRenderer.invoke('rules:delete', id),
  },

  // 할 일
  todo: {
    list: () => ipcRenderer.invoke('todo:list'),
    add: (t) => ipcRenderer.invoke('todo:add', t),
    toggle: (id) => ipcRenderer.invoke('todo:toggle', id),
    update: (t) => ipcRenderer.invoke('todo:update', t),
    remove: (id) => ipcRenderer.invoke('todo:delete', id),
    doneOn: (ymd) => ipcRenderer.invoke('todo:doneOn', ymd),
  },

  // 일정
  event: {
    list: (month) => ipcRenderer.invoke('event:list', month),
    add: (ev) => ipcRenderer.invoke('event:add', ev),
    update: (ev) => ipcRenderer.invoke('event:update', ev),
    remove: (id) => ipcRenderer.invoke('event:delete', id),
    ddays: () => ipcRenderer.invoke('event:ddays'),
  },

  // 습관
  habit: {
    list: () => ipcRenderer.invoke('habit:list'),
    add: (h) => ipcRenderer.invoke('habit:add', h),
    toggle: (habitId, date) => ipcRenderer.invoke('habit:toggle', { habitId, date }),
    weekLog: (from, to) => ipcRenderer.invoke('habit:weekLog', { from, to }),
    remove: (id) => ipcRenderer.invoke('habit:delete', id),
  },

  // 메모
  memo: {
    list: () => ipcRenderer.invoke('memo:list'),
    listArchived: () => ipcRenderer.invoke('memo:listArchived'),
    save: (m) => ipcRenderer.invoke('memo:save', m),
    archive: (id, archived) => ipcRenderer.invoke('memo:archive', { id, archived }),
    remove: (id) => ipcRenderer.invoke('memo:delete', id),
  },

  // 연간 목표
  goal: {
    list: () => ipcRenderer.invoke('goal:list'),
    add: (g) => ipcRenderer.invoke('goal:add', g),
    update: (g) => ipcRenderer.invoke('goal:update', g),
    remove: (id) => ipcRenderer.invoke('goal:delete', id),
    addMilestone: (m) => ipcRenderer.invoke('milestone:add', m),
    toggleMilestone: (id) => ipcRenderer.invoke('milestone:toggle', id),
    removeMilestone: (id) => ipcRenderer.invoke('milestone:delete', id),
  },

  // 월간 목표
  mgoal: {
    list: (month) => ipcRenderer.invoke('mgoal:list', month),
    add: (g) => ipcRenderer.invoke('mgoal:add', g),
    update: (g) => ipcRenderer.invoke('mgoal:update', g),
    step: (id, delta) => ipcRenderer.invoke('mgoal:step', { id, delta }),
    remove: (id) => ipcRenderer.invoke('mgoal:delete', id),
  },

  // 설정
  setting: {
    get: (key) => ipcRenderer.invoke('setting:get', key),
    set: (key, value) => ipcRenderer.invoke('setting:set', { key, value }),
  },

  // 월별 회고
  review: {
    month: (ym) => ipcRenderer.invoke('review:month', ym),
  },
});
