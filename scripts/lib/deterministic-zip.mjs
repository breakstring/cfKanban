import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, crc) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, data]);
}

function centralHeader(name, data, crc, offset, mode) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

async function collectFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b, "en"));
  const files = [];
  for (const name of names) {
    const childRelative = relative ? path.join(relative, name) : name;
    const childPath = path.join(root, childRelative);
    const stats = await lstat(childPath);
    if (stats.isSymbolicLink()) throw new Error(`Release bundle rejects symbolic links: ${childPath}`);
    if (stats.isDirectory()) files.push(...await collectFiles(root, childRelative));
    else if (stats.isFile()) files.push({ path: childRelative.split(path.sep).join("/"), absolutePath: childPath, mode: stats.mode });
  }
  return files;
}

export async function writeDeterministicZip({ root, outputPath, prefix = "" }) {
  const files = await collectFiles(root);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const data = await readFile(file.absolutePath);
    const name = `${prefix}${file.path}`;
    const crc = crc32(data);
    const local = localHeader(name, data, crc);
    localParts.push(local);
    centralParts.push(centralHeader(name, data, crc, offset, file.mode));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(outputPath, Buffer.concat([...localParts, central, end]));
  return { outputPath, fileCount: files.length };
}
