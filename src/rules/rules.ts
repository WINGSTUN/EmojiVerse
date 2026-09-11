import {
  activeConnections,
  entityMass,
  entityHeat,
  findModuleWithCapability,
  getEntity,
  getEntityCapacities,
  getEntityModules,
  getModuleParameter,
  hasCapability,
} from "../sim/accessors";
import { choosePolicy } from "../policy/policy";
import type {
  Candidate,
  EntityState,
  ExternalInjection,
  Intent,
  Phase,
  PortRef,
  ResourceClaim,
  WorldState,
} from "../sim/types";

const PHASES: Phase[] = ["P0", "P1", "P2"];

export function buildPhaseCandidates(world: WorldState, phase: Phase): Candidate[] {
  if (!PHASES.includes(phase)) return [];
  if (phase === "P0") return buildP0Candidates(world);
  if (phase === "P1") return buildP1Candidates(world);
  return buildP2Candidates(world);
}

export function buildP0Candidates(world: WorldState): Candidate[] {
  const candidates: Candidate[] = [];
  let generatedSpawnOrdinal = 0;
  for (const injection of world.pendingExternal) {
    candidates.push(externalCandidate(world, injection, generatedSpawnOrdinal));
    if ("presetId" in injection && !injection.entityId) generatedSpawnOrdinal += 1;
  }
  for (const entity of sortedEntities(world)) {
    if (!entity.alive || !hasCapability(world, entity, "photosynthesize")) continue;
    const lightRate = Math.min(world.config.lightEnergyPerStep, getModuleParameter(world, entity, "lightRate", 0));
    const capacity = getEnergyCapacity(world, entity, "chemical");
    const amount = Math.min(lightRate, Math.max(0, capacity - entity.energy.chemical));
    if (amount <= 0) continue;
    candidates.push({
      key: `environment-light:${entity.id}`,
      phase: "P0",
      ruleId: "environment.light-input",
      actorId: entity.id,
      priority: 1,
      exclusiveSlot: `environment-light:${entity.id}`,
      claims: [],
      writeKeys: [`entity:${entity.id}:energy:chemical`],
      operation: { kind: "external-light", entityId: entity.id, amount },
    });
  }
  return candidates;
}

