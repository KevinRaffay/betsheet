// A bounded ZIP reader for uploaded archives, with no dependency.
//
// Node ships `zlib` (raw DEFLATE, which is the compressed half of a zip) but no
// zip CONTAINER reader, and this project carries seven runtime dependencies on
// purpose. The container is a short binary format and the real archives are the
// easy case - every entry in the 91-file 2026-09-06 capture is DEFLATE, no
// zip64, no encryption, no streamed data descriptors - so this reads it
// directly and REFUSES anything it does not fully support rather than returning
// part of an archive and letting a caller believe it got all of it.
//
// SECURITY. The archive is untrusted input and decompression is an amplifier:
// the real sample is 10:1 and a hostile one is easily 1000:1. Three caps bound
// it - entry count, per-entry output, total output - and the per-entry one is
// enforced by `inflateRawSync`'s own `maxOutputLength` DURING inflation, not by
// checking the result afterwards, because checking afterwards means the memory
// was already allocated. The declared uncompressed size is checked first as a
// cheap reject, but it is attacker-controlled and is never trusted on its own.
//
// Nothing here writes to the filesystem, and nothing here interprets an entry
// name as a path. That is what makes "zip slip" structurally impossible rather
// than something to be guarded against - keep it that way.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Bounds for one upload. Deliberately generous against the real artifact
 *  (91 entries, 660 KB largest, 68 MB total) and still far from a bomb. */
export const ZIP_LIMITS = {
  entries: 500,
  entryBytes: 20 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** MS-DOS date+time (the only timestamp a basic zip entry carries) -> Date. */
function dosDateTime(time, date) {
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // DOS timestamps carry no zone; they are local time by convention, which is
  // what a person's own machine wrote and what a viewer will read it back as.
  const d = new Date(year, month - 1, day, hours, minutes, seconds);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The End of Central Directory record, searched from the end (it may be
 *  followed by up to 64 KB of archive comment). */
function findEocd(buf) {
  const min = 22;
  if (buf.length < min) throw new ZipError('Not a zip file: too short to contain a zip directory.');
  const earliest = Math.max(0, buf.length - min - 0xffff);
  for (let i = buf.length - min; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('Not a zip file: no end-of-central-directory record found.');
}

/**
 * `readZip(buffer, { limits, filter })` -> `[{ name, bytes, modifiedAt }]`.
 *
 * `filter(name)` is consulted BEFORE an entry is inflated, so a caller that
 * wants only `.html` never spends its output budget on anything else.
 *
 * Throws `ZipError` with a message naming what it could not do. It never
 * returns a partial archive: a caller that gets a list got the whole of what
 * the filter selected.
 */
export function readZip(buffer, { limits = ZIP_LIMITS, filter = null } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const eocd = findEocd(buf);

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // Any of these at their sentinel means the real value lives in a zip64
  // record. Refused by name rather than silently read as 0xFFFF/0xFFFFFFFF.
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('This is a zip64 archive, which this reader does not support. '
      + 'Re-create it as a standard zip (under 65535 entries and 4 GB).');
  }
  if (entryCount > limits.entries) {
    throw new ZipError(`This archive holds ${entryCount} entries; the limit is ${limits.entries}.`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('Zip directory runs past the end of the file - the upload is truncated or corrupt.');
  }

  const files = [];
  let totalOut = 0;
  let p = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDFH_SIG) {
      throw new ZipError(`Zip directory entry ${i + 1} is malformed - the upload is truncated or corrupt.`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // A directory entry is a name ending in '/' with no content. Not a file,
    // not an error, simply not interesting.
    if (name.endsWith('/')) continue;
    if (filter && !filter(name)) continue;

    if (flags & 0x1) {
      throw new ZipError(`"${name}" is encrypted; this reader cannot open password-protected archives.`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(`"${name}" uses compression method ${method}; only stored and deflate are supported.`);
    }
    if (uncompSize === 0xffffffff || compSize === 0xffffffff) {
      throw new ZipError(`"${name}" is a zip64 entry, which this reader does not support.`);
    }
    // Cheap reject on the DECLARED size. Attacker-controlled, so it is a fast
    // path and never the actual enforcement - `maxOutputLength` below is.
    if (uncompSize > limits.entryBytes) {
      throw new ZipError(`"${name}" declares ${uncompSize} bytes, over the ${limits.entryBytes}-byte per-file limit.`);
    }
    if (totalOut + uncompSize > limits.totalBytes) {
      throw new ZipError(`This archive decompresses to more than the ${limits.totalBytes}-byte total limit.`);
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) {
      throw new ZipError(`"${name}" has no valid local header - the upload is truncated or corrupt.`);
    }
    // The local header's own name/extra lengths are what locate the data, and
    // its extra field is routinely a DIFFERENT length from the central
    // directory's. Reading the central one here is a classic way to land a few
    // bytes into the compressed data.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    if (dataAt + compSize > buf.length) {
      throw new ZipError(`"${name}" runs past the end of the file - the upload is truncated or corrupt.`);
    }
    const compressed = buf.subarray(dataAt, dataAt + compSize);

    let bytes;
    if (method === METHOD_STORED) {
      bytes = Buffer.from(compressed);
    } else {
      try {
        bytes = zlib.inflateRawSync(compressed, { maxOutputLength: limits.entryBytes });
      } catch (err) {
        // maxOutputLength surfaces as a RangeError-ish "buffer too big"; either
        // way the entry did not decompress, and saying which entry matters more
        // than relaying zlib's wording.
        throw new ZipError(`"${name}" could not be decompressed (${err?.message ?? err}). `
          + 'It may be corrupt, or larger than the per-file limit.');
      }
    }

    // The declared size is attacker-controlled; the real one is what was
    // produced. Check the budget against reality before accepting the entry.
    totalOut += bytes.length;
    if (bytes.length > limits.entryBytes || totalOut > limits.totalBytes) {
      throw new ZipError(`"${name}" decompressed past the size limit - refusing the archive.`);
    }
    // CRC is the integrity check the format already carries. A mismatch means
    // the bytes are not what was zipped, which is worth failing on rather than
    // parsing.
    if (typeof zlib.crc32 === 'function' && crc !== 0) {
      const actual = zlib.crc32(bytes) >>> 0;
      if (actual !== crc) {
        throw new ZipError(`"${name}" failed its checksum - the upload is corrupt.`);
      }
    }

    files.push({ name, bytes, modifiedAt: dosDateTime(modTime, modDate) });
  }

  return files;
}
