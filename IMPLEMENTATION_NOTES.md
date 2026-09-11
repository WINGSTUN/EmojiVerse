# Implementation notes

## 시간과 결정론

모든 `step()`은 동일한 world snapshot에서 phase 후보를 만들고 `P0`, `P1`, `P2` 순서로 해결합니다. 후보는 우선순위와 `seed/tick/phase/key`의 안정 해시로 정렬됩니다. 각 phase에서 다음을 순서대로 적용합니다.

1. 후보 수 제한
2. typed resource claim 예약
3. exclusive slot 예약
4. write key 충돌 검사
5. draft world에 apply
6. 모든 operation과 원장의 검증
7. 성공한 경우에만 world에 commit

실패한 apply는 draft 전체를 버리고 실패 로그만 남깁니다. entity/module/connection record는 외부 참조를 유지하도록 commit 시 제자리에서 병합합니다.

## 질량·에너지·열

자원은 `MassLedger`와 `EnergyLedger`의 안전한 정수입니다. 구조 질량과 모듈 구조 질량은 물리 질량에 한 번만 포함되며, `edibleMass`는 구조 질량의 섭취 가능 부분입니다. 성장, 소화, 충전, 방출, 연소, 가공, 이동/공격 비용은 모두 입력·출력 원장에 보이는 변환으로 구현했습니다.

열은 별도 보존 에너지 형태입니다. 모듈/개체의 열을 합친 값으로 임계값을 판정하고, 이번 버전에서는 명세의 경계 테스트와 재현성을 위해 열 단위를 정수 threshold로 비교합니다. `entityTemperature`는 관찰용 지수이며, 연소 허용 여부의 직접 판정값은 `entityHeat >= ignitionTemperature`입니다.

## 콘텐츠와 구성

`src/content/catalog.ts`의 preset, module, connection, conversion template, action template은 선언형 데이터입니다. 실행 가능한 callback이나 사용자 식은 저장하지 않습니다. 런타임은 알려진 typed template kind와 bounded parameter만 해석합니다.

모듈 ID는 entity ID와 stable semantic label을 조합합니다. fixture 삽입 순서가 달라도 같은 물리 ID를 만들 수 있고, machine blueprint의 alias는 preset module ID와 분리됩니다. 모듈을 분리하면 `ownerEntityId`와 연결이 비활성화되지만 `integrity`, `cooldown`, inventory, energy, capacity override는 보존됩니다. 기존 모듈 ID를 지정한 attach는 그 상태를 그대로 재장착합니다.

## 외부 경계와 안전성

초기 fixture 생성 API(`createEntityFromPreset`, `createMachineFromBlueprint`, fixture setter)는 `finalizeFixture` 전에만 사용할 수 있습니다. 실행 중 추가되는 것은 `queueExternalResource`와 `queueExternalSpawn`뿐이며, 둘 다 P0 candidate가 되어 외부 원장에 기록됩니다. entity 수, module 수, connection 수, candidate 수, pending queue에는 모두 상한이 있습니다.

정의 JSON은 version 1 package shape, module/preset/blueprint의 필수 typed 필드, 포트 방향, bounded parameter를 검사합니다. 기존 ID와 내용이 충돌하면 카탈로그를 바꾸지 않고 거부합니다.

## 의도한 단순화

이번 구현은 시뮬레이션 경계를 선명하게 보이는 것을 우선했습니다. 따라서 terrain obstruction과 일반 경로 탐색, 다중 tick 예약, 서버/네트워크 동기화, 실수 기반 온도 모델, 사용자 정의 코드 실행, 복잡한 유체/화학식은 구현하지 않았습니다. 이 제한은 README와 UI 설명에도 노출되어 있습니다.
