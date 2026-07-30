function readU32(bytes, offset, bigEndian) {
  return bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset);
}

export function inspectExecutable(bytes) {
  if (bytes.length >= 70 && bytes.subarray(0, 2).toString('binary') === 'MZ') {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
      throw new Error('Invalid PE executable.');
    }
    const machine = bytes.readUInt16LE(peOffset + 4);
    const architecture = new Map([
      [0x014c, 'x86'],
      [0x8664, 'x86_64'],
      [0xaa64, 'aarch64'],
    ]).get(machine);
    return { format: 'pe', architectures: architecture ? [architecture] : [] };
  }

  if (
    bytes.length >= 20
    && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    if (bytes[5] !== 1) throw new Error('Only little-endian ELF executables are supported.');
    const machine = bytes.readUInt16LE(18);
    const architecture = new Map([
      [3, 'x86'],
      [62, 'x86_64'],
      [183, 'aarch64'],
    ]).get(machine);
    return { format: 'elf', architectures: architecture ? [architecture] : [] };
  }

  if (bytes.length >= 8) {
    const magic = bytes.subarray(0, 4).toString('hex');
    if (magic === 'cffaedfe' || magic === 'feedfacf') {
      const bigEndian = magic === 'feedfacf';
      const cpuType = readU32(bytes, 4, bigEndian);
      const architecture = new Map([
        [7, 'x86'],
        [0x01000007, 'x86_64'],
        [0x0100000c, 'aarch64'],
      ]).get(cpuType);
      return { format: 'macho', architectures: architecture ? [architecture] : [] };
    }
    if (['cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'].includes(magic)) {
      const bigEndian = magic.startsWith('cafe');
      const is64 = magic.endsWith('babf') || magic.startsWith('bfba');
      const count = readU32(bytes, 4, bigEndian);
      if (!count || count > 32) throw new Error('Invalid universal Mach-O executable.');
      const entrySize = is64 ? 32 : 20;
      const architectures = [];
      for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * entrySize;
        if (offset + 4 > bytes.length) throw new Error('Truncated universal Mach-O executable.');
        const cpuType = readU32(bytes, offset, bigEndian);
        const architecture = new Map([
          [7, 'x86'],
          [0x01000007, 'x86_64'],
          [0x0100000c, 'aarch64'],
        ]).get(cpuType);
        if (architecture && !architectures.includes(architecture)) architectures.push(architecture);
      }
      return { format: 'macho', architectures };
    }
  }
  throw new Error('Unsupported executable format.');
}

export function validateExecutable(bytes, expected) {
  const inspected = inspectExecutable(bytes);
  if (inspected.format !== expected.format) {
    throw new Error(`Expected ${expected.format}, found ${inspected.format}.`);
  }
  for (const architecture of expected.architectures) {
    if (!inspected.architectures.includes(architecture)) {
      throw new Error(
        `Expected ${architecture} executable, found ${inspected.architectures.join(', ') || 'unknown'}.`,
      );
    }
  }
  return inspected;
}
