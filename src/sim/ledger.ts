import {
  ENERGY_RESOURCES,
  MASS_RESOURCES,
  type EnergyLedger,
  type EnergyResource,
  type Inventory,
  type MassLedger,
  type MassResource,
  type WorldState,
} from "./types";

export const MAX_SAFE_LEDGER_VALUE = Number.MAX_SAFE_INTEGER;

export function zeroMass(): MassLedger {
  return Object.fromEntries(MASS_RESOURCES.map((resource) => [resource, 0])) as MassLedger;
}

export function zeroEnergy(): EnergyLedger {
  return Object.fromEntries(ENERGY_RESOURCES.map((resource) => [resource, 0])) as EnergyLedger;
}

export function emptyInventory(): Inventory {
  return { mass: zeroMass(), energy: zeroEnergy() };
}

export function cloneMass(source: MassLedger): MassLedger {
  return { ...source };
}

export function cloneEnergy(source: EnergyLedger): EnergyLedger {
  return { ...source };
}

export function cloneInventory(source: Inventory): Inventory {
  return { mass: cloneMass(source.mass), energy: cloneEnergy(source.energy) };
}

export function addMass(target: MassLedger, source: Partial<Record<MassResource, number>>): void {
  for (const resource of MASS_RESOURCES) {
    const amount = source[resource] ?? 0;
    target[resource] += amount;
  }
}

export function addEnergy(target: EnergyLedger, source: Partial<Record<EnergyResource, number>>): void {
  for (const resource of ENERGY_RESOURCES) {
    const amount = source[resource] ?? 0;
    target[resource] += amount;
  }
}

export function subtractMass(target: MassLedger, source: Partial<Record<MassResource, number>>): void {
  for (const resource of MASS_RESOURCES) {
    const amount = source[resource] ?? 0;
    target[resource] -= amount;
  }
}

export function subtractEnergy(target: EnergyLedger, source: Partial<Record<EnergyResource, number>>): void {
  for (const resource of ENERGY_RESOURCES) {
    const amount = source[resource] ?? 0;
    target[resource] -= amount;
  }
}

export function sumMass(source: MassLedger): number {
  return MASS_RESOURCES.reduce((total, resource) => total + source[resource], 0);
}

export function sumEnergy(source: EnergyLedger): number {
  return ENERGY_RESOURCES.reduce((total, resource) => total + source[resource], 0);
}

export function canAffordMass(source: MassLedger, resource: MassResource, amount: number): boolean {
  return source[resource] >= amount;
}

export function canAffordEnergy(source: EnergyLedger, resource: EnergyResource, amount: number): boolean {
  return source[resource] >= amount;
}

export function isSafeAmount(value: number, allowZero = true): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number.isFinite(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= MAX_SAFE_LEDGER_VALUE
  );
}

export function assertLedger(ledger: MassLedger | EnergyLedger, label: string): void {
  for (const [key, value] of Object.entries(ledger)) {
    if (!isSafeAmount(value)) {
      throw new Error(`${label}.${key} must be a non-negative safe integer`);
    }
  }
}

export function massTotals(world: WorldState): MassLedger {
  const totals = zeroMass();
  for (const entity of Object.values(world.entities)) {
    totals.organic += entity.structureMass;
    addMass(totals, entity.inventory.mass);
  }
  for (const module of Object.values(world.modules)) {
    totals.organic += moduleStructuralMass(world, module.definitionId);
    addMass(totals, module.inventory.mass);
  }
  return totals;
}

export function energyTotals(world: WorldState): EnergyLedger {
  const totals = zeroEnergy();
  for (const entity of Object.values(world.entities)) {
    addEnergy(totals, entity.energy);
  }
  for (const module of Object.values(world.modules)) {
    addEnergy(totals, module.energy);
  }
  return totals;
}

export function totalMass(world: WorldState): number {
  return sumMass(massTotals(world));
}

export function totalEnergy(world: WorldState): number {
  return sumEnergy(energyTotals(world));
}

export function moduleStructuralMass(world: WorldState, definitionId: string): number {
  return world.catalog.modules[definitionId]?.structuralMass ?? 0;
}

export function expectedMassTotal(world: WorldState): number {
  return world.baselineMassTotal + sumMass(world.externalLedger.massIn) - sumMass(world.externalLedger.massOut);
}

export function expectedEnergyTotal(world: WorldState): number {
  return (
    world.baselineEnergyTotal +
    sumEnergy(world.externalLedger.energyIn) -
    sumEnergy(world.externalLedger.energyOut)
  );
}

export interface BalanceReport {
  actualMass: number;
  expectedMass: number;
  actualEnergy: number;
  expectedEnergy: number;
  massDelta: number;
  energyDelta: number;
}

export function balanceReport(world: WorldState): BalanceReport {
  const actualMass = totalMass(world);
  const expectedMass = expectedMassTotal(world);
  const actualEnergy = totalEnergy(world);
  const expectedEnergy = expectedEnergyTotal(world);
  return {
    actualMass,
    expectedMass,
    actualEnergy,
    expectedEnergy,
    massDelta: actualMass - expectedMass,
    energyDelta: actualEnergy - expectedEnergy,
  };
}

export function assertWorldBalance(world: WorldState): void {
  const report = balanceReport(world);
  if (report.massDelta !== 0 || report.energyDelta !== 0) {
    throw new Error(
      `world balance violated (mass ${report.massDelta}, energy ${report.energyDelta})`,
    );
  }
}
