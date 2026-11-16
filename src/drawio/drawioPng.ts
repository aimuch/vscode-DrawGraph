import { inflateSync } from 'node:zlib';
import { unescapeXml } from './drawioSvg';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether a path points to a PNG diagram file. */
export function isPngDiagramPath(filePath: string): boolean {
  return /\.png$/i.test(filePath);
}

/** Checks whether `bytes` starts with the 8-byte PNG file signature. */
export function isValidPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function decodeCandidateXml(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (/^<mxfile\b|^<mxGraphModel\b/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes('%3C') || trimmed.includes('%3c')) {
    try {
      const decoded = decodeURIComponent(trimmed).trim();
      if (/^<mxfile\b|^<mxGraphModel\b/.test(decoded)) {
        return decoded;
      }
    } catch {
      // Ignore malformed percent-encoding.
    }
  }
  const unescaped = unescapeXml(trimmed).trim();
  if (/^<mxfile\b|^<mxGraphModel\b/.test(unescaped)) {
    return unescaped;
  }
  return undefined;
}

/**
 * Extracts the embedded draw.io diagram XML (`<mxfile>…</mxfile>`) from a PNG's
 * `tEXt`, `zTXt`, or `iTXt` metadata chunks, returning `undefined` if none is present.
 */
export function extractDiagramFromPng(bytes: Uint8Array): string | undefined {
  if (!isValidPng(bytes)) {
    return undefined;
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      break;
    }

    if (type === 'tEXt') {
      const nul = buf.indexOf(0, dataStart);
      if (nul >= dataStart && nul < dataEnd) {
        const keyword = buf.toString('latin1', dataStart, nul);
        if (keyword === 'mxfile' || keyword === 'mxGraphModel') {
          const text = buf.toString('latin1', nul + 1, dataEnd);
          const xml = decodeCandidateXml(text);
          if (xml) {
            return xml;
          }
        }
      }
    } else if (type === 'zTXt') {
      const nul = buf.indexOf(0, dataStart);
      if (nul >= dataStart && nul + 2 <= dataEnd) {
        const keyword = buf.toString('latin1', dataStart, nul);
        const compressionMethod = buf[nul + 1];
        if ((keyword === 'mxfile' || keyword === 'mxGraphModel') && compressionMethod === 0) {
          try {
            const inflated = inflateSync(buf.subarray(nul + 2, dataEnd)).toString('utf8');
            const xml = decodeCandidateXml(inflated);
            if (xml) {
              return xml;
            }
          } catch {
            // Ignore corrupt compressed chunk.
          }
        }
      }
    } else if (type === 'iTXt') {
      const nul = buf.indexOf(0, dataStart);
      if (nul >= dataStart && nul + 3 <= dataEnd) {
        const keyword = buf.toString('utf8', dataStart, nul);
        if (keyword === 'mxfile' || keyword === 'mxGraphModel') {
          const compFlag = buf[nul + 1];
          const compMethod = buf[nul + 2];
          const langEnd = buf.indexOf(0, nul + 3);
          const transEnd = langEnd >= 0 && langEnd < dataEnd ? buf.indexOf(0, langEnd + 1) : -1;
          if (transEnd >= 0 && transEnd < dataEnd) {
            try {
              const payload = buf.subarray(transEnd + 1, dataEnd);
              const text = compFlag === 1 && compMethod === 0 ? inflateSync(payload).toString('utf8') : payload.toString('utf8');
              const xml = decodeCandidateXml(text);
              if (xml) {
                return xml;
              }
            } catch {
              // Ignore malformed iTXt payload.
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }
  return undefined;
}

/** Encodes raw PNG bytes as a `data:image/png;base64,...` URI for draw.io's embed loader. */
export function pngBytesToDataUri(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;
}
