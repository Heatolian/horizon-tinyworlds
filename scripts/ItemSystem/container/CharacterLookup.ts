/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v1

import type {AbstractClass, Component, Entity} from 'meta/worlds';
import {GASComponent} from '../../gas/core/GASComponent';

/**
 * The character an item component belongs to: the nearest entity, from
 * `entity` up, that carries GAS. Item components may sit on the character
 * root or on any child of it (e.g. an `ItemSystem` child), so they resolve the
 * character through this rather than assuming `this.entity`.
 */
export function characterOf(entity: Entity): Entity | null {
  for (const candidate of [entity, ...entity.getAncestors()]) {
    if (candidate.getComponent(GASComponent) != null) {
      return candidate;
    }
  }
  return null;
}

/** All `type` components on the character root and its descendants. */
export function allOnCharacter<T extends Component>(character: Entity, type: AbstractClass<T>): T[] {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the package build's SDK typings return IComponent[]
  return [character, ...character.getChildrenWithComponent(type, true)].flatMap(entity => entity.getComponents(type) as T[]);
}

/** The `type` component on the character root or any descendant; the first one when several exist. */
export function findOnCharacter<T extends Component>(character: Entity, type: AbstractClass<T>): T | null {
  return allOnCharacter(character, type)[0] ?? null;
}
