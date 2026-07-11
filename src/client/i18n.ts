/** Runtime i18n dictionary + DOM applicator.
 *
 * Two ways to translate:
 *   1. Static HTML: mark elements with `data-i18n="key"` (textContent),
 *      `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`.
 *      `applyDomI18n(root)` walks these and writes t(key). Called once at
 *      boot and again whenever the locale changes.
 *   2. Dynamic strings (mode-pill text, toast messages, alerts) built at
 *      runtime: call `t('some.key')` directly. Views that render locale-
 *      dependent text on their own can `subscribeLocale(fn)` and re-render.
 *
 * Locale is `en` or `zh`; persisted in localStorage under `cchub.locale`.
 * First-visit default is `zh` when `navigator.language` starts with `zh`,
 * else `en`.
 */

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'cchub.locale';

type Dict = Record<string, string>;

const en: Dict = {
  'status.connecting': 'connecting',
  'status.online': 'online',
  'status.offline': 'offline',
  'status.idle': 'idle',

  'metrics.cpu': 'CPU',
  'metrics.mem': 'MEM',
  'metrics.tooltip.title': 'Host resource usage',
  'metrics.tooltip.main': 'cchub server',
  'metrics.tooltip.total': 'Total',
  'metrics.tooltip.session': 'Session',
  'metrics.tooltip.cores': '{n} cores',
  'metrics.tooltip.remote': 'N/A (remote)',
  'metrics.tooltip.empty': 'No sessions',

  'topbar.size': 'Size',
  'topbar.theme': 'Theme',
  'topbar.themeGroup.popular': 'Popular',
  'topbar.themeGroup.more': 'More',
  'topbar.new': '+ New session',
  'topbar.new.aria': 'New session',
  'topbar.recent.aria': 'Recent launches',
  'topbar.presetsConfig': 'Preset sessions config',
  'topbar.settings': 'Settings',
  'topbar.settings.title': 'Tool settings',

  'layout.group.aria': 'Session layout',
  'layout.mode.tabs': 'Tabs',
  'layout.mode.cols-2': '2-cols',
  'layout.mode.cols-3': '3-cols',
  'layout.tooltip': '{name} layout',

  'rail.sessions': 'Sessions',
  'rail.local': 'Local',
  'rail.close': 'Close {name}',
  'rail.reveal.local': 'Open {cwd}',
  'rail.reveal.remote': 'Open {cwd}',

  'reveal.files': 'Open in file browser',
  'reveal.vscode': 'Open in VS Code',
  'reveal.vscode.remote': 'Open in VS Code (Remote-SSH)',
  'reveal.cmd': 'Open in CMD',
  'reveal.cmd.admin': 'Open in CMD (Admin)',
  'reveal.powershell': 'Open in PowerShell',
  'reveal.powershell.admin': 'Open in PowerShell (Admin)',
  'reveal.xshell': 'Open in XShell',
  'reveal.xftp': 'Open in XFTP',

  'recent.empty': 'No recent launches yet.',
  'recent.clearAll': 'Clear all',
  'recent.custom': 'Custom…',
  'recent.forget': 'Forget this launch',
  'recent.tip': 'Shift+click to edit before launching',
  'recent.time.now': 'just now',
  'recent.removed': 'removed',
  'recent.noCwd': '(no cwd)',

  'launch.title': 'Launch session',
  'launch.subtitle': 'Start Claude Code from config.',
  'launch.close': 'Close launch dialog',
  'launch.preset': 'Preset session',
  'launch.server': 'Server',
  'launch.profile': 'LLM provider',
  'launch.overrides': 'Overrides',
  'launch.cwd': 'Working directory',
  'launch.browse': 'Browse',
  'launch.conda': 'Conda env',
  'launch.condaNone': 'No conda env',
  'launch.resume': 'Resume',
  'launch.resumeNew': 'New session',
  'launch.resumeContinue': 'Continue latest',
  'launch.create': 'Create session',

  'directory.title': 'Select directory',
  'directory.subtitle': 'Choose working directory.',
  'directory.close': 'Close directory dialog',
  'directory.up': 'Up',
  'directory.go': 'Go',
  'directory.select': 'Select',
  'directory.pathAria': 'Directory path',
  'directory.listAria': 'Directories',
  'directory.loading': 'Loading…',
  'directory.failedPrefix': 'Failed to load',
  'directory.empty.dirs': 'No subdirectories',
  'directory.empty.files': 'No files or subdirectories',
  'directory.selectServerFirst': 'Select a server first',
  'directory.target.dir': '{name} directory',
  'directory.target.pickFile': '{name} — pick file',

  'config.title': 'Configuration',
  'config.subtitle': 'Manage LLM providers, connection targets, and reusable launch presets.',
  'config.close': 'Close configuration dialog',
  'config.copy': 'Copy',
  'config.footer': 'Secrets remain in your local config file and are never displayed here.',
  'config.tab.llm': 'LLM Providers',
  'config.tab.server': 'Servers',
  'config.tab.proxy': 'Proxies',
  'config.tab.preset': 'Preset sessions',
  'config.sections.aria': 'Configuration sections',
  'config.error.duplicateName': 'This name is already in use',
  'config.error.profileInUse': 'This provider is referenced by a preset',
  'config.error.serverInUse': 'This server is referenced by a preset',
  'config.error.proxyInUse': 'This proxy is referenced by a preset',
  'config.error.notFound': 'Configuration item not found',
  'config.error.required': 'A required field is missing',

  'field.name': 'Name',
  'field.password': 'Password',
  'field.new': 'New…',

  'provider.select': 'LLM provider',
  'provider.select.aria': 'LLM providers',
  'provider.mode.create': 'Create LLM provider',
  'provider.mode.edit': 'Edit LLM provider',
  'provider.save.create': 'Create provider',
  'provider.save.edit': 'Save provider',
  'provider.baseUrl': 'Base URL (env: ANTHROPIC_BASE_URL — no /v1 suffix)',
  'provider.authToken': 'Auth token (env: ANTHROPIC_AUTH_TOKEN)',
  'provider.model': 'Model (env: ANTHROPIC_MODEL)',
  'provider.subagentModel': 'Subagent model (env: CLAUDE_CODE_SUBAGENT_MODEL)',
  'provider.smallModel': 'Small fast model (env: ANTHROPIC_SMALL_FAST_MODEL)',
  'provider.clearToken': 'Clear saved token',
  'provider.test': 'Test connection',
  'provider.delete': 'Delete',

  'server.select': 'Server',
  'server.select.aria': 'Servers',
  'server.mode.create': 'Create server',
  'server.mode.edit': 'Edit server',
  'server.save.create': 'Create server',
  'server.save.edit': 'Save server',
  'server.kind': 'Kind',
  'server.kind.local': 'Local',
  'server.kind.ssh': 'SSH',
  'server.os': 'OS',
  'server.os.linux': 'Linux',
  'server.os.windows': 'Windows',
  'server.os.macos': 'macOS',
  'server.host': 'Host',
  'server.port': 'Port',
  'server.username': 'Username',
  'server.privateKey': 'Private key path',
  'server.clearPassword': 'Clear saved password',
  'server.delete': 'Delete',

  'proxy.select': 'Proxy',
  'proxy.select.aria': 'Proxies',
  'proxy.mode.create': 'Create proxy',
  'proxy.mode.edit': 'Edit proxy',
  'proxy.save.create': 'Create proxy',
  'proxy.save.edit': 'Save proxy',
  'proxy.bindPort': 'Bind port',
  'proxy.host': 'Proxy host',
  'proxy.port': 'Proxy port',
  'proxy.delete': 'Delete',

  'preset.select': 'Preset session',
  'preset.select.aria': 'Preset sessions',
  'preset.mode.create': 'Create preset',
  'preset.mode.edit': 'Edit preset',
  'preset.save.create': 'Create preset',
  'preset.save.edit': 'Save preset',
  'preset.server': 'Server',
  'preset.profile': 'Profile',
  'preset.cwd': 'Working directory',
  'preset.conda': 'Conda env',
  'preset.resume': 'Resume',
  'preset.resume.new': 'New session',
  'preset.resume.continue': 'Continue latest',
  'preset.advanced': 'Advanced',
  'preset.skipPermissions': 'Skip permission prompts (--dangerously-skip-permissions)',
  'preset.proxy': 'Proxy',
  'preset.delete': 'Delete',

  'settings.title': 'Settings',
  'settings.subtitle': 'Notifications and remote-client paths for this cchub server.',
  'settings.close': 'Close settings dialog',
  'settings.tab.general': 'General',
  'settings.tab.notify': 'Notifications',
  'settings.tab.remote': 'Remote clients',
  'settings.sections.aria': 'Settings sections',
  'settings.general.title': 'General',
  'settings.general.subtitle': 'Interface preferences for this browser.',
  'settings.general.language': 'Language',
  'settings.notify.enable': 'Enable browser notifications (based on cc output heuristics — may misfire)',
  'settings.remote.detect': 'Auto-detect all paths',
  'settings.remote.detect.title': 'Auto-detect XShell, XFTP and VS Code on this server',
  'settings.remote.xshellPath': 'XShell path',
  'settings.remote.xshellBrowse': 'Browse for Xshell.exe',
  'settings.remote.xftpPath': 'XFTP path',
  'settings.remote.xftpBrowse': 'Browse for Xftp.exe',
  'settings.remote.vscodePath': 'VS Code path',
  'settings.remote.vscodeBrowse': 'Browse for code.cmd or Code.exe',
  'settings.remote.browse': 'Browse…',
  'settings.cancel': 'Cancel',
  'settings.save': 'Save',
  'settings.detect.scanning': 'Scanning…',
  'settings.detect.all': 'Detected all. Click Save to persist.',
  'settings.detect.none': 'None found. Use Browse… to pick each exe manually.',
  'settings.detect.partial': 'Found: {found}. Missing: {missing}. Use Browse… for the rest.',
  'settings.detect.noLocal': 'No local server configured — type the path manually.',

  'session.close.aria': 'Close session',
  'session.new': 'New session',

  'test.testing': 'Testing connection…',
  'test.ok': 'Connection ok',
  'test.failedPrefix': 'Connection failed',
};

