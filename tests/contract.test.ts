import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG,
  addFixtureConnection,
  balanceReport,
  createCreatureVariant,
  createEntityFromPreset,
  createMachineFromBlueprint,
  createWorld,
  entityMass,
  exportCreatureDefinition,
  finalizeFixture,
  getEntityCapacities,
  getEntityModules,
  getModuleCapacities,
  importDefinition,
  queueExternalSpawn,
  setFixtureBodyState,
  setFixtureModuleState,
  setFixtureResource,
  stateHash,
  step,
  submitIntent,
  totalEnergy,
  totalMass,
  type EntityState,
  type MachineBlueprint,
  type Position,
  type WorldState,
} from "../src";

function finish(world: WorldState): WorldState {
  finalizeFixture(world);
  return world;
}

function moduleByDefinition(world: WorldState, entityId: string, definitionId: string): string {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`missing entity ${entityId}`);
  const module = getEntityModules(world, entity).find((candidate) => candidate.definitionId === definitionId);
  if (!module) throw new Error(`missing module ${definitionId}`);
  return module.id;
}

function eventsFor(world: WorldState, ruleId: string, outcome?: "accepted" | "failed" | "external" | "system") {
  return world.logs.filter((event) => event.ruleId === ruleId && (!outcome || event.outcome === outcome));
}

function createElectricRabbitWithCrate(): { world: WorldState; rabbit: EntityState; batteryId: string; crate: EntityState } {
  const world = createWorld({ config: { seed: 700 } });
  const rabbit = createCreatureVariant(world, "herbivore", ["electric_storage"], { x: 4, y: 4, layer: "ground" }, { id: "rabbit-electric", semanticId: "electric_rabbit_fixture", displayOverride: "🔋" });
  const crate = createEntityFromPreset(world, "fuel_crate", { x: 5, y: 4, layer: "ground" }, { id: "fuel-target" });
  const batteryId = moduleByDefinition(world, rabbit.id, "electric_storage");
  return { world, rabbit, batteryId, crate };
}

function addDoubleProcessorBlueprint(world: WorldState): string {
  const base = world.catalog.machines.recycler;
  const blueprint: MachineBlueprint = {
    ...base,
    semanticId: "double_recycler_fixture",
    display: "📦⚙️⚙️",
    shortLabel: "이중 가공기",
    modules: [
      { alias: "storage", definitionId: "storage_bin" },
      { alias: "processor-a", definitionId: "processor" },
      { alias: "processor-b", definitionId: "processor" },
    ],
    connections: [
      ...["processor-a", "processor-b"].flatMap((alias) => [
        { id: `${alias}-raw`, from: { alias: "storage", portId: "raw-out" }, to: { alias, portId: "raw-in" }, kind: "mass" as const, rate: 1 },
        { id: `${alias}-product`, from: { alias, portId: "product-out" }, to: { alias: "storage", portId: "product-in" }, kind: "mass" as const, rate: 1 },
        { id: `${alias}-energy`, from: { alias: "storage", portId: "energy-out" }, to: { alias, portId: "energy-in" }, kind: "energy" as const, rate: 1 },
        { id: `${alias}-heat`, from: { alias, portId: "heat-out" }, to: { alias: "storage", portId: "heat-in" }, kind: "heat" as const, rate: 1 },
      ]),
    ],
  };
  world.catalog.machines[blueprint.semanticId] = blueprint;
  return blueprint.semanticId;
}

