# Tiny Worlds camera

Matches the fixed board view of mobile tile-rotation puzzlers (e.g. a Monument Valley–style still diorama view).

- Mode: custom, fixed, never moves or rotates (scripts/TinyWorlds/BoardCamera.ts).
- Pitch: 45 degrees down, yaw 0 (board rows read top-to-bottom, columns left-to-right).
- Focus: board centre (0, -0.45, 0.1).
- Distance: computed from the phone's aspect so a 8 m wide x 8.4 m deep area (whole 3x3 board, rock undersides and margin) always fits; about 24 m on an iPhone 16 portrait.
- FOV: 34 degrees vertical (narrow, near-orthographic diorama look); horizontal FOV capped at 46 degrees on wide screens.
- Far clip: 2500 m.
- The board sits in the middle ~35% of the screen height, leaving the top and bottom free for future UI.
