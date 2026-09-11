import {
  activeConnections,
  connectionTouchesModule,
  entityMass,
  entityHeat,
  getEntityCapacities,
  getEntityModules,
  getModuleCapacities,
  hasCapability,
  isAdjacent,
  isSameCell,
} from "./accessors";
import { cloneWorld, replaceWorld, stableHash, stateHash } from "./determinism";
import {
  addEnergy,
  addMass,
  assertLedger,
  assertWorldBalance,
  canAffordEnergy,
  energyTotals,
  isSafeAmount,
  massTotals,
  subtractEnergy,
  subtractMass,
  sumMass,
} from "./ledger";
import { buildPhaseCandidates } from "../rules/rules";
import {
  attachModuleForTransaction,
  instantiatePresetForTransaction,
} from "./world";
import { validateEntityConfiguration, validateIntent, validatePosition } from "./validation";
import {
  ENERGY_RESOURCES,
  MASS_RESOURCES,
  type Candidate,
  type Connection,
  type ConversionTemplate,
  type EnergyResource,
  type EntityState,
  type Intent,
  type MassResource,
  type Operation,
  type Phase,
  type PortRef,
  type ResourceClaim,
  type SimulationEvent,
  type StepReport,
  type WorldState,
} from "./types";

const PHASE_ORDER: Phase[] = ["P0", "P1", "P2"];

export function submitIntent(world: WorldState, intent: Intent): { ok: true } | { ok: false; error: string } {
  const errors = validateIntent(intent, world);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  if (world.pendingIntents.length >= world.config.maxPendingIntents) return { ok: false, error: "intent queue limit reached" };
  world.pendingIntents.push(JSON.parse(JSON.stringify(intent)) as Intent);
  return { ok: true };
}

export function step(world: WorldState): StepReport {
  if (world.fixtureOpen) throw new Error("finalize the initial fixture before stepping");
  world.started = true;
  const tick = world.tick;
  const phaseReports: StepReport["phases"] = [];
  let accepted = 0;
  let rejected = 0;
  for (const phase of PHASE_ORDER) {
    world.phase = phase;
    const phaseStart = cloneWorld(world);
    const candidates = buildPhaseCandidates(world, phase);
    const result = resolvePhase(world, phaseStart, candidates, phase);
    phaseReports.push({ phase, candidateCount: candidates.length, accepted: result.accepted, rejected: result.rejected });
    accepted += result.accepted;
    rejected += result.rejected;
  }
  world.tick += 1;
  world.phase = "P0";
  world.stateHash = stateHash(world);
  return { tick, phases: phaseReports, accepted, rejected, stateHash: world.stateHash };
}

export interface ResolveResult {
  accepted: number;
  rejected: number;
}

export function resolvePhase(world: WorldState, phaseStart: WorldState, candidates: Candidate[], phase: Phase): ResolveResult {
  const unique = deduplicateCandidates(candidates);
  const sorted = unique.sort((left, right) => compareCandidates(world, left, right));
  const limited = sorted.slice(0, world.config.maxCandidatesPerPhase);
  const acceptedCandidates: Candidate[] = [];
  const claimed = new Map<string, number>();
  const slots = new Set<string>();
  const writes = new Map<string, boolean>();
  let reservedEntities = 0;
  let reservedModules = 0;
  let rejected = candidates.length - limited.length;

  for (const candidate of sorted.slice(world.config.maxCandidatesPerPhase)) {
    appendFailure(world, candidate, "phase candidate limit reached");
  }
  for (const candidate of limited) {
    const preflightError = preflightOperation(phaseStart, candidate.operation, phase);
    if (preflightError) {
      rejected += 1;
      appendFailure(world, candidate, preflightError);
      continue;
    }
    const claimError = reserveClaims(phaseStart, candidate.claims, claimed);
    if (claimError) {
      rejected += 1;
      appendFailure(world, candidate, claimError);
      continue;
    }
    const slotKey = candidate.exclusiveSlot;
    if (slotKey && slots.has(slotKey)) {
      rejected += 1;
      appendFailure(world, candidate, `exclusive action slot already reserved: ${slotKey}`);
      continue;
    }
    const writeError = reserveWrites(candidate, writes);
    if (writeError) {
      rejected += 1;
      appendFailure(world, candidate, writeError);
      continue;
    }
    if (candidate.operation.kind === "spawn") {
      if (Object.keys(phaseStart.entities).length + reservedEntities >= world.config.maxEntities) {
        rejected += 1;
        appendFailure(world, candidate, "entity limit reached");
        continue;
      }
      reservedEntities += 1;
    }
    if (candidate.operation.kind === "attach-module" && !candidate.operation.moduleId) {
      if (Object.keys(phaseStart.modules).length + reservedModules >= world.config.maxModules) {
        rejected += 1;
        appendFailure(world, candidate, "module limit reached");
        continue;
      }
      reservedModules += 1;
    }
    if (slotKey) slots.add(slotKey);
    acceptedCandidates.push(candidate);
  }

  const draft = cloneWorld(world);
  const details = new Map<string, ApplyDetails>();
  const damageByTarget = new Map<string, number>();
  try {
    for (const candidate of acceptedCandidates) {
      if (candidate.operation.kind === "attack") {
        const detail = applyOperation(draft, candidate.operation, phase);
        details.set(candidate.key, detail);
        damageByTarget.set(
          candidate.operation.targetId,
          (damageByTarget.get(candidate.operation.targetId) ?? 0) + candidate.operation.damage,
        );
      } else {
        details.set(candidate.key, applyOperation(draft, candidate.operation, phase));
      }
    }
    for (const [targetId, totalDamage] of damageByTarget) {
      applyAggregatedDamage(draft, targetId, totalDamage, phase);
    }
    if (phase === "P0") draft.pendingExternal = [];
    if (phase === "P2") draft.pendingIntents = [];
    assertStateValid(draft);
    assertWorldBalance(draft);
    for (const candidate of acceptedCandidates) {
      const detail = details.get(candidate.key) ?? { inputs: {}, outputs: {}, message: "accepted" };
      appendAccepted(draft, candidate, detail, candidate.operation.kind.startsWith("external") ? "external" : "accepted");
    }
    world.stateHash = stateHash(draft);
    replaceWorld(world, draft);
    return { accepted: acceptedCandidates.length, rejected };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "atomic commit failed";
    for (const candidate of acceptedCandidates) {
      rejected += 1;
      appendFailure(world, candidate, `atomic rollback: ${reason}`);
    }
    return { accepted: 0, rejected };
  }
}

