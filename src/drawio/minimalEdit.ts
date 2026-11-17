export interface MinimalTextChange {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

/**
 * Computes the smallest single contiguous replacement converting `oldText` into `newText`
 * by trimming identical leading and trailing UTF-16 code units. Returns `undefined` when
 * the two strings are identical.
 */
export function computeMinimalTextChange(oldText: string, newText: string): MinimalTextChange | undefined {
  if (oldText === newText) {
    return undefined;
  }
  const minLen = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  // Avoid splitting a UTF-16 surrogate pair at the prefix boundary.
  if (prefix > 0 && oldText.charCodeAt(prefix - 1) >= 0xd800 && oldText.charCodeAt(prefix - 1) <= 0xdbff) {
    prefix--;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  // Avoid splitting a UTF-16 surrogate pair at the suffix boundary.
  if (oldEnd < oldText.length && oldText.charCodeAt(oldEnd) >= 0xdc00 && oldText.charCodeAt(oldEnd) <= 0xdfff) {
    oldEnd++;
    newEnd++;
  }

  return {
    startOffset: prefix,
    endOffset: oldEnd,
    replacement: newText.slice(prefix, newEnd),
  };
}