describe("A-E 통합 시나리오", () => {
  it("A: 성장 → 초식 → 포식은 공통 규칙 로그로 실행된다", () => {
    const growthWorld = createWorld({ config: { seed: 101 } });
    const plant = createEntityFromPreset(growthWorld, "plant", { x: 3, y: 3, layer: "ground" }, { id: "plant-a" });
    const herbivore = createEntityFromPreset(growthWorld, "herbivore", { x: 4, y: 3, layer: "ground" }, { id: "herb-a" });
    const massBefore = plant.structureMass;
    finish(growthWorld);
    step(growthWorld);
    expect(plant.structureMass).toBeGreaterThan(massBefore);
    expect(herbivore.inventory.mass.food).toBe(1);
    expect(eventsFor(growthWorld, "metabolism.growth", "accepted").length).toBeGreaterThan(0);
    expect(eventsFor(growthWorld, "metabolism.consume", "accepted").length).toBe(1);

    const huntingWorld = createWorld({ config: { seed: 102 } });
    const prey = createEntityFromPreset(huntingWorld, "herbivore", { x: 5, y: 5, layer: "ground" }, { id: "prey-a" });
    const predator = createEntityFromPreset(huntingWorld, "predator", { x: 6, y: 5, layer: "ground" }, { id: "predator-a" });
    setFixtureResource(huntingWorld, prey.id, "entity", "stored", 12);
    setFixtureResource(huntingWorld, predator.id, "entity", "stored", 12);
    finish(huntingWorld);
    for (let index = 0; index < 3; index += 1) {
      expect(submitIntent(huntingWorld, { type: "attack", actorId: predator.id, targetId: prey.id }).ok).toBe(true);
      step(huntingWorld);
    }
    expect(prey.alive).toBe(false);
    const foodBefore = predator.inventory.mass.food;
    step(huntingWorld);
    expect(predator.inventory.mass.food).toBeGreaterThan(foodBefore);
    expect(eventsFor(huntingWorld, "interaction.work-damage", "accepted").length).toBe(3);
    expect(eventsFor(huntingWorld, "metabolism.consume", "accepted").length).toBeGreaterThan(0);
  });

  it("B: 날개 조합은 질량·유지비를 포함한 기존 이동기로 비행한다", () => {
    const world = createWorld({ config: { seed: 201 } });
    const rabbit = createCreatureVariant(world, "herbivore", ["wing_lift"], { x: 2, y: 2, layer: "ground" }, { id: "wing-rabbit", semanticId: "wing_rabbit" });
    setFixtureResource(world, rabbit.id, "entity", "stored", 5);
    finish(world);
    const mass = entityMass(world, rabbit);
    expect(mass).toBeLessThanOrEqual(12);
    expect(submitIntent(world, { type: "move", actorId: rabbit.id, dx: 0, dy: 0, toLayer: "air" }).ok).toBe(true);
    step(world);
    expect(rabbit.position.layer).toBe("air");
    expect(eventsFor(world, "movement.orthogonal", "accepted").length).toBe(1);
    step(world);
    expect(rabbit.position.layer).toBe("ground");
    expect(eventsFor(world, "movement.air-maintenance", "accepted").length).toBeGreaterThan(0);

    const disabled = createWorld({ config: { seed: 202 } });
    const disabledRabbit = createCreatureVariant(disabled, "herbivore", ["wing_lift"], { x: 2, y: 2, layer: "ground" }, { id: "disabled-wing", semanticId: "disabled_wing" });
    const wingId = moduleByDefinition(disabled, disabledRabbit.id, "wing_lift");
    setFixtureModuleState(disabled, wingId, { integrity: 0 });
    finish(disabled);
    submitIntent(disabled, { type: "move", actorId: disabledRabbit.id, dx: 0, dy: 0, toLayer: "air" });
    step(disabled);
    expect(disabledRabbit.position.layer).toBe("ground");
    expect(eventsFor(disabled, "movement.orthogonal", "failed").length).toBeGreaterThan(0);
  });

  it("C: 충전·방출은 전하·열 수지를 보존하고 빈 전하는 실패한다", () => {
    const { world, rabbit, batteryId, crate } = createElectricRabbitWithCrate();
    setFixtureResource(world, rabbit.id, "entity", "stored", 8);
    finish(world);
    const before = totalEnergy(world);
    submitIntent(world, { type: "charge", actorId: rabbit.id });
    step(world);
    expect(world.modules[batteryId].energy.charge).toBe(3);
    expect(totalEnergy(world)).toBe(before);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    expect(world.modules[batteryId].energy.charge).toBe(0);
    expect(crate.energy.heat).toBe(3);
    expect(eventsFor(world, "electric.discharge", "accepted").length).toBe(1);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    expect(eventsFor(world, "electric.discharge", "failed").length).toBeGreaterThan(0);
  });

  it("D: 전기 → 가열 → 다음 P1 발화 → 연소는 기계와 생물에서 같은 법칙이다", () => {
    const { world, rabbit, batteryId, crate } = createElectricRabbitWithCrate();
    setFixtureResource(world, rabbit.id, "entity", "stored", 4);
    setFixtureResource(world, batteryId, "module", "charge", 6);
    finish(world);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    expect(crate.energy.heat).toBe(3);
    expect(eventsFor(world, "physics.combustion", "accepted").length).toBe(0);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    expect(crate.energy.heat).toBe(6);
    expect(eventsFor(world, "physics.combustion", "accepted").length).toBe(0);
    const fuelBefore = crate.inventory.mass.fuel;
    step(world);
    expect(crate.inventory.mass.fuel).toBe(fuelBefore - 1);
    expect(eventsFor(world, "physics.combustion", "accepted").length).toBe(1);

    const machineWorld = createWorld({ config: { seed: 704 } });
    const blueprint = machineWorld.catalog.machines.recycler;
    machineWorld.catalog.machines.electric_recycler = {
      ...blueprint,
      semanticId: "electric_recycler",
      display: "📦⚙️⚡",
      modules: [...blueprint.modules, { alias: "battery", definitionId: "electric_storage" }],
    };
    const machine = createMachineFromBlueprint(machineWorld, "electric_recycler", { x: 4, y: 4, layer: "ground" }, { id: "electric-machine" });
    const machineBattery = moduleByDefinition(machineWorld, machine.id, "electric_storage");
    const machineCrate = createEntityFromPreset(machineWorld, "fuel_crate", { x: 5, y: 4, layer: "ground" }, { id: "machine-fuel" });
    setFixtureResource(machineWorld, machineBattery, "module", "charge", 3);
    finish(machineWorld);
    submitIntent(machineWorld, { type: "discharge", actorId: machine.id, targetId: machineCrate.id });
    step(machineWorld);
    expect(eventsFor(machineWorld, "electric.discharge", "accepted").length).toBe(1);
    expect(machineCrate.energy.heat).toBe(3);
    expect(eventsFor(machineWorld, "physics.combustion", "accepted").length).toBe(0);
  });

  it("E: 저장소·기존 변환·연결만으로 새 기계가 작동한다", () => {
    const world = createWorld({ config: { seed: 801 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 9, y: 9, layer: "ground" }, { id: "recycler-e" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    setFixtureResource(world, storageId, "module", "raw", 2);
    finish(world);
    const beforeMass = totalMass(world);
    const beforeEnergy = totalEnergy(world);
    step(world);
    step(world);
    expect(world.modules[storageId].inventory.mass.raw).toBe(0);
    expect(world.modules[storageId].inventory.mass.product).toBe(2);
    expect(totalMass(world)).toBe(beforeMass);
    expect(totalEnergy(world)).toBe(beforeEnergy);
    expect(eventsFor(world, "machine.existing-conversion", "accepted").length).toBe(2);
  });
});

describe("경계 계약 T01-T20", () => {
  it("T01: 마지막 불가분 음식은 하나의 요청만 승인한다", () => {
    const world = createWorld({ config: { seed: 1 } });
    const plant = createEntityFromPreset(world, "plant", { x: 4, y: 4, layer: "ground" }, { id: "last-food" });
    setFixtureBodyState(world, plant.id, { structureMass: 1, maxStructureMass: 1, edibleMass: 1 });
    setFixtureResource(world, plant.id, "entity", "water", 0);
    setFixtureResource(world, plant.id, "entity", "nutrient", 0);
    const first = createEntityFromPreset(world, "herbivore", { x: 3, y: 4, layer: "ground" }, { id: "food-seeker-a" });
    const second = createEntityFromPreset(world, "herbivore", { x: 5, y: 4, layer: "ground" }, { id: "food-seeker-b" });
    finish(world);
    const before = totalMass(world);
    step(world);
    expect([first.inventory.mass.food, second.inventory.mass.food].filter((amount) => amount === 1)).toHaveLength(1);
    expect(plant.edibleMass).toBe(0);
    expect(totalMass(world)).toBe(before);
  });

  it("T02: 두 가공기가 마지막 원료를 중복 소비하지 않는다", () => {
    const world = createWorld({ config: { seed: 2 } });
    const blueprintId = addDoubleProcessorBlueprint(world);
    const machine = createMachineFromBlueprint(world, blueprintId, { x: 2, y: 2, layer: "ground" }, { id: "double-machine" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    setFixtureResource(world, storageId, "module", "raw", 1);
    finish(world);
    step(world);
    expect(world.modules[storageId].inventory.mass.raw).toBe(0);
    expect(world.modules[storageId].inventory.mass.product).toBe(1);
    expect(eventsFor(world, "machine.existing-conversion", "failed").length).toBeGreaterThan(0);
  });

  it("T03: 서로의 치명상은 두 공격 모두 합산된다", () => {
    const world = createWorld({ config: { seed: 3 } });
    const left = createEntityFromPreset(world, "fragile_predator", { x: 4, y: 4, layer: "ground" }, { id: "duelist-left" });
    const right = createEntityFromPreset(world, "fragile_predator", { x: 5, y: 4, layer: "ground" }, { id: "duelist-right" });
    finish(world);
    submitIntent(world, { type: "attack", actorId: left.id, targetId: right.id });
    submitIntent(world, { type: "attack", actorId: right.id, targetId: left.id });
    step(world);
    expect(left.alive).toBe(false);
    expect(right.alive).toBe(false);
    expect(eventsFor(world, "interaction.work-damage", "accepted")).toHaveLength(2);
  });

  it("T04: P1 사망 개체의 P2 명령은 이동·섭식을 만들지 않는다", () => {
    const world = createWorld({ config: { seed: 4 } });
    const actor = createEntityFromPreset(world, "fragile_predator", { x: 4, y: 4, layer: "ground" }, { id: "p1-dead" });
    setFixtureResource(world, actor.id, "entity", "stored", 0);
    finish(world);
    submitIntent(world, { type: "move", actorId: actor.id, dx: 1, dy: 0 });
    step(world);
    expect(actor.alive).toBe(false);
    expect(actor.position.x).toBe(4);
    expect(eventsFor(world, "movement.orthogonal", "failed").length).toBeGreaterThan(0);
  });

  it("T05: I=1에 피해 2를 적용하면 0으로 포화한다", () => {
    const world = createWorld({ config: { seed: 5 } });
    const prey = createEntityFromPreset(world, "fragile_prey", { x: 4, y: 4, layer: "ground" }, { id: "integrity-one" });
    const predator = createEntityFromPreset(world, "predator", { x: 5, y: 4, layer: "ground" }, { id: "damage-two" });
    finish(world);
    submitIntent(world, { type: "attack", actorId: predator.id, targetId: prey.id });
    step(world);
    expect(prey.integrity).toBe(0);
    expect(prey.alive).toBe(false);
    expect(eventsFor(world, "interaction.damage-aggregate", "system")[0]?.inputs.damage).toBe(2);
  });

  it("T06: integrity 0 잔해도 남은 연료를 태운다", () => {
    const world = createWorld({ config: { seed: 6 } });
    const crate = createEntityFromPreset(world, "fuel_crate", { x: 4, y: 4, layer: "ground" }, { id: "burning-debris" });
    setFixtureResource(world, crate.id, "entity", "heat", 4);
    finish(world);
    step(world);
    step(world);
    expect(crate.alive).toBe(false);
    const fuelAfterDeath = crate.inventory.mass.fuel;
    step(world);
    expect(crate.inventory.mass.fuel).toBe(fuelAfterDeath - 1);
  });

  it("T07: 유지비 결핍은 정해진 손상과 사망으로 이어진다", () => {
    const world = createWorld({ config: { seed: 7 } });
    const hungry = createEntityFromPreset(world, "herbivore", { x: 4, y: 4, layer: "ground" }, { id: "hungry" });
    setFixtureResource(world, hungry.id, "entity", "stored", 0);
    finish(world);
    for (let index = 0; index < 8 && hungry.alive; index += 1) step(world);
    expect(hungry.alive).toBe(false);
    expect(eventsFor(world, "survival.maintenance-deficiency", "accepted").length).toBeGreaterThan(0);
  });

  it("T08: 봉인 후 직접 생성·자원 쓰기는 거부된다", () => {
    const world = createWorld({ config: { seed: 8 } });
    finish(world);
    expect(() => createEntityFromPreset(world, "plant", { x: 1, y: 1, layer: "ground" })).toThrow();
    expect(() => setFixtureResource(world, "missing", "entity", "water", 1)).toThrow();
  });

  it("T09: 외부 주입을 제외한 생성·해체 반복은 자원을 만들지 않는다", () => {
    const world = createWorld({ config: { seed: 9 } });
    finish(world);
    const baselineMass = totalMass(world);
    queueExternalSpawn(world, { presetId: "fragile_prey", position: { x: 1, y: 1, layer: "ground" } });
    step(world);
    const spawned = Object.values(world.entities)[0];
    expect(spawned).toBeDefined();
    submitIntent(world, { type: "deconstruct", actorId: spawned.id });
    step(world);
    expect(spawned.state).toBe("debris");
    expect(totalMass(world) - Object.values(world.externalLedger.massIn).reduce((sum, amount) => sum + amount, 0)).toBe(baselineMass);
  });

  it("T10: 손상·재고·cooldown 모듈은 분리 후 재연결 시 상태를 보존한다", () => {
    const world = createWorld({ config: { seed: 10 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 2, y: 2, layer: "ground" }, { id: "module-state" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    const processorId = moduleByDefinition(world, machine.id, "processor");
    setFixtureResource(world, storageId, "module", "raw", 2);
    setFixtureModuleState(world, storageId, { integrity: 1, cooldown: 4 });
    setFixtureModuleState(world, processorId, { integrity: 0 });
    finish(world);
    submitIntent(world, { type: "detach-module", actorId: machine.id, moduleId: storageId });
    step(world);
    expect(world.modules[storageId].ownerEntityId).toBeUndefined();
    expect(world.modules[storageId].inventory.mass.raw).toBe(2);
    submitIntent(world, { type: "attach-module", actorId: machine.id, moduleDefinitionId: "storage_bin", moduleId: storageId });
    step(world);
    expect(world.modules[storageId].ownerEntityId).toBe(machine.id);
    expect(world.modules[storageId].integrity).toBe(1);
    expect(world.modules[storageId].cooldown).toBe(4);
    expect(world.modules[storageId].inventory.mass.raw).toBe(2);
  });

  it("T11: 초과 재고를 옮길 수 없는 용량 축소는 전체 거부된다", () => {
    const world = createWorld({ config: { seed: 11 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 2, y: 2, layer: "ground" }, { id: "capacity-state" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    const processorId = moduleByDefinition(world, machine.id, "processor");
    setFixtureResource(world, storageId, "module", "raw", 2);
    setFixtureModuleState(world, processorId, { integrity: 0 });
    finish(world);
    const before = getModuleCapacities(world, storageId).mass.raw;
    submitIntent(world, { type: "resize-module", actorId: machine.id, moduleId: storageId, resource: "raw", newCapacity: 1 });
    step(world);
    expect(getModuleCapacities(world, storageId).mass.raw).toBe(before);
    expect(world.modules[storageId].inventory.mass.raw).toBe(2);
    expect(eventsFor(world, "composition.resize-capacity", "failed").length).toBeGreaterThan(0);
  });

  it("T12: 같은 seed·초기 상태·Intent 로그는 매 step 같은 hash를 만든다", () => {
    const run = () => {
      const world = createWorld({ config: { seed: 12 } });
      const actor = createEntityFromPreset(world, "herbivore", { x: 2, y: 2, layer: "ground" }, { id: "deterministic-actor" });
      finish(world);
      submitIntent(world, { type: "move", actorId: actor.id, dx: 1, dy: 0 });
      const hashes = [stateHash(world)];
      step(world);
      hashes.push(stateHash(world));
      step(world);
      hashes.push(stateHash(world));
      return hashes;
    };
    expect(run()).toEqual(run());
  });

  it("T13: entity collection 삽입 순서가 결과를 바꾸지 않는다", () => {
    const run = (reverse: boolean) => {
      const world = createWorld({ config: { seed: 13 } });
      const definitions: Array<[string, Position]> = [
        ["ordered-a", { x: 2, y: 2, layer: "ground" }],
        ["ordered-b", { x: 3, y: 2, layer: "ground" }],
      ];
      for (const [id, position] of (reverse ? [...definitions].reverse() : definitions)) createEntityFromPreset(world, "herbivore", position, { id });
      finish(world);
      submitIntent(world, { type: "move", actorId: "ordered-a", dx: 1, dy: 0 });
      step(world);
      return stateHash(world);
    };
    expect(run(false)).toBe(run(true));
  });

  it("T14: 표시값·프리셋 ID 변경은 같은 물리 결과를 유지한다", () => {
    const run = (renamed: boolean) => {
      const world = createWorld({ config: { seed: 14 } });
      if (renamed) world.catalog.presets.renamed_plant = { ...world.catalog.presets.plant, semanticId: "renamed_plant", display: "🌳", shortLabel: "다른 표시" };
      createEntityFromPreset(world, renamed ? "renamed_plant" : "plant", { x: 2, y: 2, layer: "ground" }, { id: "same-physical-id" });
      finish(world);
      step(world);
      return stateHash(world);
    };
    expect(run(false)).toBe(run(true));
  });

  it("T15: 닫힌 기존 변환은 수지 순증가·step 내 무한 반복이 없다", () => {
    const world = createWorld({ config: { seed: 15 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 2, y: 2, layer: "ground" }, { id: "closed-loop" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    setFixtureResource(world, storageId, "module", "raw", 2);
    finish(world);
    const mass = totalMass(world);
    const energy = totalEnergy(world);
    for (let index = 0; index < 10; index += 1) step(world);
    expect(totalMass(world)).toBe(mass);
    expect(totalEnergy(world)).toBe(energy);
    expect(world.modules[storageId].inventory.mass.product).toBe(2);
  });

  it("T16: 과도한 외부 생성 요청은 상한에서 유한하게 종료된다", () => {
    const world = createWorld({ config: { seed: 16, maxCandidatesPerPhase: 3, maxEntities: 100 } });
    finish(world);
    for (let index = 0; index < 20; index += 1) queueExternalSpawn(world, { presetId: "fragile_prey", position: { x: index % 16, y: Math.floor(index / 16), layer: "ground" } });
    const report = step(world);
    expect(report.phases[0].candidateCount).toBe(20);
    expect(report.phases[0].accepted).toBe(3);
    expect(Object.keys(world.entities)).toHaveLength(3);
    expect(report.phases[0].rejected).toBe(17);
  });

  it("T17: P2 전기 가열은 같은 P2에서 연소를 재귀 실행하지 않는다", () => {
    const { world, rabbit, batteryId, crate } = createElectricRabbitWithCrate();
    setFixtureResource(world, rabbit.id, "entity", "stored", 4);
    setFixtureResource(world, batteryId, "module", "charge", 6);
    finish(world);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    submitIntent(world, { type: "discharge", actorId: rabbit.id, targetId: crate.id });
    step(world);
    expect(crate.energy.heat).toBe(6);
    expect(eventsFor(world, "physics.combustion", "accepted")).toHaveLength(0);
    step(world);
    expect(eventsFor(world, "physics.combustion", "accepted").length).toBe(1);
  });

  it("T18: 같은 phase 해체와 사용은 배타 충돌로 하나만 승인되고 참조가 남지 않는다", () => {
    const world = createWorld({ config: { seed: 18 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 2, y: 2, layer: "ground" }, { id: "conflict-machine" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    setFixtureResource(world, storageId, "module", "raw", 2);
    finish(world);
    submitIntent(world, { type: "process", actorId: machine.id });
    submitIntent(world, { type: "detach-module", actorId: machine.id, moduleId: storageId });
    step(world);
    const detached = world.modules[storageId].ownerEntityId === undefined;
    expect(detached || world.modules[storageId].ownerEntityId === machine.id).toBe(true);
    expect(Object.values(world.connections).every((connection) => world.modules[connection.from.moduleId] && world.modules[connection.to.moduleId])).toBe(true);
    expect(eventsFor(world, "composition.detach", "failed").length + eventsFor(world, "machine.existing-conversion", "failed").length).toBeGreaterThan(0);
  });

  it("T19: 과중량·무에너지 비행과 반복 이동은 유한한 실패가 된다", () => {
    const world = createWorld({ config: { seed: 19 } });
    const heavy = createCreatureVariant(world, "herbivore", ["wing_lift", "storage_bin", "processor", "processor"], { x: 2, y: 2, layer: "ground" }, { id: "heavy-flyer", semanticId: "heavy_flyer" });
    setFixtureResource(world, heavy.id, "entity", "stored", 0);
    finish(world);
    for (let index = 0; index < 5; index += 1) {
      submitIntent(world, { type: "move", actorId: heavy.id, dx: 0, dy: 0, toLayer: "air" });
      step(world);
    }
    expect(heavy.position.layer).toBe("ground");
    expect(eventsFor(world, "movement.orthogonal", "failed").length).toBeGreaterThan(0);
  });

  it("T20: 임의 함수·외부원·모르는 템플릿은 import 검증에서 거부된다", () => {
    const world = createWorld({ config: { seed: 20 } });
    const validWorld = createWorld({ config: { seed: 21 } });
    const creature = createEntityFromPreset(validWorld, "herbivore", { x: 1, y: 1, layer: "ground" }, { id: "exportable" });
    const exported = exportCreatureDefinition(validWorld, creature.id);
    expect(exported.ok).toBe(true);
    expect(importDefinition(world, exported.value ?? "").ok).toBe(true);
    const unknownTemplate = JSON.stringify({
      version: 1,
      kind: "creature",
      preset: { ...world.catalog.presets.herbivore, semanticId: "bad_template" },
      modules: [{ ...world.catalog.modules.ground_locomotion, semanticId: "bad_module", referencedActionOrConversionTemplateIds: ["unknown_external_source"] }],
    });
    expect(importDefinition(world, unknownTemplate).ok).toBe(false);
    const externalField = JSON.stringify({ version: 1, kind: "creature", preset: world.catalog.presets.herbivore, modules: [], externalSource: "infinite" });
    expect(importDefinition(world, externalField).ok).toBe(false);
  });
});

describe("기본 검증", () => {
  it("초기 fixture의 장부는 봉인 시점부터 균형이다", () => {
    const world = createWorld({ catalog: DEFAULT_CATALOG });
    createEntityFromPreset(world, "plant", { x: 1, y: 1, layer: "ground" }, { id: "balance-plant" });
    finish(world);
    expect(balanceReport(world).massDelta).toBe(0);
    expect(balanceReport(world).energyDelta).toBe(0);
    expect(getEntityCapacities(world, world.entities["balance-plant"])).toBeDefined();
  });

  it("잘못된 포트 연결은 설치 전에 거부된다", () => {
    const world = createWorld({ config: { seed: 22 } });
    const machine = createMachineFromBlueprint(world, "recycler", { x: 1, y: 1, layer: "ground" }, { id: "bad-port-machine" });
    const storageId = moduleByDefinition(world, machine.id, "storage_bin");
    const processorId = moduleByDefinition(world, machine.id, "processor");
    expect(() => addFixtureConnection(world, {
      id: "bad-connection",
      from: { entityId: machine.id, moduleId: storageId, portId: "raw-out" },
      to: { entityId: machine.id, moduleId: processorId, portId: "energy-in" },
      kind: "mass",
      rate: 1,
      enabled: true,
    })).toThrow();
  });
});
