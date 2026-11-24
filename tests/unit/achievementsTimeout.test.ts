import { describe, expect, it } from 'vitest';

import { raceWithTimeout } from '../../src/achievements/scraper';

describe('achievement automation timeouts', () => {
  it('resolves undefined when the work exceeds the timeout', async () => {
    const result = await raceWithTimeout(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('late'), 50);
      }),
      5,
    );
    expect(result).toBeUndefined();
  });

  it('returns the value when work finishes before the timeout', async () => {
    const result = await raceWithTimeout(Promise.resolve('ok'), 100);
    expect(result).toBe('ok');
  });
});
