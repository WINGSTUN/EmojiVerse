import { DEFAULT_CATALOG } from "../content/catalog";
import {
  cloneEnergy,
  cloneMass,
  emptyInventory,
  isSafeAmount,
  moduleStructuralMass,
  totalEnergy,
  totalMass,
  zeroEnergy,
  zeroMass,
} from "./ledger";
import { stateHash } from "./determinism";
import { getEntity, getEntityCapacities, getModule } from "./accessors";
import {
  ValidationError,
  validateCatalog,
  validateConnection,
  validateEntityConfiguration,
  validateMachineBlueprint,
  validatePosition,
  validatePresetDefinition,
  validateWorldConfig,
} from "./validation";
import type {
  Catalog,
  Connection,
  EntityState,
  EnergyResource,
  ExternalResourceInjection,
  ExternalSpawnInjection,
  MassResource,
  ModuleInstance,
  Position,
  PresetDefinition,
  ResourceCapacities,
  WorldConfig,
  WorldState,
} from "./types";

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  width: 16,
  height: 16,
  seed: 1337,
  dayLength: 8,
  lightEnergyPerStep: 2,
  maxEntities: 128,
  maxModules: 256,
  maxConnections: 256,
  maxCandidatesPerPhase: 512,
  maxPendingIntents: 128,
};

export interface CreateWorldOptions {
  config?: Partial<WorldConfig>;
  catalog?: Catalog;
}

export interface CreateEntityOptions {
  id?: string;
  displayOverride?: string;
}

export interface CreateVariantOptions extends CreateEntityOptions {
  semanticId?: string;
}

export function createWorld(options: CreateWorldOptions = {}): WorldState {
  const config = { ...DEFAULT_WORLD_CONFIG, ...(options.config ?? {}) };
  const configErrors = validateWorldConfig(config);
  if (configErrors.length > 0) throw new ValidationError("invalid world configuration", configErrors);
  const catalog = cloneCatalog(options.catalog ?? DEFAULT_CATALOG);
  const catalogErrors = validateCatalog(catalog);
  if (catalogErrors.length > 0) throw new ValidationError("invalid content catalog", catalogErrors);
  const world: WorldState = {
    config,
    catalog,
    tick: 0,
    phase: "P0",
    started: false,
    fixtureOpen: true,
    entities: {},
    modules: {},
    connections: {},
    pendingIntents: [],
    pendingExternal: [],
    logs: [],
    externalLedger: {
      massIn: zeroMass(),
      massOut: zeroMass(),
      energyIn: zeroEnergy(),
      energyOut: zeroEnergy(),
    },
    baselineMassTotal: 0,
    baselineEnergyTotal: 0,
    nextEntityOrdinal: 1,
    nextModuleOrdinal: 1,
    nextConnectionOrdinal: 1,
    nextEventOrdinal: 1,
    stateHash: "",
  };
  world.stateHash = stateHash(world);
  return world;
}

export function createEntityFromPreset(
  world: WorldState,
  presetId: string,
  position: Position,
  options: CreateEntityOptions = {},
): EntityState {
  assertFixtureEditing(world);
  const preset = world.catalog.presets[presetId];
  if (!preset) throw new ValidationError(`unknown preset ${presetId}`);
  const errors = [...validatePresetDefinition(preset, world.catalog), ...validatePosition(position, world.config)];
  if (errors.length > 0) throw new ValidationError(`cannot instantiate preset ${presetId}`, errors);
  return instantiatePresetInternal(world, preset, position, options);
}

export function createCreatureVariant(
  world: WorldState,
  basePresetId: string,
  extraModuleIds: string[],
  position: Position,
  options: CreateVariantOptions = {},
): EntityState {
  assertFixtureEditing(world);
  const base = world.catalog.presets[basePresetId];
  if (!base) throw new ValidationError(`unknown base preset ${basePresetId}`);
  const variant: PresetDefinition = {
    ...base,
    semanticId: options.semanticId ?? `${base.semanticId}_${extraModuleIds.join("_") || "variant"}`,
    display: options.displayOverride ?? base.display,
    shortLabel: `${base.shortLabel} 조합`,
    moduleIds: [...base.moduleIds, ...extraModuleIds],
    base: {
      ...base.base,
      energy: cloneEnergy(base.base.energy),
      inventory: cloneMass(base.base.inventory),
      resourceCapacities: cloneCapacities(base.base.resourceCapacities),
    },
    capabilities: [...base.capabilities],
    movement: { ...base.movement },
    senses: { ...base.senses },
    nutrition: { ...base.nutrition, preference: [...base.nutrition.preference] },
    combustion: { ...base.combustion },
  };
  const errors = validatePresetDefinition(variant, world.catalog);
  if (errors.length > 0) throw new ValidationError(`cannot create creature variant ${variant.semanticId}`, errors);
  world.catalog.presets[variant.semanticId] = variant;
  return instantiatePresetInternal(world, variant, position, options);
}