export function buildP1Candidates(world: WorldState): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entity of sortedEntities(world)) {
    const modules = getEntityModules(world, entity);
    if (entity.position.layer === "air") {
      const liftCapacity = getModuleParameter(world, entity, "liftCapacity", 0);
      const flightMaintenance = getModuleParameter(world, entity, "flightMaintenance", 0);
      if (!hasCapability(world, entity, "lift") || entityMass(world, entity) > liftCapacity || entity.energy.stored < flightMaintenance) {
        candidates.push({
          key: `air-land:${entity.id}`,
          phase: "P1",
          ruleId: "movement.air-maintenance",
          actorId: entity.id,
          priority: 0,
          exclusiveSlot: `air-maintenance:${entity.id}`,
          claims: [],
          writeKeys: [`entity:${entity.id}:position`],
          operation: { kind: "land", entityId: entity.id, reason: "양력 또는 공중 유지 에너지 조건이 깨져 지면으로 착지" },
        });
      }
    }
    if (entity.alive) {
      const maintenance = entity.maintenanceCost + modules.reduce(
        (total, module) => total + (module.integrity > 0 && module.cooldown === 0
          ? world.catalog.modules[module.definitionId]?.maintenanceCost.stored ?? 0
          : 0),
        0,
      );
      const flightMaintenance = entity.position.layer === "air"
        ? getModuleParameter(world, entity, "flightMaintenance", 0)
        : 0;
      const totalMaintenance = maintenance + flightMaintenance;
      if (totalMaintenance > 0) {
        if (entity.energy.stored >= totalMaintenance) {
          candidates.push({
            key: `maintenance:${entity.id}`,
            phase: "P1",
            ruleId: "survival.maintenance",
            actorId: entity.id,
            priority: 0,
            exclusiveSlot: `maintenance:${entity.id}`,
            claims: [claimEntityEnergy(entity.id, "stored", totalMaintenance)],
            writeKeys: [`entity:${entity.id}:energy:stored`],
            mergeWriteKeys: [`entity:${entity.id}:energy:stored`],
            operation: { kind: "maintenance", entityId: entity.id, amount: totalMaintenance },
          });
        } else {
          candidates.push({
            key: `maintenance-deficiency:${entity.id}`,
            phase: "P1",
            ruleId: "survival.maintenance-deficiency",
            actorId: entity.id,
            priority: 0,
            exclusiveSlot: `maintenance:${entity.id}`,
            claims: [],
            writeKeys: [`entity:${entity.id}:integrity`],
            operation: {
              kind: "deficiency",
              entityId: entity.id,
              damage: entity.maintenanceFailureDamage,
              reason: `유지비 ${totalMaintenance}을 저장 에너지 ${entity.energy.stored}로 지불하지 못함`,
            },
          });
        }
      }
    }
    if (entity.alive && hasCapability(world, entity, "digest_food")) {
      const templateId = entity.nutrition.digestionTemplateId ?? "digestion";
      const template = world.catalog.templates[templateId];
      if (template?.kind === "digestion" && entity.inventory.mass.food >= template.inputFood && entity.energy.chemical >= template.chemicalInput) {
        candidates.push({
          key: `digest:${entity.id}:${template.id}`,
          phase: "P1",
          ruleId: "metabolism.digestion",
          actorId: entity.id,
          priority: 1,
          exclusiveSlot: `digestion:${entity.id}`,
          claims: [
            claimEntityMass(entity.id, "food", template.inputFood),
            claimEntityEnergy(entity.id, "chemical", template.chemicalInput),
          ],
          writeKeys: [
            `entity:${entity.id}:inventory:food`,
            `entity:${entity.id}:inventory:waste`,
            `entity:${entity.id}:energy:chemical`,
            `entity:${entity.id}:energy:stored`,
            `entity:${entity.id}:energy:heat`,
          ],
          mergeWriteKeys: [`entity:${entity.id}:energy:stored`],
          operation: { kind: "digest", entityId: entity.id, templateId: template.id },
        });
      }
    }
    if (entity.alive && hasCapability(world, entity, "photosynthesize")) {
      const template = findTemplateForCapability(world, entity, "photosynthesis");
      if (template?.kind === "growth" &&
        entity.inventory.mass.water >= template.inputMass.water &&
        entity.inventory.mass.nutrient >= template.inputMass.nutrient &&
        entity.energy.chemical >= template.chemicalInput &&
        entity.structureMass < Math.min(entity.maxStructureMass, entity.maxStructureMass + template.maxStructureOutput)) {
        candidates.push({
          key: `growth:${entity.id}:${template.id}`,
          phase: "P1",
          ruleId: "metabolism.growth",
          actorId: entity.id,
          priority: 2,
          exclusiveSlot: `growth:${entity.id}`,
          claims: [
            claimEntityMass(entity.id, "water", template.inputMass.water),
            claimEntityMass(entity.id, "nutrient", template.inputMass.nutrient),
            claimEntityEnergy(entity.id, "chemical", template.chemicalInput),
          ],
          writeKeys: [
            `entity:${entity.id}:structure`,
            `entity:${entity.id}:integrity`,
            `entity:${entity.id}:inventory:water`,
            `entity:${entity.id}:inventory:nutrient`,
            `entity:${entity.id}:energy:chemical`,
            `entity:${entity.id}:energy:stored`,
            `entity:${entity.id}:energy:heat`,
          ],
          mergeWriteKeys: [`entity:${entity.id}:energy:stored`],
          operation: { kind: "grow", entityId: entity.id, templateId: template.id },
        });
      }
    }
    if (entity.alive && hasCapability(world, entity, "automatic_machine")) {
      for (const processor of getEntityModules(world, entity).filter((module) => hasModuleTemplate(world, module.definitionId, "raw_to_product"))) {
        const route = findProcessRoute(world, processor.id);
        if (!route) continue;
        const template = world.catalog.templates.raw_to_product;
        if (template.kind !== "process") continue;
        const storage = world.modules[route.storageModuleId];
        if (!storage || storage.inventory.mass.raw < template.rawInput || entity.energy.stored < template.storedInput) continue;
        candidates.push({
          key: `process:${entity.id}:${processor.id}:${storage.id}`,
          phase: "P1",
          ruleId: "machine.existing-conversion",
          actorId: entity.id,
          targetId: storage.id,
          priority: 3,
          exclusiveSlot: `machine:${processor.id}`,
          claims: [
            claimModuleMass(storage.id, "raw", template.rawInput),
            claimEntityEnergy(entity.id, "stored", template.storedInput),
          ],
          writeKeys: [
            `module:${storage.id}:resource`,
            `module:${storage.id}:inventory:raw`,
            `module:${storage.id}:inventory:product`,
            `entity:${entity.id}:energy:stored`,
            `entity:${entity.id}:energy:heat`,
          ],
          mergeWriteKeys: [`entity:${entity.id}:energy:stored`],
          operation: {
            kind: "machine-process",
            entityId: entity.id,
            processorModuleId: processor.id,
            storageModuleId: storage.id,
            templateId: template.id,
          },
        });
      }
    }
    if (entity.combustion.enabled && hasCapability(world, entity, "flammable")) {
      const template = findTemplateForCapability(world, entity, "burn");
      if (template?.kind === "burn") {
        const fuelAmount = template.fuelInput * entity.combustion.fuelPerStep;
        const chemicalAmount = template.chemicalInput * entity.combustion.fuelPerStep;
        if (fuelAmount > 0 &&
          entity.inventory.mass[entity.combustion.fuelResource] >= fuelAmount &&
          entity.energy.chemical >= chemicalAmount &&
          entityHeat(world, entity) >= entity.combustion.ignitionTemperature) {
          candidates.push({
            key: `burn:${entity.id}:${template.id}`,
            phase: "P1",
            ruleId: "physics.combustion",
            actorId: entity.id,
            priority: 4,
            exclusiveSlot: `combustion:${entity.id}`,
            claims: [
              claimEntityMass(entity.id, entity.combustion.fuelResource, fuelAmount),
              claimEntityEnergy(entity.id, "chemical", chemicalAmount),
            ],
            writeKeys: [
              `entity:${entity.id}:inventory:${entity.combustion.fuelResource}`,
              `entity:${entity.id}:inventory:scrap`,
              `entity:${entity.id}:energy:chemical`,
              `entity:${entity.id}:energy:heat`,
              `entity:${entity.id}:integrity`,
            ],
            operation: { kind: "burn", entityId: entity.id, templateId: template.id },
          });
        }
      }
    }
  }
  for (const connection of activeConnections(world).filter((item) => item.kind === "heat")) {
    const sourceHeat = heatAtPort(world, connection.from);
    if (sourceHeat <= 0) continue;
    const amount = Math.min(connection.rate, sourceHeat);
    candidates.push({
      key: `heat-transfer:${connection.id}`,
      phase: "P1",
      ruleId: "physics.heat-transfer",
      priority: 5,
      claims: [claimPortEnergy(connection.from, "heat", amount)],
      writeKeys: [portEnergyKey(connection.from, "heat"), portEnergyKey(connection.to, "heat")],
      operation: { kind: "heat-transfer", from: connection.from, to: connection.to, amount },
    });
  }
  return candidates;
}

