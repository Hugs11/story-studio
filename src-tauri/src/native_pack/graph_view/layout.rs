//! Nombres et disposition de la lecture avancée.
//!
//! Rien de ce module n'écrit : le placement de secours est recalculé à chaque
//! lecture et n'entre ni dans le document, ni dans `context.editorPositions`.
//! La position source et la disposition dérivée gardent deux propriétaires
//! distincts, et la seule porte du second vers le premier reste
//! `apply_editor_position_to_authoring`.

use std::collections::HashMap;

use serde_json::Number;

use super::dto::{LayoutSource, LayoutView, PositionView};
use crate::native_pack::dialect::{EditorPosition, ValueOrigin};
use crate::native_pack::document::Position;

/// Pas horizontal du placement de secours.
///
/// Les trois pas ci-dessous sont calibrés sur ce que la surface **peint** :
/// un Écran de 104 × 80 ou une Action de 52 × 52, suivis de leur nom en
/// libellé, haut de 14 pixels et posé 5 pixels sous la forme. Un pas plus
/// serré ne fait pas seulement un graphe dense : il fait chevaucher la carte
/// d'une Action et celle de l'Écran du rang suivant, ce qui est exactement ce
/// que la bande ci-dessous existe pour empêcher.
const FALLBACK_COLUMN_STEP: f64 = 240.0;
/// Pas vertical du placement de secours.
///
/// Un rang porte un Écran **et** une Action. L'Écran descend jusqu'à 59,
/// l'Action décalée de 96 occupe [70, 122] et son nom finit à 141 ; le rang
/// suivant commence à 200 et laisse 19 pixels avant son Écran.
const FALLBACK_ROW_STEP: f64 = 200.0;
/// Bande réservée aux Actions, pour qu'un Écran et une Action sans position ne
/// se superposent jamais au même rang — **ni leurs libellés**.
///
/// L'Écran occupe `[-40, 40]` et son nom `[45, 59]` ; l'Action posée à 96
/// occupe `[70, 122]` et son nom `[127, 141]`.
const FALLBACK_ACTION_BAND: f64 = 96.0;

/// Le plus grand entier au-delà duquel un aller-retour par `f64` n'est plus
/// fidèle. Au-delà, `x` reste affichable mais `xText` seul fait foi.
const SAFE_INTEGER: u64 = 1 << 53;

/// Vrai quand la graphie source traverse `f64` sans perte. Les fractions du
/// dialecte sont déjà des `f64` (`serde_json` sans `arbitrary_precision`) ;
/// seuls les entiers hors du domaine sûr de JavaScript posent problème.
fn exact_in_double(number: &Number) -> bool {
    if let Some(value) = number.as_i64() {
        return value.unsigned_abs() <= SAFE_INTEGER;
    }
    if let Some(value) = number.as_u64() {
        return value <= SAFE_INTEGER;
    }
    // Un littéral fractionnaire est déjà un `f64` : il n'a rien à perdre.
    number.as_f64().is_some()
}

impl PositionView {
    /// La double représentation : `x`/`y` servent au rangement, `xText`/
    /// `yText` portent la graphie exacte et `exactInDouble` dit laquelle fait
    /// foi.
    pub(crate) fn of(position: &Position) -> Self {
        Self {
            x: position.x.as_f64().unwrap_or(0.0),
            y: position.y.as_f64().unwrap_or(0.0),
            x_text: position.x.to_string(),
            y_text: position.y.to_string(),
            exact_in_double: exact_in_double(&position.x) && exact_in_double(&position.y),
        }
    }

    /// Vrai quand les deux coordonnées sont finies. Une position non finie ne
    /// peut pas servir de disposition : elle reste visible dans
    /// `sourcePosition`, et le rang suivant prend le relais.
    fn is_finite(&self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

/// Les deux collections du dialecte, dont le placement de secours se calcule
/// séparément : leurs rangs ne se mélangent pas et leurs bandes diffèrent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeBand {
    Stage,
    Action,
}

impl NodeBand {
    fn offset(self) -> f64 {
        match self {
            NodeBand::Stage => 0.0,
            NodeBand::Action => FALLBACK_ACTION_BAND,
        }
    }
}

/// Index des dispositions déjà rangées dans `context.editorPositions`.
///
/// La clé est le chemin de **champ** (`<nœud>/position`), pas le chemin de
/// nœud : c'est la forme que produit `imported_fs` et que consomme
/// `apply_editor_position_to_authoring`. Les deux ancrages voisins ne sont pas
/// confondus.
pub(crate) struct EditorPositionIndex<'a> {
    by_field_path: HashMap<&'a str, &'a EditorPosition>,
}

impl<'a> EditorPositionIndex<'a> {
    pub(crate) fn new(entries: &'a [EditorPosition]) -> Self {
        let mut by_field_path = HashMap::with_capacity(entries.len());
        // La dernière entrée d'un même chemin l'emporte, comme partout où le
        // dépôt résout une provenance (`value_origin` remonte aussi la liste).
        for entry in entries {
            by_field_path.insert(entry.path.as_str(), entry);
        }
        Self { by_field_path }
    }

    fn get(&self, field_path: &str) -> Option<&'a EditorPosition> {
        self.by_field_path.get(field_path).copied()
    }
}