const zh: Dict = {
  'status.connecting': '连接中',
  'status.online': '已连接',
  'status.offline': '离线',
  'status.idle': '空闲',

  'metrics.cpu': 'CPU',
  'metrics.mem': '内存',
  'metrics.tooltip.title': '主机资源占用',
  'metrics.tooltip.main': 'cchub 服务',
  'metrics.tooltip.total': '总计',
  'metrics.tooltip.session': '会话',
  'metrics.tooltip.cores': '{n} 核',
  'metrics.tooltip.remote': '不适用(远程)',
  'metrics.tooltip.empty': '无会话',

  'topbar.size': '字号',
  'topbar.theme': '主题',
  'topbar.themeGroup.popular': '常用',
  'topbar.themeGroup.more': '更多',
  'topbar.new': '+ 新建会话',
  'topbar.new.aria': '新建会话',
  'topbar.recent.aria': '最近启动',
  'topbar.presetsConfig': '预设会话配置',
  'topbar.settings': '设置',
  'topbar.settings.title': '工具设置',

  'layout.group.aria': '会话布局',
  'layout.mode.tabs': '标签页',
  'layout.mode.cols-2': '两列',
  'layout.mode.cols-3': '三列',
  'layout.tooltip': '{name}布局',

  'rail.sessions': '会话',
  'rail.local': '本地',
  'rail.close': '关闭 {name}',
  'rail.reveal.local': '打开 {cwd}',
  'rail.reveal.remote': '打开 {cwd}',

  'reveal.files': '在文件浏览器中打开',
  'reveal.vscode': '在 VS Code 中打开',
  'reveal.vscode.remote': '在 VS Code 中打开(远程 SSH)',
  'reveal.cmd': '在 CMD 中打开',
  'reveal.cmd.admin': '在 CMD 中打开(管理员)',
  'reveal.powershell': '在 PowerShell 中打开',
  'reveal.powershell.admin': '在 PowerShell 中打开(管理员)',
  'reveal.xshell': '在 XShell 中打开',
  'reveal.xftp': '在 XFTP 中打开',

  'recent.empty': '暂无最近启动记录。',
  'recent.clearAll': '全部清除',
  'recent.custom': '自定义…',
  'recent.forget': '忘记此启动',
  'recent.tip': '按住 Shift 单击可在启动前编辑',
  'recent.time.now': '刚刚',
  'recent.removed': '已删除',
  'recent.noCwd': '(无工作目录)',

  'launch.title': '启动会话',
  'launch.subtitle': '按配置启动 Claude Code。',
  'launch.close': '关闭启动对话框',
  'launch.preset': '预设会话',
  'launch.server': '服务器',
  'launch.profile': 'LLM供应商',
  'launch.overrides': '覆盖',
  'launch.cwd': '工作目录',
  'launch.browse': '浏览',
  'launch.conda': 'Conda 环境',
  'launch.condaNone': '不使用 Conda',
  'launch.resume': '恢复',
  'launch.resumeNew': '新会话',
  'launch.resumeContinue': '继续最近会话',
  'launch.create': '创建会话',

  'directory.title': '选择目录',
  'directory.subtitle': '选择工作目录。',
  'directory.close': '关闭目录对话框',
  'directory.up': '上级',
  'directory.go': '前往',
  'directory.select': '选择',
  'directory.pathAria': '目录路径',
  'directory.listAria': '目录列表',
  'directory.loading': '加载中…',
  'directory.failedPrefix': '加载失败',
  'directory.empty.dirs': '无子目录',
  'directory.empty.files': '无文件或子目录',
  'directory.selectServerFirst': '请先选择一个服务器',
  'directory.target.dir': '{name} 的目录',
  'directory.target.pickFile': '{name} — 选择文件',

  'config.title': '配置',
  'config.subtitle': '管理LLM供应商、连接目标以及可复用的启动预设。',
  'config.close': '关闭配置对话框',
  'config.copy': '复制',
  'config.footer': '密钥仅保存在本地配置文件中,永不在此显示。',
  'config.tab.llm': 'LLM 供应商',
  'config.tab.server': '服务器',
  'config.tab.proxy': '代理',
  'config.tab.preset': '预设会话',
  'config.sections.aria': '配置分区',
  'config.error.duplicateName': '此名称已被使用',
  'config.error.profileInUse': '此供应商被预设引用，无法删除',
  'config.error.serverInUse': '此服务器被预设引用，无法删除',
  'config.error.proxyInUse': '此代理被预设引用，无法删除',
  'config.error.notFound': '配置项未找到',
  'config.error.required': '必填字段未填写',

  'field.name': '名称',
  'field.password': '密码',
  'field.new': '新建…',

  'provider.select': 'LLM 供应商',
  'provider.select.aria': 'LLM 供应商',
  'provider.mode.create': '新建 LLM 供应商',
  'provider.mode.edit': '编辑 LLM 供应商',
  'provider.save.create': '新建供应商',
  'provider.save.edit': '保存供应商',
  'provider.baseUrl': 'Base URL（对应环境变量 ANTHROPIC_BASE_URL，不需要追加/v1）',
  'provider.authToken': 'Auth Token（对应环境变量 ANTHROPIC_AUTH_TOKEN）',
  'provider.model': '主模型（对应环境变量 ANTHROPIC_MODEL）',
  'provider.subagentModel': '子代理模型（对应环境变量 CLAUDE_CODE_SUBAGENT_MODEL）',
  'provider.smallModel': '小模型（对应环境变量 ANTHROPIC_SMALL_FAST_MODEL）',
  'provider.clearToken': '清除已保存的 Token',
  'provider.test': '测试连接',
  'provider.delete': '删除',

  'server.select': '服务器',
  'server.select.aria': '服务器',
  'server.mode.create': '新建服务器',
  'server.mode.edit': '编辑服务器',
  'server.save.create': '新建服务器',
  'server.save.edit': '保存服务器',
  'server.kind': '类型',
  'server.kind.local': '本地',
  'server.kind.ssh': 'SSH',
  'server.os': '操作系统',
  'server.os.linux': 'Linux',
  'server.os.windows': 'Windows',
  'server.os.macos': 'macOS',
  'server.host': '主机',
  'server.port': '端口',
  'server.username': '用户名',
  'server.privateKey': '私钥路径',
  'server.clearPassword': '清除已保存的密码',
  'server.delete': '删除',

  'proxy.select': '代理',
  'proxy.select.aria': '代理',
  'proxy.mode.create': '新建代理',
  'proxy.mode.edit': '编辑代理',
  'proxy.save.create': '新建代理',
  'proxy.save.edit': '保存代理',
  'proxy.bindPort': '本地端口',
  'proxy.host': '代理主机',
  'proxy.port': '代理端口',
  'proxy.delete': '删除',

  'preset.select': '预设会话',
  'preset.select.aria': '预设会话',
  'preset.mode.create': '新建预设',
  'preset.mode.edit': '编辑预设',
  'preset.save.create': '新建预设',
  'preset.save.edit': '保存预设',
  'preset.server': '服务器',
  'preset.profile': '供应商',
  'preset.cwd': '工作目录',
  'preset.conda': 'Conda 环境',
  'preset.resume': '恢复',
  'preset.resume.new': '新会话',
  'preset.resume.continue': '继续最近会话',
  'preset.advanced': '高级',
  'preset.skipPermissions': '跳过权限提示 (--dangerously-skip-permissions)',
  'preset.proxy': '代理',
  'preset.delete': '删除',

  'settings.title': '设置',
  'settings.subtitle': '此 cchub 服务器的通知与远程客户端路径。',
  'settings.close': '关闭设置对话框',
  'settings.tab.general': '通用',
  'settings.tab.notify': '通知',
  'settings.tab.remote': '远程客户端',
  'settings.sections.aria': '设置分区',
  'settings.general.title': '通用',
  'settings.general.subtitle': '当前浏览器的界面偏好。',
  'settings.general.language': '语言',
  'settings.notify.enable': '启用浏览器通知（通过对cc的字符分析实现，可能误报）',
  'settings.remote.detect': '自动检测所有路径',
  'settings.remote.detect.title': '在此服务器上自动检测 XShell、XFTP 与 VS Code',
  'settings.remote.xshellPath': 'XShell 路径',
  'settings.remote.xshellBrowse': '浏览 Xshell.exe',
  'settings.remote.xftpPath': 'XFTP 路径',
  'settings.remote.xftpBrowse': '浏览 Xftp.exe',
  'settings.remote.vscodePath': 'VS Code 路径',
  'settings.remote.vscodeBrowse': '浏览 code.cmd 或 Code.exe',
  'settings.remote.browse': '浏览…',
  'settings.cancel': '取消',
  'settings.save': '保存',
  'settings.detect.scanning': '扫描中…',
  'settings.detect.all': '已检测到全部。点击"保存"生效。',
  'settings.detect.none': '未检测到,请用"浏览…"手动选择每一项。',
  'settings.detect.partial': '已找到:{found}。未找到:{missing}。其余请用"浏览…"。',
  'settings.detect.noLocal': '未配置本地服务器 —— 请手动输入路径。',

  'session.close.aria': '关闭会话',
  'session.new': '新会话',

  'test.testing': '正在测试连接…',
  'test.ok': '连接成功',
  'test.failedPrefix': '连接失败',
};

