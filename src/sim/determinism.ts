import type { WorldState } from "./types";

export function cloneWorld(world: WorldState): WorldState {
  return JSON.parse(JSON.stringify(world)) as WorldState;
}

export function replaceWorld(target: WorldState, source: WorldState): void {
  const cloned = cloneWorld(source);
  const entityRecord = target.entities;
  const moduleRecord = target.modules;
  const connectionRecord = target.connections;
  Object.assign(target, cloned);
  mergeRecord(entityRecord, cloned.entities);
  mergeRecord(moduleRecord, cloned.modules);
  mergeRecord(connectionRecord, cloned.connections);
  target.entities = entityRecord;
  target.modules = moduleRecord;
  target.connections = connectionRecord;
}

function mergeRecord<T extends object>(target: Record<string, T>, source: Record<string, T>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (target[key]) {
      for (const existingKey of Object.keys(target[key])) {
        if (!(existingKey in value)) delete (target[key] as Record<string, unknown>)[existingKey];
      }
      Object.assign(target[key], value);
    }
    else target[key] = value;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function fnv1a(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function physicalProjection(world: WorldState): unknown {
  const entities = Object.values(world.entities)
    .map((entity) => ({
      id: entity.id,
      position: entity.position,
      state: entity.state,
      alive: entity.alive,
      structureMass: entity.structureMass,
      maxStructureMass: entity.maxStructureMass,
      edibleMass: entity.edibleMass,
      integrity: entity.integrity,
      maxIntegrity: entity.maxIntegrity,
      heatCapacity: entity.heatCapacity,
      inventory: entity.inventory,
      energy: entity.energy,
      moduleIds: [...entity.moduleIds].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const modules = Object.values(world.modules)
    .map((module) => ({
      id: module.id,
      ownerEntityId: module.ownerEntityId,
      integrity: module.integrity,
      cooldown: module.cooldown,
      inventory: module.inventory,
      energy: module.energy,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const connections = Object.values(world.connections)
    .map((connection) => ({
      id: connection.id,
      from: connection.from,
      to: connection.to,
      kind: connection.kind,
      rate: connection.rate,
      enabled: connection.enabled,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    tick: world.tick,
    phase: world.phase,
    entities,
    modules,
    connections,
    externalLedger: world.externalLedger,
  };
}

export function stateHash(world: WorldState): string {
  return fnv1a(JSON.stringify(canonicalize(physicalProjection(world))));
}

export function stableHash(input: string): string {
  return fnv1a(input);
}
