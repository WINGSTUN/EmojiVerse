import "./styles.css";

import {
  ENERGY_RESOURCES,
  MASS_RESOURCES,
  activeConnections,
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
  type EnergyResource,
  type EntityState,
  type Intent,
  type MassResource,
  type WorldState,
} from "../index";

type ScenarioId = "A" | "B" | "C" | "D" | "E";
type NoticeTone = "info" | "success" | "error";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("#app was not found");
const app: HTMLDivElement = appElement;

const SCENARIOS: Record<ScenarioId, { title: string; description: string }> = {
  A: { title: "생장 · 섭식 · 포식", description: "식물의 성장부터 사체 섭취까지 공통 규칙으로 이어집니다." },
  B: { title: "날개 · 질량 · 착륙", description: "모듈 능력, 총 질량, 저장 에너지로 비행 가능성을 판정합니다." },
  C: { title: "전하 저장 · 방출", description: "저장 에너지를 전하로 바꾸고 인접 대상에 열로 방출합니다." },
  D: { title: "전기 가열 · 연소", description: "열 임계값을 넘긴 연료 상자가 다음 P1에서 연소합니다." },
  E: { title: "재활용 기계", description: "연결된 저장소와 가공기가 raw → product 변환을 반복합니다." },
};

let world = createDemoWorld("A");
let selectedEntityId: string | undefined = firstEntityId(world);
let commandTargetId: string | undefined;
let selectedScenario: ScenarioId = "A";
let paused = true;
let speedMs = 700;
let timerId: number | undefined;
let notice = "시나리오를 선택하고 Step을 눌러 첫 tick을 실행하세요.";
let noticeTone: NoticeTone = "info";
let definitionText = "";

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
  const selected = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  const targetEntities = Object.values(world.entities)
    .filter((entity) => entity.id !== selected?.id)
    .sort(compareEntities);
  const scenario = SCENARIOS[selectedScenario];
  const phaseSummary = world.logs.length > 0
    ? `${world.logs[world.logs.length - 1]?.phase ?? world.phase} · 마지막 이벤트 ${world.logs[world.logs.length - 1]?.ruleId ?? "-"}`
    : "아직 이벤트가 없습니다";

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="eyebrow">LOCAL · DETERMINISTIC · DATA-DRIVEN</div>
          <h1>EmojiVerse <span>🪐</span></h1>
          <p>고정 16×16 세계에서 질량·에너지·열·구성을 한 tick씩 관찰하는 작은 실험실</p>
        </div>
        <div class="top-controls">
          <label class="field compact-field">
            <span>시나리오</span>
            <select id="scenario-select">
              ${Object.entries(SCENARIOS).map(([id, item]) => `<option value="${id}" ${id === selectedScenario ? "selected" : ""}>${id} · ${escapeHtml(item.title)}</option>`).join("")}
            </select>
          </label>
          <button class="button ghost" data-action="reset">초기화</button>
          <button class="button" data-action="toggle">${paused ? "▶ 자동 실행" : "Ⅱ 일시정지"}</button>
          <button class="button primary" data-action="step">Step 1 tick</button>
        </div>
      </header>

      <section class="status-strip">
        <div class="status-item"><span>시나리오</span><strong>${selectedScenario} · ${escapeHtml(scenario.title)}</strong></div>
        <div class="status-item"><span>tick / phase</span><strong>${world.tick} / ${world.phase}</strong></div>
        <div class="status-item"><span>entities</span><strong>${Object.keys(world.entities).length} · modules ${Object.keys(world.modules).length}</strong></div>
        <div class="status-item hash-item"><span>state hash</span><strong>${escapeHtml(world.stateHash)}</strong></div>
      </section>

      <div class="notice ${noticeTone}"><span class="notice-dot"></span>${escapeHtml(notice)}<span class="notice-context">${escapeHtml(phaseSummary)}</span></div>

      <main class="main-grid">
        <section class="panel world-panel">
          <div class="panel-heading">
            <div><span class="panel-kicker">WORLD VIEW</span><h2>16×16 관찰 보드</h2></div>
            <div class="legend"><span><i class="legend-swatch ground"></i>ground</span><span><i class="legend-swatch air"></i>air</span><span><i class="legend-swatch selected"></i>selected</span></div>
          </div>
          <div class="grid-wrap"><div class="world-grid" style="--grid-size: ${world.config.width};">${renderGrid()}</div></div>
          <div class="world-footer"><span>${escapeHtml(scenario.description)}</span><span>자동 정책은 memoryless · 모든 행동은 P0 → P1 → P2 후보로 기록됩니다.</span></div>
        </section>

        <aside class="side-column">
          <section class="panel inspector-panel">
            <div class="panel-heading"><div><span class="panel-kicker">INSPECTOR</span><h2>선택한 개체</h2></div><span class="pill">${selected ? escapeHtml(selected.id) : "none"}</span></div>
            ${renderInspector(selected)}
          </section>

          <section class="panel action-panel">
            <div class="panel-heading"><div><span class="panel-kicker">INTENTS</span><h2>의도 제출</h2></div><span class="muted">다음 Step에서 해결</span></div>
            ${renderIntentControls(selected, targetEntities)}
          </section>
        </aside>
      </main>

      <section class="lower-grid">
        <section class="panel intervention-panel">
          <div class="panel-heading"><div><span class="panel-kicker">EXTERNAL INPUT</span><h2>외부 개입</h2></div><span class="muted">P0에서 원자 커밋</span></div>
          ${renderExternalControls(selected)}
        </section>
        <section class="panel definition-panel">
          <div class="panel-heading"><div><span class="panel-kicker">DEFINITION IO</span><h2>정의 JSON</h2></div><span class="muted">콜백·스크립트 필드 차단</span></div>
          <textarea id="definition-json" spellcheck="false" placeholder="Export selected definition 또는 version 1 package JSON을 붙여넣으세요.">${escapeHtml(definitionText)}</textarea>
          <div class="inline-actions"><button class="button ghost" data-action="export-definition" ${selected ? "" : "disabled"}>선택 정의 내보내기</button><button class="button" data-action="import-definition">카탈로그로 가져오기</button></div>
        </section>
      </section>

      <section class="panel log-panel">
        <div class="panel-heading"><div><span class="panel-kicker">EVENT LOG</span><h2>최근 이벤트</h2></div><span class="muted">최대 2,000개 보존 · 최신 80개 표시</span></div>
        <div class="log-list">${renderLogs()}</div>
      </section>
    </div>
  `;

  bindEvents();
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
      const labels = all.map((entity) => `${entity.display} ${entity.shortLabel}`).join(", ");
      cells.push(`
        <button class="grid-cell ${isSelected ? "selected" : ""} ${all.length > 1 ? "stacked" : ""}" data-x="${x}" data-y="${y}" aria-label="${escapeHtml(`(${x},${y}) ${labels || "empty"}`)}">
          <span class="coordinate">${x},${y}</span>
          <span class="cell-ground">${groundEntity ? escapeHtml(groundEntity.display) : ""}</span>
          <span class="cell-air">${airEntity ? escapeHtml(airEntity.display) : ""}</span>
          ${all.length > 1 ? `<span class="stack-count">+${all.length - 1}</span>` : ""}
        </button>
      `);
    }
  }
  return cells.join("");
}

function renderInspector(entity: EntityState | undefined): string {
  if (!entity) return `<div class="empty-state"><span class="empty-emoji">🧭</span><p>보드에서 개체가 있는 칸을 선택하세요.</p><small>빈 칸을 눌러 선택을 해제할 수도 있습니다.</small></div>`;

  const capacities = getEntityCapacities(world, entity);
  const modules = getEntityModules(world, entity);
  const capabilities = [...new Set([...entity.capabilities, ...modules.flatMap((module) => world.catalog.modules[module.definitionId]?.providedCapabilities ?? [])])];
  return `
    <div class="entity-hero"><span class="entity-emoji">${escapeHtml(entity.display)}</span><div><h3>${escapeHtml(entity.shortLabel)}</h3><p>${escapeHtml(entity.definitionId)} · ${entity.position.layer} layer</p></div><span class="state-chip ${entity.alive ? "alive" : "dead"}">${entity.alive ? "alive" : "debris"}</span></div>
    <div class="stat-grid">
      ${statCard("위치", `(${entity.position.x}, ${entity.position.y})`)}
      ${statCard("질량", `${entityMass(world, entity)} u`)}
      ${statCard("구조 / 식용", `${entity.structureMass} / ${entity.edibleMass}`)}
      ${statCard("무결성", `${entity.integrity} / ${entity.maxIntegrity}`)}
      ${statCard("열", `${entityHeat(world, entity)} / ${entityHeatCapacity(world, entity)}`)}
      ${statCard("온도 지수", formatNumber(entityTemperature(world, entity)))}
    </div>
    <div class="meter-block"><div class="meter-label"><span>stored energy</span><strong>${entity.energy.stored} / ${capacities.energy.stored}</strong></div><div class="meter"><span style="width:${barPercent(entity.energy.stored, capacities.energy.stored)}%"></span></div></div>
    <div class="ledger-block"><span class="subheading">질량 원장</span><p>${ledgerSummary(entity.inventory.mass)}</p><span class="subheading">에너지 원장</span><p>${ledgerSummary(entity.energy)}</p></div>
    <div class="capability-block"><span class="subheading">능력</span><div class="tag-list">${capabilities.length > 0 ? capabilities.map((capability) => `<span class="tag">${escapeHtml(capability)}</span>`).join("") : `<span class="muted">없음</span>`}</div></div>
    <div class="module-block"><div class="module-heading"><span class="subheading">장착 모듈 ${modules.length}</span><span class="muted">연결 ${activeConnections(world).filter((connection) => connection.from.entityId === entity.id || connection.to.entityId === entity.id).length}</span></div>${modules.length > 0 ? modules.map(renderModuleRow).join("") : `<p class="muted">장착된 모듈이 없습니다.</p>`}</div>
  `;
}

function renderModuleRow(module: WorldState["modules"][string]): string {
  const definition = world.catalog.modules[module.definitionId];
  const capacities = getModuleCapacities(world, module.id);
  return `
    <div class="module-row" data-module-row="${escapeHtml(module.id)}">
      <div class="module-title"><span>${escapeHtml(definition?.display ?? "◈")}</span><strong>${escapeHtml(definition?.shortLabel ?? module.definitionId)}</strong><code>${escapeHtml(module.id)}</code></div>
      <div class="module-meta"><span class="${module.integrity > 0 ? "good" : "bad"}">integrity ${module.integrity}</span><span>cooldown ${module.cooldown}</span><span>${ledgerSummary(module.energy)}</span></div>
      <div class="module-actions"><select data-resize-resource aria-label="resize resource">${MASS_RESOURCES.map((resource) => `<option value="${resource}">${resource}</option>`).join("")}</select><input data-resize-capacity type="number" min="0" step="1" value="${capacities.mass.raw ?? 0}" aria-label="new capacity" /><button class="mini-button" data-action="resize" data-module-id="${escapeHtml(module.id)}">축소</button><button class="mini-button danger" data-action="detach" data-module-id="${escapeHtml(module.id)}">분리</button></div>
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
    <label class="field"><span>대상 개체</span><select id="target-select"><option value="">대상 없음</option>${targetEntities.map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === targetValue ? "selected" : ""}>${escapeHtml(candidate.display)} ${escapeHtml(candidate.id)} · ${candidate.position.layer}</option>`).join("")}</select></label>
    <div class="intent-group"><span class="subheading">이동 / 층</span><div class="button-grid"><button class="mini-button" data-action="move-n" ${disabledAttr(disabled)}>↑</button><button class="mini-button" data-action="move-w" ${disabledAttr(disabled)}>←</button><button class="mini-button" data-action="move-e" ${disabledAttr(disabled)}>→</button><button class="mini-button" data-action="move-s" ${disabledAttr(disabled)}>↓</button><button class="mini-button" data-action="takeoff" ${disabledAttr(disabled)}>비행</button><button class="mini-button" data-action="land" ${disabledAttr(disabled)}>착륙</button></div></div>
    <div class="intent-group"><span class="subheading">상호작용</span><div class="button-grid wide"><button class="mini-button" data-action="consume" ${disabledAttr(disabled)}>섭취</button><button class="mini-button" data-action="attack" ${disabledAttr(disabled)}>공격</button><button class="mini-button" data-action="charge" ${disabledAttr(disabled)}>충전</button><button class="mini-button" data-action="discharge" ${disabledAttr(disabled)}>방출</button><button class="mini-button" data-action="process" ${disabledAttr(disabled)}>가공</button><button class="mini-button danger" data-action="deconstruct" ${disabledAttr(disabled)}>해체</button></div></div>
    <div class="intent-group composition-group"><span class="subheading">구성 변경</span><div class="composition-line"><select id="attach-definition" ${disabledAttr(disabled)}><option value="">새 모듈 선택</option>${attachable.map((module) => `<option value="${escapeHtml(module.semanticId)}">${escapeHtml(module.shortLabel)}</option>`).join("")}</select><button class="mini-button" data-action="attach" ${disabledAttr(disabled)}>장착</button></div>${detached.length > 0 ? `<div class="composition-line"><select id="reattach-module" ${disabledAttr(disabled)}><option value="">분리 모듈 재장착</option>${detached.map((module) => `<option value="${escapeHtml(module.id)}">${escapeHtml(module.id)} · ${escapeHtml(module.definitionId)}</option>`).join("")}</select><button class="mini-button" data-action="reattach" ${disabledAttr(disabled)}>복귀</button></div>` : ""}</div>
    <p class="hint">버튼은 즉시 상태를 바꾸지 않고 intent queue에 들어갑니다. 한 tick의 P2에서 후보 정렬·예약·원자 커밋을 거칩니다.</p>
  `;
}

