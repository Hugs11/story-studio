use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecutableFormat {
    Pe,
    Elf,
    MachO,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecutableArchitecture {
    X86,
    X86_64,
    Aarch64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ExecutableTarget {
    pub format: ExecutableFormat,
    pub architecture: ExecutableArchitecture,
}

impl ExecutableTarget {
    pub(crate) const fn new(
        format: ExecutableFormat,
        architecture: ExecutableArchitecture,
    ) -> Self {
        Self {
            format,
            architecture,
        }
    }
}

pub(crate) fn target_for(os: &str, arch: &str) -> Option<ExecutableTarget> {
    match (os, arch) {
        ("windows", "x86_64") => Some(ExecutableTarget::new(
            ExecutableFormat::Pe,
            ExecutableArchitecture::X86_64,
        )),
        ("linux", "x86_64") => Some(ExecutableTarget::new(
            ExecutableFormat::Elf,
            ExecutableArchitecture::X86_64,
        )),
        ("macos", "aarch64") => Some(ExecutableTarget::new(
            ExecutableFormat::MachO,
            ExecutableArchitecture::Aarch64,
        )),
        _ => None,
    }
}

pub(crate) fn validate_executable_file(
    path: &Path,
    target: ExecutableTarget,
) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Lecture de l'exécutable impossible : {error}"))?;
    validate_executable_bytes(&bytes, target)
}

pub(crate) fn validate_executable_bytes(
    bytes: &[u8],
    target: ExecutableTarget,
) -> Result<(), String> {
    let architectures = match target.format {
        ExecutableFormat::Pe => pe_architectures(bytes),
        ExecutableFormat::Elf => elf_architectures(bytes),
        ExecutableFormat::MachO => macho_architectures(bytes),
    }
    .ok_or_else(|| format!("Format exécutable invalide : {:?} attendu.", target.format))?;

    if architectures.contains(&target.architecture) {
        Ok(())
    } else {
        Err(format!(
            "Architecture exécutable incompatible : {:?} attendue, trouvé {:?}.",
            target.architecture, architectures
        ))
    }
}

fn pe_architectures(bytes: &[u8]) -> Option<Vec<ExecutableArchitecture>> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let pe_offset =
        usize::try_from(u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?)).ok()?;
    if bytes.get(pe_offset..pe_offset.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let machine = u16::from_le_bytes(
        bytes
            .get(pe_offset.checked_add(4)?..pe_offset.checked_add(6)?)?
            .try_into()
            .ok()?,
    );
    let architecture = match machine {
        0x014c => ExecutableArchitecture::X86,
        0x8664 => ExecutableArchitecture::X86_64,
        0xaa64 => ExecutableArchitecture::Aarch64,
        _ => return Some(Vec::new()),
    };
    Some(vec![architecture])
}

fn elf_architectures(bytes: &[u8]) -> Option<Vec<ExecutableArchitecture>> {
    if bytes.get(..4)? != b"\x7fELF" || *bytes.get(5)? != 1 {
        return None;
    }
    let machine = u16::from_le_bytes(bytes.get(18..20)?.try_into().ok()?);
    let architecture = match machine {
        3 => ExecutableArchitecture::X86,
        62 => ExecutableArchitecture::X86_64,
        183 => ExecutableArchitecture::Aarch64,
        _ => return Some(Vec::new()),
    };
    Some(vec![architecture])
}

