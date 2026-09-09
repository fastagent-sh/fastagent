/** A minimal, DETERMINISTIC single-file ZIP writer — just enough to package the forwarder Lambda. */
import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

/** MS-DOS epoch (1980-01-01 00:00:00) — the earliest the format can express, and a constant. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** Build a ZIP archive containing exactly one stored entry. */
export function zipSingleFile(name: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const sum = crc32(content);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
  localHeader.writeUInt16LE(0, 6); // general purpose flags
  localHeader.writeUInt16LE(0, 8); // method: 0 = stored
  localHeader.writeUInt16LE(DOS_TIME, 10);
  localHeader.writeUInt16LE(DOS_DATE, 12);
  localHeader.writeUInt32LE(sum, 14);
  localHeader.writeUInt32LE(content.byteLength, 18); // compressed size (= raw, stored)
  localHeader.writeUInt32LE(content.byteLength, 22); // uncompressed size
  localHeader.writeUInt16LE(nameBytes.byteLength, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory header signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed to extract
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(DOS_TIME, 12);
  centralHeader.writeUInt16LE(DOS_DATE, 14);
  centralHeader.writeUInt32LE(sum, 16);
  centralHeader.writeUInt32LE(content.byteLength, 20);
  centralHeader.writeUInt32LE(content.byteLength, 24);
  centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // file comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attributes
  // External attributes: regular file, rw-r--r-- in the high 16 bits.
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  centralHeader.writeUInt32LE(0, 42); // local header offset (single entry: always 0)

  const centralSize = centralHeader.byteLength + nameBytes.byteLength;
  const centralOffset = localHeader.byteLength + nameBytes.byteLength + content.byteLength;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localHeader, nameBytes, content, centralHeader, nameBytes, end]);
}
