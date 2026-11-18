import { deflateSync, inflateSync } from 'node:zlib';

export interface PdfImagePage {
  /** Raw JPEG bytes (`image/jpeg`) or PNG bytes (`image/png`). */
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
  /** Intrinsic pixel width of the image (auto-detected from PNG IHDR or JPEG SOF when omitted). */
  widthPx?: number;
  /** Intrinsic pixel height of the image (auto-detected from PNG IHDR or JPEG SOF when omitted). */
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

function readJpegDimensions(jpegBytes: Uint8Array): { width: number; height: number } | undefined {
  const buf = Buffer.from(jpegBytes.buffer, jpegBytes.byteOffset, jpegBytes.byteLength);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return undefined;
  }
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      pos += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2 || pos + 2 + segLen > buf.length) {
      break;
    }
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = buf.readUInt16BE(pos + 5);
      const width = buf.readUInt16BE(pos + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    pos += 2 + segLen;
  }
  return undefined;
}

function unpackSubByteSamples(rowBytes: Uint8Array, width: number, bitDepth: number): Uint8Array {
  const out = new Uint8Array(width);
  const mask = (1 << bitDepth) - 1;
  const samplesPerByte = 8 / bitDepth;
  for (let x = 0; x < width; x++) {
    const byteIdx = Math.floor(x / samplesPerByte);
    const shift = 8 - bitDepth * ((x % samplesPerByte) + 1);
    out[x] = (rowBytes[byteIdx] >>> shift) & mask;
  }
  return out;
}