function renderExternalControls(entity: EntityState | undefined): string {
  const ownerOptions = [
    ...Object.values(world.entities).sort(compareEntities).map((candidate) => `<option value="entity:${escapeHtml(candidate.id)}" ${candidate.id === entity?.id ? "selected" : ""}>entity · ${escapeHtml(candidate.id)}</option>`),
    ...Object.values(world.modules).sort((a, b) => a.id.localeCompare(b.id)).map((module) => `<option value="module:${escapeHtml(module.id)}">module · ${escapeHtml(module.id)}</option>`),
  ];
  return `
    <div class="external-block"><span class="subheading">외부 자원 주입</span><div class="form-row"><select id="external-owner">${ownerOptions.join("")}</select><select id="external-resource"><optgroup label="mass">${MASS_RESOURCES.map((resource) => `<option value="mass:${resource}">${resource}</option>`).join("")}</optgroup><optgroup label="energy">${ENERGY_RESOURCES.map((resource) => `<option value="energy:${resource}">${resource}</option>`).join("")}</optgroup></select><input id="external-amount" type="number" min="1" step="1" value="1" aria-label="injection amount" /><button class="mini-button" data-action="inject-resource">주입</button></div><input id="external-label" class="text-input" value="manual console input" aria-label="injection label" /></div>
    <div class="external-block"><span class="subheading">외부 개체 생성</span><div class="form-row"><select id="spawn-preset">${Object.values(world.catalog.presets).sort((a, b) => a.semanticId.localeCompare(b.semanticId)).map((preset) => `<option value="${escapeHtml(preset.semanticId)}">${escapeHtml(preset.display)} ${escapeHtml(preset.shortLabel)}</option>`).join("")}</select><select id="spawn-layer"><option value="ground">ground</option><option value="air">air</option></select><input id="spawn-x" type="number" min="0" max="15" step="1" value="1" aria-label="spawn x" /><input id="spawn-y" type="number" min="0" max="15" step="1" value="1" aria-label="spawn y" /><button class="mini-button" data-action="spawn">생성</button></div></div>
  `;
}