export function buildP2Candidates(world: WorldState): Candidate[] {
  const explicitActors = new Set(world.pendingIntents.map((intent) => intent.actorId));
  const candidates: Candidate[] = [];
  for (const intent of [...world.pendingIntents].sort(compareIntents)) {
    candidates.push(intentCandidate(world, intent));
  }
  for (const entity of sortedEntities(world)) {
    if (!entity.alive || explicitActors.has(entity.id)) continue;
    const policyIntent = choosePolicy(world, entity);
    if (policyIntent) candidates.push(intentCandidate(world, policyIntent, true));
  }
  return candidates;
}

function externalCandidate(world: WorldState, injection: ExternalInjection, generatedSpawnOrdinal = 0): Candidate {
  if ("presetId" in injection) {
    const entityId = injection.entityId ?? `${injection.presetId}-${world.config.seed}-${world.nextEntityOrdinal + generatedSpawnOrdinal}`;
    return {
      key: `external-spawn:${injection.id}:${entityId}`,
      phase: "P0",
      ruleId: "external.spawn",
      targetId: entityId,
      priority: 0,
      exclusiveSlot: `external-spawn:${entityId}`,
      claims: [],
      writeKeys: [`entity:${entityId}`],
      operation: { kind: "spawn", presetId: injection.presetId, entityId, position: injection.position, displayOverride: injection.displayOverride },
    };
  }
  return {
    key: `external-resource:${injection.id}`,
    phase: "P0",
    ruleId: "external.resource-injection",
    targetId: injection.ownerId,
    priority: 0,
    exclusiveSlot: `external:${injection.ownerId}:${injection.resourceKind}:${injection.resource}`,
    claims: [],
    writeKeys: [`${injection.scope}:${injection.ownerId}:${injection.resourceKind}:${injection.resource}`],
    operation: {
      kind: "external-resource",
      ownerId: injection.ownerId,
      scope: injection.scope,
      resourceKind: injection.resourceKind,
      resource: injection.resource,
      amount: injection.amount,
      label: injection.label,
    },
  };
}