interface ApplyDetails {
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  message: string;
}

function preflightOperation(start: WorldState, operation: Operation, phase: Phase): string | undefined {
  if (operation.kind === "invalid") return operation.message;
  if (operation.kind === "external-light") {
    const entity = start.entities[operation.entityId];
    if (!entity || !entity.alive) return "light target is not alive";
    if (!isSafeAmount(operation.amount, false)) return "light input is invalid";
    if (entity.energy.chemical + operation.amount > entityEnergyCapacity(start, entity, "chemical")) return "chemical energy capacity exceeded";
    return undefined;
  }
  if (operation.kind === "external-resource") {
    const owner = operation.scope === "entity" ? start.entities[operation.ownerId] : start.modules[operation.ownerId];
    if (!owner) return "external resource owner does not exist";
    if (!isSafeAmount(operation.amount, false)) return "external resource amount is invalid";
    if (operation.resourceKind === "mass" && !MASS_RESOURCES.includes(operation.resource as MassResource)) return "mass injection names an energy resource";
    if (operation.resourceKind === "energy" && !ENERGY_RESOURCES.includes(operation.resource as EnergyResource)) return "energy injection names a mass resource";
    const current = readResource(start, operation.ownerId, operation.scope, operation.resource);
    const capacity = resourceCapacity(start, operation.ownerId, operation.scope, operation.resource);
    if (current + operation.amount > capacity) return `${String(operation.resource)} capacity exceeded`;
    return undefined;
  }
  if (operation.kind === "spawn") {
    const preset = start.catalog.presets[operation.presetId];
    if (!preset) return `unknown spawn preset ${operation.presetId}`;
    if (start.entities[operation.entityId]) return `duplicate spawned entity ${operation.entityId}`;
    const positionErrors = validatePosition(operation.position, start.config);
    return positionErrors.length > 0 ? positionErrors.join("; ") : undefined;
  }
  if (operation.kind === "maintenance") {
    const entity = start.entities[operation.entityId];
    if (!entity?.alive) return "maintenance target is not alive";
    if (!canAffordEnergy(entity.energy, "stored", operation.amount)) return "maintenance resource was not reserved";
    return undefined;
  }
  if (operation.kind === "deficiency") {
    const entity = start.entities[operation.entityId];
    if (!entity?.alive) return "maintenance target is not alive";
    if (!isSafeAmount(operation.damage)) return "deficiency damage is invalid";
    return undefined;
  }
  if (operation.kind === "grow") {
    const entity = start.entities[operation.entityId];
    const template = start.catalog.templates[operation.templateId];
    if (!entity?.alive) return "growth target is not alive";
    if (!template || template.kind !== "growth") return "growth template is unavailable";
    if (entity.structureMass + template.structureOutput > entity.maxStructureMass) return "growth structure capacity reached";
    if (entity.inventory.mass.water < template.inputMass.water || entity.inventory.mass.nutrient < template.inputMass.nutrient) return "growth mass inputs unavailable";
    if (entity.energy.chemical < template.chemicalInput) return "growth chemical energy unavailable";
    if (entity.energy.stored + template.storedOutput > entityEnergyCapacity(start, entity, "stored")) return "growth stored-energy capacity exceeded";
    return undefined;
  }
  if (operation.kind === "digest") {
    const entity = start.entities[operation.entityId];
    const template = start.catalog.templates[operation.templateId];
    if (!entity?.alive) return "digestion target is not alive";
    if (!template || template.kind !== "digestion") return "digestion template is unavailable";
    if (entity.inventory.mass.food < template.inputFood || entity.energy.chemical < template.chemicalInput) return "digestion inputs unavailable";
    if (entity.energy.stored + template.storedOutput > entityEnergyCapacity(start, entity, "stored")) return "digestion stored-energy capacity exceeded";
    if (entity.inventory.mass.waste + template.wasteOutput > entityMassCapacity(start, entity, "waste")) return "waste capacity exceeded";
    return undefined;
  }
  if (operation.kind === "burn") {
    const entity = start.entities[operation.entityId];
    const template = start.catalog.templates[operation.templateId];
    if (!entity || !entity.combustion.enabled || !hasCapability(start, entity, "flammable")) return "combustion capability is unavailable";
    if (!template || template.kind !== "burn") return "burn template is unavailable";
    const fuel = template.fuelInput * entity.combustion.fuelPerStep;
    const chemical = template.chemicalInput * entity.combustion.fuelPerStep;
    if (entity.inventory.mass[entity.combustion.fuelResource] < fuel || entity.energy.chemical < chemical) return "combustion inputs unavailable";
    if (entityHeat(start, entity) < entity.combustion.ignitionTemperature) return "ignition temperature not reached";
    return undefined;
  }
  if (operation.kind === "heat-transfer") {
    if (!isActiveConnection(start, operation.from, operation.to, "heat")) return "heat connection is inactive";
    if (readPortEnergy(start, operation.from, "heat") < operation.amount) return "heat source is empty";
    return undefined;
  }
  if (operation.kind === "machine-process") {
    const entity = start.entities[operation.entityId];
    const processor = start.modules[operation.processorModuleId];
    const storage = start.modules[operation.storageModuleId];
    const template = start.catalog.templates[operation.templateId];
    if (!entity?.alive || !processor || !storage) return "machine process references a missing component";
    if (processor.ownerEntityId !== entity.id) return "processor is not mounted on actor";
    if (!template || template.kind !== "process") return "process template is unavailable";
    if (!hasCapability(start, entity, "process") || !isProcessRouteActive(start, processor.id, storage.id)) return "required machine ports are not connected";
    if (storage.inventory.mass.raw < template.rawInput || entity.energy.stored < template.storedInput) return "machine process inputs unavailable";
    if (storage.inventory.mass.product + template.productOutput > moduleMassCapacity(start, storage.id, "product")) return "machine product capacity exceeded";
    return undefined;
  }
  if (operation.kind === "move") {
    const entity = start.entities[operation.entityId];
    if (!entity?.alive) return "move actor is not alive";
    if (!samePosition(entity.position, operation.from)) return "move intent is stale";
    if (!isSafeAmount(operation.energyCost)) return "move cost is invalid";
    if (Math.abs(operation.to.x - operation.from.x) + Math.abs(operation.to.y - operation.from.y) > 1) return "movement is not orthogonal and adjacent";
    if (operation.to.x < 0 || operation.to.y < 0 || operation.to.x >= start.config.width || operation.to.y >= start.config.height) return "destination is outside the world";
    if (operation.to.layer === "air") {
      if (!hasCapability(start, entity, "lift") || !hasCapability(start, entity, "air_move")) return "air movement capability is unavailable";
      if (entityMass(start, entity) > getModuleParameterFromEntity(start, entity, "liftCapacity", 0)) return "total mass exceeds lift capacity";
    } else if (operation.from.layer === "ground" && !hasCapability(start, entity, "ground_move")) {
      return "ground movement capability is unavailable";
    }
    if (operation.energyCost > 0 && !canAffordEnergy(entity.energy, "stored", operation.energyCost)) return "movement energy unavailable";
    return undefined;
  }
  if (operation.kind === "consume") {
    const actor = start.entities[operation.actorId];
    const target = start.entities[operation.targetId];
    if (!actor?.alive || !target || actor.id === target.id) return "consume actor or target is invalid";
    if (operation.amount !== 1) return "consume transfers one indivisible mass unit";
    if (!(isAdjacent(actor, target) || isSameCell(actor, target))) return "food is out of reach";
    if (!actor.nutrition.preference.includes(target.nutrition.edibleAs ?? "processed_food")) return "food group is incompatible";
    if (target.alive && target.nutrition.foodAccess !== "alive" && target.nutrition.foodAccess !== "always") return "living food is not accessible";
    if (!target.alive && target.nutrition.foodAccess !== "after_death" && target.nutrition.foodAccess !== "always") return "dead food is not accessible";
    if (target.edibleMass < operation.amount || target.structureMass < operation.amount) return "food mass is unavailable";
    if (target.energy.chemical < operation.chemicalTransfer) return "food chemical energy is unavailable";
    if (actor.inventory.mass.food + operation.amount > entityMassCapacity(start, actor, "food")) return "food storage capacity exceeded";
    return undefined;
  }
  if (operation.kind === "attack") {
    const actor = start.entities[operation.actorId];
    const target = start.entities[operation.targetId];
    if (!actor?.alive || !target?.alive || actor.id === target.id) return "attack actor or target is invalid";
    if (!isAdjacent(actor, target) && !isSameCell(actor, target)) return "work target is out of reach";
    if (!hasCapability(start, actor, "work_damage")) return "work capability is unavailable";
    if (!isSafeAmount(operation.damage, false)) return "damage must be positive";
    if (!canAffordEnergy(actor.energy, "stored", operation.energyCost)) return "work energy unavailable";
    return undefined;
  }
  if (operation.kind === "discharge") {
    const actor = start.entities[operation.actorId];
    const module = start.modules[operation.moduleId];
    const target = start.entities[operation.targetId];
    if (!actor?.alive || !module || module.ownerEntityId !== actor.id || !target || target.id === actor.id) return "discharge actor, module, or target is invalid";
    if (!hasCapability(start, actor, "electric_discharge")) return "electric discharge capability is unavailable";
    if (!isAdjacent(actor, target) && !isSameCell(actor, target)) return "discharge target is out of reach";
    if (!isSafeAmount(operation.amount, false) || module.energy.charge < operation.amount) return "charge is unavailable";
    return undefined;
  }
  if (operation.kind === "charge") {
    const entity = start.entities[operation.entityId];
    const module = start.modules[operation.moduleId];
    const template = start.catalog.templates[operation.templateId];
    if (!entity?.alive || !module || module.ownerEntityId !== entity.id) return "charge actor or module is invalid";
    if (!template || template.kind !== "charge" || !hasCapability(start, entity, "charge_storage")) return "charge capability is unavailable";
    if (entity.energy.stored < template.storedInput) return "stored energy is unavailable";
    if (module.energy.charge + template.chargeOutput > moduleEnergyCapacity(start, module.id, "charge")) return "charge capacity exceeded";
    return undefined;
  }
  if (operation.kind === "attach-module") {
    const entity = start.entities[operation.entityId];
    const definition = start.catalog.modules[operation.moduleDefinitionId];
    if (!entity?.alive || !definition) return "attach actor or module definition is invalid";
    if (operation.moduleId) {
      const existing = start.modules[operation.moduleId];
      if (!existing || existing.ownerEntityId || existing.definitionId !== operation.moduleDefinitionId) return "detached module is not available";
    }
    const candidateModuleIds = [...entity.moduleIds, operation.moduleId ?? `new:${operation.moduleDefinitionId}`];
      const errors = validateEntityConfiguration(entity, candidateModuleIds, start.catalog, start.modules);
    return errors.length > 0 ? errors.join("; ") : undefined;
  }
  if (operation.kind === "detach-module") {
    const entity = start.entities[operation.entityId];
    const module = start.modules[operation.moduleId];
    if (!entity || !module || module.ownerEntityId !== entity.id) return "module is not mounted on actor";
    if (entity.alive) {
      const errors = validateEntityConfiguration(entity, entity.moduleIds.filter((moduleId) => moduleId !== operation.moduleId), start.catalog, start.modules);
      if (errors.length > 0) return `detach would invalidate the entity: ${errors.join("; ")}`;
    }
    return undefined;
  }
  if (operation.kind === "resize-module") {
    const entity = start.entities[operation.entityId];
    const module = start.modules[operation.moduleId];
    if (!entity?.alive || !module || module.ownerEntityId !== entity.id) return "module is not mounted on actor";
    if (!isSafeAmount(operation.newCapacity)) return "new capacity is invalid";
    const capacities = getModuleCapacities(start, module.id);
    const currentCapacity = capacities.mass[operation.resource];
    if (operation.newCapacity > currentCapacity) return "capacity increase is not a free edit";
    if (module.inventory.mass[operation.resource] > operation.newCapacity) return "capacity reduction would strand overflow; transfer or reject the whole edit";
    return undefined;
  }
  if (operation.kind === "land") {
    const entity = start.entities[operation.entityId];
    return !entity ? "landing actor does not exist" : entity.position.layer !== "air" ? "actor is already on the ground" : undefined;
  }
  if (operation.kind === "deconstruct") {
    return start.entities[operation.entityId] ? undefined : "deconstruct target does not exist";
  }
  return `unsupported operation in ${phase}`;
}

