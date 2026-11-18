import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { t } from '../l10n';
import { config } from '../util';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_PRESETS,
  parseMagpieGatewayJson,
  parseSseChatLine,
  type AiProviderId,
} from './diagramAiCore';

export { AI_PROVIDER_IDS, AI_PROVIDER_PRESETS, type AiProviderId };

const SECRET_KEY_PREFIX = 'drawGraph.ai.apiKey.';
const ACCEPTED_TARGETS_STATE_KEY = 'drawGraph.ai.acceptedTargets';

let secretStorage: vscode.SecretStorage | undefined;
const cachedProvidersWithKeys = new Set<AiProviderId>();
const apiKeyChangedEmitter = new vscode.EventEmitter<void>();

/** Fires whenever a stored AI API key is added, updated, or cleared. */
export const onDidChangeAiApiKey: vscode.Event<void> = apiKeyChangedEmitter.event;

function secretKeyFor(provider: AiProviderId): string {
  return `${SECRET_KEY_PREFIX}${provider}`;
}

/**
 * Binds `vscode.SecretStorage` and warms the synchronous key-presence cache
 * so Settings Drawer snapshots stay non-blocking.
 */
export function initAiSecretStorage(context: vscode.ExtensionContext): void {
  secretStorage = context.secrets;
  const refreshAll = async () => {
    let changed = false;
    for (const id of AI_PROVIDER_IDS) {
      try {
        const val = await context.secrets.get(secretKeyFor(id));
        const has = Boolean(val && val.trim());
        if (has !== cachedProvidersWithKeys.has(id)) {
          changed = true;
          if (has) {
            cachedProvidersWithKeys.add(id);
          } else {
            cachedProvidersWithKeys.delete(id);
          }
        }
      } catch {
        // Ignore individual secret read errors
      }
    }
    if (changed) {
      apiKeyChangedEmitter.fire();
    }
  };
  void refreshAll();
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key.startsWith(SECRET_KEY_PREFIX)) {
        void refreshAll();
      }
    }),
  );
}

export function normalizeAiProviderId(raw: string | undefined): AiProviderId {
  if (raw && (AI_PROVIDER_IDS as readonly string[]).includes(raw)) {
    return raw as AiProviderId;
  }
  return 'VS Code';
}

export function readMagpieGatewayUrlSync(): string | null {
  try {
    const gwPath = path.join(os.homedir(), '.config', 'magpie', 'gateway.json');
    const raw = fs.readFileSync(gwPath, 'utf8');
    return parseMagpieGatewayJson(raw);
  } catch {
    return null;
  }
}

export interface AiConfigSnapshot {
  provider: AiProviderId;
  baseUrl: string;
  effectiveBaseUrl: string;
  model: string;
  effectiveModel: string;
  hasApiKey: boolean;
  requiresApiKey: boolean;
  autoDiscoverModels: boolean;
}

export function getAiConfigSync(): AiConfigSnapshot {
  const cfg = config();
  const provider = normalizeAiProviderId(cfg.get<string>('ai.provider', 'VS Code'));
  const preset = AI_PROVIDER_PRESETS[provider];
  const baseUrl = (cfg.get<string>('ai.baseUrl', '') || '').trim();
  let effectiveBaseUrl = baseUrl || preset.defaultBaseUrl;
  if (!baseUrl && provider === 'Magpie') {
    effectiveBaseUrl = readMagpieGatewayUrlSync() ?? preset.defaultBaseUrl;
  }
  const model = (cfg.get<string>('ai.model', '') || '').trim();
  const effectiveModel = model || preset.defaultModel;

  return {
    provider,
    baseUrl,
    effectiveBaseUrl,
    model,
    effectiveModel,
    hasApiKey: cachedProvidersWithKeys.has(provider),
    requiresApiKey: preset.requiresApiKey,
    autoDiscoverModels: preset.autoDiscoverModels,
  };
}

