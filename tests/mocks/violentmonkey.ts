import { vi } from 'vitest';

export const GM = {
  getValue: vi.fn(async () => undefined),
  setValue: vi.fn(async () => undefined),
  notification: vi.fn(),
};
