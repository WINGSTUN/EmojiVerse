import "./styles.css";

import {
  ENERGY_RESOURCES,
  MASS_RESOURCES,
  activeConnections,
  buildPhaseCandidates,
  cloneWorld,
  createCreatureVariant,
  createEntityFromPreset,
  createMachineFromBlueprint,
  createWorld,
  entityHeat,
  entityHeatCapacity,
  entityMass,
  entityTemperature,
  exportCreatureDefinition,
  exportMachineDefinition,
  finalizeFixture,
  getEntityCapacities,
  getEntityModules,
  getModuleCapacities,
  importDefinition,
  queueExternalResource,
  queueExternalSpawn,
  setFixtureResource,
  step,
  submitIntent,
  type Candidate,
  type EnergyResource,
  type EntityState,
  type Intent,
  type MassResource,
  type SimulationEvent,
  type WorldState,
} from "../index";

type ScenarioId = "A" | "B" | "C" | "D" | "E";
type NoticeTone = "info" | "success" | "error";
type IntentResultStatus = "pending" | "success" | "failed" | "not-executed";

interface ScenarioConfig {
  title: string;
  description: string;
  observe: string;
  steps: string[];
  check: string;
  toolAction?: "open-tools";
}

interface IntentRecord {
  uiId: number;
  intent: Intent;
  actorId: string;
  actorLabel: string;
  targetId?: string;
  targetLabel?: string;
  submittedAtTick: number;
  candidateKey?: string;
  status: IntentResultStatus;
  processedTick?: number;
  event?: SimulationEvent;
}

interface ViewState {
  detailOpen: Record<string, boolean>;
  formValues: Record<string, string>;
  focusedId?: string;
}

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("#app was not found");
const app: HTMLDivElement = appElement;

const SCENARIOS: Record<ScenarioId, ScenarioConfig> = {
  A: {
    title: "생장 · 섭식 · 포식",
    description: "식물의 성장부터 사체 섭취까지 공통 규칙으로 이어집니다.",
    observe: "식물·초식동물·포식자의 위치와 저장 에너지를 먼저 확인합니다.",
    steps: [
      "보드에서 식물, 초식동물, 포식자를 차례로 선택해 상태를 비교합니다.",
      "한 단계 진행을 실행하고, 첫 단계에서 실제로 발생한 성장·유지·정책 행동을 확인합니다.",
      "섭식·포식은 대상과 거리를 맞춘 뒤 행동을 예약하고, 처리 결과를 선택 개체 아래에서 확인합니다.",
    ],
    check: "첫 단계에 모든 현상이 동시에 일어난다고 가정하지 말고, 원본 이벤트 로그에서 실제 발생한 규칙을 확인하세요.",
  },
  B: {
    title: "날개 · 질량 · 착륙",
    description: "모듈 능력, 총 질량, 저장 에너지로 비행 가능성을 판정합니다.",
    observe: "양력 기관이 장착된 🐇🪽의 현재 층·총 질량·저장 에너지를 확인합니다.",
    steps: [
      "🐇🪽를 선택하고 비행을 예약한 다음 한 단계 진행을 실행합니다.",
      "Inspector의 층이 공중으로 바뀌었는지, 행동 결과에 비행 성공이 기록되었는지 확인합니다.",
      "착륙을 예약하고 다시 한 단계 진행해 지상 복귀 결과를 확인합니다.",
    ],
    check: "양력 한도는 12u로 정의되어 있으며, 실제 총 질량·저장 에너지는 매 단계 Inspector에서 확인합니다.",
  },
  C: {
    title: "전하 저장 · 방출",
    description: "저장 에너지를 전하로 바꾸고 인접 대상에 열로 방출합니다.",
    observe: "전기 토끼와 인접한 연료 상자의 에너지·열 수치를 비교할 준비를 합니다.",
    steps: [
      "전기 토끼를 선택하고 충전을 예약한 뒤 한 단계 진행해 전하 저장소를 채웁니다.",
      "대상에서 인접한 연료 상자를 고르고 방출을 예약한 뒤 한 단계 진행합니다.",
      "토끼의 전하와 상자의 열이 각각 어떻게 변했는지 Inspector에서 비교합니다.",
    ],
    check: "충전은 저장 에너지 4를 전하 3과 열 1로 바꾸고, 방출은 전하 3을 대상 열 3으로 전달합니다.",
  },
  D: {
    title: "전기 가열 · 연소",
    description: "열 임계값을 넘긴 연료 상자가 다음 P1에서 연소합니다.",
    observe: "초기 연료 상자는 열 0, 전기 토끼의 전하 저장소는 6으로 시작합니다.",
    steps: [
      "전기 토끼를 선택하고 대상에서 연료 상자를 고릅니다.",
      "방출 예약 → 한 단계 진행을 두 번 반복해 상자에 열을 3씩 전달합니다.",
      "세 번째 한 단계 진행에서 P1 연소 이벤트와 상자의 열·무결성 변화를 확인합니다. 반복 실험은 외부 도구를 사용할 수 있습니다.",
    ],
    check: "연소 조건은 열 4 이상·연료·화학 에너지이며, 조건이 충족되면 방출 다음 단계의 P1에서 처리됩니다.",
    toolAction: "open-tools",
  },
  E: {
    title: "재활용 기계",
    description: "연결된 저장소와 가공기가 raw → product 변환을 반복합니다.",
    observe: "원료·제품 저장소의 raw 양과 원료 가공 기계의 저장 에너지를 확인합니다.",
    steps: [
      "초기 raw 2가 들어 있는 재활용 기계를 선택합니다.",
      "한 단계 진행을 실행하면 연결된 자동 가공이 raw에서 product로 변환됩니다.",
      "저장소의 raw·product, 기계의 열·저장 에너지 변화를 다음 단계마다 비교합니다.",
    ],
    check: "기존 변환 템플릿은 raw 1을 product 1로 바꾸며 저장 에너지 2와 열 2를 사용합니다.",
  },
};

const CAPABILITY_LABELS: Record<string, string> = {
  photosynthesize: "광합성",
  digest_food: "소화",
  consume_plant: "식물 섭식",
  consume_animal: "동물 섭식",
  ground_move: "지상 이동",
  lift: "양력",
  air_move: "공중 이동",
  night_sense: "야간 감각",
  charge_storage: "전하 충전",
  electric_discharge: "전기 방출",
  flammable: "연소 가능",
  storage: "저장",
  process: "가공",
  automatic_machine: "자동 가공",
  work_damage: "구조 작업",
  edible_tissue: "식용 조직",
};

const RULE_LABELS: Record<string, string> = {
  "environment.light-input": "환경 빛 입력",
  "movement.air-maintenance": "공중 유지·착륙",
  "movement.orthogonal": "이동",
  "survival.maintenance": "유지비",
  "survival.maintenance-deficiency": "유지비 부족",
  "metabolism.digestion": "소화",
  "metabolism.growth": "성장",
  "metabolism.consume": "섭식",
  "interaction.work-damage": "구조 작업",
  "interaction.damage-aggregate": "피해 합산",
  "electric.charge": "전하 충전",
  "electric.discharge": "전기 방출",
  "physics.combustion": "연소",
  "physics.heat-transfer": "열 전달",
  "machine.existing-conversion": "기존 변환",
  "composition.attach": "모듈 장착",
  "composition.detach": "모듈 분리",
  "composition.resize-capacity": "모듈 용량 축소",
  "composition.deconstruct": "해체",
  "external.spawn": "외부 생성",
  "external.resource-injection": "외부 자원 주입",
  "intent.invalid": "잘못된 행동",
};

