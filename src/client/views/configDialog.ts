import { el } from '../dom.js';
import type { AppDeps } from '../deps.js';
import type { CardController } from './cards/cardController.js';
import { mountProfileCard } from './cards/profileCard.js';
import { mountServerCard } from './cards/serverCard.js';
import { mountPresetCard } from './cards/presetCard.js';
import { mountProxyCard } from './cards/proxyCard.js';
import { setupDialogTabs } from './dialogTabs.js';
import { t } from '../i18n.js';

export function mountConfigDialog(deps: AppDeps) {
  const configDialog = el<HTMLDialogElement>('config-dialog');
  const profileCard = mountProfileCard(deps);
  const serverCard = mountServerCard(deps);
  const presetCard = mountPresetCard(deps);
  const proxyCard = mountProxyCard(deps);

  setupDialogTabs(configDialog);

  deps.bus.on('config:open', () => configDialog.showModal());

  // Reset the matching edit card once the server confirms its save. Kept here so
  // "saved → reset form" lives with the cards rather than in the composition root.
  deps.conn.onMessage((msg) => {
    queueMicrotask(() => {
      if (msg.type === 'config.profile.saved') selectSaved(profileCard, msg.selectedId);
      else if (msg.type === 'config.server.saved') selectSaved(serverCard, msg.selectedId);
      else if (msg.type === 'config.preset.saved') selectSaved(presetCard, msg.selectedId);
      else if (msg.type === 'config.proxy.saved') selectSaved(proxyCard, msg.selectedId);
      else if (msg.type === 'error' && msg.code === 'CONFIG_ERROR' && msg.sourceType) {
        const card = configCardFor(msg.sourceType, profileCard, serverCard, proxyCard, presetCard);
        card?.showError(translateConfigError(msg.message));
      }
    });
  });
}

function selectSaved(card: { startNew(): void; edit(id: string): void }, selectedId?: string): void {
  if (selectedId) card.edit(selectedId);
  else card.startNew();
}

export function configCardFor(
  sourceType: string,
  profile: CardController,
  server: CardController,
  proxy: CardController,
  preset: CardController,
): CardController | null {
  if (sourceType.startsWith('config.profile')) return profile;
  if (sourceType.startsWith('config.server')) return server;
  if (sourceType.startsWith('config.proxy')) return proxy;
  if (sourceType.startsWith('config.preset')) return preset;
  return null;
}

const ERROR_I18N: Record<string, string> = {
  'name already exists': 'config.error.duplicateName',
  'profile not found': 'config.error.notFound',
  'server not found': 'config.error.notFound',
  'preset not found': 'config.error.notFound',
  'proxy not found': 'config.error.notFound',
  'profile is used by a preset': 'config.error.profileInUse',
  'server is used by a preset': 'config.error.serverInUse',
  'proxy is used by a preset': 'config.error.proxyInUse',
  'serverId is required': 'config.error.required',
};

function translateConfigError(message: string): string {
  const key = ERROR_I18N[message];
  return key ? t(key) : message;
}
