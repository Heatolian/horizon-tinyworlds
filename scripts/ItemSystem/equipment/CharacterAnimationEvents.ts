/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Item System Scripts v2

import type {Entity} from 'meta/worlds';

/**
 * The animation events a character's Animator fires (`OnAnimationEvent`), as
 * relayed by its `EquipmentBinder` to whatever it has equipped, e.g. a throw
 * leaving the hand on `release`.
 *
 * A leaf like `EquipmentTags`, so the binder and the equipment it holds need
 * not import each other. Animation events reach clients only: on the server
 * nothing is relayed.
 */

type AnimationEventListener = (name: string) => void;

const listeners = new Map<Entity, Set<AnimationEventListener>>();

/** Calls `listener` with each animation event `character` fires, until the returned function is called. */
export function onCharacterAnimationEvent(character: Entity, listener: AnimationEventListener): () => void {
  let forCharacter = listeners.get(character);
  if (forCharacter == null) {
    forCharacter = new Set();
    listeners.set(character, forCharacter);
  }
  forCharacter.add(listener);
  return () => {
    forCharacter.delete(listener);
    if (forCharacter.size === 0 && listeners.get(character) === forCharacter) {
      listeners.delete(character);
    }
  };
}

export function relayCharacterAnimationEvent(character: Entity, name: string): void {
  const forCharacter = listeners.get(character);
  if (forCharacter == null) {
    return;
  }
  for (const listener of [...forCharacter]) {
    listener(name);
  }
}
