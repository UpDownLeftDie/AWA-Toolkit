import { describe, expect, it } from 'vitest';

import { pickStuckLockNudgeTarget } from '../../src/artifacts/api';
import {
  COOLDOWN_MS,
  defaultArtifactSettings,
  hasElapsedShowroomLock,
  STUCK_SLOT_LOCK_HINT,
} from '../../src/artifacts/settings';
import { renderCooldownBlock } from '../../src/artifacts/ui/render';

describe('hasElapsedShowroomLock', () => {
  const nowMs = Date.parse('2026-08-10T16:50:00.000Z');

  it('is true when Showroom is locked and the GM timer has already hit 0', () => {
    expect(
      hasElapsedShowroomLock(
        {
          ...defaultArtifactSettings,
          slotCooldowns: [
            {
              position: 2,
              changedAt: new Date(nowMs - COOLDOWN_MS).toISOString(),
              estimated: true,
            },
          ],
        },
        { 2: true },
        nowMs,
      ),
    ).toBe(true);
  });

  it('is false while the local timer still has remaining time', () => {
    expect(
      hasElapsedShowroomLock(
        {
          ...defaultArtifactSettings,
          slotCooldowns: [
            {
              position: 2,
              changedAt: new Date(nowMs - COOLDOWN_MS / 2).toISOString(),
            },
          ],
        },
        { 2: true },
        nowMs,
      ),
    ).toBe(false);
  });

  it('is false when Showroom is locked but no duration was recorded', () => {
    expect(
      hasElapsedShowroomLock(
        defaultArtifactSettings,
        { 2: true },
        nowMs,
      ),
    ).toBe(false);
  });

  it('is false when Showroom already shows the slot open', () => {
    expect(
      hasElapsedShowroomLock(
        {
          ...defaultArtifactSettings,
          slotCooldowns: [
            {
              position: 2,
              changedAt: new Date(nowMs - COOLDOWN_MS).toISOString(),
            },
          ],
        },
        { 2: false },
        nowMs,
      ),
    ).toBe(false);
  });
});

describe('renderCooldownBlock', () => {
  it('appends the Megumin stuck-lock hint when the timer has elapsed', () => {
    const html = renderCooldownBlock(
      {
        ...defaultArtifactSettings,
        slotCooldowns: [
          {
            position: 2,
            changedAt: new Date(0).toISOString(),
            estimated: true,
          },
        ],
      },
      { 2: true },
    );
    expect(html).toContain('slot 2 (locked');
    expect(html).toContain(STUCK_SLOT_LOCK_HINT);
  });
});

describe('pickStuckLockNudgeTarget', () => {
  it('prefers H`erkow Warrior Script among maxed 0-frag cards', () => {
    expect(
      pickStuckLockNudgeTarget([
        {
          instanceId: 1,
          displayName: 'Collapsed Star',
          maxLevel: true,
        },
        {
          instanceId: 2,
          displayName: "H`erkow Warrior Script",
          maxLevel: false,
          upgradeCost: 0,
        },
      ]),
    ).toEqual({
      instanceId: 2,
      displayName: "H`erkow Warrior Script",
    });
  });

  it('skips cards that would spend fragments', () => {
    expect(
      pickStuckLockNudgeTarget([
        {
          instanceId: 3,
          displayName: 'Chai Stones',
          maxLevel: false,
          upgradeCost: 40,
        },
      ]),
    ).toBeUndefined();
  });
});
