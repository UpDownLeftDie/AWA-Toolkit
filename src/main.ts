import { initArtifactOptimizer } from './artifacts/ui';
import { initFilters } from './siteFilters';
import { initUcfReadingMode } from './ucf/readingMode';

function waitForBody(): Promise<HTMLElement> {
  if (document.body) {
    return Promise.resolve(document.body);
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) {
        return;
      }
      observer.disconnect();
      resolve(document.body);
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

void initArtifactOptimizer();
await waitForBody();
await initFilters();
await initUcfReadingMode();