const REASON_LABELS: Record<string, string> = {
  "air movement capability is unavailable": "비행 능력이 없습니다.",
  "total mass exceeds lift capacity": "총 질량이 양력 한도를 초과했습니다.",
  "ground movement capability is unavailable": "지상 이동 능력이 없습니다.",
  "movement energy unavailable": "이동에 필요한 저장 에너지가 부족합니다.",
  "destination is outside the world": "목적지가 세계 범위를 벗어났습니다.",
  "actor is already on the ground": "이미 지상에 있습니다.",
  "move actor is not alive": "이동 주체가 생존 상태가 아닙니다.",
  "food is out of reach": "섭식 대상이 닿을 수 있는 거리에 없습니다.",
  "discharge target is out of reach": "방출 대상이 닿을 수 있는 거리에 없습니다.",
  "charge is unavailable": "방출할 전하가 부족합니다.",
  "stored energy is unavailable": "충전에 필요한 저장 에너지가 부족합니다.",
  "charge capacity exceeded": "전하 저장 용량을 초과합니다.",
  "ignition temperature not reached": "발화 온도에 도달하지 않았습니다.",
};

let world = createDemoWorld("A");
let selectedEntityId: string | undefined = firstEntityId(world);
let commandTargetId: string | undefined;
let selectedScenario: ScenarioId = "A";
let paused = true;
let speedMs = 700;
let timerId: number | undefined;
let notice = "시나리오를 선택하고 한 단계 진행을 눌러 첫 tick을 실행하세요.";
let noticeTone: NoticeTone = "info";
let definitionText = "";
let viewState: ViewState = { detailOpen: {}, formValues: {} };
let captureViewStateOnNextRender = true;
let pendingIntentRecords: IntentRecord[] = [];
let recentIntentResults: IntentRecord[] = [];
let nextIntentOrdinal = 1;

render();

function createDemoWorld(scenario: ScenarioId): WorldState {
  const demo = createWorld({ config: { seed: 900 + scenario.charCodeAt(0) } });

  if (scenario === "A") {
    const plant = createEntityFromPreset(demo, "plant", { x: 3, y: 7, layer: "ground" }, { id: "demo-plant" });
    const herbivore = createEntityFromPreset(demo, "herbivore", { x: 4, y: 7, layer: "ground" }, { id: "demo-herbivore" });
    const predator = createEntityFromPreset(demo, "predator", { x: 7, y: 7, layer: "ground" }, { id: "demo-predator" });
    setFixtureResource(demo, herbivore.id, "entity", "stored", 12);
    setFixtureResource(demo, predator.id, "entity", "stored", 12);
    setFixtureResource(demo, plant.id, "entity", "water", 3);
    setFixtureResource(demo, plant.id, "entity", "nutrient", 3);
  }

  if (scenario === "B") {
    const rabbit = createCreatureVariant(
      demo,
      "herbivore",
      ["wing_lift"],
      { x: 5, y: 5, layer: "ground" },
      { id: "demo-wing-rabbit", semanticId: "demo_wing_rabbit", displayOverride: "🐇🪽" },
    );
    setFixtureResource(demo, rabbit.id, "entity", "stored", 12);
  }

  if (scenario === "C" || scenario === "D") {
    const rabbit = createCreatureVariant(
      demo,
      "herbivore",
      ["electric_storage"],
      { x: 5, y: 5, layer: "ground" },
      { id: "demo-electric-rabbit", semanticId: "demo_electric_rabbit", displayOverride: "🐇⚡" },
    );
    const crate = createEntityFromPreset(demo, "fuel_crate", { x: 6, y: 5, layer: "ground" }, { id: "demo-fuel-crate" });
    const batteryId = moduleForDefinition(demo, rabbit.id, "electric_storage");
    setFixtureResource(demo, rabbit.id, "entity", "stored", 8);
    if (scenario === "D") setFixtureResource(demo, batteryId, "module", "charge", 6);
    if (scenario === "C") setFixtureResource(demo, crate.id, "entity", "heat", 0);
  }

  if (scenario === "E") {
    const machine = createMachineFromBlueprint(demo, "recycler", { x: 7, y: 7, layer: "ground" }, { id: "demo-recycler" });
    const storageId = moduleForDefinition(demo, machine.id, "storage_bin");
    setFixtureResource(demo, storageId, "module", "raw", 2);
  }

  finalizeFixture(demo);
  return demo;
}