const dicts: Record<Locale, Dict> = { en, zh };

function detectDefault(): Locale {
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  return /^zh/i.test(nav) ? 'zh' : 'en';
}

function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* SSR or blocked storage — fall through */ }
  return detectDefault();
}

let current: Locale = loadLocale();
const listeners = new Set<(l: Locale) => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    applyDomI18n(document);
  }
  for (const fn of listeners) fn(next);
}

export function subscribeLocale(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: string): string {
  return dicts[current][key] ?? dicts.en[key] ?? key;
}

const ATTR_MAP: Array<[string, (el: Element, value: string) => void]> = [
  ['data-i18n', (el, v) => { el.textContent = v; }],
  ['data-i18n-placeholder', (el, v) => { (el as HTMLInputElement).placeholder = v; }],
  ['data-i18n-title', (el, v) => { el.setAttribute('title', v); }],
  ['data-i18n-aria-label', (el, v) => { el.setAttribute('aria-label', v); }],
];

export function applyDomI18n(root: ParentNode = document): void {
  for (const [attr, apply] of ATTR_MAP) {
    const nodes = root.querySelectorAll<Element>(`[${attr}]`);
    for (const node of nodes) {
      const key = node.getAttribute(attr);
      if (!key) continue;
      apply(node, t(key));
    }
  }
  if (root === document) {
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  }
}