function applyOperation(world: WorldState, operation: Operation, phase: Phase): ApplyDetails {
  if (operation.kind === "invalid") throw new Error(operation.message);
  if (operation.kind === "external-light") {
    const entity = requireEntity(world, operation.entityId);
    entity.energy.chemical += operation.amount;
    world.externalLedger.energyIn.chemical += operation.amount;
    return { inputs: { "빛(외부)": operation.amount }, outputs: { chemical: operation.amount }, message: "승인된 환경 빛 입력" };
  }
  if (operation.kind === "external-resource") {
    setResource(world, operation.ownerId, operation.scope, operation.resource, readResource(world, operation.ownerId, operation.scope, operation.resource) + operation.amount);
    if (operation.resourceKind === "mass") world.externalLedger.massIn[operation.resource as MassResource] += operation.amount;
    else world.externalLedger.energyIn[operation.resource as EnergyResource] += operation.amount;
    return { inputs: { external: operation.amount }, outputs: { [String(operation.resource)]: operation.amount }, message: `외부 주입: ${operation.label}` };
  }
  if (operation.kind === "spawn") {
    const beforeMass = massTotals(world);
    const beforeEnergy = energyTotals(world);
    instantiatePresetForTransaction(world, operation.presetId, operation.position, { id: operation.entityId, displayOverride: operation.displayOverride });
    const afterMass = massTotals(world);
    const afterEnergy = energyTotals(world);
    recordLedgerDelta(world.externalLedger.massIn, beforeMass, afterMass);
    recordLedgerDelta(world.externalLedger.energyIn, beforeEnergy, afterEnergy);
    return { inputs: { external_spawn: sumMass(afterMass) - sumMass(beforeMass) }, outputs: { entity: 1 }, message: `외부 자원으로 ${operation.entityId} 생성` };
  }
  if (operation.kind === "maintenance") {
    const entity = requireEntity(world, operation.entityId);
    entity.energy.stored -= operation.amount;
    entity.energy.heat += operation.amount;
    return { inputs: { stored: operation.amount }, outputs: { heat: operation.amount }, message: `유지비 ${operation.amount} 지불; 폐열로 전환` };
  }
  if (operation.kind === "deficiency") {
    const entity = requireEntity(world, operation.entityId);
    const before = entity.integrity;
    entity.integrity = Math.max(0, entity.integrity - operation.damage);
    if (entity.integrity === 0) markDead(entity);
    return { inputs: { deficiency: operation.damage }, outputs: { integrity: entity.integrity - before }, message: operation.reason };
  }
  if (operation.kind === "grow") {
    const entity = requireEntity(world, operation.entityId);
    const template = requireTemplate(world, operation.templateId, "growth");
    subtractMass(entity.inventory.mass, template.inputMass);
    entity.structureMass += template.structureOutput;
    entity.edibleMass = Math.min(entity.structureMass, entity.edibleMass + template.edibleOutput);
    subtractEnergy(entity.energy, { chemical: template.chemicalInput });
    addEnergy(entity.energy, { stored: template.storedOutput, heat: template.heatOutput });
    entity.maxIntegrity += template.integrityOutput;
    entity.integrity = Math.min(entity.maxIntegrity, entity.integrity + template.integrityOutput);
    return {
      inputs: { water: template.inputMass.water, nutrient: template.inputMass.nutrient, chemical: template.chemicalInput },
      outputs: { structure: template.structureOutput, edible: template.edibleOutput, stored: template.storedOutput, heat: template.heatOutput },
      message: "공통 성장 변환 실행",
    };
  }
  if (operation.kind === "digest") {
    const entity = requireEntity(world, operation.entityId);
    const template = requireTemplate(world, operation.templateId, "digestion");
    entity.inventory.mass.food -= template.inputFood;
    entity.inventory.mass.waste += template.wasteOutput;
    subtractEnergy(entity.energy, { chemical: template.chemicalInput });
    addEnergy(entity.energy, { stored: template.storedOutput, heat: template.heatOutput });
    return {
      inputs: { food: template.inputFood, chemical: template.chemicalInput },
      outputs: { waste: template.wasteOutput, stored: template.storedOutput, heat: template.heatOutput },
      message: "공통 소화 변환 실행",
    };
  }
  if (operation.kind === "burn") {
    const entity = requireEntity(world, operation.entityId);
    const template = requireTemplate(world, operation.templateId, "burn");
    const multiplier = entity.combustion.fuelPerStep;
    const fuel = template.fuelInput * multiplier;
    const chemical = template.chemicalInput * multiplier;
    entity.inventory.mass[entity.combustion.fuelResource] -= fuel;
    entity.inventory.mass.scrap += template.scrapOutput * multiplier;
    entity.energy.chemical -= chemical;
    entity.energy.heat += template.heatOutput * multiplier;
    const beforeIntegrity = entity.integrity;
    entity.integrity = Math.max(0, entity.integrity - entity.combustion.damagePerStep * multiplier);
    if (entity.integrity === 0) markDead(entity);
    return {
      inputs: { fuel, chemical },
      outputs: { scrap: template.scrapOutput * multiplier, heat: template.heatOutput * multiplier, damage: beforeIntegrity - entity.integrity },
      message: entity.alive ? "발화 후 공통 연소 실행" : "잔해의 연료 연소 실행",
    };
  }
  if (operation.kind === "heat-transfer") {
    const source = requireModule(world, operation.from.moduleId);
    const target = requireModule(world, operation.to.moduleId);
    source.energy.heat -= operation.amount;
    target.energy.heat += operation.amount;
    return { inputs: { heat: operation.amount }, outputs: { heat: operation.amount }, message: "명시적 연결을 통한 열 전달" };
  }
  if (operation.kind === "machine-process") {
    const entity = requireEntity(world, operation.entityId);
    const storage = requireModule(world, operation.storageModuleId);
    const processor = requireModule(world, operation.processorModuleId);
    const template = requireTemplate(world, operation.templateId, "process");
    storage.inventory.mass.raw -= template.rawInput;
    storage.inventory.mass.product += template.productOutput;
    entity.energy.stored -= template.storedInput;
    processor.energy.heat += template.heatOutput;
    return {
      inputs: { raw: template.rawInput, stored: template.storedInput },
      outputs: { product: template.productOutput, heat: template.heatOutput },
      message: "연결된 기존 변환 템플릿 실행",
    };
  }
  if (operation.kind === "move") {
    const entity = requireEntity(world, operation.entityId);
    entity.position = { ...operation.to };
    if (operation.energyCost > 0) {
      entity.energy.stored -= operation.energyCost;
      entity.energy.heat += operation.energyCost;
    }
    return { inputs: operation.energyCost > 0 ? { stored: operation.energyCost } : {}, outputs: { distance: 1, ...(operation.energyCost > 0 ? { heat: operation.energyCost } : {}) }, message: `${operation.to.layer} 인접 칸으로 이동` };
  }
  if (operation.kind === "consume") {
    const actor = requireEntity(world, operation.actorId);
    const target = requireEntity(world, operation.targetId);
    target.structureMass -= operation.amount;
    target.edibleMass -= operation.amount;
    target.energy.chemical -= operation.chemicalTransfer;
    actor.inventory.mass.food += operation.amount;
    actor.energy.chemical += operation.chemicalTransfer;
    if (target.structureMass <= 0) markDead(target);
    return {
      inputs: { food: operation.amount, chemical: operation.chemicalTransfer },
      outputs: { food: operation.amount, chemical: operation.chemicalTransfer },
      message: `${target.shortLabel}의 접근 가능한 조직 섭취`,
    };
  }
  if (operation.kind === "attack") {
    const actor = requireEntity(world, operation.actorId);
    actor.energy.stored -= operation.energyCost;
    actor.energy.heat += operation.energyCost;
    return { inputs: { stored: operation.energyCost }, outputs: { damage: operation.damage, heat: operation.energyCost }, message: "유료 구조 작업 실행; 피해는 대상별 합산" };
  }
  if (operation.kind === "discharge") {
    const module = requireModule(world, operation.moduleId);
    const target = requireEntity(world, operation.targetId);
    module.energy.charge -= operation.amount;
    target.energy.heat += operation.amount;
    return { inputs: { charge: operation.amount }, outputs: { heat: operation.amount }, message: "전하를 대상 열로 유료 방출" };
  }
  if (operation.kind === "charge") {
    const entity = requireEntity(world, operation.entityId);
    const module = requireModule(world, operation.moduleId);
    const template = requireTemplate(world, operation.templateId, "charge");
    entity.energy.stored -= template.storedInput;
    module.energy.charge += template.chargeOutput;
    module.energy.heat += template.heatOutput;
    return { inputs: { stored: template.storedInput }, outputs: { charge: template.chargeOutput, heat: template.heatOutput }, message: "저장 에너지에서 전하 충전" };
  }
  if (operation.kind === "attach-module") {
    const definition = world.catalog.modules[operation.moduleDefinitionId];
    if (!definition) throw new Error("module definition disappeared during commit");
    const existing = operation.moduleId ? world.modules[operation.moduleId] : undefined;
    const module = attachModuleForTransaction(world, operation.entityId, operation.moduleDefinitionId, operation.moduleId);
    if (!existing) {
      addMass(world.externalLedger.massIn, definition.materialCost);
      const excess = sumMass(definition.materialCost) - definition.structuralMass;
      if (excess > 0) requireEntity(world, operation.entityId).inventory.mass.scrap += excess;
    }
    return { inputs: existing ? {} : { external_material: sumMass(definition.materialCost) }, outputs: { module: 1 }, message: existing ? `기존 모듈 ${module.id} 재연결` : `외부 재료로 모듈 ${module.id} 장착` };
  }
  if (operation.kind === "detach-module") {
    const entity = requireEntity(world, operation.entityId);
    const module = requireModule(world, operation.moduleId);
    entity.moduleIds = entity.moduleIds.filter((moduleId) => moduleId !== module.id);
    module.ownerEntityId = undefined;
    for (const connection of Object.values(world.connections)) {
      if (connectionTouchesModule(connection, module.id)) connection.enabled = false;
    }
    return { inputs: {}, outputs: { detached_module: 1 }, message: `모듈 ${module.id} 분리; 재고·손상·cooldown 보존` };
  }
  if (operation.kind === "resize-module") {
    const module = requireModule(world, operation.moduleId);
    const capacities = getModuleCapacities(world, module.id);
    module.capacityOverrides = {
      mass: { ...capacities.mass, [operation.resource]: operation.newCapacity },
      energy: { ...capacities.energy },
    };
    return { inputs: {}, outputs: { capacity: operation.newCapacity }, message: `모듈 저장 용량을 ${operation.resource}:${operation.newCapacity}로 축소` };
  }
  if (operation.kind === "land") {
    const entity = requireEntity(world, operation.entityId);
    entity.position.layer = "ground";
    return { inputs: {}, outputs: { landing: 1 }, message: operation.reason };
  }
  if (operation.kind === "deconstruct") {
    const entity = requireEntity(world, operation.entityId);
    markDead(entity);
    return { inputs: {}, outputs: { debris: 1 }, message: "해체는 자원을 삭제하지 않고 잔해 상태로 전환" };
  }
  throw new Error(`unhandled operation ${phase}`);
}

