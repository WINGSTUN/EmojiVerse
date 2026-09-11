import { validateMachineBlueprint, validateModuleDefinition, validatePresetDefinition } from "./validation";
import type { Catalog, MachineBlueprint, ModuleDefinition, PresetDefinition, Result, WorldState } from "./types";

export interface CreatureDefinitionPackage {
  version: 1;
  kind: "creature";
  preset: PresetDefinition;
  modules: ModuleDefinition[];
}

export interface MachineDefinitionPackage {
  version: 1;
  kind: "machine";
  blueprint: MachineBlueprint;
  modules: ModuleDefinition[];
}

export type DefinitionPackage = CreatureDefinitionPackage | MachineDefinitionPackage;

export function exportCreatureDefinition(world: WorldState, entityId: string): Result<string> {
  const entity = world.entities[entityId];
  if (!entity) return { ok: false, error: `unknown entity ${entityId}` };
  const preset = world.catalog.presets[entity.definitionId];
  if (!preset) return { ok: false, error: `definition ${entity.definitionId} is not exportable` };
  const modules = preset.moduleIds
    .map((moduleId) => world.catalog.modules[moduleId])
    .filter((module): module is ModuleDefinition => Boolean(module));
  return { ok: true, value: JSON.stringify({ version: 1, kind: "creature", preset, modules }, null, 2) };
}

export function exportMachineDefinition(world: WorldState, entityId: string): Result<string> {
  const entity = world.entities[entityId];
  if (!entity) return { ok: false, error: `unknown entity ${entityId}` };
  const blueprint = world.catalog.machines[entity.definitionId];
  if (!blueprint) return { ok: false, error: `definition ${entity.definitionId} is not exportable` };
  const modules = blueprint.modules
    .map((module) => world.catalog.modules[module.definitionId])
    .filter((module): module is ModuleDefinition => Boolean(module));
  return { ok: true, value: JSON.stringify({ version: 1, kind: "machine", blueprint, modules }, null, 2) };
}

export function importDefinition(world: WorldState, raw: string): Result<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "definition JSON is invalid" };
  }
  const packageResult = parseDefinitionPackage(parsed);
  if (!packageResult.ok || !packageResult.value) return { ok: false, error: packageResult.error ?? "definition shape is invalid" };
  const definitionPackage = packageResult.value;
  const candidateCatalog = cloneCatalog(world.catalog);
  for (const module of definitionPackage.modules) {
    const moduleErrors = validateModuleDefinition(module, candidateCatalog);
    if (moduleErrors.length > 0) return { ok: false, error: `module ${module.semanticId}: ${moduleErrors.join("; ")}` };
    const existing = candidateCatalog.modules[module.semanticId];
    if (existing && JSON.stringify(existing) !== JSON.stringify(module)) return { ok: false, error: `module id conflict: ${module.semanticId}` };
    candidateCatalog.modules[module.semanticId] = module;
  }
  if (definitionPackage.kind === "creature") {
    const errors = validatePresetDefinition(definitionPackage.preset, candidateCatalog);
    if (errors.length > 0) return { ok: false, error: `preset ${definitionPackage.preset.semanticId}: ${errors.join("; ")}` };
    const existing = candidateCatalog.presets[definitionPackage.preset.semanticId];
    if (existing && JSON.stringify(existing) !== JSON.stringify(definitionPackage.preset)) return { ok: false, error: `preset id conflict: ${definitionPackage.preset.semanticId}` };
    candidateCatalog.presets[definitionPackage.preset.semanticId] = definitionPackage.preset;
    world.catalog = candidateCatalog;
    return { ok: true, value: `creature:${definitionPackage.preset.semanticId}` };
  }
  const blueprintErrors = validateMachineBlueprint(definitionPackage.blueprint, candidateCatalog);
  if (blueprintErrors.length > 0) return { ok: false, error: `machine ${definitionPackage.blueprint.semanticId}: ${blueprintErrors.join("; ")}` };
  const existing = candidateCatalog.machines[definitionPackage.blueprint.semanticId];
  if (existing && JSON.stringify(existing) !== JSON.stringify(definitionPackage.blueprint)) return { ok: false, error: `machine id conflict: ${definitionPackage.blueprint.semanticId}` };
  candidateCatalog.machines[definitionPackage.blueprint.semanticId] = definitionPackage.blueprint;
  world.catalog = candidateCatalog;
  return { ok: true, value: `machine:${definitionPackage.blueprint.semanticId}` };
}

function parseDefinitionPackage(value: unknown): Result<DefinitionPackage> {
  if (!isRecord(value) || value.version !== 1 || (value.kind !== "creature" && value.kind !== "machine") || !Array.isArray(value.modules)) {
    return { ok: false, error: "definition must be a version 1 creature or machine package" };
  }
  if (!hasOnlyKeys(value, value.kind === "creature" ? ["version", "kind", "preset", "modules"] : ["version", "kind", "blueprint", "modules"])) {
    return { ok: false, error: "definition contains unsupported executable or external fields" };
  }
  if (value.modules.some((module) => !isRecord(module))) return { ok: false, error: "module package contains an invalid value" };
  if (value.kind === "creature" && isRecord(value.preset)) {
    return { ok: true, value: { version: 1, kind: "creature", preset: value.preset as unknown as PresetDefinition, modules: value.modules as unknown as ModuleDefinition[] } };
  }
  if (value.kind === "machine" && isRecord(value.blueprint)) {
    return { ok: true, value: { version: 1, kind: "machine", blueprint: value.blueprint as unknown as MachineBlueprint, modules: value.modules as unknown as ModuleDefinition[] } };
  }
  return { ok: false, error: "definition payload is missing its typed preset or blueprint" };
}

function cloneCatalog(catalog: Catalog): Catalog {
  return JSON.parse(JSON.stringify(catalog)) as Catalog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
