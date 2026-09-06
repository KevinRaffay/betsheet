// Verification for server/zip-read.js.
// Run: npm run check-zip-read
//
// PURE and hermetic: no server, no database, no committed archive. Every zip
// under test is BUILT HERE, byte by byte, which is the only way to test the
// cases that matter - an encrypted entry, a zip64 sentinel, a truncated file,
// a decompression bomb - since none of those can be produced by zipping a
// directory and none should be committed as a fixture.
//
// The reader's correctness against a REAL archive was established separately
// and is recorded in the ledger: all 91 entries of the 2026-09-06 capture come
// back byte-identical (sha256, entry for entry) to Python's `zipfile`. What
// this script guards is the behaviour that has to hold on hostile or damaged
// input, where "it worked on the real one" proves nothing.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { readZip, ZipError, ZIP_LIMITS } from '../server/zip-read.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

/** Assert that a call throws ZipError, and that the message says WHICH problem
 *  it is - a refusal nobody can act on is barely better than a crash. */
function refuses(name, fn, pattern) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) { check(name, false, 'did not throw'); return; }
  check(name, err instanceof ZipError && pattern.test(err.message), `${err.name}: ${err.message}`);
}

// ---------- a minimal zip writer, so the inputs are exactly as intended ----------

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/** entries: [{ name, data, method?, flags?, crcOverride?, sizeOverride? }] */
function buildZip(entries, { eocdCountOverride = null } = {}) {
  const when = new Date(2026, 8, 6, 12, 34, 56);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const method = e.method ?? 8;
    const raw = Buffer.from(e.data);
    const body = method === 0 ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = e.crcOverride ?? (zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0);
    const usize = e.sizeOverride ?? raw.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.flags ?? 0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime(when), 10);
    lfh.writeUInt16LE(dosDate(when), 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(usize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, body);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(e.flags ?? 0, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(dosTime(when), 12);
    cdfh.writeUInt16LE(dosDate(when), 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(body.length, 20);
    cdfh.writeUInt32LE(usize, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);
    cdfh.writeUInt16LE(0, 32);
    cdfh.writeUInt16LE(0, 34);
    cdfh.writeUInt16LE(0, 36);
    cdfh.writeUInt32LE(0, 38);
    cdfh.writeUInt32LE(offset, 42);
    centrals.push(cdfh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  const count = eocdCountOverride ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// ---------- the ordinary case ----------

console.log('-- reads what it is given --');
{
  const zip = buildZip([
    { name: 'a.html', data: '<html>alpha</html>' },
    { name: 'nested/b.html', data: '<html>beta</html>' },
    { name: 'stored.html', data: '<html>gamma</html>', method: 0 },
  ]);
  const files = readZip(zip);
  check('every entry comes back', files.length === 3, String(files.length));
  check('contents round-trip exactly',
    files[0].bytes.toString() === '<html>alpha</html>'
    && files[1].bytes.toString() === '<html>beta</html>');
  check('a STORED entry reads too, not just deflate',
    files[2].bytes.toString() === '<html>gamma</html>');
  check('names keep their path as written, without being interpreted as one',
    files[1].name === 'nested/b.html');
  check('each entry carries its own timestamp - a day keeps its own capture time',
    files[0].modifiedAt instanceof Date && files[0].modifiedAt.getFullYear() === 2026);
}

console.log('\n-- the filter runs BEFORE inflation, so junk costs nothing --');
{
  const big = 'x'.repeat(5 * 1024 * 1024);
  const zip = buildZip([
    { name: 'keep.html', data: '<html>keep</html>' },
    { name: 'huge.bin', data: big },
  ]);
  const files = readZip(zip, { filter: (n) => n.endsWith('.html') });
  check('only the selected entry is returned', files.length === 1 && files[0].name === 'keep.html');
  // The unselected entry is over a per-entry cap set below its size: if the
  // filter ran after inflation, or not at all, this would throw.
  const tight = { ...ZIP_LIMITS, entryBytes: 1024 };
  const still = readZip(zip, { limits: tight, filter: (n) => n.endsWith('.html') });
  check('an entry the filter skipped is never inflated, never counted, never a limit failure',
    still.length === 1);
}

console.log('\n-- directory entries are not files --');
{
  const zip = buildZip([{ name: 'folder/', data: '' }, { name: 'folder/x.html', data: '<html>x</html>' }]);
  const files = readZip(zip);
  check('a directory entry is skipped rather than returned as an empty file',
    files.length === 1 && files[0].name === 'folder/x.html');
}

// ---------- the refusals, which are the point ----------

console.log('\n-- refuses a decompression bomb, during inflation --');
{
  // 8 MB of zeros compresses to a few KB. With a 1 MB per-entry cap the reader
  // must stop while inflating, not allocate 8 MB and then object.
  const bomb = buildZip([{ name: 'bomb.html', data: Buffer.alloc(8 * 1024 * 1024) }]);
  refuses('a highly compressible entry is stopped at the per-entry cap',
    () => readZip(bomb, { limits: { ...ZIP_LIMITS, entryBytes: 1024 * 1024 } }),
    /limit|decompress/i);

  // A LIE in the declared size must not get past the real enforcement: this
  // entry claims to be tiny and is not.
  const liar = buildZip([{ name: 'liar.html', data: Buffer.alloc(8 * 1024 * 1024), sizeOverride: 10 }]);
  refuses('a declared size that lies is caught by the real inflation cap, not believed',
    () => readZip(liar, { limits: { ...ZIP_LIMITS, entryBytes: 1024 * 1024 } }),
    /limit|decompress/i);

  refuses('the TOTAL cap is enforced across entries, not just per entry',
    () => readZip(
      buildZip([
        { name: 'a.html', data: Buffer.alloc(600 * 1024) },
        { name: 'b.html', data: Buffer.alloc(600 * 1024) },
      ]),
      { limits: { ...ZIP_LIMITS, entryBytes: 1024 * 1024, totalBytes: 1024 * 1024 } },
    ),
    /total limit/i);

  refuses('too many entries is refused before any of them is read',
    () => readZip(buildZip([{ name: 'a.html', data: 'a' }, { name: 'b.html', data: 'b' }]),
      { limits: { ...ZIP_LIMITS, entries: 1 } }),
    /entries; the limit is/i);
}

console.log('\n-- refuses what it cannot honestly read --');
{
  refuses('an encrypted entry is named and refused, not returned as garbage',
    () => readZip(buildZip([{ name: 'secret.html', data: '<html>s</html>', flags: 0x1 }])),
    /encrypted/i);

  refuses('an unsupported compression method is named with its number',
    () => readZip(buildZip([{ name: 'x.html', data: 'x', method: 0 }].map((e) => ({ ...e, method: 12 })))),
    /compression method 12/i);

  refuses('a zip64 sentinel in the directory is refused rather than read as 0xFFFFFFFF',
    () => readZip(buildZip([{ name: 'a.html', data: 'a' }], { eocdCountOverride: 0xffff })),
    /zip64/i);

  refuses('a file with no end-of-directory record is not a zip',
    () => readZip(Buffer.from('this is not a zip file at all, it is prose')),
    /not a zip file/i);

  refuses('an empty buffer is refused rather than read as an empty archive',
    () => readZip(Buffer.alloc(0)), /not a zip file/i);

  const good = buildZip([{ name: 'a.html', data: '<html>a</html>' }]);
  refuses('a truncated archive is refused rather than yielding the entries that survived',
    () => readZip(good.subarray(0, good.length - 40)), /not a zip file|truncated|corrupt/i);
}

console.log('\n-- integrity --');
{
  if (typeof zlib.crc32 === 'function') {
    const tampered = buildZip([{ name: 'a.html', data: '<html>a</html>', crcOverride: 0x12345678 }]);
    refuses('an entry whose checksum does not match its bytes is refused',
      () => readZip(tampered), /checksum|corrupt/i);
  } else {
    check('crc32 unavailable in this Node, checksum assertion skipped', true);
  }
}

console.log('\n-- it never writes anything, which is what makes zip slip moot --');
{
  // A classic traversal name. The reader must hand it back as DATA with the
  // name untouched and never resolve it against the filesystem.
  const evil = buildZip([{ name: '../../../etc/passwd', data: 'root:x:0:0' }]);
  const files = readZip(evil);
  check('a traversal name is returned verbatim as a name, never resolved as a path',
    files.length === 1 && files[0].name === '../../../etc/passwd'
    && files[0].bytes.toString() === 'root:x:0:0');
  const src = fs.readFileSync(new URL('../server/zip-read.js', import.meta.url), 'utf8');
  check('the module imports no filesystem module and writes nothing',
    !/node:fs|writeFileSync|createWriteStream/.test(src),
    'server/zip-read.js must not touch the filesystem');
}

if (failures) {
  console.error(`\ncheck-zip-read: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-zip-read: all checks passed');