function render(): void {
  if (captureViewStateOnNextRender) captureViewState();
  captureViewStateOnNextRender = true;
  syncPendingIntentRecords();

  const selected = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  const targetEntities = Object.values(world.entities)
    .filter((entity) => entity.id !== selected?.id)
    .sort(compareEntities);
  const scenario = SCENARIOS[selectedScenario];
  const latestEvent = world.logs[world.logs.length - 1];
  const phaseSummary = latestEvent
    ? `최근 처리 · ${escapeHtml(eventSubject(latestEvent))} · ${escapeHtml(ruleLabel(latestEvent.ruleId))}`
    : "처리 결과는 선택 개체의 행동 영역에 표시됩니다";

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="eyebrow">LOCAL · DETERMINISTIC · DATA-DRIVEN</div>
          <h1>EmojiVerse <span>🪐</span></h1>
          <p>고정 16×16 세계에서 질량·에너지·열·구성을 한 단계씩 관찰하는 작은 실험실</p>
        </div>
      </header>

      <div class="execution-dock" aria-label="실험 실행 컨트롤">
        <div class="dock-context"><span class="dock-kicker">RUN CONTROL</span><strong>${selectedScenario} · 현재 tick ${world.tick}</strong></div>
        <div class="top-controls">
          <label class="field compact-field">
            <span>실험 시나리오</span>
            <select id="scenario-select" aria-label="실험 시나리오">
              ${Object.entries(SCENARIOS).map(([id, item]) => `<option value="${id}" ${id === selectedScenario ? "selected" : ""}>${id} · ${escapeHtml(item.title)}</option>`).join("")}
            </select>
          </label>
          <button class="button ghost" data-action="reset" title="현재 시나리오의 초기 fixture로 되돌립니다.">초기화</button>
          <button class="button" data-action="toggle" title="자동 실행 타이머를 한 개만 유지합니다.">${paused ? "▶ 자동 실행" : "Ⅱ 일시정지"}</button>
          <button class="button primary" data-action="step" title="현재 tick의 P0 → P1 → P2를 한 번 처리합니다.">한 단계 진행</button>
        </div>
      </div>

      <section class="status-strip" aria-label="실험 상태">
        <div class="status-item"><span>시나리오</span><strong>${selectedScenario} · ${escapeHtml(scenario.title)}</strong></div>
        <div class="status-item"><span>현재 tick</span><strong>${world.tick}</strong></div>
        <div class="status-item"><span>개체 · 모듈</span><strong>${Object.keys(world.entities).length} · ${Object.keys(world.modules).length}</strong></div>
        <div class="status-item queue-status"><span>예약 행동</span><strong>${world.pendingIntents.length}건</strong></div>
      </section>

      <div class="notice ${noticeTone}" role="status" aria-live="polite"><span class="notice-dot"></span><span>${escapeHtml(notice)}</span><span class="notice-context">${phaseSummary}</span></div>

      ${renderScenarioGuide(scenario)}

      <main class="main-grid">
        <section class="panel world-panel">
          <div class="panel-heading">
            <div><span class="panel-kicker">WORLD VIEW</span><h2>16×16 관찰 보드</h2></div>
            <div class="legend"><span><i class="legend-swatch ground"></i>지상</span><span><i class="legend-swatch air"></i>공중</span><span><i class="legend-swatch selected"></i>선택</span><span><i class="legend-swatch debris"></i>잔해</span></div>
          </div>
          <div class="grid-wrap"><div class="world-grid" style="--grid-size: ${world.config.width};">${renderGrid()}</div></div>
          <div class="world-footer"><span>${escapeHtml(scenario.description)}</span><span>자동 정책은 memoryless · 행동은 예약 후 다음 단계에서 처리됩니다.</span></div>
        </section>

        <aside class="side-column">
          <section class="panel inspector-panel">
            <div class="panel-heading"><div><span class="panel-kicker">INSPECTOR</span><h2>선택한 개체</h2></div><span class="pill">${selected ? escapeHtml(selected.shortLabel) : "선택 없음"}</span></div>
            ${renderInspector(selected)}
          </section>

          <section class="panel action-panel">
            <div class="panel-heading"><div><span class="panel-kicker">ACTIONS</span><h2>행동 예약</h2></div><span class="muted">다음 단계에서 처리</span></div>
            ${renderIntentControls(selected, targetEntities)}
          </section>
        </aside>
      </main>

      <section class="experiment-tools-grid">
        <details class="panel disclosure" id="tools-details">
          <summary class="disclosure-summary"><span><span class="panel-kicker">EXPERIMENT TOOLS</span><strong>외부 개입 · 개발 정보</strong></span><span class="summary-meta">P0 입력 · 상태 해시 ▾</span></summary>
          <div class="disclosure-content">
            <p class="section-intro">외부 자원·개체 생성은 입력 큐에 들어가며 다음 단계의 P0에서 원자적으로 처리됩니다.</p>
            ${renderExternalControls(selected)}
            ${renderDevInfo()}
          </div>
        </details>

        <details class="panel disclosure" id="definition-details">
          <summary class="disclosure-summary"><span><span class="panel-kicker">DEFINITION IO</span><strong>정의 JSON</strong></span><span class="summary-meta">콜백 차단 · 내보내기 ▾</span></summary>
          <div class="disclosure-content">
            <p class="section-intro">정의 패키지는 데이터 필드만 허용하며, 실행 가능한 콜백·스크립트는 거부됩니다.</p>
            <textarea id="definition-json" data-persist-key="definition-json" spellcheck="false" aria-label="정의 JSON" placeholder="선택 정의 내보내기 또는 version 1 package JSON을 붙여넣으세요.">${escapeHtml(definitionText)}</textarea>
            <div class="inline-actions"><button class="button ghost" data-action="export-definition" ${selected ? "" : "disabled"}>선택 정의 내보내기</button><button class="button" data-action="import-definition">카탈로그로 가져오기</button></div>
          </div>
        </details>
      </section>

      <details class="panel disclosure log-panel" id="logs-details">
        <summary class="disclosure-summary"><span><span class="panel-kicker">EVENT LOG</span><strong>원본 이벤트 로그</strong></span><span class="summary-meta">최대 2,000개 보존 · 최신 80개 표시 ▾</span></summary>
        <div class="disclosure-content"><p class="section-intro">화면에는 읽기 쉬운 요약을, 원본 펼침 영역에는 기존 rule key·내부 ID·event ID를 그대로 표시합니다.</p><div class="log-list">${renderLogs()}</div></div>
      </details>
    </div>
  `;

  bindEvents();
  restoreViewState();
}

function renderScenarioGuide(scenario: ScenarioConfig): string {
  return `
    <section class="panel guide-panel" aria-labelledby="guide-title">
      <div class="panel-heading"><div><span class="panel-kicker">QUICK GUIDE</span><h2 id="guide-title">${escapeHtml(selectedScenario)} 실험 흐름</h2></div><span class="flow-pill">선택 → 예약 → 진행 → 확인</span></div>
      <div class="guide-grid">
        <div class="guide-card"><span class="guide-label">관찰</span><p>${escapeHtml(scenario.observe)}</p></div>
        <div class="guide-card guide-steps"><span class="guide-label">조작</span><ol>${scenario.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></div>
        <div class="guide-card"><span class="guide-label">확인</span><p>${escapeHtml(scenario.check)}</p>${scenario.toolAction ? `<button class="mini-button guide-tool-button" data-action="${scenario.toolAction}">고급 도구 열기</button>` : ""}</div>
      </div>
    </section>
  `;
}

function renderGrid(): string {
  const cells: string[] = [];
  for (let y = 0; y < world.config.height; y += 1) {
    for (let x = 0; x < world.config.width; x += 1) {
      const ground = entitiesAt(x, y, "ground");
      const air = entitiesAt(x, y, "air");
      const all = [...ground, ...air];
      const isSelected = all.some((entity) => entity.id === selectedEntityId);
      const groundEntity = ground[0];
      const airEntity = air[0];
      const markedEntity = all.find((entity) => entity.state === "debris" || entity.state === "dead");
      const stateClass = markedEntity ? `has-${markedEntity.state}` : "";
      const labels = all.map((entity) => `${entity.display} ${entity.shortLabel}, ${layerLabel(entity.position.layer)}, ${lifeStateLabel(entity)}`).join("; ");
      cells.push(`
        <button class="grid-cell ${isSelected ? "selected" : ""} ${stateClass} ${all.length > 1 ? "stacked" : ""}" data-x="${x}" data-y="${y}" aria-pressed="${isSelected}" aria-label="${escapeHtml(`(${x},${y}) ${labels || "빈 칸"}`)}">
          <span class="coordinate">${x},${y}</span>
          <span class="cell-ground ${groundEntity && groundEntity.state !== "alive" ? "cell-debris" : ""}">${groundEntity ? escapeHtml(groundEntity.display) : ""}</span>
          <span class="cell-air ${airEntity && airEntity.state !== "alive" ? "cell-debris" : ""}">${airEntity ? escapeHtml(airEntity.display) : ""}</span>
          ${markedEntity ? `<span class="cell-state-badge ${markedEntity.state}">${escapeHtml(lifeStateLabel(markedEntity))}</span>` : ""}
          ${all.length > 1 ? `<span class="stack-count">+${all.length - 1}</span>` : ""}
        </button>
      `);
    }
  }
  return cells.join("");
}

function renderInspector(entity: EntityState | undefined): string {
  if (!entity) return `<div class="empty-state"><span class="empty-emoji">🧭</span><p>보드에서 개체가 있는 칸을 선택하세요.</p><small>빈 칸을 누르면 선택을 해제할 수 있습니다.</small></div>`;

  const capacities = getEntityCapacities(world, entity);
  const modules = getEntityModules(world, entity);
  const capabilities = [...new Set([...entity.capabilities, ...modules.flatMap((module) => world.catalog.modules[module.definitionId]?.providedCapabilities ?? [])])];
  const stateClass = lifeStateClass(entity);
  return `
    <div class="entity-hero"><span class="entity-emoji ${stateClass}">${escapeHtml(entity.display)}</span><div><h3>${escapeHtml(entity.shortLabel)}</h3><p>${escapeHtml(layerLabel(entity.position.layer))} · (${entity.position.x}, ${entity.position.y})</p></div><span class="state-chip ${stateClass}">${escapeHtml(lifeStateLabel(entity))}</span></div>
    ${entity.state === "debris" ? `<p class="state-note debris-note">잔해 상태입니다. 본체와 남은 자원은 보존되며, 보드에서 잔해 배지로 표시됩니다.</p>` : entity.state === "dead" ? `<p class="state-note dead-note">사망 상태입니다. 본체와 남은 자원은 보존됩니다.</p>` : ""}
    <div class="stat-grid">
      ${statCard("위치", `(${entity.position.x}, ${entity.position.y})`)}
      ${statCard("층", layerLabel(entity.position.layer))}
      ${statCard("질량", `${entityMass(world, entity)} u`)}
      ${statCard("구조 / 식용", `${entity.structureMass} / ${entity.edibleMass}`)}
      ${statCard("무결성", `${entity.integrity} / ${entity.maxIntegrity}`)}
      ${statCard("열", `${entityHeat(world, entity)} / ${entityHeatCapacity(world, entity)}`)}
      ${statCard("온도 지수", formatNumber(entityTemperature(world, entity)))}
    </div>
    <div class="meter-block"><div class="meter-label"><span>저장 에너지</span><strong>${entity.energy.stored} / ${capacities.energy.stored}</strong></div><div class="meter"><span style="width:${barPercent(entity.energy.stored, capacities.energy.stored)}%"></span></div></div>
    <details class="nested-disclosure" id="entity-details">
      <summary><span>개체 상세</span><span class="summary-meta">원장 · 능력 · 모듈 · 내부 키 ▾</span></summary>
      <div class="disclosure-content">
        <div class="identity-detail"><span class="subheading">정의 ID</span><code>${escapeHtml(entity.definitionId)}</code></div>
        <div class="ledger-block"><span class="subheading">질량 원장</span><p>${ledgerSummary(entity.inventory.mass)}</p><span class="subheading">에너지 원장</span><p>${ledgerSummary(entity.energy)}</p></div>
        <div class="capability-block"><span class="subheading">능력</span><div class="tag-list">${capabilities.length > 0 ? capabilities.map((capability) => `<span class="tag" title="${escapeHtml(capability)}">${escapeHtml(CAPABILITY_LABELS[capability] ?? capability)}</span>`).join("") : `<span class="muted">없음</span>`}</div></div>
        <div class="module-block"><div class="module-heading"><span class="subheading">장착 모듈 ${modules.length}</span><span class="muted">연결 ${activeConnections(world).filter((connection) => connection.from.entityId === entity.id || connection.to.entityId === entity.id).length}</span></div>${modules.length > 0 ? modules.map(renderModuleRow).join("") : `<p class="muted">장착된 모듈이 없습니다.</p>`}</div>
      </div>
    </details>
  `;
}

function renderModuleRow(module: WorldState["modules"][string]): string {
  const definition = world.catalog.modules[module.definitionId];
  const capacities = getModuleCapacities(world, module.id);
  return `
    <div class="module-row" data-module-row="${escapeHtml(module.id)}">
      <div class="module-title"><span>${escapeHtml(definition?.display ?? "◈")}</span><strong>${escapeHtml(definition?.shortLabel ?? module.definitionId)}</strong><code>${escapeHtml(module.id)}</code></div>
      <div class="module-meta"><span class="${module.integrity > 0 ? "good" : "bad"}">무결성 ${module.integrity}</span><span>cooldown ${module.cooldown}</span><span>${ledgerSummary(module.energy)}</span></div>
      <div class="module-actions"><select data-persist-key="resize-resource:${module.id}" data-resize-resource aria-label="${escapeHtml(`${definition?.shortLabel ?? module.definitionId} 용량 자원`)}">${MASS_RESOURCES.map((resource) => `<option value="${resource}">${resource}</option>`).join("")}</select><input data-persist-key="resize-capacity:${module.id}" data-resize-capacity type="number" min="0" step="1" value="${capacities.mass.raw ?? 0}" aria-label="${escapeHtml(`${definition?.shortLabel ?? module.definitionId} 새 용량`)}" /><button class="mini-button" data-action="resize" data-module-id="${escapeHtml(module.id)}">축소 예약</button><button class="mini-button danger" data-action="detach" data-module-id="${escapeHtml(module.id)}">분리 예약</button></div>
    </div>
  `;
}

function renderIntentControls(entity: EntityState | undefined, targetEntities: EntityState[]): string {
  const disabled = !entity;
  const targetValue = commandTargetId && targetEntities.some((candidate) => candidate.id === commandTargetId) ? commandTargetId : targetEntities[0]?.id ?? "";
  const mountedDefinitions = new Set(entity ? getEntityModules(world, entity).map((module) => module.definitionId) : []);
  const attachable = Object.values(world.catalog.modules).filter((module) => !mountedDefinitions.has(module.semanticId)).sort((a, b) => a.semanticId.localeCompare(b.semanticId));
  const detached = Object.values(world.modules).filter((module) => !module.ownerEntityId).sort((a, b) => a.id.localeCompare(b.id));
  return `
    <label class="field"><span>대상 개체 <small>(섭취·공격·방출)</small></span><select id="target-select" aria-label="대상 개체"><option value="">대상 없음</option>${targetEntities.map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === targetValue ? "selected" : ""}>${escapeHtml(targetOptionLabel(candidate))}</option>`).join("")}</select></label>
    <div class="intent-group"><span class="subheading">이동 / 층 전환</span><div class="button-grid"><button class="mini-button" data-action="move-n" aria-label="북쪽 이동 예약" title="북쪽으로 이동을 예약합니다." ${disabledAttr(disabled)}>↑</button><button class="mini-button" data-action="move-w" aria-label="서쪽 이동 예약" title="서쪽으로 이동을 예약합니다." ${disabledAttr(disabled)}>←</button><button class="mini-button" data-action="move-e" aria-label="동쪽 이동 예약" title="동쪽으로 이동을 예약합니다." ${disabledAttr(disabled)}>→</button><button class="mini-button" data-action="move-s" aria-label="남쪽 이동 예약" title="남쪽으로 이동을 예약합니다." ${disabledAttr(disabled)}>↓</button><button class="mini-button" data-action="takeoff" aria-label="비행 예약" title="공중 층으로 전환을 예약합니다." ${disabledAttr(disabled)}>비행 예약</button><button class="mini-button" data-action="land" aria-label="착륙 예약" title="지상 층으로 전환을 예약합니다." ${disabledAttr(disabled)}>착륙 예약</button></div></div>
    <div class="intent-group"><span class="subheading">상호작용</span><div class="button-grid wide"><button class="mini-button" data-action="consume" aria-label="섭식 행동 예약" ${disabledAttr(disabled)}>섭식 예약</button><button class="mini-button" data-action="attack" aria-label="공격 행동 예약" ${disabledAttr(disabled)}>공격 예약</button><button class="mini-button" data-action="charge" aria-label="충전 행동 예약" ${disabledAttr(disabled)}>충전 예약</button><button class="mini-button" data-action="discharge" aria-label="방출 행동 예약" ${disabledAttr(disabled)}>방출 예약</button><button class="mini-button" data-action="process" aria-label="가공 행동 예약" ${disabledAttr(disabled)}>가공 예약</button><button class="mini-button danger" data-action="deconstruct" aria-label="해체 행동 예약" ${disabledAttr(disabled)}>해체 예약</button></div></div>
    <div class="intent-group composition-group"><span class="subheading">구성 변경</span><div class="composition-line"><select id="attach-definition" aria-label="장착할 모듈" ${disabledAttr(disabled)}><option value="">새 모듈 선택</option>${attachable.map((module) => `<option value="${escapeHtml(module.semanticId)}">${escapeHtml(module.shortLabel)}</option>`).join("")}</select><button class="mini-button" data-action="attach" ${disabledAttr(disabled)}>장착 예약</button></div>${detached.length > 0 ? `<div class="composition-line"><select id="reattach-module" aria-label="재장착할 분리 모듈" ${disabledAttr(disabled)}><option value="">분리 모듈 재장착</option>${detached.map((module) => `<option value="${escapeHtml(module.id)}">${escapeHtml(module.definitionId)}</option>`).join("")}</select><button class="mini-button" data-action="reattach" ${disabledAttr(disabled)}>복귀 예약</button></div>` : ""}</div>
    <p class="hint">행동은 즉시 상태를 바꾸지 않고 예약 큐에 들어갑니다. 자원·거리·능력 같은 조건은 다음 단계의 엔진이 판정하며, 결과는 아래에 남습니다.</p>
    ${renderRequestFeedback(entity)}
  `;
}

function renderRequestFeedback(entity: EntityState | undefined): string {
  const selectedPending = entity ? pendingIntentRecords.filter((record) => record.actorId === entity.id) : [];
  const selectedResults = entity ? recentIntentResults.filter((record) => record.actorId === entity.id) : [];
  return `
    <section class="request-feedback" aria-live="polite">
      <div class="request-summary"><strong>대기 중 ${world.pendingIntents.length}건</strong><span>현재 개체 ${selectedPending.length}건</span></div>
      ${pendingIntentRecords.length > 0 ? `<div class="request-block"><span class="subheading">예약 큐</span><ul class="request-list">${pendingIntentRecords.slice(0, 8).map(renderPendingRequest).join("")}</ul>${pendingIntentRecords.length > 8 ? `<p class="muted">외 ${pendingIntentRecords.length - 8}건</p>` : ""}</div>` : `<p class="request-empty">예약된 행동이 없습니다. 버튼을 누른 뒤 다음 단계를 진행하세요.</p>`}
      ${selectedResults.length > 0 ? `<div class="request-block result-block"><div class="result-heading"><span class="subheading">내 최근 요청 결과</span><span class="muted">최근 5건 보존</span></div>${selectedResults.slice(0, 5).map(renderIntentResult).join("")}</div>` : entity ? `<p class="request-empty">아직 이 개체의 수동 처리 결과가 없습니다.</p>` : ""}
    </section>
  `;
}

function renderPendingRequest(record: IntentRecord): string {
  return `<li class="request-item"><span class="request-mark pending">예약</span><div><strong>${escapeHtml(record.actorLabel)} · ${escapeHtml(intentActionLabel(record.intent))}</strong><small>${escapeHtml(intentContextLabel(record))} · 다음 단계에서 처리</small></div></li>`;
}

function renderIntentResult(record: IntentRecord): string {
  const event = record.event;
  const statusLabel = record.status === "success" ? "성공" : record.status === "failed" ? "실패" : "실행되지 않음";
  const headline = record.status === "success"
    ? `${record.actorLabel} · ${intentActionLabel(record.intent)} 처리됨`
    : record.status === "failed"
      ? `${record.actorLabel} · ${intentActionLabel(record.intent)} 실패`
      : `${record.actorLabel} · ${intentActionLabel(record.intent)} 실행되지 않았습니다`;
  const message = record.status === "success"
    ? friendlyEventMessage(event?.message ?? "처리됨")
    : record.status === "failed"
      ? event?.reason ? reasonLabel(event.reason) : "거래 실패"
      : "해당 단계에서 대응 이벤트가 확인되지 않았습니다.";
  const detail = event
    ? `<details class="result-details"><summary>원본 이벤트 보기</summary><code>${escapeHtml(JSON.stringify(event, null, 2))}</code></details>`
    : "";
  return `
    <article class="request-result ${record.status}" data-result-status="${record.status}">
      <div class="result-topline"><span class="request-mark ${record.status}">${statusLabel}</span><strong>${escapeHtml(headline)}</strong><span class="request-tick">처리 tick ${record.processedTick ?? "—"}</span></div>
      <p>${escapeHtml(message)}</p>
      <dl class="result-meta"><div><dt>대상</dt><dd>${escapeHtml(record.targetLabel ?? "없음")}</dd></div><div><dt>예약 tick</dt><dd>${record.submittedAtTick}</dd></div></dl>
      ${detail}
    </article>
  `;
}

function renderExternalControls(entity: EntityState | undefined): string {
  const defaultOwner = entity ? `entity:${entity.id}` : Object.values(world.entities).sort(compareEntities)[0] ? `entity:${Object.values(world.entities).sort(compareEntities)[0].id}` : "";
  const selectedOwner = persistedValue("external-owner", defaultOwner);
  const selectedResource = persistedValue("external-resource", "mass:water");
  const ownerOptions = [
    ...Object.values(world.entities).sort(compareEntities).map((candidate) => `<option value="entity:${escapeHtml(candidate.id)}" ${selectedOwner === `entity:${candidate.id}` ? "selected" : ""}>개체 · ${escapeHtml(candidate.shortLabel)} · ${escapeHtml(candidate.id)}</option>`),
    ...Object.values(world.modules).sort((a, b) => a.id.localeCompare(b.id)).map((module) => `<option value="module:${escapeHtml(module.id)}" ${selectedOwner === `module:${module.id}` ? "selected" : ""}>모듈 · ${escapeHtml(module.id)}</option>`),
  ];
  return `
    <div class="external-block"><span class="subheading">외부 자원 주입</span><div class="form-row"><select id="external-owner" data-persist-key="external-owner" aria-label="외부 자원 소유자">${ownerOptions.join("")}</select><select id="external-resource" data-persist-key="external-resource" aria-label="외부 자원 종류"><optgroup label="질량">${MASS_RESOURCES.map((resource) => `<option value="mass:${resource}" ${selectedResource === `mass:${resource}` ? "selected" : ""}>${resource}</option>`).join("")}</optgroup><optgroup label="에너지">${ENERGY_RESOURCES.map((resource) => `<option value="energy:${resource}" ${selectedResource === `energy:${resource}` ? "selected" : ""}>${resource}</option>`).join("")}</optgroup></select><input id="external-amount" data-persist-key="external-amount" type="number" min="1" step="1" value="${escapeHtml(persistedValue("external-amount", "1"))}" aria-label="주입량" /><button class="mini-button" data-action="inject-resource">주입 예약</button></div><input id="external-label" data-persist-key="external-label" class="text-input" value="${escapeHtml(persistedValue("external-label", "manual console input"))}" aria-label="주입 라벨" /></div>
    <div class="external-block"><span class="subheading">외부 개체 생성</span><div class="form-row"><select id="spawn-preset" data-persist-key="spawn-preset" aria-label="생성 프리셋">${Object.values(world.catalog.presets).sort((a, b) => a.semanticId.localeCompare(b.semanticId)).map((preset) => `<option value="${escapeHtml(preset.semanticId)}" ${persistedValue("spawn-preset", "") === preset.semanticId ? "selected" : ""}>${escapeHtml(preset.display)} ${escapeHtml(preset.shortLabel)}</option>`).join("")}</select><select id="spawn-layer" data-persist-key="spawn-layer" aria-label="생성 층"><option value="ground" ${persistedValue("spawn-layer", "ground") === "ground" ? "selected" : ""}>지상</option><option value="air" ${persistedValue("spawn-layer", "ground") === "air" ? "selected" : ""}>공중</option></select><input id="spawn-x" data-persist-key="spawn-x" type="number" min="0" max="${world.config.width - 1}" step="1" value="${escapeHtml(persistedValue("spawn-x", "1"))}" aria-label="생성 x 좌표" /><input id="spawn-y" data-persist-key="spawn-y" type="number" min="0" max="${world.config.height - 1}" step="1" value="${escapeHtml(persistedValue("spawn-y", "1"))}" aria-label="생성 y 좌표" /><button class="mini-button" data-action="spawn">생성 예약</button></div></div>
  `;
}

function renderDevInfo(): string {
  return `
    <div class="dev-info"><span class="subheading">개발 정보</span><dl class="dev-grid"><div><dt>현재 phase</dt><dd>${world.phase}</dd></div><div><dt>state hash</dt><dd>${escapeHtml(world.stateHash)}</dd></div><div><dt>이벤트 보존</dt><dd>${world.logs.length} / 2,000</dd></div><div><dt>pending intent 원본</dt><dd>${world.pendingIntents.length}건</dd></div></dl></div>
  `;
}

function renderLogs(): string {
  if (world.logs.length === 0) return `<div class="empty-log">아직 로그가 없습니다. 행동을 예약하거나 한 단계를 진행하세요.</div>`;
  return world.logs.slice(-80).reverse().map((event) => `
    <article class="log-entry ${event.outcome}">
      <div class="log-time">t${event.tick}<br>${event.phase}</div>
      <div class="log-body"><div class="log-title"><strong>${escapeHtml(eventSubject(event))} · ${escapeHtml(ruleLabel(event.ruleId))}</strong><span class="outcome ${event.outcome}">${escapeHtml(outcomeLabel(event.outcome))}</span></div><p>${escapeHtml(friendlyEventMessage(event.message))}${event.reason ? ` <span class="reason">사유: ${escapeHtml(reasonLabel(event.reason))}</span>` : ""}</p><details class="log-raw"><summary>원본 키·ID</summary><code>${escapeHtml(JSON.stringify(event, null, 2))}</code></details></div>
      <div class="log-actors">${escapeHtml(eventSubject(event))}</div>
    </article>
  `).join("");
}

function bindEvents(): void {
  app.querySelector<HTMLSelectElement>("#scenario-select")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (!isScenarioId(value)) return;
    selectedScenario = value;
    world = createDemoWorld(selectedScenario);
    selectedEntityId = firstEntityId(world);
    commandTargetId = undefined;
    definitionText = "";
    clearIntentTracking();
    resetViewState();
    setNotice(`${selectedScenario} 시나리오를 준비했습니다.`, "success");
    render();
  });

  app.querySelector<HTMLTextAreaElement>("#definition-json")?.addEventListener("input", (event) => {
    definitionText = (event.target as HTMLTextAreaElement).value;
  });
  app.querySelector<HTMLSelectElement>("#target-select")?.addEventListener("change", (event) => {
    commandTargetId = (event.target as HTMLSelectElement).value || undefined;
  });
  app.querySelectorAll<HTMLButtonElement>("[data-x][data-y]").forEach((button) => {
    button.addEventListener("click", () => {
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      const candidates = [...entitiesAt(x, y, "ground"), ...entitiesAt(x, y, "air")];
      selectedEntityId = candidates[0]?.id;
      commandTargetId = undefined;
      setNotice(selectedEntityId ? `${entityLabel(selectedEntityId)} 선택` : `(${x}, ${y}) 빈 칸`, "info");
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });
}

function handleAction(button: HTMLButtonElement): void {
  const action = button.dataset.action;
  if (action === "reset") {
    world = createDemoWorld(selectedScenario);
    selectedEntityId = firstEntityId(world);
    commandTargetId = undefined;
    definitionText = "";
    clearIntentTracking();
    resetViewState();
    setNotice("초기 fixture로 되돌렸습니다.", "success");
    render();
    return;
  }
  if (action === "toggle") {
    paused = !paused;
    updateTimer();
    render();
    return;
  }
  if (action === "step") {
    runStep();
    return;
  }
  if (action === "open-tools") {
    openDetail("tools-details");
    return;
  }
  if (action === "export-definition") {
    exportSelectedDefinition();
    return;
  }
  if (action === "import-definition") {
    importTypedDefinition();
    return;
  }
  if (action === "inject-resource") {
    injectResource();
    return;
  }
  if (action === "spawn") {
    spawnEntity();
    return;
  }
  if (action === "detach" || action === "resize") {
    const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
    const moduleId = button.dataset.moduleId;
    if (!entity || !moduleId) return showNotice("먼저 개체와 모듈을 선택하세요.", "error");
    if (action === "detach") return sendIntent({ type: "detach-module", actorId: entity.id, moduleId });
    const row = button.closest<HTMLElement>(".module-row");
    const resource = row?.querySelector<HTMLSelectElement>("[data-resize-resource]")?.value as MassResource | undefined;
    const newCapacity = Number(row?.querySelector<HTMLInputElement>("[data-resize-capacity]")?.value);
    if (!resource || !Number.isSafeInteger(newCapacity) || newCapacity < 0) return showNotice("축소 용량은 0 이상의 정수여야 합니다.", "error");
    return sendIntent({ type: "resize-module", actorId: entity.id, moduleId, resource, newCapacity });
  }
  if (action === "attach" || action === "reattach") {
    const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
    if (!entity) return showNotice("먼저 개체를 선택하세요.", "error");
    if (action === "attach") {
      const moduleDefinitionId = app.querySelector<HTMLSelectElement>("#attach-definition")?.value;
      if (!moduleDefinitionId) return showNotice("장착할 모듈을 선택하세요.", "error");
      return sendIntent({ type: "attach-module", actorId: entity.id, moduleDefinitionId });
    }
    const moduleId = app.querySelector<HTMLSelectElement>("#reattach-module")?.value;
    const module = moduleId ? world.modules[moduleId] : undefined;
    if (!module) return showNotice("재장착할 분리 모듈을 선택하세요.", "error");
    return sendIntent({ type: "attach-module", actorId: entity.id, moduleDefinitionId: module.definitionId, moduleId: module.id });
  }

  const intent = intentForAction(action);
  if (intent) sendIntent(intent);
}

function intentForAction(action: string | undefined): Intent | undefined {
  const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  if (!entity) {
    showNotice("먼저 개체를 선택하세요.", "error");
    return undefined;
  }
  const targetId = currentTargetId();
  if (["consume", "attack", "discharge"].includes(action ?? "") && !targetId) {
    showNotice("대상 개체를 선택하세요.", "error");
    return undefined;
  }
  switch (action) {
    case "move-n": return { type: "move", actorId: entity.id, dx: 0, dy: -1 };
    case "move-s": return { type: "move", actorId: entity.id, dx: 0, dy: 1 };
    case "move-w": return { type: "move", actorId: entity.id, dx: -1, dy: 0 };
    case "move-e": return { type: "move", actorId: entity.id, dx: 1, dy: 0 };
    case "takeoff": return { type: "move", actorId: entity.id, dx: 0, dy: 0, toLayer: "air" };
    case "land": return { type: "move", actorId: entity.id, dx: 0, dy: 0, toLayer: "ground" };
    case "consume": return { type: "consume", actorId: entity.id, targetId: targetId ?? "", amount: 1 };
    case "attack": return { type: "attack", actorId: entity.id, targetId: targetId ?? "" };
    case "charge": return { type: "charge", actorId: entity.id };
    case "discharge": return { type: "discharge", actorId: entity.id, targetId: targetId ?? "" };
    case "process": return { type: "process", actorId: entity.id };
    case "deconstruct": return { type: "deconstruct", actorId: entity.id };
    default: return undefined;
  }
}

function sendIntent(intent: Intent): void {
  const result = submitIntent(world, intent);
  if (result.ok) {
    const record = createIntentRecord(intent);
    record.candidateKey = candidateKeyForIntent(world, intent);
    pendingIntentRecords.push(record);
    setNotice(`${intentActionLabel(intent)} 행동을 예약했습니다. 다음 단계에서 처리됩니다.`, "success");
  }
  else setNotice(`행동 예약 거부: ${result.error}`, "error");
  render();
}

function runStep(): void {
  const queuedRecords = [...pendingIntentRecords];
  const existingEventIds = new Set(world.logs.map((event) => event.id));
  const stepStart = cloneWorld(world);
  try {
    for (const record of queuedRecords) record.candidateKey = candidateKeyForIntent(stepStart, record.intent) ?? record.candidateKey;
    const report = step(world);
    const stepEvents = world.logs.filter((event) => !existingEventIds.has(event.id));
    resolveIntentResults(queuedRecords, stepEvents, report.tick);
    setNotice(`tick ${report.tick} 완료 · ${report.accepted}개 승인 · ${report.rejected}개 거부`, report.rejected > 0 ? "info" : "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "한 단계 실행에 실패했습니다.", "error");
  }
  render();
}

function injectResource(): void {
  const ownerValue = app.querySelector<HTMLSelectElement>("#external-owner")?.value ?? "";
  const resourceValue = app.querySelector<HTMLSelectElement>("#external-resource")?.value ?? "";
  const amount = Number(app.querySelector<HTMLInputElement>("#external-amount")?.value);
  const label = app.querySelector<HTMLInputElement>("#external-label")?.value || "manual console input";
  const ownerSeparator = ownerValue.indexOf(":");
  const scope = ownerSeparator >= 0 ? ownerValue.slice(0, ownerSeparator) : "";
  const ownerId = ownerSeparator >= 0 ? ownerValue.slice(ownerSeparator + 1) : "";
  const [resourceKind, resource] = resourceValue.split(":");
  if ((scope !== "entity" && scope !== "module") || !ownerId || (resourceKind !== "mass" && resourceKind !== "energy") || !resource || !Number.isSafeInteger(amount) || amount < 1) {
    setNotice("외부 자원 입력값을 확인하세요.", "error");
    render();
    return;
  }
  try {
    queueExternalResource(world, {
      ownerId,
      scope,
      resourceKind,
      resource: resource as MassResource | EnergyResource,
      amount,
      label,
    });
    setNotice(`외부 ${resource} ${amount} 단위 입력을 예약했습니다. 다음 단계 P0에서 처리됩니다.`, "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "외부 입력을 예약하지 못했습니다.", "error");
  }
  render();
}

function spawnEntity(): void {
  const presetId = app.querySelector<HTMLSelectElement>("#spawn-preset")?.value;
  const layer = app.querySelector<HTMLSelectElement>("#spawn-layer")?.value;
  const x = Number(app.querySelector<HTMLInputElement>("#spawn-x")?.value);
  const y = Number(app.querySelector<HTMLInputElement>("#spawn-y")?.value);
  if (!presetId || (layer !== "ground" && layer !== "air") || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    setNotice("외부 생성 위치를 확인하세요.", "error");
    render();
    return;
  }
  try {
    queueExternalSpawn(world, { presetId, position: { x, y, layer } });
    setNotice(`${presetId} 외부 생성 입력을 예약했습니다. 다음 단계 P0에서 처리됩니다.`, "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "외부 생성 요청에 실패했습니다.", "error");
  }
  render();
}

function exportSelectedDefinition(): void {
  const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  if (!entity) return showNotice("내보낼 개체를 선택하세요.", "error");
  const result = world.catalog.machines[entity.definitionId]
    ? exportMachineDefinition(world, entity.id)
    : exportCreatureDefinition(world, entity.id);
  if (result.ok && result.value !== undefined) {
    definitionText = result.value;
    setNotice(`${entity.shortLabel} 정의를 JSON으로 내보냈습니다.`, "success");
  } else setNotice(result.error ?? "정의 내보내기에 실패했습니다.", "error");
  render();
}

function importTypedDefinition(): void {
  const raw = app.querySelector<HTMLTextAreaElement>("#definition-json")?.value ?? definitionText;
  const result = importDefinition(world, raw);
  if (result.ok) setNotice(`${result.value} 정의를 카탈로그에 추가했습니다.`, "success");
  else setNotice(`가져오기 실패: ${result.error}`, "error");
  render();
}

function currentTargetId(): string | undefined {
  return app.querySelector<HTMLSelectElement>("#target-select")?.value || commandTargetId;
}

function updateTimer(): void {
  if (timerId !== undefined) {
    window.clearInterval(timerId);
    timerId = undefined;
  }
  if (!paused) timerId = window.setInterval(runStep, speedMs);
}

function setNotice(message: string, tone: NoticeTone): void {
  notice = message;
  noticeTone = tone;
}

function showNotice(message: string, tone: NoticeTone): void {
  setNotice(message, tone);
  render();
}

function entitiesAt(x: number, y: number, layer: "ground" | "air"): EntityState[] {
  return Object.values(world.entities)
    .filter((entity) => entity.position.x === x && entity.position.y === y && entity.position.layer === layer)
    .sort(compareEntities);
}

function moduleForDefinition(currentWorld: WorldState, entityId: string, definitionId: string): string {
  const entity = currentWorld.entities[entityId];
  const module = entity ? getEntityModules(currentWorld, entity).find((candidate) => candidate.definitionId === definitionId) : undefined;
  if (!module) throw new Error(`module ${definitionId} is missing from ${entityId}`);
  return module.id;
}

function firstEntityId(currentWorld: WorldState): string | undefined {
  return Object.values(currentWorld.entities).sort(compareEntities)[0]?.id;
}

function compareEntities(left: EntityState, right: EntityState): number {
  return left.id.localeCompare(right.id);
}

function createIntentRecord(intent: Intent): IntentRecord {
  const actor = world.entities[intent.actorId];
  const targetId = intentTargetId(intent);
  return {
    uiId: nextIntentOrdinal++,
    intent: cloneIntent(intent),
    actorId: intent.actorId,
    actorLabel: actor ? `${actor.display} ${actor.shortLabel}` : intent.actorId,
    targetId,
    targetLabel: targetId ? targetOptionLabel(world.entities[targetId]) : undefined,
    submittedAtTick: world.tick,
    status: "pending",
  };
}

function resolveIntentResults(records: IntentRecord[], events: SimulationEvent[], processedTick: number): void {
  if (records.length === 0) return;
  const eventsByCandidate = new Map<string, SimulationEvent>();
  for (const event of events) {
    if (event.candidateKey && (event.outcome === "accepted" || event.outcome === "failed")) eventsByCandidate.set(event.candidateKey, event);
  }
  const consumedCandidateKeys = new Set<string>();
  for (const record of records) {
    const key = record.candidateKey;
    const event = key && !consumedCandidateKeys.has(key) ? eventsByCandidate.get(key) : undefined;
    record.processedTick = processedTick;
    if (event && key) {
      consumedCandidateKeys.add(key);
      record.event = event;
      record.status = event.outcome === "accepted" ? "success" : "failed";
    } else {
      record.status = "not-executed";
    }
  }
  recentIntentResults = [...records, ...recentIntentResults].slice(0, 5);
  const completedIds = new Set(records.map((record) => record.uiId));
  pendingIntentRecords = pendingIntentRecords.filter((record) => !completedIds.has(record.uiId));
}

function syncPendingIntentRecords(): void {
  const available = [...pendingIntentRecords];
  const synced: IntentRecord[] = [];
  for (const intent of world.pendingIntents) {
    const key = intentKey(intent);
    const index = available.findIndex((record) => intentKey(record.intent) === key);
    if (index >= 0) {
      const [record] = available.splice(index, 1);
      synced.push(record);
    } else {
      synced.push(createIntentRecord(intent));
    }
  }
  pendingIntentRecords = synced;
}

function clearIntentTracking(): void {
  pendingIntentRecords = [];
  recentIntentResults = [];
}

function candidateKeyForIntent(currentWorld: WorldState, intent: Intent): string | undefined {
  const candidates = buildPhaseCandidates(currentWorld, "P2");
  return candidates.find((candidate) => candidate.key.startsWith("intent-") && candidateMatchesIntent(candidate, intent, currentWorld))?.key;
}

function candidateMatchesIntent(candidate: Candidate, intent: Intent, currentWorld: WorldState): boolean {
  if (candidate.actorId !== intent.actorId || candidate.phase !== "P2") return false;
  const entity = currentWorld.entities[intent.actorId];
  switch (intent.type) {
    case "move": {
      if (!entity || candidate.ruleId !== "movement.orthogonal" || candidate.operation.kind !== "move") return false;
      const toLayer = intent.toLayer ?? entity.position.layer;
      return candidate.operation.from.x === entity.position.x && candidate.operation.from.y === entity.position.y && candidate.operation.from.layer === entity.position.layer && candidate.operation.to.x === entity.position.x + intent.dx && candidate.operation.to.y === entity.position.y + intent.dy && candidate.operation.to.layer === toLayer;
    }
    case "consume": return candidate.ruleId === "metabolism.consume" && candidate.operation.kind === "consume" && candidate.operation.targetId === intent.targetId;
    case "attack": return candidate.ruleId === "interaction.work-damage" && candidate.operation.kind === "attack" && candidate.operation.targetId === intent.targetId;
    case "discharge": return candidate.ruleId === "electric.discharge" && candidate.operation.kind === "discharge" && candidate.operation.targetId === intent.targetId;
    case "charge": return candidate.ruleId === "electric.charge" && candidate.operation.kind === "charge";
    case "process": return candidate.ruleId === "machine.existing-conversion" && candidate.operation.kind === "machine-process" && (!intent.processorModuleId || candidate.operation.processorModuleId === intent.processorModuleId);
    case "attach-module": return candidate.ruleId === "composition.attach" && candidate.operation.kind === "attach-module" && candidate.operation.moduleDefinitionId === intent.moduleDefinitionId && candidate.operation.moduleId === intent.moduleId;
    case "detach-module": return candidate.ruleId === "composition.detach" && candidate.operation.kind === "detach-module" && candidate.operation.moduleId === intent.moduleId;
    case "resize-module": return candidate.ruleId === "composition.resize-capacity" && candidate.operation.kind === "resize-module" && candidate.operation.moduleId === intent.moduleId && candidate.operation.resource === intent.resource && candidate.operation.newCapacity === intent.newCapacity;
    case "deconstruct": return candidate.ruleId === "composition.deconstruct" && candidate.operation.kind === "deconstruct";
    default: return false;
  }
}

function intentKey(intent: Intent): string {
  return JSON.stringify(intent, Object.keys(intent).sort());
}

function cloneIntent(intent: Intent): Intent {
  return JSON.parse(JSON.stringify(intent)) as Intent;
}

function intentTargetId(intent: Intent): string | undefined {
  if (intent.type === "consume" || intent.type === "attack" || intent.type === "discharge") return intent.targetId;
  return undefined;
}

function intentActionLabel(intent: Intent): string {
  if (intent.type === "move") {
    if (intent.toLayer === "air" && intent.dx === 0 && intent.dy === 0) return "비행";
    if (intent.toLayer === "ground" && intent.dx === 0 && intent.dy === 0) return "착륙";
    const direction = intent.dx === 1 ? "동쪽" : intent.dx === -1 ? "서쪽" : intent.dy === 1 ? "남쪽" : "북쪽";
    return `${direction} 이동`;
  }
  const labels: Record<Exclude<Intent["type"], "move">, string> = {
    consume: "섭식",
    attack: "공격",
    discharge: "방출",
    charge: "충전",
    process: "가공",
    "attach-module": "모듈 장착",
    "detach-module": "모듈 분리",
    "resize-module": "용량 축소",
    deconstruct: "해체",
  };
  return labels[intent.type];
}

function intentContextLabel(record: IntentRecord): string {
  if (record.targetLabel) return `대상 ${record.targetLabel}`;
  if (record.intent.type === "resize-module") return `자원 ${record.intent.resource} · ${record.intent.newCapacity}`;
  if (record.intent.type === "attach-module") return `모듈 ${record.intent.moduleDefinitionId}`;
  return "대상 없음";
}

function entityLabel(entityId: string): string {
  const entity = world.entities[entityId];
  return entity ? `${entity.display} ${entity.shortLabel}` : entityId;
}

function targetOptionLabel(entity: EntityState | undefined): string {
  if (!entity) return "삭제된 개체";
  return `${entity.display} ${entity.shortLabel} · (${entity.position.x}, ${entity.position.y}) · ${layerLabel(entity.position.layer)} · ${lifeStateLabel(entity)}`;
}

function eventSubject(event: SimulationEvent): string {
  const actor = event.actorId ? entityLabel(event.actorId) : "시스템";
  if (!event.targetId) return actor;
  const targetEntity = world.entities[event.targetId];
  const targetModule = world.modules[event.targetId];
  const target = targetEntity ? `${targetEntity.display} ${targetEntity.shortLabel}` : targetModule ? `모듈 ${targetModule.definitionId}` : event.targetId;
  return `${actor} → ${target}`;
}

function ruleLabel(ruleId: string): string {
  return RULE_LABELS[ruleId] ?? "규칙 처리";
}

function outcomeLabel(outcome: SimulationEvent["outcome"]): string {
  if (outcome === "accepted") return "성공";
  if (outcome === "failed") return "실패";
  if (outcome === "external") return "외부";
  return "시스템";
}

function friendlyEventMessage(message: string): string {
  return message.replace(/^ground /, "지상 ").replace(/^air /, "공중 ");
}

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

function layerLabel(layer: EntityState["position"]["layer"]): string {
  return layer === "air" ? "공중" : "지상";
}

function lifeStateLabel(entity: EntityState): string {
  if (entity.state === "debris") return "잔해";
  if (entity.state === "dead") return "사망";
  return entity.alive ? "생존" : "비활성";
}

function lifeStateClass(entity: EntityState): string {
  if (entity.state === "debris") return "debris";
  if (entity.state === "dead") return "dead";
  return "alive";
}

function statCard(label: string, value: string): string {
  return `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function ledgerSummary(ledger: Record<string, number>): string {
  const entries = Object.entries(ledger).filter(([, amount]) => amount !== 0);
  return entries.length > 0 ? entries.map(([resource, amount]) => `${escapeHtml(resource)} ${amount}`).join(" · ") : "—";
}

function barPercent(value: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return Math.max(0, Math.min(100, (value / capacity) * 100));
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "∞";
}

function persistedValue(key: string, fallback: string): string {
  return viewState.formValues[key] ?? fallback;
}

function captureViewState(): void {
  const detailIds = ["tools-details", "definition-details", "logs-details", "entity-details"];
  for (const id of detailIds) {
    const detail = app.querySelector<HTMLDetailsElement>(`#${id}`);
    if (detail) viewState.detailOpen[id] = detail.open;
  }
  app.querySelectorAll<HTMLElement>("[data-persist-key]").forEach((element) => {
    const key = element.dataset.persistKey;
    if (key && "value" in element) viewState.formValues[key] = (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  });
  const active = document.activeElement;
  viewState.focusedId = active instanceof HTMLElement && app.contains(active) && active.id ? active.id : undefined;
}

function restoreViewState(): void {
  app.querySelectorAll<HTMLElement>("[data-persist-key]").forEach((element) => {
    const key = element.dataset.persistKey;
    const value = key ? viewState.formValues[key] : undefined;
    if (value === undefined || !("value" in element)) return;
    const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (control instanceof HTMLSelectElement && !Array.from(control.options).some((option) => option.value === value)) return;
    control.value = value;
  });
  for (const [id, open] of Object.entries(viewState.detailOpen)) {
    const detail = app.querySelector<HTMLDetailsElement>(`#${id}`);
    if (detail) detail.open = open;
  }
  if (viewState.focusedId) {
    const focused = document.getElementById(viewState.focusedId);
    if (focused instanceof HTMLElement && app.contains(focused) && !focused.hasAttribute("disabled") && ["INPUT", "SELECT", "TEXTAREA"].includes(focused.tagName)) focused.focus({ preventScroll: true });
  }
}

function resetViewState(): void {
  viewState = { detailOpen: {}, formValues: {} };
  captureViewStateOnNextRender = false;
}

function openDetail(id: string): void {
  viewState.detailOpen[id] = true;
  captureViewStateOnNextRender = false;
  render();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function disabledAttr(disabled: boolean): string {
  return disabled ? "disabled" : "";
}

function isScenarioId(value: string): value is ScenarioId {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E";
}