export function createMachineFromBlueprint(
  world: WorldState,
  blueprintId: string,
  position: Position,
  options: CreateEntityOptions = {},
): EntityState {
  assertFixtureEditing(world);
  const blueprint = world.catalog.machines[blueprintId];
  if (!blueprint) throw new ValidationError(`unknown machine blueprint ${blueprintId}`);
  const blueprintErrors = validateMachineBlueprint(blueprint, world.catalog);
  const positionErrors = validatePosition(position, world.config);
  if (blueprintErrors.length > 0 || positionErrors.length > 0) {
    throw new ValidationError(`cannot instantiate machine ${blueprintId}`, [...blueprintErrors, ...positionErrors]);
  }
  if (Object.keys(world.entities).length >= world.config.maxEntities) throw new ValidationError("entity limit reached");
  const entityId = options.id ?? nextEntityId(world, "machine");
  if (options.id) world.nextEntityOrdinal += 1;
  if (world.entities[entityId]) throw new ValidationError(`duplicate entity id ${entityId}`);
  const entity: EntityState = {
    id: entityId,
    definitionId: blueprint.semanticId,
    display: options.displayOverride ?? blueprint.display,
    shortLabel: blueprint.shortLabel,
    kind: "machine",
    position: { ...position },
    state: "alive",
    alive: true,
    structureMass: 1,
    maxStructureMass: 1,
    edibleMass: 0,
    integrity: 5,
    maxIntegrity: 5,
    heatCapacity: 12,
    resourceCapacities: {
      mass: zeroMass(),
      energy: { stored: 12, charge: 0, chemical: 0, heat: 12 },
    },
    maintenanceCost: 0,
    maintenanceFailureDamage: 1,
    inventory: emptyInventory(),
    energy: { stored: 8, charge: 0, chemical: 0, heat: 0 },
    capabilities: [],
    movement: { mode: "stationary", groundCost: 0, airCost: 0, maxDistancePerStep: 0 },
    senses: { dayRange: 0, darkRange: 0 },
    nutrition: { preference: [], foodAccess: "after_death", foodCapacity: 0 },
    combustion: {
      enabled: false,
      fuelResource: "fuel",
      ignitionTemperature: 999,
      fuelPerStep: 0,
      chemicalEnergyPerFuel: 0,
      heatPerFuel: 0,
      damagePerStep: 0,
    },
    moduleIds: [],
  };
  world.entities[entity.id] = entity;

  const moduleAliases = new Map<string, string>();
  for (const blueprintModule of blueprint.modules) {
    const moduleId = nextModuleId(world, entity.id, blueprintModule.alias);
    moduleAliases.set(blueprintModule.alias, moduleId);
    const definition = world.catalog.modules[blueprintModule.definitionId];
    if (!definition) throw new ValidationError(`unknown module ${blueprintModule.definitionId}`);
    world.modules[moduleId] = createModuleInstance(moduleId, definition.semanticId, entity.id, world);
    entity.moduleIds.push(moduleId);
  }
  for (const spec of blueprint.connections) {
    const fromModuleId = moduleAliases.get(spec.from.alias);
    const toModuleId = moduleAliases.get(spec.to.alias);
    if (!fromModuleId || !toModuleId) throw new ValidationError(`connection ${spec.id} has an unresolved alias`);
    const connection: Connection = {
      id: `${entity.id}:connection:${spec.id}`,
      from: { entityId: entity.id, moduleId: fromModuleId, portId: spec.from.portId },
      to: { entityId: entity.id, moduleId: toModuleId, portId: spec.to.portId },
      kind: spec.kind,
      rate: spec.rate,
      enabled: true,
    };
    const errors = validateConnection(connection, world.modules, world.catalog);
    if (errors.length > 0) throw new ValidationError(`invalid machine connection ${spec.id}`, errors);
    world.connections[connection.id] = connection;
  }
  return entity;
}

