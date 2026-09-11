import { isSafeAmount, sumMass } from "./ledger";
import type {
  Catalog,
  Capability,
  Connection,
  EntityState,
  Intent,
  MachineBlueprint,
  ModuleDefinition,
  ModuleInstance,
  PortDefinition,
  PresetDefinition,
  ResourceCapacities,
  WorldConfig,
} from "./types";

const KNOWN_CAPABILITIES: Capability[] = [
  "photosynthesize",
  "digest_food",
  "consume_plant",
  "consume_animal",
  "ground_move",
  "lift",
  "air_move",
  "night_sense",
  "charge_storage",
  "electric_discharge",
  "flammable",
  "storage",
  "process",
  "automatic_machine",
  "work_damage",
  "edible_tissue",
];

export class ValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function validateCatalog(catalog: Catalog): string[] {
  const errors: string[] = [];
  for (const definition of Object.values(catalog.modules)) {
    errors.push(...validateModuleDefinition(definition, catalog).map((error) => `module ${definition.semanticId}: ${error}`));
  }
  for (const preset of Object.values(catalog.presets)) {
    errors.push(...validatePresetDefinition(preset, catalog).map((error) => `preset ${preset.semanticId}: ${error}`));
  }
  for (const blueprint of Object.values(catalog.machines)) {
    errors.push(...validateMachineBlueprint(blueprint, catalog).map((error) => `machine ${blueprint.semanticId}: ${error}`));
  }
  if (containsFunction(catalog)) {
    errors.push("catalog must not contain executable functions");
  }
  return errors;
}

export function validateModuleDefinition(definition: ModuleDefinition, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9_\-]*$/.test(definition.semanticId)) {
    errors.push("semantic_id must be a stable lowercase identifier");
  }
  if (!definition.display || !definition.shortLabel) {
    errors.push("display and short_label are required");
  }
  if (!isSafeAmount(definition.structuralMass, false)) {
    errors.push("structural_mass must be a positive safe integer");
  }
  if (sumMass(definition.materialCost) < definition.structuralMass) {
    errors.push("material_cost cannot create less mass than structural_mass");
  }
  errors.push(...validateLedger(definition.materialCost, "material_cost"));
  errors.push(...validateCapacities(definition.resourceCapacities));
  if (!isSafeAmount(definition.maintenanceCost.stored)) {
    errors.push("maintenance_cost.stored must be a non-negative safe integer");
  }
  if (!KNOWN_CAPABILITIES.every((capability) => capability !== undefined)) {
    errors.push("capability registry is invalid");
  }
  for (const capability of definition.providedCapabilities) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      errors.push(`unknown capability ${String(capability)}`);
    }
  }
  const portIds = new Set<string>();
  for (const port of definition.requiredSlotsOrPorts) {
    if (portIds.has(port.id)) {
      errors.push(`duplicate port ${port.id}`);
    }
    portIds.add(port.id);
    if (!port.id || !["mass", "energy", "heat", "control"].includes(port.kind)) {
      errors.push(`invalid port ${port.id}`);
    }
  }
  for (const templateId of definition.referencedActionOrConversionTemplateIds) {
    if (!catalog.templates[templateId] && !catalog.actions[templateId]) {
      errors.push(`unknown action or conversion template ${templateId}`);
    }
  }
  for (const [key, value] of Object.entries(definition.boundedParameters)) {
    if (!isSafeAmount(value)) {
      errors.push(`bounded parameter ${key} must be a non-negative safe integer`);
    }
  }
  if (!["automatic", "intent"].includes(definition.activation)) {
    errors.push("activation must be automatic or intent");
  }
  return errors;
}

