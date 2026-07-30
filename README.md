# 모아보드 (Moaboard)

윈도우 데스크톱 작업 대시보드.
워크 트래커 자동 감지 · 캘린더 · 할 일 · 메모 · 습관 · 연간 목표.
**모든 데이터는 로컬 SQLite에 저장. 서버 없음.**

> 이 버전은 **윈도우 전용**이야.

## 준비물
- Windows 10 / 11 (x64)
- Node.js 20 이상 (LTS 권장)

## 처음 실행

```bash
npm install          # 의존성 설치 (electron만 받으면 됨)
npm start            # 앱 실행
```

> SQLite는 **Node 내장 모듈(node:sqlite)**을 써서 별도 빌드 도구(Visual Studio C++ 등)가 필요 없어.
> `npm install`은 electron만 받으면 되니까 빠르게 끝나.

## 개발 모드 (DevTools 열림)

```bash
npm run dev
```

## 배포 빌드 (윈도우)

```bash
npm run dist            # 설치 파일(NSIS .exe) + 포터블 .exe 둘 다
npm run dist:portable   # 포터블 단일 exe만 (설치 없이 실행)
```

- **NSIS**: 설치형. 바탕화면·시작메뉴 바로가기 생성, 설치 경로 선택 가능.
- **Portable**: 설치 없이 exe 하나로 실행. USB에 넣고 다녀도 됨.
- 결과물은 `dist/` 폴더에 생성돼.

## 상시 실행 & 자동 시작
- 창을 닫아도 **트레이(작업표시줄 우하단)로 숨어서 계속 돌아가.** 워크 트래커가 백그라운드로 시간 기록.
- 완전 종료는 트레이 아이콘 우클릭 → 종료.
- 윈도우 부팅 시 자동 시작 (설정에서 끌 수 있음). 부팅 시엔 창 없이 트레이로만 조용히 시작.

## 구조

```
src/
  main/
    main.js       메인 프로세스 (창·트레이·자동시작·IPC)
    preload.js    렌더러에 노출하는 안전한 API (window.moa.*)
    tracker.js    워크 트래커 자동 감지 엔진 (active-win)
  db/
    db.js         SQLite 스키마 + 초기화
  renderer/
    index.html    UI (디자인 v9 기반)
    assets/       아이콘 (tray.png, icon.ico 넣기)
```

## 데이터 위치
- `%APPDATA%/moaboard/moaboard.db`

## 워크 트래커 작동 방식
1. active-win으로 5초마다 최상단 창의 **프로세스명**을 읽음 (예: `CLIPStudioPaint.exe`)
2. `app_rule` 테이블의 매핑 규칙과 대조 → 카테고리 결정 (예: 그림 작업)
3. 카테고리별로 세션 시간 누적. 카테고리 바뀌면 새 세션.
4. 90초 이상 입력 없으면(자리 비움) 세션 자동 정지 → 시간 부풀지 않음.
5. 기본 규칙: CLIP STUDIO/Photoshop→그림, VS Code/Visual Studio→코딩, 한글/Word→글·기획, Chrome/Firefox→리서치. (편집 가능)

## 다음 할 일 (로드맵)
- [ ] 할 일/일정/메모/습관 UI를 실제 DB에 연결 (현재는 트래커만 연결됨)
- [ ] 프로그램 규칙 편집 모달
- [ ] 구글 캘린더 읽기 전용 연동