/// La disposition d'un nœud avant application du placement de secours.
///
/// `None` signifie que le nœud n'a ni position d'auteur utilisable ni entrée
/// d'éditeur : il entre dans le comptage du rang 3.
pub(crate) fn resolve_ranked_layout(
    node_path: &str,
    authored: Option<&PositionView>,
    editor_positions: &EditorPositionIndex<'_>,
    authored_origin: ValueOrigin,
) -> Option<LayoutView> {
    if let Some(position) = authored.filter(|position| position.is_finite()) {
        return Some(LayoutView {
            x: position.x,
            y: position.y,
            source: LayoutSource::Authored,
            origin: Some(authored_origin),
        });
    }
    let field_path = format!("{node_path}/position");
    let entry = editor_positions.get(field_path.as_str())?;
    let projected = PositionView::of(&entry.position);
    if !projected.is_finite() {
        return None;
    }
    Some(LayoutView {
        x: projected.x,
        y: projected.y,
        source: LayoutSource::EditorPosition,
        origin: Some(entry.origin),
    })
}

/// Le placement de secours : déterministe, sans état, calculé à
/// la lecture, **jamais écrit dans le payload**.
///
/// Il diffère volontairement du quadrillage linéaire de
/// `projected_stage_position`, qui reste la règle de la projection FS et est
/// déjà servi au rang 2. Il ne le remplace pas et ne le corrige pas : il couvre
/// le cas que la projection FS ne couvre pas — les Actions d'un import STUdio
/// et les nœuds créés dans l'éditeur.
///
/// `rank` est le **rang du nœud dans sa collection**, et `count` la taille de
/// cette collection — pas le rang parmi les seuls nœuds sans position, ni leur
/// nombre. La distinction n'est pas cosmétique : avec un rang dense sur le
/// sous-ensemble des nœuds sans position, déplacer **un** nœud le retirait de
/// ce sous-ensemble, décalait d'une case tous les suivants et pouvait changer
/// le nombre de colonnes. L'auteur voyait alors un voisin venir occuper la
/// place qu'il venait de libérer, et toute la grille glisser derrière lui.
/// Indexer sur la collection entière laisse simplement un trou là où un nœud
/// a reçu une vraie position, et ne bouge personne d'autre.
pub(crate) fn fallback_layout(rank: usize, count: usize, band: NodeBand) -> LayoutView {
    let columns = fallback_columns(count);
    let column = rank % columns;
    let row = rank / columns;
    LayoutView {
        x: column as f64 * FALLBACK_COLUMN_STEP,
        y: row as f64 * FALLBACK_ROW_STEP + band.offset(),
        source: LayoutSource::Fallback,
        // Un placement recalculé n'a aucune provenance d'auteur : lui en
        // donner une laisserait croire qu'une valeur a été lue quelque part.
        origin: None,
    }
}

/// `ceil(sqrt(n))`, borné à au moins une colonne pour rester divisible.
fn fallback_columns(count: usize) -> usize {
    if count <= 1 {
        return 1;
    }
    let approximate = (count as f64).sqrt().ceil() as usize;
    // `sqrt` sur un `f64` peut rendre une racine d'un cheveu trop courte pour
    // un grand carré parfait ; la correction garde la grille exacte.
    let mut columns = approximate.max(1);
    while columns * columns < count {
        columns += 1;
    }
    columns
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_colonnes_du_repli_suivent_la_racine_carree() {
        assert_eq!(fallback_columns(0), 1);
        assert_eq!(fallback_columns(1), 1);
        assert_eq!(fallback_columns(2), 2);
        assert_eq!(fallback_columns(4), 2);
        assert_eq!(fallback_columns(5), 3);
        assert_eq!(fallback_columns(9), 3);
        assert_eq!(fallback_columns(10), 4);
        assert_eq!(fallback_columns(9_121), 96);
    }

    #[test]
    fn la_bande_des_actions_ne_recouvre_pas_celle_des_ecrans() {
        let stage = fallback_layout(0, 4, NodeBand::Stage);
        let action = fallback_layout(0, 4, NodeBand::Action);
        assert_eq!(stage.y, 0.0);
        assert_eq!(action.y, FALLBACK_ACTION_BAND);
        assert_eq!(stage.x, action.x);
    }

    /// Les pas doivent loger ce que la surface peint : une carte de 80 de haut
    /// centrée sur la position, puis son nom sur 14, posé 5 plus bas.
    #[test]
    fn un_rang_loge_les_deux_cartes_et_leurs_libelles() {
        const STAGE_HALF: f64 = 40.0;
        const STAGE_LABEL_BOTTOM: f64 = STAGE_HALF + 5.0 + 14.0;
        const ACTION_HALF: f64 = 26.0;
        const ACTION_LABEL_BOTTOM: f64 = ACTION_HALF + 5.0 + 14.0;
        let stage = fallback_layout(0, 4, NodeBand::Stage);
        let action = fallback_layout(0, 4, NodeBand::Action);
        let next_stage = fallback_layout(2, 4, NodeBand::Stage);
        // Le nom de l'Écran s'arrête avant la carte de l'Action.
        assert!(stage.y + STAGE_LABEL_BOTTOM < action.y - ACTION_HALF);
        // Le nom de l'Action s'arrête avant la carte de l'Écran du rang suivant.
        assert!(action.y + ACTION_LABEL_BOTTOM < next_stage.y - STAGE_HALF);
    }

    #[test]
    fn un_entier_hors_domaine_sur_est_signale_sans_etre_arrondi() {
        let position = Position {
            x: Number::from(9_007_199_254_740_993_u64),
            y: Number::from(12_i32),
        };
        let view = PositionView::of(&position);
        assert!(!view.exact_in_double);
        assert_eq!(view.x_text, "9007199254740993");
    }

    #[test]
    fn une_position_fractionnaire_n_est_jamais_arrondie() {
        let position = Position {
            x: Number::from_f64(-12.5).expect("valeur finie"),
            y: Number::from_f64(376_960.25).expect("valeur finie"),
        };
        let view = PositionView::of(&position);
        assert!(view.exact_in_double);
        assert_eq!(view.x_text, "-12.5");
        assert_eq!(view.y_text, "376960.25");
    }
}
