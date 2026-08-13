import type { MonkeyUserScript } from 'vite-plugin-monkey';

const metadata: MonkeyUserScript = {
  name: 'AWA Toolkit',
  namespace: 'https://github.com/UpDownLeftDie/AWA-Toolkit',
  icon: 'https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon.png',
  icon64:
    'https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon64.png',
  version: '2.0.7',
  description:
    'Artifact Optimizer, Control Center tasks, giveaway/vault filters, and UCF reading mode',
  match: ['*://*.alienwarearena.com/*'],
  connect: ['store.steampowered.com', 'raw.githubusercontent.com'],
  'run-at': 'document-start',
};

export default metadata;