function applyAggregatedDamage(world: WorldState, targetId: string, totalDamage: number, phase: Phase): void {
  const target = world.entities[targetId];
  if (!target) throw new Error(`damage target ${targetId} disappeared`);
  const before = target.integrity;
  target.integrity = Math.max(0, target.integrity - totalDamage);
  if (target.integrity === 0) markDead(target);
  appendSystemEvent(world, phase, "interaction.damage-aggregate", target.id, {
    inputs: { damage: totalDamage },
    outputs: { integrity_before: before, integrity_after: target.integrity },
    message: target.alive ? "대상별 합산 피해 적용" : "대상별 합산 피해로 사망; 몸과 잔여 자원 보존",
  });
}

function markDead(entity: EntityState): void {
  entity.alive = false;
  entity.state = "debris";
}

function reserveClaims(start: WorldState, claims: ResourceClaim[], reserved: Map<string, number>): string | undefined {
  for (const claim of claims) {
    if (!isSafeAmount(claim.amount, false)) return "invalid resource claim amount";
    const key = claimKey(claim);
    const available = readClaim(start, claim) - (reserved.get(key) ?? 0);
    if (available < claim.amount) return `resource unavailable: ${key}`;
  }
  for (const claim of claims) {
    const key = claimKey(claim);
    reserved.set(key, (reserved.get(key) ?? 0) + claim.amount);
  }
  return undefined;
}

