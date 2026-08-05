const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SENSITIVE_PNG_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const SENSITIVE_JPEG_MARKERS = new Set([0xe1, 0xed, 0xfe]);

function isPng(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function transformPng(bytes, remove = false) {
  if (!isPng(bytes)) throw new Error("Invalid PNG image");
  const chunks = [bytes.subarray(0, 8)];
  const sensitive = [];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (SENSITIVE_PNG_CHUNKS.has(type)) sensitive.push(type);
    if (!remove || !SENSITIVE_PNG_CHUNKS.has(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd || offset !== bytes.length) throw new Error("Invalid PNG chunk stream");
  return { bytes: remove ? Buffer.concat(chunks) : bytes, sensitive };
}

function transformJpeg(bytes, remove = false) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG image");
  const chunks = [bytes.subarray(0, 2)];
  const sensitive = [];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG marker stream");
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("Truncated JPEG marker");
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(bytes.subarray(markerStart));
      offset = bytes.length;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      chunks.push(bytes.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment length");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("Invalid JPEG segment length");
    const end = offset + length;
    if (SENSITIVE_JPEG_MARKERS.has(marker)) sensitive.push(`0x${marker.toString(16).toUpperCase()}`);
    if (!remove || !SENSITIVE_JPEG_MARKERS.has(marker)) chunks.push(bytes.subarray(markerStart, end));
    offset = end;
  }
  if (offset !== bytes.length) throw new Error("Invalid JPEG data");
  return { bytes: remove ? Buffer.concat(chunks) : bytes, sensitive };
}

function transformIco(bytes, remove = false) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error("Invalid ICO image");
  const count = bytes.readUInt16LE(4);
  const headerLength = 6 + count * 16;
  if (!count || headerLength > bytes.length) throw new Error("Invalid ICO directory");
  const entries = [];
  const sensitive = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const size = bytes.readUInt32LE(entryOffset + 8);
    const imageOffset = bytes.readUInt32LE(entryOffset + 12);
    if (!size || imageOffset < headerLength || imageOffset + size > bytes.length) throw new Error("Invalid ICO entry");
    const original = bytes.subarray(imageOffset, imageOffset + size);
    const transformed = isPng(original) ? transformPng(original, remove) : { bytes: original, sensitive: [] };
    sensitive.push(...transformed.sensitive.map((item) => `entry-${index}:${item}`));
    entries.push({ directory: Buffer.from(bytes.subarray(entryOffset, entryOffset + 16)), image: transformed.bytes });
  }
  if (!remove) return { bytes, sensitive };
  const header = Buffer.from(bytes.subarray(0, headerLength));
  let imageOffset = headerLength;
  entries.forEach((entry, index) => {
    entry.directory.writeUInt32LE(entry.image.length, 8);
    entry.directory.writeUInt32LE(imageOffset, 12);
    entry.directory.copy(header, 6 + index * 16);
    imageOffset += entry.image.length;
  });
  return { bytes: Buffer.concat([header, ...entries.map((entry) => entry.image)]), sensitive };
}

function transformIcns(bytes, remove = false) {
  if (bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error("Invalid ICNS image");
  }
  const chunks = [];
  const sensitive = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) throw new Error("Invalid ICNS chunk");
    const payload = bytes.subarray(offset + 8, offset + length);
    const transformed = isPng(payload) ? transformPng(payload, remove) : { bytes: payload, sensitive: [] };
    sensitive.push(...transformed.sensitive.map((item) => `${type}:${item}`));
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(type, 0, 4, "ascii");
    chunkHeader.writeUInt32BE(8 + transformed.bytes.length, 4);
    chunks.push(Buffer.concat([chunkHeader, transformed.bytes]));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error("Invalid ICNS data");
  if (!remove) return { bytes, sensitive };
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  header.writeUInt32BE(totalLength, 4);
  return { bytes: Buffer.concat([header, ...chunks]), sensitive };
}

function transformImage(bytes, extension, remove = false) {
  switch (extension.toLowerCase()) {
    case ".png": return transformPng(bytes, remove);
    case ".jpg":
    case ".jpeg": return transformJpeg(bytes, remove);
    case ".ico": return transformIco(bytes, remove);
    case ".icns": return transformIcns(bytes, remove);
    default: return { bytes, sensitive: [] };
  }
}

function sanitizeImageFile(filePath) {
  const original = fs.readFileSync(filePath);
  const result = transformImage(original, path.extname(filePath), true);
  if (result.bytes.equals(original)) return { filePath, changed: false, removed: [] };
  const stat = fs.statSync(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, result.bytes, { mode: stat.mode & 0o777, flag: "wx" });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, stat.mode & 0o777);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { filePath, changed: true, removed: result.sensitive };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Provide one or more image paths");
  for (const filePath of files) console.log(JSON.stringify(sanitizeImageFile(path.resolve(filePath))));
}

module.exports = { sanitizeImageFile, transformImage };
