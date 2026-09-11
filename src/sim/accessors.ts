import type {
  Capability,
  EntityState,
  EnergyResource,
  MassResource,
  ModuleDefinition,
  ModuleInstance,
  PortDefinition,
  PortRef,
  ResourceCapacities,
  WorldState,
} from "./types";

export function getEntity(world: WorldState, entityId: string): EntityState | undefined {
  return world.entities[entityId];
}

export function getModule(world: WorldState, moduleId: string): ModuleInstance | undefined {
  return world.modules[moduleId];
}

export function getModuleDefinition(world: WorldState, moduleId: string): ModuleDefinition | undefined {
  const module = getModule(world, moduleId);
  return module ? world.catalog.modules[module.definitionId] : undefined;
}

export function getEntityModules(world: WorldState, entity: EntityState): ModuleInstance[] {
  return entity.moduleIds.map((moduleId) => world.modules[moduleId]).filter((module): module is ModuleInstance => Boolean(module));
}

export function getEntityModuleDefinitions(world: WorldState, entity: EntityState): ModuleDefinition[] {
  return getEntityModules(world, entity)
    .map((module) => world.catalog.modules[module.definitionId])
    .filter((definition): definition is ModuleDefinition => Boolean(definition));
}

export function getEntityCapabilities(world: WorldState, entity: EntityState): Set<Capability> {
  const capabilities = new Set<Capability>(entity.capabilities);
  for (const module of getEntityModules(world, entity)) {
    if (module.integrity <= 0 || module.cooldown > 0) continue;
    for (const capability of world.catalog.modules[module.definitionId]?.providedCapabilities ?? []) capabilities.add(capability);
  }
  return capabilities;
}

export function hasCapability(world: WorldState, entity: EntityState, capability: Capability): boolean {
  return getEntityCapabilities(world, entity).has(capability);
}

export function findModuleWithCapability(world: WorldState, entity: EntityState, capability: Capability): ModuleInstance | undefined {
  return getEntityModules(world, entity).find((module) => {
    const definition = world.catalog.modules[module.definitionId];
    return module.integrity > 0 && module.cooldown === 0 && definition?.providedCapabilities.includes(capability);
  });
}

export function getEntityCapacities(world: WorldState, entity: EntityState): ResourceCapacities {
  const capacities: ResourceCapacities = {
    mass: { ...entity.resourceCapacities.mass },
    energy: { ...entity.resourceCapacities.energy },
  };
  for (const module of getEntityModules(world, entity)) {
    const definition = world.catalog.modules[module.definitionId];
    if (!definition) continue;
    const moduleCapacities = getModuleCapacities(world, module.id);
    for (const [resource, amount] of Object.entries(moduleCapacities.mass)) {
      capacities.mass[resource as MassResource] += amount;
    }
    for (const [resource, amount] of Object.entries(moduleCapacities.energy)) {
      capacities.energy[resource as EnergyResource] += amount;
    }
  }
  return capacities;
}

export function getModuleCapacities(world: WorldState, moduleId: string): ResourceCapacities {
  const module = world.modules[moduleId];
  const definition = module ? world.catalog.modules[module.definitionId] : undefined;
  if (!definition) return { mass: {} as ResourceCapacities["mass"], energy: {} as ResourceCapacities["energy"] };
  return {
    mass: { ...(module.capacityOverrides?.mass ?? definition.resourceCapacities.mass) },
    energy: { ...(module.capacityOverrides?.energy ?? definition.resourceCapacities.energy) },
  };
}

export function entityMass(world: WorldState, entity: EntityState): number {
  const inventoryMass = Object.values(entity.inventory.mass).reduce((total, amount) => total + amount, 0);
  const moduleMass = getEntityModules(world, entity).reduce(
    (total, module) => total +
      (world.catalog.modules[module.definitionId]?.structuralMass ?? 0) +
      Object.values(module.inventory.mass).reduce((moduleTotal, amount) => moduleTotal + amount, 0),
    0,
  );
  return entity.structureMass + inventoryMass + moduleMass;
}

export function entityHeat(world: WorldState, entity: EntityState): number {
  return entity.energy.heat + getEntityModules(world, entity).reduce((total, module) => total + module.energy.heat, 0);
}

export function entityHeatCapacity(world: WorldState, entity: EntityState): number {
  return entity.heatCapacity + getEntityModules(world, entity).reduce(
    (total, module) => total + (world.catalog.modules[module.definitionId]?.boundedParameters.heatCapacity ?? 0),
    0,
  );
}

export function entityTemperature(world: WorldState, entity: EntityState): number {
  const capacity = entityHeatCapacity(world, entity);
  return capacity > 0 ? entityHeat(world, entity) / capacity : Number.POSITIVE_INFINITY;
}

export function getModuleParameter(world: WorldState, entity: EntityState, parameter: string, fallback = 0): number {
  const values = getEntityModuleDefinitions(world, entity)
    .map((definition) => definition.boundedParameters[parameter])
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : fallback;
}

export function distance(a: EntityState, b: EntityState): number {
  if (a.position.layer !== b.position.layer) return Number.POSITIVE_INFINITY;
  return Math.abs(a.position.x - b.position.x) + Math.abs(a.position.y - b.position.y);
}

export function isAdjacent(a: EntityState, b: EntityState): boolean {
  return distance(a, b) === 1;
}

export function isSameCell(a: EntityState, b: EntityState): boolean {
  return a.position.layer === b.position.layer && a.position.x === b.position.x && a.position.y === b.position.y;
}

export function isInBounds(world: WorldState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.config.width && y < world.config.height;
}

export function portDefinition(world: WorldState, ref: PortRef): PortDefinition | undefined {
  return getModuleDefinition(world, ref.moduleId)?.requiredSlotsOrPorts.find((port) => port.id === ref.portId);
}

export function activeConnections(world: WorldState): Array<WorldState["connections"][string]> {
  return Object.values(world.connections).filter((connection) => {
    if (!connection.enabled) return false;
    const fromModule = world.modules[connection.from.moduleId];
    const toModule = world.modules[connection.to.moduleId];
    return Boolean(
      fromModule &&
        toModule &&
        fromModule.ownerEntityId === connection.from.entityId &&
        toModule.ownerEntityId === connection.to.entityId,
    );
  });
}

export function hasConnection(world: WorldState, fromModuleId: string, toModuleId: string, kind: string): boolean {
  return activeConnections(world).some(
    (connection) => connection.from.moduleId === fromModuleId && connection.to.moduleId === toModuleId && connection.kind === kind,
  );
}

export function connectionTouchesModule(connection: WorldState["connections"][string], moduleId: string): boolean {
  return connection.from.moduleId === moduleId || connection.to.moduleId === moduleId;
}
