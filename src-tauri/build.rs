fn main() {
    embed_tests_manifest();
    tauri_build::build()
}

// Donne aux binaires de test Windows le manifeste que `tauri_build` ne pose que
// sur l'application.
//
// `rfd`, tiré par le greffon de dialogues, importe `TaskDialogIndirect` : ce
// symbole n'existe que dans la version 6 de `comctl32`, laquelle n'est chargée
// que si le binaire la déclare. Un binaire de test sans manifeste résout donc
// `comctl32.dll` vers la 5.82 de `System32`, qui ne l'exporte pas, et meurt au
// chargement sur `STATUS_ENTRYPOINT_NOT_FOUND` : `cargo test` n'exécute aucun
// test sous Windows.
//
// `rustc-link-arg-tests` viserait exactement les cibles de test, mais reste
// réservé à nightly. Sur stable, `rustc-link-arg` s'applique à toutes les
// cibles, et l'application porte déjà la ressource manifeste de `tauri_build` :
// lui ajouter un manifeste généré produit `CVT1100: duplicate resource`. D'où
// le `/MANIFEST:NO` rendu aux seules cibles binaires, qui neutralise la
// génération là où elle ferait doublon et la laisse agir ailleurs. La ressource
// de `tauri_build` n'est pas touchée : le manifeste de l'application reste
// identique, et les cibles de test reçoivent le leur.
//
// La cible est lue dans l'environnement plutôt qu'avec `cfg!`, sans quoi une
// compilation croisée depuis Linux ou macOS déciderait d'après la machine hôte.
// Hors Windows MSVC, cette fonction ne fait rien.
fn embed_tests_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("windows")
        .join("tests-common-controls.manifest");
    println!("cargo::rerun-if-changed={}", manifest.display());
    println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
        manifest.display()
    );
    println!("cargo::rustc-link-arg-bins=/MANIFEST:NO");
}
