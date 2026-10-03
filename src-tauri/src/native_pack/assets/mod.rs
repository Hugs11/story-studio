/// Préparation des médias du chemin de production avancé. Elle
/// réutilise les briques ci-dessous — FFmpeg, redimensionnement, hachage,
/// staging — sans emprunter l'orchestration du mode Libre.
#[allow(dead_code)]
pub(crate) mod advanced;
pub(crate) mod audio;
pub(crate) mod image;
/// Le parallélisme des préparations, **commun aux deux chaînes** : chaque média
/// est indépendant des autres, et attendre FFmpeg cent fois de suite est le seul
/// vrai coût d'une production.
pub(crate) mod parallel;
pub(crate) mod pipeline;
pub(crate) mod zip_bundle;