function intentCandidate(world: WorldState, intent: Intent, isPolicy = false): Candidate {
  const entity = getEntity(world, intent.actorId);
  if (!entity) {
    return invalidCandidate(intent.actorId, intent.type, `알 수 없는 actor ${intent.actorId}`);
  }
  const prefix = isPolicy ? "policy" : "intent";
  switch (intent.type) {
    case "move": {
      const toLayer = intent.toLayer ?? entity.position.layer;
      const to = { x: entity.position.x + intent.dx, y: entity.position.y + intent.dy, layer: toLayer };
      const fromAir = entity.position.layer === "air";
      const landing = fromAir && toLayer === "ground";
      const energyCost = landing ? 0 : toLayer === "air" ? getModuleParameter(world, entity, "airMoveCost", entity.movement.airCost) : entity.movement.groundCost;
      return {
        key: `${prefix}-move:${entity.id}:${to.x},${to.y},${to.layer}`,
        phase: "P2",
        ruleId: "movement.orthogonal",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `action:${entity.id}`,
        claims: energyCost > 0 ? [claimEntityEnergy(entity.id, "stored", energyCost)] : [],
        writeKeys: [`entity:${entity.id}:position`, ...(energyCost > 0 ? [`entity:${entity.id}:energy:stored`] : [])],
        operation: { kind: "move", entityId: entity.id, from: { ...entity.position }, to, energyCost },
      };
    }
    case "consume": {
      const amount = intent.amount ?? 1;
      const digestion = world.catalog.templates[entity.nutrition.digestionTemplateId ?? "digestion"];
      const chemicalTransfer = digestion?.kind === "digestion" ? digestion.chemicalInput * amount : 2 * amount;
      return {
        key: `${prefix}-consume:${entity.id}:${intent.targetId}:${amount}`,
        phase: "P2",
        ruleId: "metabolism.consume",
        actorId: entity.id,
        targetId: intent.targetId,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `action:${entity.id}`,
        claims: [
          claimBodyEdible(intent.targetId, amount),
          claimEntityEnergy(intent.targetId, "chemical", chemicalTransfer),
        ],
        writeKeys: [
          `entity:${intent.targetId}:body`,
          `entity:${intent.targetId}:energy:chemical`,
          `entity:${entity.id}:inventory:food`,
          `entity:${entity.id}:energy:chemical`,
        ],
        operation: { kind: "consume", actorId: entity.id, targetId: intent.targetId, amount, chemicalTransfer },
      };
    }
    case "attack": {
      const template = world.catalog.actions.predation_work;
      const damage = template?.damage ?? getModuleParameter(world, entity, "workDamage", 0);
      const energyCost = template?.storedCost ?? 1;
      return {
        key: `${prefix}-attack:${entity.id}:${intent.targetId}`,
        phase: "P2",
        ruleId: "interaction.work-damage",
        actorId: entity.id,
        targetId: intent.targetId,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `action:${entity.id}`,
        claims: [claimEntityEnergy(entity.id, "stored", energyCost)],
        writeKeys: [`entity:${entity.id}:energy:stored`, `entity:${intent.targetId}:body`],
        mergeWriteKeys: [`entity:${intent.targetId}:body`, `entity:${intent.targetId}:integrity`],
        operation: { kind: "attack", actorId: entity.id, targetId: intent.targetId, damage, energyCost },
      };
    }
    case "discharge": {
      const module = findModuleWithCapability(world, entity, "electric_discharge");
      const template = world.catalog.templates.discharge;
      const amount = template?.kind === "discharge" ? template.chargeInput : 0;
      return {
        key: `${prefix}-discharge:${entity.id}:${intent.targetId}:${module?.id ?? "none"}`,
        phase: "P2",
        ruleId: "electric.discharge",
        actorId: entity.id,
        targetId: intent.targetId,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `action:${entity.id}`,
        claims: module && amount > 0 ? [claimModuleEnergy(module.id, "charge", amount)] : [],
        writeKeys: module ? [`module:${module.id}:energy:charge`, `entity:${intent.targetId}:energy:heat`] : [],
        operation: { kind: "discharge", actorId: entity.id, moduleId: module?.id ?? "", targetId: intent.targetId, amount },
      };
    }
    case "charge": {
      const module = findModuleWithCapability(world, entity, "charge_storage");
      const template = world.catalog.templates.charge;
      const templateId = template?.id ?? "charge";
      const amount = template?.kind === "charge" ? template.storedInput : 0;
      return {
        key: `${prefix}-charge:${entity.id}:${module?.id ?? "none"}`,
        phase: "P2",
        ruleId: "electric.charge",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `action:${entity.id}`,
        claims: [claimEntityEnergy(entity.id, "stored", amount)],
        writeKeys: module ? [`entity:${entity.id}:energy:stored`, `module:${module.id}:energy:charge`, `module:${module.id}:energy:heat`] : [],
        operation: { kind: "charge", entityId: entity.id, moduleId: module?.id ?? "", templateId },
      };
    }
    case "process": {
      const processor = intent.processorModuleId
        ? world.modules[intent.processorModuleId]
        : getEntityModules(world, entity).find((module) => hasModuleTemplate(world, module.definitionId, "raw_to_product"));
      const route = processor ? findProcessRoute(world, processor.id) : undefined;
      const template = world.catalog.templates.raw_to_product;
      return {
        key: `${prefix}-process:${entity.id}:${processor?.id ?? "none"}`,
        phase: "P2",
        ruleId: "machine.existing-conversion",
        actorId: entity.id,
        targetId: route?.storageModuleId,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `machine:${processor?.id ?? "none"}`,
        claims: route && template?.kind === "process" ? [
          claimModuleMass(route.storageModuleId, "raw", template.rawInput),
          claimEntityEnergy(entity.id, "stored", template.storedInput),
        ] : [],
        writeKeys: route ? [
          `module:${route.storageModuleId}:resource`,
          `module:${route.storageModuleId}:inventory:raw`,
          `module:${route.storageModuleId}:inventory:product`,
          `entity:${entity.id}:energy:stored`,
          `entity:${entity.id}:energy:heat`,
        ] : [],
        mergeWriteKeys: route ? [`entity:${entity.id}:energy:stored`] : [],
        operation: {
          kind: "machine-process",
          entityId: entity.id,
          processorModuleId: processor?.id ?? "",
          storageModuleId: route?.storageModuleId ?? "",
          templateId: template?.id ?? "raw_to_product",
        },
      };
    }
    case "attach-module":
      return {
        key: `${prefix}-attach:${entity.id}:${intent.moduleDefinitionId}`,
        phase: "P2",
        ruleId: "composition.attach",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `configuration:${entity.id}`,
        claims: [],
        writeKeys: [`entity:${entity.id}:configuration`, `module:new:${entity.id}`],
        operation: {
          kind: "attach-module",
          entityId: entity.id,
          moduleDefinitionId: intent.moduleDefinitionId,
          moduleId: intent.moduleId,
        },
      };
    case "detach-module":
      return {
        key: `${prefix}-detach:${entity.id}:${intent.moduleId}`,
        phase: "P2",
        ruleId: "composition.detach",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `configuration:${entity.id}`,
        claims: [],
        writeKeys: [`entity:${entity.id}:configuration`, `entity:${entity.id}:body`, `module:${intent.moduleId}:owner`, `module:${intent.moduleId}:resource`],
        operation: { kind: "detach-module", entityId: entity.id, moduleId: intent.moduleId },
      };
    case "resize-module":
      return {
        key: `${prefix}-resize:${entity.id}:${intent.moduleId}:${intent.resource}:${intent.newCapacity}`,
        phase: "P2",
        ruleId: "composition.resize-capacity",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `configuration:${entity.id}`,
        claims: [],
        writeKeys: [`entity:${entity.id}:configuration`, `module:${intent.moduleId}:capacity`, `module:${intent.moduleId}:inventory`],
        operation: { kind: "resize-module", entityId: entity.id, moduleId: intent.moduleId, resource: intent.resource, newCapacity: intent.newCapacity },
      };
    case "deconstruct":
      return {
        key: `${prefix}-deconstruct:${entity.id}`,
        phase: "P2",
        ruleId: "composition.deconstruct",
        actorId: entity.id,
        priority: isPolicy ? 20 : 10,
        exclusiveSlot: `configuration:${entity.id}`,
        claims: [],
        writeKeys: [`entity:${entity.id}:body`, `entity:${entity.id}:configuration`],
        operation: { kind: "deconstruct", entityId: entity.id },
      };
    default:
      return invalidCandidate(entity.id, "unknown", "지원하지 않는 Intent");
  }
}