function reserveWrites(candidate: Candidate, writes: Map<string, boolean>): string | undefined {
  const mergeKeys = new Set(candidate.mergeWriteKeys ?? []);
  for (const key of candidate.writeKeys) {
    const previousMerge = writes.get(key);
    if (previousMerge !== undefined && !(previousMerge && mergeKeys.has(key))) return `write conflict: ${key}`;
  }
  for (const key of candidate.writeKeys) {
    writes.set(key, Boolean(writes.get(key) && mergeKeys.has(key)) || mergeKeys.has(key));
  }
  return undefined;
}

function readClaim(world: WorldState, claim: ResourceClaim): number {
  if (claim.scope === "body") return world.entities[claim.ownerId]?.edibleMass ?? 0;
  return readResource(world, claim.ownerId, claim.scope, claim.resource);
}

function readResource(
  world: WorldState,
  ownerId: string,
  scope: "entity" | "module",
  resource: ResourceClaim["resource"],
): number {
  if (resource === "edible") return world.entities[ownerId]?.edibleMass ?? 0;
  if (scope === "entity") {
    const entity = world.entities[ownerId];
    if (!entity) return 0;
    if (MASS_RESOURCES.includes(resource as MassResource)) return entity.inventory.mass[resource as MassResource];
    return entity.energy[resource as EnergyResource];
  }
  const module = world.modules[ownerId];
  if (!module) return 0;
  if (MASS_RESOURCES.includes(resource as MassResource)) return module.inventory.mass[resource as MassResource];
  return module.energy[resource as EnergyResource];
}

