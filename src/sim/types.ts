export const MASS_RESOURCES = [
  "water",
  "nutrient",
  "organic",
  "food",
  "fuel",
  "raw",
  "product",
  "scrap",
  "waste",
] as const;

export type MassResource = (typeof MASS_RESOURCES)[number];

export const ENERGY_RESOURCES = ["stored", "charge", "chemical", "heat"] as const;

export type EnergyResource = (typeof ENERGY_RESOURCES)[number];

export type Layer = "ground" | "air";
export type EntityKind = "plant" | "creature" | "machine";
export type LivingState = "alive" | "dead" | "debris";
export type ActivationMode = "automatic" | "intent";
export type Phase = "P0" | "P1" | "P2";
export type PortKind = "mass" | "energy" | "heat" | "control";
export type PortDirection = "in" | "out" | "bidirectional";
export type FoodGroup = "plant_tissue" | "animal_tissue" | "processed_food";
export type Capability =
  | "photosynthesize"
  | "digest_food"
  | "consume_plant"
  | "consume_animal"
  | "ground_move"
  | "lift"
  | "air_move"
  | "night_sense"
  | "charge_storage"
  | "electric_discharge"
  | "flammable"
  | "storage"
  | "process"
  | "automatic_machine"
  | "work_damage"
  | "edible_tissue";

export type MassLedger = Record<MassResource, number>;
export type EnergyLedger = Record<EnergyResource, number>;

export interface Inventory {
  mass: MassLedger;
  energy: EnergyLedger;
}

export interface ResourceCapacities {
  mass: MassLedger;
  energy: EnergyLedger;
}

export interface Position {
  x: number;
  y: number;
  layer: Layer;
}

export interface PortDefinition {
  id: string;
  kind: PortKind;
  direction: PortDirection;
}

export interface MaintenanceCost {
  stored: number;
}

export interface ModuleDefinition {
  semanticId: string;
  display: string;
  shortLabel: string;
  requiredSlotsOrPorts: PortDefinition[];
  materialCost: MassLedger;
  structuralMass: number;
  resourceCapacities: ResourceCapacities;
  maintenanceCost: MaintenanceCost;
  providedCapabilities: Capability[];
  referencedActionOrConversionTemplateIds: string[];
  boundedParameters: Record<string, number>;
  activation: ActivationMode;
  /** Modules sharing an exclusive slot cannot be mounted together. */
  exclusiveSlot?: string;
}

export interface BaseEntityDefinition {
  structureMass: number;
  maxStructureMass: number;
  integrity: number;
  maxIntegrity: number;
  edibleMass: number;
  energy: EnergyLedger;
  inventory: MassLedger;
  heatCapacity: number;
  resourceCapacities: ResourceCapacities;
  maintenanceCost: number;
  maintenanceFailureDamage: number;
}

export interface MovementProfile {
  mode: "stationary" | "ground" | "air";
  groundCost: number;
  airCost: number;
  maxDistancePerStep: number;
}

export interface SensoryProfile {
  dayRange: number;
  darkRange: number;
}

export interface NutritionProfile {
  preference: FoodGroup[];
  edibleAs?: FoodGroup;
  foodAccess: "alive" | "after_death" | "always";
  digestionTemplateId?: string;
  foodCapacity: number;
}

export interface CombustionProfile {
  enabled: boolean;
  fuelResource: MassResource;
  ignitionTemperature: number;
  fuelPerStep: number;
  chemicalEnergyPerFuel: number;
  heatPerFuel: number;
  damagePerStep: number;
}

export interface PresetDefinition {
  semanticId: string;
  display: string;
  shortLabel: string;
  kind: EntityKind;
  moduleIds: string[];
  base: BaseEntityDefinition;
  capabilities: Capability[];
  movement: MovementProfile;
  senses: SensoryProfile;
  nutrition: NutritionProfile;
  combustion: CombustionProfile;
}

export interface BlueprintModule {
  alias: string;
  definitionId: string;
}

export interface BlueprintPortRef {
  alias: string;
  portId: string;
}

export interface BlueprintConnection {
  id: string;
  from: BlueprintPortRef;
  to: BlueprintPortRef;
  kind: PortKind;
  rate: number;
}

export interface MachineBlueprint {
  semanticId: string;
  display: string;
  shortLabel: string;
  modules: BlueprintModule[];
  connections: BlueprintConnection[];
}

export interface GrowthTemplate {
  id: string;
  kind: "growth";
  inputMass: Pick<MassLedger, "water" | "nutrient">;
  structureOutput: number;
  edibleOutput: number;
  chemicalInput: number;
  storedOutput: number;
  heatOutput: number;
  integrityOutput: number;
  maxStructureOutput: number;
  rate: number;
}