function invalidCandidate(actorId: string, type: string, message: string): Candidate {
  return {
    key: `invalid:${actorId}:${type}:${message}`,
    phase: "P2",
    ruleId: "intent.invalid",
    actorId,
    priority: 0,
    exclusiveSlot: `action:${actorId}`,
    claims: [],
    writeKeys: [],
    operation: { kind: "invalid", message },
  };
}

function sortedEntities(world: WorldState): EntityState[] {
  return Object.values(world.entities).sort((left, right) => left.id.localeCompare(right.id));
}

function compareIntents(left: Intent, right: Intent): number {
  return intentKey(left).localeCompare(intentKey(right));
}

function intentKey(intent: Intent): string {
  return JSON.stringify(intent, Object.keys(intent).sort());
}

function claimEntityMass(ownerId: string, resource: string, amount: number): ResourceClaim {
  return { ownerId, scope: "entity", resource: resource as ResourceClaim["resource"], amount };
}

function claimModuleMass(ownerId: string, resource: string, amount: number): ResourceClaim {
  return { ownerId, scope: "module", resource: resource as ResourceClaim["resource"], amount };
}

function claimEntityEnergy(ownerId: string, resource: string, amount: number): ResourceClaim {
  return { ownerId, scope: "entity", resource: resource as ResourceClaim["resource"], amount };
}

