# EmojiVerse

EmojiVerse는 preview 명세를 바탕으로 만든 로컬 플레이어블 결정론적 시뮬레이션 프로토타입입니다. 브라우저에서 16×16 보드를 관찰하고, intent를 제출한 뒤 고정된 `P0 → P1 → P2` 순서로 한 tick씩 결과를 확인할 수 있습니다.

## 배포

이 프로젝트의 표준 실행 경로는 `main` push를 감지하는 GitHub Actions입니다. 저장소를 `WINGSTUN/EmojiVerse`로 만든 뒤 `.github/workflows/deploy-pages.yml`이 실행되면 계약 테스트, production build, GitHub Pages 배포를 순서대로 수행합니다. Pages 주소는 `https://WINGSTUN.github.io/EmojiVerse/`입니다.

배포 workflow는 npm 기반 Ubuntu runner를 사용하며, 로컬 PowerShell이나 pnpm에 의존하지 않습니다. GitHub 저장소의 Actions 탭에서 테스트와 배포 로그를 확인할 수 있습니다.

## 화면 사용법

- `시나리오`: A–E fixture를 다시 만들고 시작합니다. 초기 fixture는 `finalizeFixture` 이후 직접 수정할 수 없습니다.
- `Step 1 tick`: 현재 intent와 memoryless 정책을 후보로 만들고 `P0 → P1 → P2`를 실행합니다.
- `자동 실행`: 일시정지/재생을 전환합니다. 기본값은 일시정지입니다.
- 보드 칸: 개체를 선택합니다. 검사기에서 질량, 무결성, 열, 원장, 능력, 모듈을 확인합니다.
- `의도 제출`: 이동, 비행/착륙, 섭취, 공격, 충전/방출, 가공, 해체, 모듈 장착/분리/용량 축소를 다음 Step에 예약합니다.
- `외부 개입`: entity/module 대상 자원 주입과 preset 기반 개체 생성을 큐에 넣습니다. 외부 입력은 P0에서 원자적으로 반영되고 외부 원장에 기록됩니다.
- `정의 JSON`: 허용된 version 1 creature/machine package만 가져옵니다. 콜백, 함수, 임의 실행 필드는 허용되지 않습니다.

## 시나리오

| ID | 확인할 흐름 |
| --- | --- |
| A | 식물 성장 → 초식동물 섭취 → 포식자의 유료 구조 작업 → 사체 섭취 |
| B | wing module → 총 질량/저장 에너지 판정 → air 이동 → 착륙 |
| C | 저장 에너지 4 → 전하 3 충전 → 전하 3 방출 → 빈 전하 실패 |
| D | 전하 방출로 열 축적 → 다음 P1에서 ignition threshold 연소 |
| E | 연결된 storage/processor의 raw → product 기존 변환 |

## 구조

- `src/sim/types.ts`: 원장, entity/module/connection, typed intent/operation 모델
- `src/sim/ledger.ts`: non-negative safe integer 질량·에너지 원장과 balance 검사
- `src/rules/rules.ts`: 데이터 카탈로그와 능력/템플릿 기반 후보 생성
- `src/policy/policy.ts`: 상태를 직접 수정하지 않는 memoryless 정책
- `src/sim/engine.ts`: 후보 정렬, claim/write 예약, capacity 제한, atomic apply/rollback, 이벤트 로그
- `src/sim/world.ts`: 16×16 world와 fixture/external input 경계
- `src/sim/serialization.ts`: 안전한 정의 JSON import/export
- `src/ui/main.ts`, `src/ui/styles.css`: 브라우저 관찰·조작 화면
- `tests/contract.test.ts`: A–E 및 T01–T20 경계 계약 테스트

## 의도한 범위와 제한

이 버전은 독립적으로 실행되는 로컬 프로토타입입니다. 지형 장애물/경로 탐색, 연속 실수량, 복잡한 solver, 네트워크 동기화, 서버 저장, 배포는 범위에 포함하지 않았습니다. 자원량과 열은 명세의 1차 구현에 맞춰 안전한 정수 단위로 처리하며, 모듈의 구조 질량은 entity 총 질량에 포함됩니다.

현재는 로컬 Pages workflow까지 준비했으며, `WINGSTUN` GitHub 인증이 연결되기 전에는 원격 저장소 생성이나 push를 수행하지 않습니다.