export interface DigestionTemplate {
  id: string;
  kind: "digestion";
  inputFood: number;
  chemicalInput: number;
  storedOutput: number;
  heatOutput: number;
  wasteOutput: number;
  rate: number;
}

export interface ChargeTemplate {
  id: string;
  kind: "charge";
  storedInput: number;
  chargeOutput: number;
  heatOutput: number;
  rate: number;
}

export interface DischargeTemplate {
  id: string;
  kind: "discharge";
  chargeInput: number;
  heatOutput: number;
  rate: number;
}

export interface BurnTemplate {
  id: string;
  kind: "burn";
  fuelInput: number;
  chemicalInput: number;
  heatOutput: number;
  structuralDamage: number;
  scrapOutput: number;
  rate: number;
}

export interface ProcessTemplate {
  id: string;
  kind: "process";
  rawInput: number;
  productOutput: number;
  storedInput: number;
  heatOutput: number;
  rate: number;
}

export type ConversionTemplate =
  | GrowthTemplate
  | DigestionTemplate
  | ChargeTemplate
  | DischargeTemplate
  | BurnTemplate
  | ProcessTemplate;

export interface ActionTemplate {
  id: string;
  kind: "move" | "work_damage";
  storedCost: number;
  damage?: number;
  rate: number;
}

export interface Catalog {
  templates: Record<string, ConversionTemplate>;
  actions: Record<string, ActionTemplate>;
  modules: Record<string, ModuleDefinition>;
  presets: Record<string, PresetDefinition>;
  machines: Record<string, MachineBlueprint>;
}

export interface ModuleInstance {
  id: string;
  definitionId: string;
  ownerEntityId?: string;
  integrity: number;
  cooldown: number;
  inventory: Inventory;
  energy: EnergyLedger;
  capacityOverrides?: ResourceCapacities;
}

export interface EntityState {
  id: string;
  definitionId: string;
  display: string;
  shortLabel: string;
  kind: EntityKind;
  position: Position;
  state: LivingState;
  alive: boolean;
  structureMass: number;
  maxStructureMass: number;
  edibleMass: number;
  integrity: number;
  maxIntegrity: number;
  heatCapacity: number;
  resourceCapacities: ResourceCapacities;
  maintenanceCost: number;
  maintenanceFailureDamage: number;
  inventory: Inventory;
  energy: EnergyLedger;
  capabilities: Capability[];
  movement: MovementProfile;
  senses: SensoryProfile;
  nutrition: NutritionProfile;
  combustion: CombustionProfile;
  moduleIds: string[];
}

export interface PortRef {
  entityId: string;
  moduleId: string;
  portId: string;
}

export interface Connection {
  id: string;
  from: PortRef;
  to: PortRef;
  kind: PortKind;
  rate: number;
  enabled: boolean;
}

export interface ExternalLedger {
  massIn: MassLedger;
  massOut: MassLedger;
  energyIn: EnergyLedger;
  energyOut: EnergyLedger;
}

export interface ExternalResourceInjection {
  id: string;
  ownerId: string;
  scope: "entity" | "module";
  resourceKind: "mass" | "energy";
  resource: MassResource | EnergyResource;
  amount: number;
  label: string;
}

export interface ExternalSpawnInjection {
  id: string;
  presetId: string;
  entityId?: string;
  position: Position;
  displayOverride?: string;
}

export type ExternalInjection = ExternalResourceInjection | ExternalSpawnInjection;

export interface MoveIntent {
  type: "move";
  actorId: string;
  dx: number;
  dy: number;
  toLayer?: Layer;
}

export interface ConsumeIntent {
  type: "consume";
  actorId: string;
  targetId: string;
  amount?: number;
}

export interface AttackIntent {
  type: "attack";
  actorId: string;
  targetId: string;
}

export interface DischargeIntent {
  type: "discharge";
  actorId: string;
  targetId: string;
  amount?: number;
}

export interface ChargeIntent {
  type: "charge";
  actorId: string;
  amount?: number;
}

export interface ProcessIntent {
  type: "process";
  actorId: string;
  processorModuleId?: string;
}

export interface AttachModuleIntent {
  type: "attach-module";
  actorId: string;
  moduleDefinitionId: string;
  moduleId?: string;
}

export interface DetachModuleIntent {
  type: "detach-module";
  actorId: string;
  moduleId: string;
}