function claimModuleEnergy(ownerId: string, resource: string, amount: number): ResourceClaim {
  return { ownerId, scope: "module", resource: resource as ResourceClaim["resource"], amount };
}

function claimBodyEdible(ownerId: string, amount: number): ResourceClaim {
  return { ownerId, scope: "body", resource: "edible", amount };
}

function claimPortEnergy(ref: PortRef, resource: string, amount: number): ResourceClaim {
  return { ownerId: ref.moduleId, scope: "module", resource: resource as ResourceClaim["resource"], amount };
}

function portEnergyKey(ref: PortRef, resource: string): string {
  return `module:${ref.moduleId}:energy:${resource}`;
}

function getEnergyCapacity(world: WorldState, entity: EntityState, resource: "stored" | "charge" | "chemical" | "heat"): number {
  return getEntityCapacities(world, entity).energy[resource];
}

function findTemplateForCapability(world: WorldState, entity: EntityState, templateId: string) {
  for (const module of getEntityModules(world, entity)) {
    const definition = world.catalog.modules[module.definitionId];
    if (definition?.referencedActionOrConversionTemplateIds.includes(templateId)) return world.catalog.templates[templateId];
  }
  return undefined;
}

function hasModuleTemplate(world: WorldState, definitionId: string, templateId: string): boolean {
  return world.catalog.modules[definitionId]?.referencedActionOrConversionTemplateIds.includes(templateId) ?? false;
}

function findProcessRoute(world: WorldState, processorModuleId: string): { storageModuleId: string } | undefined {
  const connections = activeConnections(world);
  const rawFeeds = connections.filter(
    (connection) => connection.kind === "mass" && connection.to.moduleId === processorModuleId && connection.to.portId === "raw-in",
  );
  for (const rawFeed of rawFeeds) {
    const storageModuleId = rawFeed.from.moduleId;
    const hasProductReturn = connections.some(
      (connection) => connection.kind === "mass" && connection.from.moduleId === processorModuleId && connection.from.portId === "product-out" &&
        connection.to.moduleId === storageModuleId && connection.to.portId === "product-in",
    );
    const hasEnergy = connections.some(
      (connection) => connection.kind === "energy" && connection.from.moduleId === storageModuleId && connection.from.portId === "energy-out" &&
        connection.to.moduleId === processorModuleId && connection.to.portId === "energy-in",
    );
    const hasHeat = connections.some(
      (connection) => connection.kind === "heat" && connection.from.moduleId === processorModuleId && connection.from.portId === "heat-out" &&
        connection.to.moduleId === storageModuleId && connection.to.portId === "heat-in",
    );
    if (hasProductReturn && hasEnergy && hasHeat) return { storageModuleId };
  }
  return undefined;
}

function heatAtPort(world: WorldState, ref: PortRef): number {
  const module = world.modules[ref.moduleId];
  return module?.energy.heat ?? 0;
}