export async function getApiKey(provider: AiProviderId): Promise<string> {
  if (!secretStorage) {
    return '';
  }
  try {
    const val = (await secretStorage.get(secretKeyFor(provider)))?.trim() ?? '';
    if (val) {
      cachedProvidersWithKeys.add(provider);
    } else {
      cachedProvidersWithKeys.delete(provider);
    }
    return val;
  } catch {
    return '';
  }
}

export async function getEffectiveApiKey(provider: AiProviderId): Promise<string> {
  const stored = await getApiKey(provider);
  if (stored) {
    return stored;
  }
  if (provider === 'Magpie') return 'magpie';
  if (provider === 'CC Switch') return 'cc-switch';
  if (provider === 'Ollama') return 'ollama';
  return '';
}

export async function setApiKey(providerOverride?: AiProviderId, explicitKey?: string): Promise<boolean> {
  if (!secretStorage) {
    return false;
  }
  const provider = providerOverride ?? getAiConfigSync().provider;
  if (provider === 'VS Code') {
    void vscode.window.showInformationMessage(
      t('The built-in VS Code model provider does not require an API key.'),
    );
    return false;
  }

  let trimmed: string;
  if (typeof explicitKey === 'string') {
    trimmed = explicitKey.trim();
  } else {
    const preset = AI_PROVIDER_PRESETS[provider];
    const entered = await vscode.window.showInputBox({
      title: t('Set AI API Key ({0})', preset.name),
      prompt: t('Stored securely in OS Keychain via VS Code SecretStorage (never written to settings.json).'),
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
    });
    if (entered === undefined) {
      return false;
    }
    trimmed = entered.trim();
  }

  if (!trimmed) {
    await secretStorage.delete(secretKeyFor(provider));
    cachedProvidersWithKeys.delete(provider);
    apiKeyChangedEmitter.fire();
    return false;
  }

  await secretStorage.store(secretKeyFor(provider), trimmed);
  cachedProvidersWithKeys.add(provider);
  apiKeyChangedEmitter.fire();
  if (explicitKey === undefined) {
    void vscode.window.showInformationMessage(t('API key saved securely for {0}.', provider));
  }
  return true;
}

export async function clearApiKey(providerOverride?: AiProviderId, silent = false): Promise<boolean> {
  if (!secretStorage) {
    return false;
  }
  const provider = providerOverride ?? getAiConfigSync().provider;
  await secretStorage.delete(secretKeyFor(provider));
  cachedProvidersWithKeys.delete(provider);
  apiKeyChangedEmitter.fire();
  if (!silent) {
    void vscode.window.showInformationMessage(t('Cleared stored API key for {0}.', provider));
  }
  return true;
}

// Runtime typing for VS Code 1.90+ Language Model API while staying compatible with @types/vscode ~1.85.0
interface VscodeLanguageModelChat {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  sendRequest(
    messages: unknown[],
    options?: Record<string, unknown>,
    token?: vscode.CancellationToken,
  ): Promise<{ text: AsyncIterable<string> }>;
}

interface VscodeLmNamespace {
  selectChatModels(selector?: { id?: string; vendor?: string; family?: string }): Promise<VscodeLanguageModelChat[]>;
}

interface VscodeLmChatMessageStatic {
  User(content: string): unknown;
}

function getVscodeLmApi(): { lm: VscodeLmNamespace; ChatMessage: VscodeLmChatMessageStatic } | undefined {
  const ns = vscode as unknown as {
    lm?: VscodeLmNamespace;
    LanguageModelChatMessage?: VscodeLmChatMessageStatic;
  };
  if (ns.lm && typeof ns.lm.selectChatModels === 'function' && ns.LanguageModelChatMessage) {
    return { lm: ns.lm, ChatMessage: ns.LanguageModelChatMessage };
  }
  return undefined;
}

/**
 * Queries `<baseUrl>/models` (or `vscode.lm.selectChatModels()` when provider is `VS Code`)
 * to discover available model IDs.
 */