export function validatePresetDefinition(definition: PresetDefinition, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (!definition.semanticId || !definition.display || !definition.shortLabel) {
    errors.push("semantic_id, display, and short_label are required");
  }
  if (!isSafeAmount(definition.base.structureMass, false)) errors.push("structureMass must be positive");
  if (!isSafeAmount(definition.base.maxStructureMass, false)) errors.push("maxStructureMass must be positive");
  if (definition.base.maxStructureMass < definition.base.structureMass) errors.push("maxStructureMass is below structureMass");
  if (!isSafeAmount(definition.base.integrity)) errors.push("integrity must be non-negative");
  if (!isSafeAmount(definition.base.maxIntegrity, false)) errors.push("maxIntegrity must be positive");
  if (definition.base.integrity > definition.base.maxIntegrity) errors.push("integrity is above maxIntegrity");
  if (!isSafeAmount(definition.base.edibleMass) || definition.base.edibleMass > definition.base.structureMass) {
    errors.push("edibleMass must be between zero and structureMass");
  }
  if (!isSafeAmount(definition.base.heatCapacity, false)) errors.push("heatCapacity must be positive");
  if (!isSafeAmount(definition.base.maintenanceCost)) errors.push("maintenanceCost must be non-negative");
  if (!isSafeAmount(definition.base.maintenanceFailureDamage)) errors.push("maintenanceFailureDamage must be non-negative");
  errors.push(...validateLedger(definition.base.inventory, "base.inventory"));
  errors.push(...validateLedger(definition.base.energy, "base.energy"));
  errors.push(...validateCapacities(definition.base.resourceCapacities));

  const moduleIds = new Set<string>();
  const slots = new Set<string>();
  const provided = new Set<Capability>(definition.capabilities);
  for (const moduleId of definition.moduleIds) {
    const module = catalog.modules[moduleId];
    if (!module) {
      errors.push(`unknown module ${moduleId}`);
      continue;
    }
    if (moduleIds.has(moduleId) && module.exclusiveSlot) {
      errors.push(`duplicate exclusive module ${moduleId}`);
    }
    moduleIds.add(moduleId);
    if (module.exclusiveSlot && slots.has(module.exclusiveSlot)) {
      errors.push(`exclusive slot collision ${module.exclusiveSlot}`);
    }
    if (module.exclusiveSlot) slots.add(module.exclusiveSlot);
    for (const capability of module.providedCapabilities) provided.add(capability);
  }
  const capacities = aggregateCapacities(definition.base.resourceCapacities, definition.moduleIds, catalog);
  for (const [resource, amount] of Object.entries(definition.base.inventory)) {
    if (amount > capacities.mass[resource as keyof typeof capacities.mass]) {
      errors.push(`initial mass ${resource} exceeds capacity`);
    }
  }
  for (const [resource, amount] of Object.entries(definition.base.energy)) {
    if (amount > capacities.energy[resource as keyof typeof capacities.energy]) {
      errors.push(`initial energy ${resource} exceeds capacity`);
    }
  }
  if (definition.movement.mode === "ground" && !provided.has("ground_move")) {
    errors.push("ground movement requires ground_move capability");
  }
  if (definition.movement.mode === "air" && (!provided.has("air_move") || !provided.has("lift"))) {
    errors.push("air movement requires air_move and lift capabilities");
  }
  if (!isSafeAmount(definition.movement.groundCost) || !isSafeAmount(definition.movement.airCost)) {
    errors.push("movement costs must be non-negative safe integers");
  }
  if (!isSafeAmount(definition.movement.maxDistancePerStep)) errors.push("movement distance must be non-negative");
  if (!isSafeAmount(definition.senses.dayRange) || !isSafeAmount(definition.senses.darkRange)) {
    errors.push("sensory ranges must be non-negative");
  }
  if (definition.nutrition.digestionTemplateId && !catalog.templates[definition.nutrition.digestionTemplateId]) {
    errors.push(`unknown digestion template ${definition.nutrition.digestionTemplateId}`);
  }
  if (!isSafeAmount(definition.nutrition.foodCapacity)) errors.push("foodCapacity must be non-negative");
  if (definition.combustion.enabled) {
    if (!provided.has("flammable")) errors.push("combustion requires flammable capability");
    if (!isSafeAmount(definition.combustion.ignitionTemperature)) errors.push("ignitionTemperature must be non-negative");
    if (!isSafeAmount(definition.combustion.fuelPerStep)) errors.push("fuelPerStep must be non-negative");
    if (!isSafeAmount(definition.combustion.chemicalEnergyPerFuel)) errors.push("chemicalEnergyPerFuel must be non-negative");
    if (!isSafeAmount(definition.combustion.heatPerFuel)) errors.push("heatPerFuel must be non-negative");
    if (!isSafeAmount(definition.combustion.damagePerStep)) errors.push("damagePerStep must be non-negative");
  }
  return errors;
}

