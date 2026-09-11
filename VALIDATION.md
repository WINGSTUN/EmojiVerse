# Validation record

검증 기준일: 2026-09-10 (Asia/Seoul)

## 자동 검증

- TypeScript strict typecheck: 통과
- Vitest 계약 테스트: `1 test file / 27 tests passed`
- A–E 통합 시나리오: 통과
- T01–T20 경계 계약: 통과
- Vite production build: 통과 (`16 modules transformed`, `dist/` 산출물 생성)
- GitHub Pages workflow: 준비 완료 (`.github/workflows/deploy-pages.yml`); `WINGSTUN/EmojiVerse` 연결 후 Actions에서 실행 예정

계약 테스트가 확인하는 주요 경계는 마지막 음식 선점, wing 비활성/과질량 착륙, 동일 자원 claim, 빈 전하 방출, 임계값 직전/초과 연소, P2 이후 연소 지연, 다중 공격 합산, 모듈 ID/상태 보존, capacity 축소 overflow, hash/삽입 순서/정의 ID 독립성, 원장 보존, candidate cap, P2 중복 방지, 외부 입력 원장, 다중 외부 생성, 실패 atomicity, 연결 끊김, 정의 JSON 안전성입니다.

## 수동 브라우저 확인

최종 Vite 실행 후 브라우저에서 다음을 확인해야 합니다.

1. 초기 화면에 16×16 보드, A 시나리오, tick 0, `Step 1 tick`이 표시되는지 확인
2. B를 선택하고 `비행` intent 제출 후 Step하여 air layer와 로그를 확인
3. C에서 `충전` 및 `방출`을 제출하여 전하/열 원장을 확인
4. E에서 Step하여 storage의 raw가 product로 변환되고 이벤트 로그가 쌓이는지 확인
5. `선택 정의 내보내기`와 JSON 가져오기 오류 경계를 확인

현재 자동 검증은 완료됐지만, 이 실행 환경에서는 브라우저 런타임 초기화가 `C:\Users\zjava\AppData` 접근 제한으로 중단되어 위 수동 확인을 아직 수행하지 못했습니다. 따라서 로컬 실행 가능 상태는 확인됐고, 최종 완료 판정 전에는 사용자 환경에서 한 번의 브라우저 smoke test가 남아 있습니다.