export async function fetchProviderModels(providerOverride?: AiProviderId): Promise<string[]> {
  const snap = getAiConfigSync();
  const provider = providerOverride ?? snap.provider;

  if (provider === 'VS Code') {
    const lmApi = getVscodeLmApi();
    if (!lmApi) {
      return [];
    }
    try {
      const models = await lmApi.lm.selectChatModels();
      return models.map((m) => m.id || m.family).filter(Boolean);
    } catch {
      return [];
    }
  }

  let baseUrl = snap.baseUrl;
  if (!baseUrl) {
    baseUrl =
      provider === 'Magpie'
        ? (readMagpieGatewayUrlSync() ?? AI_PROVIDER_PRESETS.Magpie.defaultBaseUrl)
        : AI_PROVIDER_PRESETS[provider].defaultBaseUrl;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (!baseUrl) {
    return [];
  }

  const apiKey = await getEffectiveApiKey(provider);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${baseUrl}/models)`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
  const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = rawList
    .map((item) => {
      if (typeof item?.id === 'string') return item.id.trim();
      if (typeof (item as { name?: unknown })?.name === 'string') return ((item as { name: string }).name).trim();
      return '';
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

export async function ensureAiConsent(
  context: vscode.ExtensionContext,
  targetLabel: string,
  baseUrl: string,
  skipConsent = false,
): Promise<boolean> {
  if (skipConsent || (baseUrl && isLoopbackUrl(baseUrl))) {
    return true;
  }
  const accepted = context.globalState.get<string[]>(ACCEPTED_TARGETS_STATE_KEY, []);
  if (accepted.includes(targetLabel)) {
    return true;
  }
  const onceBtn = t('Continue Once');
  const alwaysBtn = t('Always Allow for {0}', targetLabel);
  const choice = await vscode.window.showInformationMessage(
    t('DrawGraph AI will send your prompt and selected diagram/code context to {0}. Continue?', targetLabel),
    { modal: true },
    onceBtn,
    alwaysBtn,
  );
  if (choice === alwaysBtn) {
    await context.globalState.update(ACCEPTED_TARGETS_STATE_KEY, [...accepted, targetLabel]);
    return true;
  }
  return choice === onceBtn;
}

export interface RunAiPromptOptions {
  onChunk?: (accumulatedText: string, deltaText: string) => void;
  token?: vscode.CancellationToken;
  skipConsent?: boolean;
  modelOverride?: string;
}

export interface RunAiPromptResult {
  text: string;
  provider: AiProviderId;
  modelName: string;
}

export async function runAiPrompt(
  context: vscode.ExtensionContext,
  prompt: string,
  options: RunAiPromptOptions = {},
): Promise<RunAiPromptResult> {
  const snap = getAiConfigSync();
  const provider = snap.provider;

  if (provider === 'VS Code') {
    const lmApi = getVscodeLmApi();
    if (!lmApi) {
      throw new Error(
        t(
          'No built-in VS Code Language Model API is available. Switch DrawGraph AI Provider in Settings (e.g. DeepSeek, OpenAI, Qwen, Ollama, or OpenAI Compatible).',
        ),
      );
    }
    const desired = options.modelOverride || snap.effectiveModel;
    let models = desired ? await lmApi.lm.selectChatModels({ id: desired }) : [];
    if (models.length === 0 && desired) {
      models = await lmApi.lm.selectChatModels({ family: desired });
    }
    if (models.length === 0) {
      models = await lmApi.lm.selectChatModels();
    }
    if (models.length === 0) {
      throw new Error(
        t(
          'No VS Code chat models are currently installed/signed-in. Install GitHub Copilot Chat or configure an API provider in DrawGraph Settings.',
        ),
      );
    }
    const chosen = models[0];
    const targetLabel = `${chosen.vendor || 'VS Code'} (${chosen.name || chosen.id})`;
    const ok = await ensureAiConsent(context, targetLabel, '', options.skipConsent);
    if (!ok) {
      throw new vscode.CancellationError();
    }
    const cts = new vscode.CancellationTokenSource();
    const link = options.token?.onCancellationRequested(() => cts.cancel());
    try {
      const response = await chosen.sendRequest([lmApi.ChatMessage.User(prompt)], {}, cts.token);
      let full = '';
      for await (const fragment of response.text) {
        if (cts.token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        full += fragment;
        options.onChunk?.(full, fragment);
      }
      return { text: full, provider, modelName: chosen.name || chosen.id };
    } finally {
      link?.dispose();
      cts.dispose();
    }
  }

  // Direct OpenAI-compatible HTTP provider
  const baseUrl = snap.effectiveBaseUrl.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(
      t('No Base URL configured for AI provider "{0}". Set "drawGraph.ai.baseUrl" in Settings.', provider),
    );
  }

  const apiKey = await getEffectiveApiKey(provider);
  if (snap.requiresApiKey && !apiKey) {
    const saved = await setApiKey(provider);
    if (!saved) {
      throw new Error(t('API key is required for {0}.', provider));
    }
  }
  const finalApiKey = await getEffectiveApiKey(provider);

  let model = options.modelOverride || snap.effectiveModel;
  if (!model && snap.autoDiscoverModels) {
    try {
      const discovered = await fetchProviderModels(provider);
      if (discovered.length > 0) {
        model = discovered[0];
      }
    } catch {
      // Fall through to validation error below
    }
  }
  if (!model) {
    throw new Error(
      t('No model specified for "{0}". Set "drawGraph.ai.model" or click Discover Models in Settings.', provider),
    );
  }

  let hostDisplay: string = provider;
  try {
    hostDisplay = `${provider} (${new URL(baseUrl).host})`;
  } catch {
    // Keep provider name
  }
  const allowed = await ensureAiConsent(context, hostDisplay, baseUrl, options.skipConsent);
  if (!allowed) {
    throw new vscode.CancellationError();
  }

  const text = await streamOpenAiCompatibleCompletion({
    baseUrl,
    apiKey: finalApiKey,
    model,
    prompt,
    onChunk: options.onChunk,
    token: options.token,
  });
  return { text, provider, modelName: model };
}

async function streamOpenAiCompatibleCompletion(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  onChunk?: (accumulatedText: string, deltaText: string) => void;
  token?: vscode.CancellationToken;
}): Promise<string> {
  const abortController = new AbortController();
  let timedOut = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, 60_000);
  };

  const tokenSub = args.token?.onCancellationRequested(() => {
    abortController.abort();
  });
  if (args.token?.isCancellationRequested) {
    tokenSub?.dispose();
    throw new vscode.CancellationError();
  }

  resetIdleTimer();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };
    if (args.apiKey) {
      headers.Authorization = `Bearer ${args.apiKey}`;
    }

    const res = await fetch(`${args.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: args.model,
        stream: true,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are DrawGraph AI, a precise software & hardware diagramming assistant for Mermaid, PlantUML, Draw.io XML, Graphviz DOT, and WaveDrom.',
          },
          { role: 'user', content: args.prompt },
        ],
      }),
      signal: abortController.signal,
    });

    resetIdleTimer();

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      let detail = errBody.slice(0, 300).trim();
      try {
        const parsed = JSON.parse(errBody) as { error?: { message?: string } | string };
        if (parsed?.error) {
          detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? detail);
        }
      } catch {
        // Keep raw snippet
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (json?.error?.message) {
        throw new Error(json.error.message);
      }
      const full = json?.choices?.[0]?.message?.content ?? '';
      if (full) {
        args.onChunk?.(full, full);
      }
      return full;
    }

    if (!res.body) {
      return '';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseSseChatLine(line);
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        if (parsed.text) {
          full += parsed.text;
          args.onChunk?.(full, parsed.text);
        }
        if (parsed.done) {
          return full;
        }
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseChatLine(buffer);
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      if (parsed.text) {
        full += parsed.text;
        args.onChunk?.(full, parsed.text);
      }
    }
    return full;
  } catch (err) {
    if (args.token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (timedOut) {
      throw new Error(t('AI request timed out after 60 seconds without response.'));
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    tokenSub?.dispose();
  }
}
