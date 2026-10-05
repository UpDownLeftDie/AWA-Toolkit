import { initArtifactOptimizer } from './artifacts/ui';
import { documentBody } from './pageGlobals';
import { initFilters } from './siteFilters';
import { initUcfReadingMode } from './ucf/readingMode';

function waitForBody(): Promise<HTMLElement> {
  const existing = documentBody();
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const body = documentBody();
      if (!body) {
        return;
      }
      observer.disconnect();
      resolve(body);
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

initArtifactOptimizer();
await waitForBody();
await initFilters();
await initUcfReadingMode();