export function setFixtureResource(
  world: WorldState,
  ownerId: string,
  scope: "entity" | "module",
  resource: MassResource | EnergyResource,
  amount: number,
): void {
  assertFixtureEditing(world);
  if (!isSafeAmount(amount)) throw new ValidationError("fixture resource amount must be a non-negative safe integer");
  if (scope === "entity") {
    const entity = getEntity(world, ownerId);
    if (!entity) throw new ValidationError(`unknown entity ${ownerId}`);
    const capacities = getEntityCapacities(world, entity);
    if (resource in capacities.mass) {
      const massResource = resource as MassResource;
      if (amount > capacities.mass[massResource]) throw new ValidationError(`fixture amount exceeds ${resource} capacity`);
      entity.inventory.mass[massResource] = amount;
    } else {
      const energyResource = resource as EnergyResource;
      if (amount > capacities.energy[energyResource]) throw new ValidationError(`fixture amount exceeds ${resource} capacity`);
      entity.energy[energyResource] = amount;
    }
    return;
  }
  const module = getModule(world, ownerId);
  if (!module) throw new ValidationError(`unknown module ${ownerId}`);
  const definition = world.catalog.modules[module.definitionId];
  if (!definition) throw new ValidationError(`module ${ownerId} has an unknown definition`);
  if (resource in definition.resourceCapacities.mass) {
    const massResource = resource as MassResource;
    if (amount > definition.resourceCapacities.mass[massResource]) throw new ValidationError(`fixture amount exceeds ${resource} capacity`);
    module.inventory.mass[massResource] = amount;
  } else {
    const energyResource = resource as EnergyResource;
    if (amount > definition.resourceCapacities.energy[energyResource]) throw new ValidationError(`fixture amount exceeds ${resource} capacity`);
    module.energy[energyResource] = amount;
  }
}

export function addFixtureConnection(world: WorldState, connection: Connection): void {
  assertFixtureEditing(world);
  if (Object.keys(world.connections).length >= world.config.maxConnections) throw new ValidationError("connection limit reached");
  if (world.connections[connection.id]) throw new ValidationError(`duplicate connection id ${connection.id}`);
  const errors = validateConnection(connection, world.modules, world.catalog);
  if (errors.length > 0) throw new ValidationError("invalid fixture connection", errors);
  world.connections[connection.id] = { ...connection, enabled: connection.enabled ?? true };
}

export function setFixtureModuleState(
  world: WorldState,
  moduleId: string,
  state: Partial<Pick<ModuleInstance, "integrity" | "cooldown">>,
): void {
  assertFixtureEditing(world);
  const module = world.modules[moduleId];
  if (!module) throw new ValidationError(`unknown module ${moduleId}`);
  if (state.integrity !== undefined && !isSafeAmount(state.integrity)) throw new ValidationError("module integrity must be non-negative");
  if (state.cooldown !== undefined && !isSafeAmount(state.cooldown)) throw new ValidationError("module cooldown must be non-negative");
  if (state.integrity !== undefined) module.integrity = state.integrity;
  if (state.cooldown !== undefined) module.cooldown = state.cooldown;
}

export function setFixtureBodyState(
  world: WorldState,
  entityId: string,
  state: Partial<Pick<EntityState, "structureMass" | "maxStructureMass" | "edibleMass" | "integrity" | "maxIntegrity">>,
): void {
  assertFixtureEditing(world);
  const entity = world.entities[entityId];
  if (!entity) throw new ValidationError(`unknown entity ${entityId}`);
  const next = { ...entity, ...state };
  const errors = validateEntityConfiguration(next, next.moduleIds, world.catalog, world.modules);
  if (!isSafeAmount(next.structureMass) || !isSafeAmount(next.maxStructureMass, false) || next.edibleMass > next.structureMass) errors.push("invalid fixture body mass");
  if (!isSafeAmount(next.integrity) || !isSafeAmount(next.maxIntegrity, false) || next.integrity > next.maxIntegrity) errors.push("invalid fixture integrity");
  if (errors.length > 0) throw new ValidationError("invalid fixture body state", errors);
  if (state.structureMass !== undefined) entity.structureMass = state.structureMass;
  if (state.maxStructureMass !== undefined) entity.maxStructureMass = state.maxStructureMass;
  if (state.edibleMass !== undefined) entity.edibleMass = state.edibleMass;
  if (state.integrity !== undefined) entity.integrity = state.integrity;
  if (state.maxIntegrity !== undefined) entity.maxIntegrity = state.maxIntegrity;
}

