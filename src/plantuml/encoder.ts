import { deflateRawSync } from 'node:zlib';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** Encodes PlantUML source the way the PlantUML server expects in its URLs (deflate + custom base64). */
export function encodePlantUml(source: string): string {
  const data = deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 });
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += ALPHABET[b1 >> 2];
    out += ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
    out += ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
    out += ALPHABET[b3 & 0x3f];
  }
  return out;
}

export interface DiagramBlock {
  /** Source of the block including its @start/@end lines. */
  source: string;
  startLine: number;
  endLine: number;
}

/**
 * Splits a file into its `@startXXX ... @endXXX` blocks. A file without any
 * markers is treated as a single `@startuml` diagram.
 */
export function splitDiagrams(text: string): DiagramBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: DiagramBlock[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (start < 0 && /^@start\w*/i.test(line)) {
      start = i;
    } else if (start >= 0 && /^@end\w*/i.test(line)) {
      blocks.push({ source: lines.slice(start, i + 1).join('\n'), startLine: start, endLine: i });
      start = -1;
    }
  }
  if (start >= 0) {
    // Unterminated block: render it anyway so the user sees progress while typing.
    const rest = lines.slice(start);
    const end = '@end' + (/^@start(\w*)/i.exec(rest[0].trim())?.[1] ?? 'uml');
    blocks.push({ source: [...rest, end].join('\n'), startLine: start, endLine: lines.length - 1 });
  }
  if (blocks.length === 0 && text.trim().length > 0) {
    blocks.push({ source: `@startuml\n${text}\n@enduml`, startLine: 0, endLine: lines.length - 1 });
  }
  return blocks;
}

/** Picks the block that contains `line`, falling back to the nearest preceding one, then the first. */
export function pickBlock(blocks: DiagramBlock[], line: number | undefined): DiagramBlock | undefined {
  if (blocks.length === 0) {
    return undefined;
  }
  if (line === undefined) {
    return blocks[0];
  }
  let best = blocks[0];
  for (const block of blocks) {
    if (block.startLine <= line) {
      best = block;
    }
  }
  return best;
}
