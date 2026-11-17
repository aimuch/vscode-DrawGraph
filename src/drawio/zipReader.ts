import { inflateRawSync } from 'node:zlib';

export interface ZipFileEntry {
  relativePath: string;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function sanitizeRelativeZipPath(rawName: string): string | undefined {
  const normalized = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) {
    return undefined;
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      return undefined;
    }
  }
  return parts.join('/');
}

/**
 * Pure Node.js ZIP / WAR archive reader (Store + Deflate) with strict path-traversal
 * filtering and automatic Draw.io webapp root normalization (`index.html` discovery).
 */
export function extractWebappZipEntries(archiveBytes: Uint8Array, maxUncompressedBytes = 350 * 1024 * 1024): ZipFileEntry[] {
  const buf = Buffer.from(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  if (buf.length < 22) {
    throw new Error('Invalid ZIP/WAR archive: file is too small.');
  }

  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP/WAR archive: End of Central Directory not found.');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset >= buf.length) {
    throw new Error('Invalid ZIP/WAR archive: corrupt central directory offset.');
  }

  const rawEntries: ZipFileEntry[] = [];
  let totalBytes = 0;
  let ptr = centralDirOffset;

  for (let idx = 0; idx < totalEntries && ptr + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) {
      break;
    }
    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    const cleanPath = sanitizeRelativeZipPath(rawName);
    if (!cleanPath || cleanPath.startsWith('META-INF/') || cleanPath.startsWith('WEB-INF/')) {
      continue;
    }
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== LOC_SIG) {
      throw new Error(`Invalid local header for entry "${cleanPath}".`);
    }

    const locNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const locExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated data for entry "${cleanPath}".`);
    }

    totalBytes += uncompressedSize;
    if (totalBytes > maxUncompressedBytes) {
      throw new Error('Archive exceeds maximum allowed uncompressed size.');
    }

    const slice = buf.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (compressionMethod === 0) {
      data = new Uint8Array(slice);
    } else if (compressionMethod === 8) {
      data = inflateRawSync(slice, { maxOutputLength: Math.max(uncompressedSize + 1024, 65536) });
    } else {
      continue;
    }

    rawEntries.push({ relativePath: cleanPath, data });
  }

  // Locate Draw.io's index.html root (either at archive root as in draw.war, or nested inside webapp/).
  const indexCandidates = rawEntries
    .filter((e) => e.relativePath === 'index.html' || e.relativePath.endsWith('/index.html'))
    .sort((a, b) => {
      const aWebapp = a.relativePath.endsWith('webapp/index.html') ? 0 : 1;
      const bWebapp = b.relativePath.endsWith('webapp/index.html') ? 0 : 1;
      if (aWebapp !== bWebapp) {
        return aWebapp - bWebapp;
      }
      return a.relativePath.split('/').length - b.relativePath.split('/').length;
    });

  if (indexCandidates.length === 0) {
    throw new Error('Archive does not contain an index.html Draw.io webapp entry.');
  }

  const indexRel = indexCandidates[0].relativePath;
  const rootPrefix = indexRel === 'index.html' ? '' : indexRel.slice(0, -'index.html'.length);
  if (!rootPrefix) {
    return rawEntries;
  }

  return rawEntries
    .filter((e) => e.relativePath.startsWith(rootPrefix))
    .map((e) => ({
      relativePath: e.relativePath.slice(rootPrefix.length),
      data: e.data,
    }))
    .filter((e) => e.relativePath.length > 0);
}

/**
 * Helper to build a minimal Store-method ZIP buffer from in-memory files (used in tests and tooling).
 */
export function buildStoreZipBuffer(files: Array<{ name: string; content: string | Uint8Array }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const dataBuf = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    const crc = crc32(dataBuf);

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC_SIG, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0, 6);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt16LE(0, 10);
    loc.writeUInt16LE(0, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(dataBuf.length, 18);
    loc.writeUInt32LE(dataBuf.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    loc.writeUInt16LE(0, 28);
    localChunks.push(loc, nameBuf, dataBuf);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(dataBuf.length, 20);
    cen.writeUInt32LE(dataBuf.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centralChunks.push(cen, nameBuf);

    offset += 30 + nameBuf.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
