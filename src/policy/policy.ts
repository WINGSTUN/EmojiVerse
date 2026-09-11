import {
  distance,
  getEntity,
  getModuleParameter,
  hasCapability,
  isAdjacent,
} from "../sim/accessors";
import type { EntityState, Intent, WorldState } from "../sim/types";

/**
 * A memoryless policy.  It only reads the phase-start observation and emits a
 * normal public Intent; it never mutates the world.
 */
export function choosePolicy(world: WorldState, actor: EntityState): Intent | undefined {
  if (!actor.alive || actor.nutrition.preference.length === 0) return undefined;
  const range = senseRange(world, actor);
  const foodTargets = Object.values(world.entities)
    .filter((target) => target.id !== actor.id && target.edibleMass > 0)
    .filter((target) => actor.nutrition.preference.includes(target.nutrition.edibleAs ?? "processed_food"))
    .map((target) => ({ target, distance: distance(actor, target) }))
    .filter(({ distance: targetDistance }) => Number.isFinite(targetDistance) && targetDistance <= range)
    .sort((left, right) => {
      const leftScore = foodScore(left.target, left.distance);
      const rightScore = foodScore(right.target, right.distance);
      return rightScore - leftScore || left.target.id.localeCompare(right.target.id);
    });

  for (const { target } of foodTargets) {
    const accessible = target.alive
      ? target.nutrition.foodAccess === "alive" || target.nutrition.foodAccess === "always"
      : target.nutrition.foodAccess === "after_death" || target.nutrition.foodAccess === "always";
    if (isAdjacent(actor, target) || sameCell(actor, target)) {
      if (accessible) return { type: "consume", actorId: actor.id, targetId: target.id, amount: 1 };
      if (target.alive && hasCapability(world, actor, "work_damage")) {
        return { type: "attack", actorId: actor.id, targetId: target.id };
      }
    }
    if (target.alive && !accessible && !hasCapability(world, actor, "work_damage")) continue;
    return moveToward(actor, target);
  }
  return undefined;
}

export function senseRange(world: WorldState, entity: EntityState): number {
  const cyclePosition = world.tick % world.config.dayLength;
  const isDark = cyclePosition >= Math.floor(world.config.dayLength / 2);
  if (!isDark) return entity.senses.dayRange;
  return hasCapability(world, entity, "night_sense")
    ? getModuleParameter(world, entity, "darkRange", entity.senses.darkRange)
    : entity.senses.darkRange;
}

function moveToward(actor: EntityState, target: EntityState): Intent {
  const dx = target.position.x - actor.position.x;
  const dy = target.position.y - actor.position.y;
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return { type: "move", actorId: actor.id, dx: Math.sign(dx), dy: 0 };
  if (dy !== 0) return { type: "move", actorId: actor.id, dx: 0, dy: Math.sign(dy) };
  return { type: "move", actorId: actor.id, dx: 0, dy: 0 };
}

function foodScore(target: EntityState, targetDistance: number): number {
  const risk = target.alive ? 1 : 0;
  return target.edibleMass - targetDistance - risk;
}

function sameCell(left: EntityState, right: EntityState): boolean {
  return left.position.layer === right.position.layer && left.position.x === right.position.x && left.position.y === right.position.y;
}

export function targetForPolicy(world: WorldState, actorId: string, targetId: string): EntityState | undefined {
  const actor = getEntity(world, actorId);
  if (!actor) return undefined;
  return getEntity(world, targetId);
}