function setResource(
  world: WorldState,
  ownerId: string,
  scope: "entity" | "module",
  resource: ResourceClaim["resource"],
  amount: number,
): void {
  if (resource === "edible") {
    requireEntity(world, ownerId).edibleMass = amount;
    return;
  }
  if (scope === "entity") {
    const entity = requireEntity(world, ownerId);
    if (MASS_RESOURCES.includes(resource as MassResource)) entity.inventory.mass[resource as MassResource] = amount;
    else entity.energy[resource as EnergyResource] = amount;
    return;
  }
  const module = requireModule(world, ownerId);
  if (MASS_RESOURCES.includes(resource as MassResource)) module.inventory.mass[resource as MassResource] = amount;
  else module.energy[resource as EnergyResource] = amount;
}

function resourceCapacity(world: WorldState, ownerId: string, scope: "entity" | "module", resource: ResourceClaim["resource"]): number {
  if (resource === "edible") return world.entities[ownerId]?.structureMass ?? 0;
  if (scope === "entity") {
    const entity = world.entities[ownerId];
    return entity ? (MASS_RESOURCES.includes(resource as MassResource) ? getEntityCapacities(world, entity).mass[resource as MassResource] : getEntityCapacities(world, entity).energy[resource as EnergyResource]) : 0;
  }
  const module = world.modules[ownerId];
  return module ? (MASS_RESOURCES.includes(resource as MassResource) ? getModuleCapacities(world, module.id).mass[resource as MassResource] : getModuleCapacities(world, module.id).energy[resource as EnergyResource]) : 0;
}

