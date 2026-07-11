import { val, setVal } from '../../dom.js';
import type { AppDeps } from '../../deps.js';
import { createCardController } from './cardController.js';
import { buildProxySaveMessage, type ProxyFormValues } from './cardSerializers.js';

function readProxyForm(): ProxyFormValues {
  return {
    name: val('proxy-name'),
    bindPort: val('proxy-bind-port'),
    host: val('proxy-host'),
    port: val('proxy-port'),
  };
}

export function mountProxyCard(deps: AppDeps) {
  return createCardController(deps, {
    prefix: 'proxy',
    modeKey: 'proxyMode',
    selectedKey: 'selectedProxyId',
    modeCreateKey: 'proxy.mode.create',
    modeEditKey: 'proxy.mode.edit',
    saveCreateKey: 'proxy.save.create',
    saveEditKey: 'proxy.save.edit',
    items: (s) => s.config!.proxies,
    lookup: (id) => deps.store.getProxy(id),
    buildSave: (editing, selectedId) => buildProxySaveMessage(readProxyForm(), { editing, selectedId }),
    buildDelete: (selectedId) => ({ type: 'config.proxy.delete', id: selectedId }),
    buildCopy: (selectedId) => ({ type: 'config.proxy.copy', id: selectedId }),
    fillForm: (p) => {
      setVal('proxy-name', p.name);
      setVal('proxy-bind-port', String(p.bindPort));
      setVal('proxy-host', p.host);
      setVal('proxy-port', String(p.port));
    },
    resetForm: () => {
      setVal('proxy-list', '');
      setVal('proxy-name', '');
      setVal('proxy-bind-port', '');
      setVal('proxy-host', '');
      setVal('proxy-port', '');
    },
  });
}