/**
 * Decodes any non-interlaced PNG (colorType 0 grayscale, 2 RGB, 3 PLTE indexed palette,
 * 4 grayscale+alpha, 6 RGBA; bitDepth 1/2/4/8/16; optional tRNS transparency) into PDF
 * `/DeviceRGB` FlateDecode + optional `/SMask` streams.
 */
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
  let interlace = 0;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
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
      interlace = buf[dataStart + 12];
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (
    width <= 0 ||
    height <= 0 ||
    interlace !== 0 ||
    ![1, 2, 4, 8, 16].includes(bitDepth) ||
    ![0, 2, 3, 4, 6].includes(colorType)
  ) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }

  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowByteLen = Math.ceil((width * bitsPerPixel) / 8);

  const raw = inflateSync(Buffer.concat(idatParts));
  const recon = Buffer.alloc(height * rowByteLen);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowByteLen + 1)];
    const srcRow = y * (rowByteLen + 1) + 1;
    const dstRow = y * rowByteLen;
    for (let x = 0; x < rowByteLen; x++) {
      const byte = raw[srcRow + x];
      const left = x >= bpp ? recon[dstRow + x - bpp] : 0;
      const up = y > 0 ? recon[dstRow - rowByteLen + x] : 0;
      const upLeft = y > 0 && x >= bpp ? recon[dstRow - rowByteLen + x - bpp] : 0;
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

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height, 255);
  let hasTransparency = false;

  if (colorType === 3) {
    if (!plte) {
      throw new Error('Invalid indexed PNG: missing PLTE chunk');
    }
    for (let y = 0; y < height; y++) {
      const rowSlice = recon.subarray(y * rowByteLen, (y + 1) * rowByteLen);
      const indices = bitDepth < 8 ? unpackSubByteSamples(rowSlice, width, bitDepth) : rowSlice;
      for (let x = 0; x < width; x++) {
        const idx = indices[x];
        const pOff = idx * 3;
        const dstPixel = y * width + x;
        const dstRgb = dstPixel * 3;
        rgb[dstRgb] = plte[pOff] ?? 0;
        rgb[dstRgb + 1] = plte[pOff + 1] ?? 0;
        rgb[dstRgb + 2] = plte[pOff + 2] ?? 0;
        const a = trns && idx < trns.length ? trns[idx] : 255;
        alpha[dstPixel] = a;
        if (a < 255) {
          hasTransparency = true;
        }
      }
    }
  } else if (colorType === 0) {
    const maxSample = (1 << bitDepth) - 1;
    const transGray = trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
    for (let y = 0; y < height; y++) {
      const rowSlice = recon.subarray(y * rowByteLen, (y + 1) * rowByteLen);
      if (bitDepth < 8) {
        const samples = unpackSubByteSamples(rowSlice, width, bitDepth);
        for (let x = 0; x < width; x++) {
          const s = samples[x];
          const g = Math.round((s * 255) / maxSample);
          const dstPixel = y * width + x;
          rgb.fill(g, dstPixel * 3, dstPixel * 3 + 3);
          if (s === transGray) {
            alpha[dstPixel] = 0;
            hasTransparency = true;
          }
        }
      } else {
        const step = bitDepth === 16 ? 2 : 1;
        for (let x = 0; x < width; x++) {
          const rawVal = bitDepth === 16 ? rowSlice.readUInt16BE(x * 2) : rowSlice[x];
          const g = bitDepth === 16 ? rawVal >>> 8 : rawVal;
          const dstPixel = y * width + x;
          rgb[dstPixel * 3] = g;
          rgb[dstPixel * 3 + 1] = g;
          rgb[dstPixel * 3 + 2] = g;
          if (rawVal === transGray && step >= 1) {
            alpha[dstPixel] = 0;
            hasTransparency = true;
          }
        }
      }
    }
  } else if (colorType === 4) {
    const step = bitDepth === 16 ? 4 : 2;
    for (let y = 0; y < height; y++) {
      const rowSlice = recon.subarray(y * rowByteLen, (y + 1) * rowByteLen);
      for (let x = 0; x < width; x++) {
        const g = rowSlice[x * step];
        const a = rowSlice[x * step + (bitDepth === 16 ? 2 : 1)];
        const dstPixel = y * width + x;
        rgb[dstPixel * 3] = g;
        rgb[dstPixel * 3 + 1] = g;
        rgb[dstPixel * 3 + 2] = g;
        alpha[dstPixel] = a;
        if (a < 255) {
          hasTransparency = true;
        }
      }
    }
  } else if (colorType === 2) {
    if (bitDepth === 8 && !trns) {
      return { width, height, rgbFlate: deflateSync(recon) };
    }
    const step = bitDepth === 16 ? 6 : 3;
    const trR = trns && trns.length >= 6 ? trns.readUInt16BE(0) : -1;
    const trG = trns && trns.length >= 6 ? trns.readUInt16BE(2) : -1;
    const trB = trns && trns.length >= 6 ? trns.readUInt16BE(4) : -1;
    for (let y = 0; y < height; y++) {
      const rowSlice = recon.subarray(y * rowByteLen, (y + 1) * rowByteLen);
      for (let x = 0; x < width; x++) {
        const off = x * step;
        const dstPixel = y * width + x;
        const dstRgb = dstPixel * 3;
        rgb[dstRgb] = rowSlice[off];
        rgb[dstRgb + 1] = rowSlice[off + (bitDepth === 16 ? 2 : 1)];
        rgb[dstRgb + 2] = rowSlice[off + (bitDepth === 16 ? 4 : 2)];
        if (trR >= 0) {
          const rr = bitDepth === 16 ? rowSlice.readUInt16BE(off) : rowSlice[off];
          const rg = bitDepth === 16 ? rowSlice.readUInt16BE(off + 2) : rowSlice[off + 1];
          const rb = bitDepth === 16 ? rowSlice.readUInt16BE(off + 4) : rowSlice[off + 2];
          if (rr === trR && rg === trG && rb === trB) {
            alpha[dstPixel] = 0;
            hasTransparency = true;
          }
        }
      }
    }
  } else {
    // colorType === 6 (RGBA 8-bit or 16-bit)
    const step = bitDepth === 16 ? 8 : 4;
    const chStep = bitDepth === 16 ? 2 : 1;
    for (let y = 0; y < height; y++) {
      const rowSlice = recon.subarray(y * rowByteLen, (y + 1) * rowByteLen);
      for (let x = 0; x < width; x++) {
        const off = x * step;
        const dstPixel = y * width + x;
        const dstRgb = dstPixel * 3;
        rgb[dstRgb] = rowSlice[off];
        rgb[dstRgb + 1] = rowSlice[off + chStep];
        rgb[dstRgb + 2] = rowSlice[off + chStep * 2];
        const a = rowSlice[off + chStep * 3];
        alpha[dstPixel] = a;
        if (a < 255) {
          hasTransparency = true;
        }
      }
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
  const offsets: number[] = [0, 0, 0]; // 1-based: [0 unused, 1 Catalog, 2 Pages]
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

  const pageObjIds: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const scale = Math.max(1, pg.scale ?? 2);
    const margin = 24;

    let imgObjId: number;
    let resolvedW = pg.widthPx ?? 400;
    let resolvedH = pg.heightPx ?? 300;
    if (pg.format === 'jpeg') {
      if (!pg.widthPx || !pg.heightPx) {
        const dims = readJpegDimensions(pg.bytes);
        if (dims) {
          resolvedW = pg.widthPx ?? dims.width;
          resolvedH = pg.heightPx ?? dims.height;
        }
      }
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