export function validateMachineBlueprint(blueprint: MachineBlueprint, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (!blueprint.semanticId || !blueprint.display || !blueprint.shortLabel) {
    errors.push("semantic_id, display, and short_label are required");
  }
  const aliases = new Set<string>();
  const ports = new Map<string, PortDefinition>();
  for (const module of blueprint.modules) {
    if (aliases.has(module.alias)) errors.push(`duplicate module alias ${module.alias}`);
    aliases.add(module.alias);
    const definition = catalog.modules[module.definitionId];
    if (!definition) {
      errors.push(`unknown module ${module.definitionId}`);
      continue;
    }
    for (const port of definition.requiredSlotsOrPorts) ports.set(`${module.alias}:${port.id}`, port);
  }
  const connectionIds = new Set<string>();
  for (const connection of blueprint.connections) {
    if (connectionIds.has(connection.id)) errors.push(`duplicate connection ${connection.id}`);
    connectionIds.add(connection.id);
    const from = ports.get(`${connection.from.alias}:${connection.from.portId}`);
    const to = ports.get(`${connection.to.alias}:${connection.to.portId}`);
    if (!from || !to) {
      errors.push(`connection ${connection.id} references an unknown port`);
      continue;
    }
    if (!compatibleDirection(from.direction, to.direction)) errors.push(`connection ${connection.id} has invalid direction`);
    if (from.kind !== connection.kind || to.kind !== connection.kind) errors.push(`connection ${connection.id} kind mismatch`);
    if (!isSafeAmount(connection.rate, false)) errors.push(`connection ${connection.id} rate must be positive`);
  }
  return errors;
}

export function validateConnection(connection: Connection, worldModules: Record<string, ModuleInstance>, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (!isSafeAmount(connection.rate, false)) errors.push("connection rate must be positive");
  const fromModule = worldModules[connection.from.moduleId];
  const toModule = worldModules[connection.to.moduleId];
  if (!fromModule || !toModule) return [...errors, "connection references a missing module"];
  const fromDefinition = catalog.modules[fromModule.definitionId];
  const toDefinition = catalog.modules[toModule.definitionId];
  const from = fromDefinition?.requiredSlotsOrPorts.find((port) => port.id === connection.from.portId);
  const to = toDefinition?.requiredSlotsOrPorts.find((port) => port.id === connection.to.portId);
  if (!from || !to) return [...errors, "connection references a missing port"];
  if (from.kind !== connection.kind || to.kind !== connection.kind) errors.push("connection kind does not match ports");
  if (!compatibleDirection(from.direction, to.direction)) errors.push("connection direction is not output to input");
  return errors;
}

export function validateWorldConfig(config: WorldConfig): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    const allowsZero = key === "seed" || key === "lightEnergyPerStep";
    if (!isSafeAmount(value as number, !allowsZero)) errors.push(`config.${key} must be a ${allowsZero ? "non-negative" : "positive"} safe integer`);
  }
  if (config.width < 1 || config.height < 1) errors.push("world dimensions must be positive");
  return errors;
}

export function validatePosition(position: { x: number; y: number }, config: WorldConfig): string[] {
  const errors: string[] = [];
  if (!isSafeAmount(position.x) || position.x >= config.width) errors.push("x is outside the world");
  if (!isSafeAmount(position.y) || position.y >= config.height) errors.push("y is outside the world");
  return errors;
}