export function finalizeFixture(world: WorldState): void {
  assertFixtureEditing(world);
  const errors = validateCatalog(world.catalog);
  for (const entity of Object.values(world.entities)) {
    errors.push(...validateEntityConfiguration(entity, entity.moduleIds, world.catalog, world.modules).map((error) => `${entity.id}: ${error}`));
  }
  for (const connection of Object.values(world.connections)) {
    errors.push(...validateConnection(connection, world.modules, world.catalog).map((error) => `${connection.id}: ${error}`));
  }
  if (errors.length > 0) throw new ValidationError("invalid initial fixture", errors);
  world.baselineMassTotal = totalMass(world);
  world.baselineEnergyTotal = totalEnergy(world);
  world.externalLedger.massIn = zeroMass();
  world.externalLedger.massOut = zeroMass();
  world.externalLedger.energyIn = zeroEnergy();
  world.externalLedger.energyOut = zeroEnergy();
  world.fixtureOpen = false;
  world.started = false;
  world.stateHash = stateHash(world);
}

export function queueExternalResource(world: WorldState, injection: Omit<ExternalResourceInjection, "id">): void {
  if (world.fixtureOpen) throw new ValidationError("finalize the fixture before external injection");
  assertExternalAmount(injection.amount);
  if (!world.entities[injection.ownerId] && !world.modules[injection.ownerId]) throw new ValidationError("external owner does not exist");
  if (injection.scope === "entity" && !world.entities[injection.ownerId]) throw new ValidationError("external entity owner does not exist");
  if (injection.scope === "module" && !world.modules[injection.ownerId]) throw new ValidationError("external module owner does not exist");
  if (world.pendingExternal.length >= world.config.maxPendingIntents) throw new ValidationError("external queue limit reached");
  world.pendingExternal.push({ ...injection, id: `external-${world.tick}-${world.pendingExternal.length + 1}` });
}

export function queueExternalSpawn(world: WorldState, injection: Omit<ExternalSpawnInjection, "id">): void {
  if (world.fixtureOpen) throw new ValidationError("finalize the fixture before external injection");
  if (!world.catalog.presets[injection.presetId]) throw new ValidationError(`unknown spawn preset ${injection.presetId}`);
  const errors = validatePosition(injection.position, world.config);
  if (errors.length > 0) throw new ValidationError("invalid external spawn position", errors);
  if (world.pendingExternal.length >= world.config.maxPendingIntents) throw new ValidationError("external queue limit reached");
  world.pendingExternal.push({ ...injection, id: `external-spawn-${world.tick}-${world.pendingExternal.length + 1}` });
}

export function fixtureModuleIds(world: WorldState, entityId: string): string[] {
  return [...(world.entities[entityId]?.moduleIds ?? [])];
}

function instantiatePresetInternal(
  world: WorldState,
  preset: PresetDefinition,
  position: Position,
  options: CreateEntityOptions,
): EntityState {
  if (Object.keys(world.entities).length >= world.config.maxEntities) throw new ValidationError("entity limit reached");
  if (world.catalog.modules && Object.keys(world.modules).length + preset.moduleIds.length > world.config.maxModules) {
    throw new ValidationError("module limit reached");
  }
  const entityId = options.id ?? nextEntityId(world, preset.semanticId);
  if (options.id) world.nextEntityOrdinal += 1;
  if (world.entities[entityId]) throw new ValidationError(`duplicate entity id ${entityId}`);
  const entity: EntityState = {
    id: entityId,
    definitionId: preset.semanticId,
    display: options.displayOverride ?? preset.display,
    shortLabel: preset.shortLabel,
    kind: preset.kind,
    position: { ...position },
    state: "alive",
    alive: true,
    structureMass: preset.base.structureMass,
    maxStructureMass: preset.base.maxStructureMass,
    edibleMass: preset.base.edibleMass,
    integrity: preset.base.integrity,
    maxIntegrity: preset.base.maxIntegrity,
    heatCapacity: preset.base.heatCapacity,
    resourceCapacities: cloneCapacities(preset.base.resourceCapacities),
    maintenanceCost: preset.base.maintenanceCost,
    maintenanceFailureDamage: preset.base.maintenanceFailureDamage,
    inventory: { mass: cloneMass(preset.base.inventory), energy: zeroEnergy() },
    energy: cloneEnergy(preset.base.energy),
    capabilities: [...preset.capabilities],
    movement: { ...preset.movement },
    senses: { ...preset.senses },
    nutrition: { ...preset.nutrition, preference: [...preset.nutrition.preference] },
    combustion: { ...preset.combustion },
    moduleIds: [],
  };
  world.entities[entity.id] = entity;
  for (const definitionId of preset.moduleIds) {
    const moduleId = nextModuleId(world, entity.id, definitionId);
    world.modules[moduleId] = createModuleInstance(moduleId, definitionId, entity.id, world);
    entity.moduleIds.push(moduleId);
  }
  return entity;
}

