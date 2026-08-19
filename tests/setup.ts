import { beforeEach, vi } from 'vitest';

import { GM } from '$';

beforeEach(() => {
  vi.mocked(GM.getValue).mockReset();
  vi.mocked(GM.setValue).mockReset();
  vi.mocked(GM.notification).mockReset();
  vi.mocked(GM.getValue).mockResolvedValue(undefined);
});