export function validateIntent(intent: Intent, world: { config: WorldConfig }): string[] {
  const errors: string[] = [];
  if (!intent.actorId) errors.push("actorId is required");
  if (intent.type === "move") {
    if (!Number.isInteger(intent.dx) || !Number.isInteger(intent.dy)) errors.push("move delta must be integer");
    if (Math.abs(intent.dx) + Math.abs(intent.dy) > 1 && !(intent.dx === 0 && intent.dy === 0)) {
      errors.push("only orthogonal adjacent movement is supported");
    }
  }
  if ("amount" in intent && intent.amount !== undefined && !isSafeAmount(intent.amount, false)) {
    errors.push("amount must be a positive safe integer");
  }
  if (intent.type === "attach-module" && !intent.moduleDefinitionId) errors.push("moduleDefinitionId is required");
  if (intent.type === "detach-module" && !intent.moduleId) errors.push("moduleId is required");
  if (intent.type === "resize-module" && (!isSafeAmount(intent.newCapacity) || !intent.resource)) errors.push("new capacity must be a non-negative safe integer");
  if (errors.length > 0 && world.config.maxPendingIntents < 1) errors.push("intent queue is disabled");
  return errors;
}

function validateLedger(ledger: Record<string, number>, label: string): string[] {
  return Object.entries(ledger)
    .filter(([, value]) => !isSafeAmount(value))
    .map(([key]) => `${label}.${key} must be a non-negative safe integer`);
}

function validateCapacities(capacities: ResourceCapacities): string[] {
  return [...validateLedger(capacities.mass, "resourceCapacities.mass"), ...validateLedger(capacities.energy, "resourceCapacities.energy")];
}

function aggregateCapacities(base: ResourceCapacities, moduleIds: string[], catalog: Catalog): ResourceCapacities {
  const capacities: ResourceCapacities = {
    mass: { ...base.mass },
    energy: { ...base.energy },
  };
  for (const moduleId of moduleIds) {
    const definition = catalog.modules[moduleId];
    if (!definition) continue;
    for (const [resource, amount] of Object.entries(definition.resourceCapacities.mass)) {
      capacities.mass[resource as keyof typeof capacities.mass] += amount;
    }
    for (const [resource, amount] of Object.entries(definition.resourceCapacities.energy)) {
      capacities.energy[resource as keyof typeof capacities.energy] += amount;
    }
  }
  return capacities;
}

function compatibleDirection(from: PortDefinition["direction"], to: PortDefinition["direction"]): boolean {
  return (from === "out" || from === "bidirectional") && (to === "in" || to === "bidirectional");
}

function containsFunction(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsFunction);
  return false;
}

export function validateEntityConfiguration(
  entity: EntityState,
  moduleIds: string[],
  catalog: Catalog,
  instances: Record<string, { definitionId: string }> = {},
): string[] {
  const errors: string[] = [];
  const slots = new Set<string>();
  const capabilities = new Set<Capability>(entity.capabilities);
  for (const moduleId of moduleIds) {
    const instance = instances[moduleId];
    const module = catalog.modules[instance?.definitionId ?? moduleId];
    if (!module) {
      errors.push(`unknown module ${moduleId}`);
      continue;
    }
    if (module.exclusiveSlot && slots.has(module.exclusiveSlot)) errors.push(`exclusive slot collision ${module.exclusiveSlot}`);
    if (module.exclusiveSlot) slots.add(module.exclusiveSlot);
    for (const capability of module.providedCapabilities) capabilities.add(capability);
  }
  if (entity.movement.mode === "ground" && !capabilities.has("ground_move")) errors.push("ground_move capability is required");
  if (entity.movement.mode === "air" && (!capabilities.has("air_move") || !capabilities.has("lift"))) {
    errors.push("air_move and lift capabilities are required");
  }
  if (entity.nutrition.digestionTemplateId && !capabilities.has("digest_food")) errors.push("digest_food capability is required");
  if (entity.combustion.enabled && !capabilities.has("flammable")) errors.push("flammable capability is required");
  return errors;
}
