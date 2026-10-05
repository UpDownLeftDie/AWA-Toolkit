import type { MonkeyUserScript } from 'vite-plugin-monkey';

const repositoryUrl = 'https://github.com/UpDownLeftDie/AWA-Toolkit';

const metadata: MonkeyUserScript = {
  name: 'AWA Toolkit',
  namespace: repositoryUrl,
  homepageURL: repositoryUrl,
  supportURL: `${repositoryUrl}/issues`,
  icon: 'https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon.png',
  icon64:
    'https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon64.png',
  version: '2.3.2',
  description:
    'Artifact Optimizer, Control Center tasks, giveaway/vault filters, and UCF reading mode',
  match: ['*://*.alienwarearena.com/*'],
  connect: ['store.steampowered.com', 'raw.githubusercontent.com'],
  'run-at': 'document-start',
};

export default metadata;