export interface DeconstructIntent {
  type: "deconstruct";
  actorId: string;
}

export interface ResizeModuleIntent {
  type: "resize-module";
  actorId: string;
  moduleId: string;
  resource: MassResource;
  newCapacity: number;
}

export type Intent =
  | MoveIntent
  | ConsumeIntent
  | AttackIntent
  | DischargeIntent
  | ChargeIntent
  | ProcessIntent
  | AttachModuleIntent
  | DetachModuleIntent
  | ResizeModuleIntent
  | DeconstructIntent;

export type ResourceClaim = {
  ownerId: string;
  scope: "entity" | "module" | "body";
  resource: MassResource | EnergyResource | "edible";
  amount: number;
};

export type Operation =
  | { kind: "invalid"; message: string }
  | { kind: "external-light"; entityId: string; amount: number }
  | {
      kind: "external-resource";
      ownerId: string;
      scope: "entity" | "module";
      resourceKind: "mass" | "energy";
      resource: MassResource | EnergyResource;
      amount: number;
      label: string;
    }
  | { kind: "spawn"; presetId: string; entityId: string; position: Position; displayOverride?: string }
  | { kind: "maintenance"; entityId: string; amount: number }
  | { kind: "deficiency"; entityId: string; damage: number; reason: string }
  | { kind: "grow"; entityId: string; templateId: string }
  | { kind: "digest"; entityId: string; templateId: string }
  | { kind: "burn"; entityId: string; templateId: string }
  | {
      kind: "heat-transfer";
      from: PortRef;
      to: PortRef;
      amount: number;
    }
  | {
      kind: "machine-process";
      entityId: string;
      processorModuleId: string;
      storageModuleId: string;
      templateId: string;
    }
  | {
      kind: "move";
      entityId: string;
      from: Position;
      to: Position;
      energyCost: number;
    }
  | { kind: "consume"; actorId: string; targetId: string; amount: number; chemicalTransfer: number }
  | { kind: "attack"; actorId: string; targetId: string; damage: number; energyCost: number }
  | { kind: "discharge"; actorId: string; moduleId: string; targetId: string; amount: number }
  | { kind: "charge"; entityId: string; moduleId: string; templateId: string }
  | { kind: "attach-module"; entityId: string; moduleDefinitionId: string; moduleId?: string }
  | { kind: "detach-module"; entityId: string; moduleId: string }
  | { kind: "resize-module"; entityId: string; moduleId: string; resource: MassResource; newCapacity: number }
  | { kind: "land"; entityId: string; reason: string }
  | { kind: "deconstruct"; entityId: string };

export interface Candidate {
  key: string;
  phase: Phase;
  ruleId: string;
  actorId?: string;
  targetId?: string;
  priority: number;
  exclusiveSlot?: string;
  claims: ResourceClaim[];
  writeKeys: string[];
  mergeWriteKeys?: string[];
  operation: Operation;
}

export interface SimulationEvent {
  id: string;
  tick: number;
  phase: Phase;
  outcome: "accepted" | "failed" | "external" | "system";
  ruleId: string;
  /** Deterministic candidate provenance for consumers that need exact intent matching. */
  candidateKey?: string;
  actorId?: string;
  targetId?: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  message: string;
  reason?: string;
}

export interface WorldConfig {
  width: number;
  height: number;
  seed: number;
  dayLength: number;
  lightEnergyPerStep: number;
  maxEntities: number;
  maxModules: number;
  maxConnections: number;
  maxCandidatesPerPhase: number;
  maxPendingIntents: number;
}

export interface WorldState {
  config: WorldConfig;
  catalog: Catalog;
  tick: number;
  phase: Phase;
  started: boolean;
  fixtureOpen: boolean;
  entities: Record<string, EntityState>;
  modules: Record<string, ModuleInstance>;
  connections: Record<string, Connection>;
  pendingIntents: Intent[];
  pendingExternal: ExternalInjection[];
  logs: SimulationEvent[];
  externalLedger: ExternalLedger;
  baselineMassTotal: number;
  baselineEnergyTotal: number;
  nextEntityOrdinal: number;
  nextModuleOrdinal: number;
  nextConnectionOrdinal: number;
  nextEventOrdinal: number;
  stateHash: string;
}

export interface PhaseReport {
  phase: Phase;
  candidateCount: number;
  accepted: number;
  rejected: number;
}

export interface StepReport {
  tick: number;
  phases: PhaseReport[];
  accepted: number;
  rejected: number;
  stateHash: string;
}

export interface Result<T> {
  ok: boolean;
  value?: T;
  error?: string;
}