function claimKey(claim: ResourceClaim): string {
  return `${claim.scope}:${claim.ownerId}:${String(claim.resource)}`;
}

function compareCandidates(world: WorldState, left: Candidate, right: Candidate): number {
  return left.priority - right.priority ||
    stableHash(`${world.config.seed}|${world.tick}|${left.phase}|${left.key}`).localeCompare(stableHash(`${world.config.seed}|${world.tick}|${right.phase}|${right.key}`)) ||
    left.key.localeCompare(right.key);
}

function deduplicateCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    const dedupKey = JSON.stringify({
      phase: candidate.phase,
      ruleId: candidate.ruleId,
      actorId: candidate.actorId ?? "",
      targetId: candidate.targetId ?? "",
      operation: candidate.operation,
    });
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    result.push(candidate);
  }
  return result;
}

function appendFailure(world: WorldState, candidate: Candidate, reason: string): void {
  appendEvent(world, {
    id: "",
    tick: world.tick,
    phase: candidate.phase,
    outcome: "failed",
    ruleId: candidate.ruleId,
    candidateKey: candidate.key,
    actorId: candidate.actorId,
    targetId: candidate.targetId,
    inputs: {},
    outputs: {},
    message: "거래 실패",
    reason,
  });
}

function appendAccepted(world: WorldState, candidate: Candidate, detail: ApplyDetails, outcome: SimulationEvent["outcome"]): void {
  appendEvent(world, {
    id: "",
    tick: world.tick,
    phase: candidate.phase,
    outcome,
    ruleId: candidate.ruleId,
    candidateKey: candidate.key,
    actorId: candidate.actorId,
    targetId: candidate.targetId,
    inputs: detail.inputs,
    outputs: detail.outputs,
    message: detail.message,
  });
}

function appendSystemEvent(world: WorldState, phase: Phase, ruleId: string, targetId: string, detail: ApplyDetails): void {
  appendEvent(world, {
    id: "",
    tick: world.tick,
    phase,
    outcome: "system",
    ruleId,
    targetId,
    inputs: detail.inputs,
    outputs: detail.outputs,
    message: detail.message,
  });
}

function appendEvent(world: WorldState, event: SimulationEvent): void {
  event.id = `event-${world.tick}-${world.nextEventOrdinal}`;
  world.nextEventOrdinal += 1;
  world.logs.push(event);
  if (world.logs.length > 2000) world.logs.splice(0, world.logs.length - 2000);
}