function renderLogs(): string {
  if (world.logs.length === 0) return `<div class="empty-log">아직 로그가 없습니다. Step을 실행하거나 외부 입력을 큐에 넣으세요.</div>`;
  return world.logs.slice(-80).reverse().map((event) => `
    <article class="log-entry ${event.outcome}">
      <div class="log-time">t${event.tick}<br>${event.phase}</div>
      <div class="log-body"><div class="log-title"><strong>${escapeHtml(event.ruleId)}</strong><span class="outcome ${event.outcome}">${event.outcome}</span></div><p>${escapeHtml(event.message)}${event.reason ? ` <span class="reason">${escapeHtml(event.reason)}</span>` : ""}</p></div>
      <div class="log-actors">${event.actorId ? escapeHtml(event.actorId) : "system"}${event.targetId ? ` → ${escapeHtml(event.targetId)}` : ""}</div>
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
      setNotice(selectedEntityId ? `${selectedEntityId} 선택` : `(${x}, ${y}) 빈 칸`, "info");
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
    if (!entity || !moduleId) return setNotice("먼저 개체와 모듈을 선택하세요.", "error");
    if (action === "detach") return sendIntent({ type: "detach-module", actorId: entity.id, moduleId });
    const row = button.closest<HTMLElement>(".module-row");
    const resource = row?.querySelector<HTMLSelectElement>("[data-resize-resource]")?.value as MassResource | undefined;
    const newCapacity = Number(row?.querySelector<HTMLInputElement>("[data-resize-capacity]")?.value);
    if (!resource || !Number.isSafeInteger(newCapacity) || newCapacity < 0) return setNotice("축소 용량은 0 이상의 정수여야 합니다.", "error");
    return sendIntent({ type: "resize-module", actorId: entity.id, moduleId, resource, newCapacity });
  }
  if (action === "attach" || action === "reattach") {
    const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
    if (!entity) return setNotice("먼저 개체를 선택하세요.", "error");
    if (action === "attach") {
      const moduleDefinitionId = app.querySelector<HTMLSelectElement>("#attach-definition")?.value;
      if (!moduleDefinitionId) return setNotice("장착할 모듈을 선택하세요.", "error");
      return sendIntent({ type: "attach-module", actorId: entity.id, moduleDefinitionId });
    }
    const moduleId = app.querySelector<HTMLSelectElement>("#reattach-module")?.value;
    const module = moduleId ? world.modules[moduleId] : undefined;
    if (!module) return setNotice("재장착할 분리 모듈을 선택하세요.", "error");
    return sendIntent({ type: "attach-module", actorId: entity.id, moduleDefinitionId: module.definitionId, moduleId: module.id });
  }

  const intent = intentForAction(action);
  if (intent) sendIntent(intent);
}

function intentForAction(action: string | undefined): Intent | undefined {
  const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  if (!entity) {
    setNotice("먼저 개체를 선택하세요.", "error");
    return undefined;
  }
  const targetId = currentTargetId();
  if (["consume", "attack", "discharge"].includes(action ?? "") && !targetId) {
    setNotice("대상 개체를 선택하세요.", "error");
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
  if (result.ok) setNotice(`${intent.type} intent를 queue에 넣었습니다. 다음 Step에서 P2로 처리됩니다.`, "success");
  else setNotice(`intent 거부: ${result.error}`, "error");
  render();
}

function runStep(): void {
  try {
    const report = step(world);
    const phaseText = report.phases.map((phase) => `${phase.phase} ${phase.accepted}/${phase.candidateCount}`).join(" · ");
    setNotice(`tick ${report.tick} 완료 · ${phaseText}`, "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "step 실행에 실패했습니다.", "error");
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
    setNotice(`외부 ${resource} ${amount} 단위를 P0 입력 큐에 넣었습니다.`, "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "외부 입력을 큐에 넣지 못했습니다.", "error");
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
    return;
  }
  try {
    queueExternalSpawn(world, { presetId, position: { x, y, layer } });
    setNotice(`${presetId} 외부 생성 요청을 P0 입력 큐에 넣었습니다.`, "success");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "외부 생성 요청에 실패했습니다.", "error");
  }
  render();
}

function exportSelectedDefinition(): void {
  const entity = selectedEntityId ? world.entities[selectedEntityId] : undefined;
  if (!entity) return setNotice("내보낼 개체를 선택하세요.", "error");
  const result = world.catalog.machines[entity.definitionId]
    ? exportMachineDefinition(world, entity.id)
    : exportCreatureDefinition(world, entity.id);
  if (result.ok && result.value !== undefined) {
    definitionText = result.value;
    setNotice(`${entity.id} 정의를 JSON으로 내보냈습니다.`, "success");
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function disabledAttr(disabled: boolean): string {
  return disabled ? "disabled" : "";
}

function isScenarioId(value: string): value is ScenarioId {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E";
}