function createModuleInstance(id: string, definitionId: string, ownerEntityId: string, world: WorldState): ModuleInstance {
  const definition = world.catalog.modules[definitionId];
  if (!definition) throw new ValidationError(`unknown module ${definitionId}`);
  return {
    id,
    definitionId,
    ownerEntityId,
    integrity: definition.boundedParameters.moduleIntegrity ?? 3,
    cooldown: 0,
    inventory: emptyInventory(),
    energy: zeroEnergy(),
  };
}

function nextEntityId(world: WorldState, prefix: string): string {
  const id = `${prefix}-${world.config.seed}-${world.nextEntityOrdinal}`;
  world.nextEntityOrdinal += 1;
  return id;
}

function nextModuleId(world: WorldState, entityId: string, stableLabel = "component"): string {
  const prefix = `${entityId}:module:${stableLabel}`;
  let duplicateOrdinal = 1;
  let id = `${prefix}:${duplicateOrdinal}`;
  while (world.modules[id]) {
    duplicateOrdinal += 1;
    id = `${prefix}:${duplicateOrdinal}`;
  }
  world.nextModuleOrdinal += 1;
  return id;
}

export function nextConnectionId(world: WorldState): string {
  const id = `connection-${world.config.seed}-${world.nextConnectionOrdinal}`;
  world.nextConnectionOrdinal += 1;
  return id;
}

function cloneCatalog(catalog: Catalog): Catalog {
  return JSON.parse(JSON.stringify(catalog)) as Catalog;
}

function cloneCapacities(capacities: ResourceCapacities): ResourceCapacities {
  return { mass: cloneMass(capacities.mass), energy: cloneEnergy(capacities.energy) };
}

function assertFixtureEditing(world: WorldState): void {
  if (!world.fixtureOpen || world.started) throw new ValidationError("initial fixture is already sealed");
}

function assertExternalAmount(amount: number): void {
  if (!isSafeAmount(amount, false)) throw new ValidationError("external amount must be a positive safe integer");
}

export function moduleMass(world: WorldState, moduleId: string): number {
  const module = getModule(world, moduleId);
  return module ? moduleStructuralMass(world, module.definitionId) : 0;
}

/** Internal transaction helpers. They are intentionally separate from the
 * fixture-only public constructors so runtime creation still goes through the
 * engine's external-input accounting. */
export function instantiatePresetForTransaction(
  world: WorldState,
  presetId: string,
  position: Position,
  options: CreateEntityOptions = {},
): EntityState {
  const preset = world.catalog.presets[presetId];
  if (!preset) throw new ValidationError(`unknown preset ${presetId}`);
  const errors = [...validatePresetDefinition(preset, world.catalog), ...validatePosition(position, world.config)];
  if (errors.length > 0) throw new ValidationError(`cannot instantiate preset ${presetId}`, errors);
  return instantiatePresetInternal(world, preset, position, options);
}

export function attachModuleForTransaction(
  world: WorldState,
  entityId: string,
  moduleDefinitionId: string,
  existingModuleId?: string,
): ModuleInstance {
  const entity = world.entities[entityId];
  const definition = world.catalog.modules[moduleDefinitionId];
  if (!entity || !definition) throw new ValidationError("cannot attach an unknown entity or module definition");
  if (existingModuleId) {
    const existing = world.modules[existingModuleId];
    if (!existing || existing.definitionId !== moduleDefinitionId || existing.ownerEntityId) {
      throw new ValidationError("detached module is not available for reattachment");
    }
    existing.ownerEntityId = entityId;
    if (!entity.moduleIds.includes(existing.id)) entity.moduleIds.push(existing.id);
    for (const connection of Object.values(world.connections)) {
      if (connection.from.moduleId === existing.id || connection.to.moduleId === existing.id) connection.enabled = true;
    }
    return existing;
  }
  if (Object.keys(world.modules).length >= world.config.maxModules) throw new ValidationError("module limit reached");
  const moduleId = nextModuleId(world, entityId, moduleDefinitionId);
  const module = createModuleInstance(moduleId, moduleDefinitionId, entityId, world);
  world.modules[moduleId] = module;
  entity.moduleIds.push(moduleId);
  return module;
}
