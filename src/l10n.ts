import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  normalizeLanguageSetting,
  resolveDrawioLanguage,
  resolveLanguage,
  translateMessage,
  type LanguageSetting,
  type ResolvedLanguage,
} from './l10nCore';

export { normalizeLanguageSetting, resolveDrawioLanguage, resolveLanguage, type LanguageSetting, type ResolvedLanguage };

let extensionRootPath = path.join(__dirname, '..');
const cachedBundles = new Map<string, Record<string, string> | null>();

export function initL10n(extensionPath: string): void {
  extensionRootPath = extensionPath;
  cachedBundles.clear();
}

export function getLanguageSetting(): LanguageSetting {
  return normalizeLanguageSetting(vscode.workspace.getConfiguration('drawGraph').get<string>('language', 'Auto'));
}

export function getLanguage(): ResolvedLanguage {
  return resolveLanguage(getLanguageSetting(), vscode.env.language);
}

export function getDrawioLanguage(): string {
  return resolveDrawioLanguage(getLanguageSetting(), vscode.env.language);
}

function getBundle(lang: ResolvedLanguage): Record<string, string> | null {
  if (lang === 'en') {
    return null;
  }
  if (cachedBundles.has(lang)) {
    return cachedBundles.get(lang) ?? null;
  }
  try {
    const filePath = path.join(extensionRootPath, 'l10n', `bundle.l10n.${lang}.json`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>;
    cachedBundles.set(lang, parsed);
    return parsed;
  } catch {
    cachedBundles.set(lang, null);
    return null;
  }
}

/**
 * Translates `message` according to `drawGraph.language` (`Auto` / `Simplified Chinese` / `English`),
 * allowing immediate runtime switching between Chinese and English independent of VS Code's OS locale.
 */
export function t(message: string, ...args: Array<string | number>): string {
  const lang = getLanguage();
  return translateMessage(getBundle(lang), lang, message, args);
}
