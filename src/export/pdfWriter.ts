import { deflateSync, inflateSync } from 'node:zlib';

export interface PdfImagePage {
  /** Raw JPEG bytes (`image/jpeg`) or PNG bytes (`image/png`). */
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
  /** Intrinsic pixel width of the image (auto-detected from IHDR for PNG when omitted). */
  widthPx?: number;
  /** Intrinsic pixel height of the image (auto-detected from IHDR for PNG when omitted). */
  heightPx?: number;
  /** Scale factor used when rasterizing (e.g. `2` means 2 px = 1 pt). */
  scale?: number;
}

interface DecodedPngForPdf {
  width: number;
  height: number;
  rgbFlate: Buffer;
  alphaFlate?: Buffer;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG into PDF FlateDecode RGB + optional SMask streams. */
function decodePngToPdfStreams(pngBytes: Uint8Array): DecodedPngForPdf {
  const buf = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  if (buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error('Invalid PNG header');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idatParts: Buffer[] = [];

  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) {
      break;
    }
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts));
  const recon = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const byte = raw[srcRow + x];
      const left = x >= channels ? recon[dstRow + x - channels] : 0;
      const up = y > 0 ? recon[dstRow - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? recon[dstRow - stride + x - channels] : 0;
      let val = byte;
      if (filter === 1) {
        val = (byte + left) & 0xff;
      } else if (filter === 2) {
        val = (byte + up) & 0xff;
      } else if (filter === 3) {
        val = (byte + ((left + up) >> 1)) & 0xff;
      } else if (filter === 4) {
        val = (byte + paethPredictor(left, up, upLeft)) & 0xff;
      }
      recon[dstRow + x] = val;
    }
  }

  if (colorType === 2) {
    return { width, height, rgbFlate: deflateSync(recon) };
  }

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  let hasTransparency = false;
  for (let i = 0, p = 0, r = 0; i < width * height; i++, p += 4, r += 3) {
    rgb[r] = recon[p];
    rgb[r + 1] = recon[p + 1];
    rgb[r + 2] = recon[p + 2];
    const a = recon[p + 3];
    alpha[i] = a;
    if (a < 255) {
      hasTransparency = true;
    }
  }
  return {
    width,
    height,
    rgbFlate: deflateSync(rgb),
    alphaFlate: hasTransparency ? deflateSync(alpha) : undefined,
  };
}

/**
 * Builds a standards-compliant PDF 1.4 document from one or more JPEG or PNG pages
 * with zero external dependencies.
 */
export function buildPdfDocument(pages: readonly PdfImagePage[]): Buffer {
  if (pages.length === 0) {
    throw new Error('At least one page is required to build a PDF.');
  }

  const chunks: Buffer[] = [];
  const offsets: number[] = [0]; // 1-based PDF object numbers
  let byteLen = 0;

  const pushRaw = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    byteLen += buf.length;
  };

  const beginObj = (): number => {
    const id = offsets.length;
    offsets.push(byteLen);
    pushRaw(`${id} 0 obj\n`);
    return id;
  };

  const endObj = () => {
    pushRaw('\nendobj\n');
  };

  pushRaw('%PDF-1.4\n%\xff\xff\xff\xff\n');

  // Reserve Obj 1 (Catalog) and Obj 2 (Pages) — written after page IDs are collected?
  // Even simpler: allocate IDs deterministically up front!
  // Obj 1: Catalog, Obj 2: Pages
  offsets.push(0, 0); // placeholders for 1 and 2; we'll overwrite offsets[1] and offsets[2] when emitting them at the end!
  // Wait: `offsets` already had `[0]`, so `offsets[1]` is Obj 1 and `offsets[2]` is Obj 2.

  const pageObjIds: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const scale = Math.max(1, pg.scale ?? 2);
    const margin = 24;

    let imgObjId: number;
    let resolvedW = pg.widthPx ?? 400;
    let resolvedH = pg.heightPx ?? 300;
    if (pg.format === 'jpeg') {
      imgObjId = beginObj();
      const rawJpeg = Buffer.from(pg.bytes.buffer, pg.bytes.byteOffset, pg.bytes.byteLength);
      pushRaw(
        `<< /Type /XObject /Subtype /Image /Width ${Math.round(resolvedW)} /Height ${Math.round(resolvedH)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${rawJpeg.length} >>\nstream\n`,
      );
      pushRaw(rawJpeg);
      pushRaw('\nendstream');
      endObj();
    } else {
      const decoded = decodePngToPdfStreams(pg.bytes);
      resolvedW = pg.widthPx ?? decoded.width;
      resolvedH = pg.heightPx ?? decoded.height;
      let smaskRef = '';
      if (decoded.alphaFlate) {
        const smaskId = beginObj();
        pushRaw(
          `<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${decoded.alphaFlate.length} >>\nstream\n`,
        );
        pushRaw(decoded.alphaFlate);
        pushRaw('\nendstream');
        endObj();
        smaskRef = ` /SMask ${smaskId} 0 R`;
      }
      imgObjId = beginObj();
      pushRaw(
        `<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskRef} /Length ${decoded.rgbFlate.length} >>\nstream\n`,
      );
      pushRaw(decoded.rgbFlate);
      pushRaw('\nendstream');
      endObj();
    }

    const drawW = Math.max(36, Math.round(resolvedW / scale));
    const drawH = Math.max(36, Math.round(resolvedH / scale));
    const pageW = drawW + margin * 2;
    const pageH = drawH + margin * 2;

    const contentStream = Buffer.from(`q\n${drawW} 0 0 ${drawH} ${margin} ${margin} cm\n/Im0 Do\nQ\n`, 'latin1');
    const contentObjId = beginObj();
    pushRaw(`<< /Length ${contentStream.length} >>\nstream\n`);
    pushRaw(contentStream);
    pushRaw('\nendstream');
    endObj();

    const pageObjId = beginObj();
    pushRaw(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    );
    endObj();
    pageObjIds.push(pageObjId);
  }

  // Emit Obj 1 (Catalog) and Obj 2 (Pages) with exact byte offsets
  offsets[1] = byteLen;
  pushRaw('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = byteLen;
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  pushRaw(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>\nendobj\n`);

  const xrefOffset = byteLen;
  const totalObjs = offsets.length;
  pushRaw(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
  for (let id = 1; id < totalObjs; id++) {
    pushRaw(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushRaw(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