fn macho_architectures(bytes: &[u8]) -> Option<Vec<ExecutableArchitecture>> {
    let magic = bytes.get(..4)?;
    if magic == [0xcf, 0xfa, 0xed, 0xfe] {
        return macho_thin_architecture(bytes, true).map(|arch| vec![arch]);
    }
    if magic == [0xfe, 0xed, 0xfa, 0xcf] {
        return macho_thin_architecture(bytes, false).map(|arch| vec![arch]);
    }

    let is_fat_64 = magic == [0xca, 0xfe, 0xba, 0xbf] || magic == [0xbf, 0xba, 0xfe, 0xca];
    let is_fat_32 = magic == [0xca, 0xfe, 0xba, 0xbe] || magic == [0xbe, 0xba, 0xfe, 0xca];
    if !is_fat_32 && !is_fat_64 {
        return None;
    }

    let big_endian = matches!(magic, [0xca, 0xfe, 0xba, 0xbe] | [0xca, 0xfe, 0xba, 0xbf]);
    let count = read_u32(bytes.get(4..8)?, big_endian)? as usize;
    if count == 0 || count > 32 {
        return None;
    }
    let entry_size = if is_fat_64 { 32 } else { 20 };
    let mut architectures = Vec::new();
    for index in 0..count {
        let start = 8_usize.checked_add(index.checked_mul(entry_size)?)?;
        let cpu_type = read_u32(bytes.get(start..start.checked_add(4)?)?, big_endian)?;
        if let Some(architecture) = macho_cpu_architecture(cpu_type) {
            if !architectures.contains(&architecture) {
                architectures.push(architecture);
            }
        }
    }
    Some(architectures)
}

fn macho_thin_architecture(bytes: &[u8], little_endian: bool) -> Option<ExecutableArchitecture> {
    let cpu_type = read_u32(bytes.get(4..8)?, !little_endian)?;
    macho_cpu_architecture(cpu_type)
}

fn macho_cpu_architecture(cpu_type: u32) -> Option<ExecutableArchitecture> {
    match cpu_type {
        7 => Some(ExecutableArchitecture::X86),
        0x0100_0007 => Some(ExecutableArchitecture::X86_64),
        0x0100_000c => Some(ExecutableArchitecture::Aarch64),
        _ => None,
    }
}

fn read_u32(bytes: &[u8], big_endian: bool) -> Option<u32> {
    let value: [u8; 4] = bytes.try_into().ok()?;
    Some(if big_endian {
        u32::from_be_bytes(value)
    } else {
        u32::from_le_bytes(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pe(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 128];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&64_u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    fn elf(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    fn macho(cpu_type: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&cpu_type.to_le_bytes());
        bytes
    }

    #[test]
    fn recognizes_supported_target_pairs() {
        assert_eq!(
            target_for("windows", "x86_64"),
            Some(ExecutableTarget::new(
                ExecutableFormat::Pe,
                ExecutableArchitecture::X86_64
            ))
        );
        assert!(target_for("linux", "aarch64").is_none());
        assert!(target_for("macos", "x86_64").is_none());
    }

    #[test]
    fn rejects_wrong_pe_and_elf_architectures() {
        assert!(validate_executable_bytes(
            &pe(0x8664),
            ExecutableTarget::new(ExecutableFormat::Pe, ExecutableArchitecture::X86_64)
        )
        .is_ok());
        assert!(validate_executable_bytes(
            &pe(0x014c),
            ExecutableTarget::new(ExecutableFormat::Pe, ExecutableArchitecture::X86_64)
        )
        .is_err());
        assert!(validate_executable_bytes(
            &elf(62),
            ExecutableTarget::new(ExecutableFormat::Elf, ExecutableArchitecture::X86_64)
        )
        .is_ok());
        assert!(validate_executable_bytes(
            &elf(183),
            ExecutableTarget::new(ExecutableFormat::Elf, ExecutableArchitecture::X86_64)
        )
        .is_err());
    }

    #[test]
    fn recognizes_thin_and_universal_macho_architectures() {
        let arm_target =
            ExecutableTarget::new(ExecutableFormat::MachO, ExecutableArchitecture::Aarch64);
        assert!(validate_executable_bytes(&macho(0x0100_000c), arm_target).is_ok());
        assert!(validate_executable_bytes(&macho(0x0100_0007), arm_target).is_err());

        let mut fat = vec![0_u8; 48];
        fat[..4].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe]);
        fat[4..8].copy_from_slice(&2_u32.to_be_bytes());
        fat[8..12].copy_from_slice(&0x0100_0007_u32.to_be_bytes());
        fat[28..32].copy_from_slice(&0x0100_000c_u32.to_be_bytes());
        assert!(validate_executable_bytes(&fat, arm_target).is_ok());
    }
}
