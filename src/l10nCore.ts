export type LanguageSetting = 'Auto' | 'Simplified Chinese' | 'English';
export type ResolvedLanguage = 'en' | 'zh-cn';

export function normalizeLanguageSetting(raw: unknown): LanguageSetting {
  if (raw === 'English' || raw === 'en') {
    return 'English';
  }
  if (raw === 'Simplified Chinese' || raw === 'zh-cn' || raw === 'zh-CN') {
    return 'Simplified Chinese';
  }
  return 'Auto';
}

export function resolveLanguage(setting: unknown, vscodeLanguage: string | undefined): ResolvedLanguage {
  const norm = normalizeLanguageSetting(setting);
  if (norm === 'English') {
    return 'en';
  }
  if (norm === 'Simplified Chinese') {
    return 'zh-cn';
  }
  return /^zh\b/i.test(vscodeLanguage || '') ? 'zh-cn' : 'en';
}

export function resolveDrawioLanguage(setting: unknown, vscodeLanguage: string | undefined): string {
  const norm = normalizeLanguageSetting(setting);
  if (norm === 'English') {
    return 'en';
  }
  if (norm === 'Simplified Chinese') {
    return 'zh';
  }
  const lang = (vscodeLanguage || 'en').toLowerCase();
  if (lang === 'zh-tw' || lang === 'zh-hk') {
    return 'zh-tw';
  }
  return lang.split('-')[0] || 'en';
}

export function formatMessage(template: string, args: ReadonlyArray<string | number>): string {
  if (args.length === 0) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (placeholder, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    return idx >= 0 && idx < args.length ? String(args[idx]) : placeholder;
  });
}

export function translateMessage(
  bundle: Record<string, string> | null | undefined,
  lang: ResolvedLanguage,
  message: string,
  args: ReadonlyArray<string | number> = [],
): string {
  if (lang === 'en' || !bundle) {
    return formatMessage(message, args);
  }
  const translated = typeof bundle[message] === 'string' ? bundle[message] : message;
  return formatMessage(translated, args);
}