function assertStateValid(world: WorldState): void {
  for (const entity of Object.values(world.entities)) {
    assertLedger(entity.inventory.mass, `${entity.id}.inventory.mass`);
    assertLedger(entity.energy, `${entity.id}.energy`);
    if (!isSafeAmount(entity.structureMass) || !isSafeAmount(entity.edibleMass) || entity.edibleMass > entity.structureMass) throw new Error(`invalid mass state for ${entity.id}`);
    if (!isSafeAmount(entity.integrity) || !isSafeAmount(entity.maxIntegrity, false) || entity.integrity > entity.maxIntegrity) throw new Error(`invalid integrity state for ${entity.id}`);
    if (entity.position.x < 0 || entity.position.y < 0 || entity.position.x >= world.config.width || entity.position.y >= world.config.height) throw new Error(`invalid position for ${entity.id}`);
    for (const moduleId of entity.moduleIds) {
      if (!world.modules[moduleId] || world.modules[moduleId].ownerEntityId !== entity.id) throw new Error(`dangling module reference ${moduleId}`);
    }
  }
  for (const module of Object.values(world.modules)) {
    assertLedger(module.inventory.mass, `${module.id}.inventory.mass`);
    assertLedger(module.energy, `${module.id}.energy`);
    if (!isSafeAmount(module.integrity) || !isSafeAmount(module.cooldown)) throw new Error(`invalid module state for ${module.id}`);
  }
  for (const connection of Object.values(world.connections)) {
    if (!world.modules[connection.from.moduleId] || !world.modules[connection.to.moduleId]) throw new Error(`dangling connection ${connection.id}`);
  }
}

function recordLedgerDelta(target: Record<string, number>, before: Record<string, number>, after: Record<string, number>): void {
  for (const key of Object.keys(target)) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta > 0) target[key] += delta;
  }
}

function entityEnergyCapacity(world: WorldState, entity: EntityState, resource: EnergyResource): number {
  return entity.resourceCapacities.energy[resource] + getEntityModules(world, entity).reduce(
    (total, module) => total + (world.catalog.modules[module.definitionId]?.resourceCapacities.energy[resource] ?? 0),
    0,
  );
}

function entityMassCapacity(world: WorldState, entity: EntityState, resource: MassResource): number {
  return getEntityCapacities(world, entity).mass[resource];
}

function moduleMassCapacity(world: WorldState, moduleId: string, resource: MassResource): number {
  return getModuleCapacities(world, moduleId).mass[resource] ?? 0;
}

function moduleEnergyCapacity(world: WorldState, moduleId: string, resource: EnergyResource): number {
  return getModuleCapacities(world, moduleId).energy[resource] ?? 0;
}

function getModuleParameterFromEntity(world: WorldState, entity: EntityState, parameter: string, fallback: number): number {
  const values = getEntityModules(world, entity)
    .map((module) => world.catalog.modules[module.definitionId]?.boundedParameters[parameter])
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : fallback;
}

function readPortEnergy(world: WorldState, ref: PortRef, resource: EnergyResource): number {
  return world.modules[ref.moduleId]?.energy[resource] ?? 0;
}

function isActiveConnection(world: WorldState, from: PortRef, to: PortRef, kind: Connection["kind"]): boolean {
  return activeConnections(world).some(
    (connection) => connection.kind === kind && connection.from.moduleId === from.moduleId && connection.to.moduleId === to.moduleId &&
      connection.from.portId === from.portId && connection.to.portId === to.portId,
  );
}

function isProcessRouteActive(world: WorldState, processorModuleId: string, storageModuleId: string): boolean {
  const connections = activeConnections(world);
  return connections.some((connection) => connection.kind === "mass" && connection.from.moduleId === storageModuleId && connection.from.portId === "raw-out" && connection.to.moduleId === processorModuleId && connection.to.portId === "raw-in") &&
    connections.some((connection) => connection.kind === "mass" && connection.from.moduleId === processorModuleId && connection.from.portId === "product-out" && connection.to.moduleId === storageModuleId && connection.to.portId === "product-in") &&
    connections.some((connection) => connection.kind === "energy" && connection.from.moduleId === storageModuleId && connection.from.portId === "energy-out" && connection.to.moduleId === processorModuleId && connection.to.portId === "energy-in") &&
    connections.some((connection) => connection.kind === "heat" && connection.from.moduleId === processorModuleId && connection.from.portId === "heat-out" && connection.to.moduleId === storageModuleId && connection.to.portId === "heat-in");
}

function samePosition(left: EntityState["position"], right: EntityState["position"]): boolean {
  return left.x === right.x && left.y === right.y && left.layer === right.layer;
}

function requireEntity(world: WorldState, entityId: string): EntityState {
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`missing entity ${entityId}`);
  return entity;
}

function requireModule(world: WorldState, moduleId: string) {
  const module = world.modules[moduleId];
  if (!module) throw new Error(`missing module ${moduleId}`);
  return module;
}

function requireTemplate<T extends ConversionTemplate["kind"]>(world: WorldState, templateId: string, kind: T) {
  const template = world.catalog.templates[templateId];
  if (!template || template.kind !== kind) throw new Error(`missing ${kind} template ${templateId}`);
  return template as Extract<NonNullable<WorldState["catalog"]["templates"][string]>, { kind: T }>;
}
