//! `OptionSelection` — le concept sémantique unique de la sélection d'option.
//!
//! Le dialecte STUdio v1 sérialise `Random → -1` et `Fixed(i) → i`. `-1` n'est
//! ni une valeur corrompue ni une tolérance de lecture : le writer STUdio l'écrit
//! pour le port `randomOptionIn`, son reader le reconnecte à ce port et son
//! simulateur tire un index **à chaque entrée** dans l'ActionNode.
//!
//! Le type rend le rabattement `-1 → 0` **non représentable** : un consommateur
//! ne peut plus lire un entier signé et décider seul quoi faire du négatif, il
//! doit distinguer les deux variantes. C'est la seule garantie structurelle
//! qui tienne à l'échelle du dépôt : plusieurs sites rabattaient auparavant
//! `-1` chacun à sa façon.
//!
//! Ce module ne fixe **aucune borne maximale** de nombre d'options :
//! ni `MAX_OPTIONS=100` ni `MAX_OPTIONS=2^31−1` ne sont fondés dans
//! l'intégrité. La seule valeur refusée est `< -1`, qui n'est pas
//! représentable par `OptionSelection` et qui est refusée comme dialecte
//! invalide **avant** la validation d'intégrité.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// La sentinelle sérialisée du port « option aléatoire » du dialecte STUdio v1.
pub(crate) const RANDOM_DIALECT_INDEX: i64 = -1;

/// La sélection d'option d'une transition : aléatoire à chaque entrée, ou fixée
/// sur un indice d'option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum OptionSelection {
    /// `-1` : l'option initiale est tirée parmi toutes les options de l'Action,
    /// à chaque nouvelle entrée. Exige `N ≥ 1`.
    Random,
    /// `i` : l'option d'indice `i`. Exige `0 ≤ i < N`.
    Fixed(usize),
}

/// Le refus de dialecte : une valeur JSON `< -1` n'est pas représentable, et
/// ne doit donc pas atteindre la validation d'intégrité.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OptionSelectionOutOfDialect {
    pub(crate) index: i64,
}

impl fmt::Display for OptionSelectionOutOfDialect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "optionIndex doit être supérieur ou égal à -1, reçu {}",
            self.index
        )
    }
}

impl OptionSelection {
    /// La sélection d'une option d'indice connu. Le point d'entrée des
    /// constructeurs Story Studio, qui ne produisent jamais `Random`.
    pub(crate) fn fixed(index: usize) -> Self {
        OptionSelection::Fixed(index)
    }

    /// Décode l'entier du dialecte. `-1` est `Random`, tout entier positif ou nul
    /// est `Fixed`, et `< -1` est refusé.
    pub(crate) fn from_dialect_index(index: i64) -> Result<Self, OptionSelectionOutOfDialect> {
        if index == RANDOM_DIALECT_INDEX {
            return Ok(OptionSelection::Random);
        }
        usize::try_from(index)
            .map(OptionSelection::Fixed)
            .map_err(|_| OptionSelectionOutOfDialect { index })
    }

    /// Réencode vers l'entier du dialecte. `Random` redonne exactement `-1` :
    /// c'est la moitié écriture du round-trip du dialecte.
    pub(crate) fn to_dialect_index(self) -> i64 {
        match self {
            OptionSelection::Random => RANDOM_DIALECT_INDEX,
            // Aucune borne maximale n'est imposée : l'indice vient soit du
            // document source, soit d'un indice de `Vec`.
            OptionSelection::Fixed(index) => index as i64,
        }
    }

    /// L'indice fixé, ou `None` pour `Random`. Un appelant qui a besoin d'un
    /// indice unique doit traiter explicitement l'absence : il n'existe pas
    /// d'indice « par défaut » pour une sélection aléatoire.
    pub(crate) fn fixed_index(self) -> Option<usize> {
        match self {
            OptionSelection::Random => None,
            OptionSelection::Fixed(index) => Some(index),
        }
    }

    /// Les indices d'options que cette sélection peut désigner, pour une Action
    /// de `option_count` options. `Random` les désigne toutes ; `Fixed(i)` n'en
    /// désigne qu'une, et aucune si `i` est hors bornes.
    ///
    /// C'est la primitive d'**analyse statique** : elle décrit l'ensemble des
    /// destinations possibles sans jamais tirer au sort.
    pub(crate) fn candidate_indices(self, option_count: usize) -> std::ops::Range<usize> {
        match self {
            OptionSelection::Random => 0..option_count,
            OptionSelection::Fixed(index) if index < option_count => index..index + 1,
            OptionSelection::Fixed(_) => 0..0,
        }
    }

    /// `Random` exige `N ≥ 1`, `Fixed(i)` exige `0 ≤ i < N`.
    pub(crate) fn is_within_bounds(self, option_count: usize) -> bool {
        !self.candidate_indices(option_count).is_empty()
    }

    /// La destination initiale, tirée pour une entrée dans l'Action.
    ///
    /// `source` est injectée pour que le tirage soit déterministe en test :
    /// le tirage a lieu **à chaque entrée**, donc un test qui
    /// compterait des fréquences serait fragile et ne prouverait pas la cadence.
    /// Rend `None` quand la sélection ne désigne aucune option — l'appelant
    /// n'a alors aucune destination, et n'en invente pas.
    #[cfg(test)]
    pub(crate) fn select_initial_option(
        self,
        option_count: usize,
        source: &mut dyn OptionDrawSource,
    ) -> Option<usize> {
        let candidates = self.candidate_indices(option_count);
        if candidates.is_empty() {
            return None;
        }
        match self {
            OptionSelection::Random => Some(source.draw_below(option_count)),
            OptionSelection::Fixed(index) => Some(index),
        }
    }

    // ---------------------------------------------------------------------
    // Maintenance des indices : réordonnancement, insertion, suppression.
    //
    // Les trois règles sont appelées par les gestes d'options
    // (`editing/options.rs`), qui les applique à **toutes** les transitions
    // entrantes de l'Action touchée.
    // ---------------------------------------------------------------------

    /// Réordonnancement explicite des options d'une Action.
    /// `new_position_of_old[i]` donne la nouvelle position de l'option qui
    /// occupait l'indice `i`. La destination sélectionnée est conservée ;
    /// `Random` reste `Random`, son ensemble de candidats étant inchangé.
    pub(crate) fn after_options_reordered(self, new_position_of_old: &[usize]) -> Self {
        match self {
            OptionSelection::Random => OptionSelection::Random,
            OptionSelection::Fixed(index) => new_position_of_old
                .get(index)
                .copied()
                .map(OptionSelection::Fixed)
                .unwrap_or(self),
        }
    }

    /// Insertion d'une option à l'indice `k`. `Fixed(i ≥ k)` devient
    /// `Fixed(i + 1)` pour conserver la même destination ; `Fixed(i < k)` est
    /// inchangé ; `Random` reste `Random` et son ensemble de candidats
    /// s'élargit d'une option.
    pub(crate) fn after_option_inserted(self, insertion_index: usize) -> Self {
        match self {
            OptionSelection::Random => OptionSelection::Random,
            OptionSelection::Fixed(index) if index >= insertion_index => {
                OptionSelection::Fixed(index + 1)
            }
            OptionSelection::Fixed(index) => OptionSelection::Fixed(index),
        }
    }

    /// Suppression de l'option d'indice `k`.
    ///
    /// `> k` est décrémenté, `< k` est inchangé, `Random` est inchangé. La
    /// transition qui pointait **exactement** sur `k` rend `None` : elle ne
    /// reçoit jamais automatiquement une autre destination, et la commande doit
    /// exiger une décision explicite de retargeting ou de suppression.
    ///
    /// La validité de `Random` après suppression n'est pas décidée ici : elle
    /// dépend du nombre d'options restantes et reste le rôle de la validation d'intégrité
    /// (`OptionSelectionInvalid`).
    pub(crate) fn after_option_removed(self, removed_index: usize) -> Option<Self> {
        match self {
            OptionSelection::Random => Some(OptionSelection::Random),
            OptionSelection::Fixed(index) if index == removed_index => None,
            OptionSelection::Fixed(index) if index > removed_index => {
                Some(OptionSelection::Fixed(index - 1))
            }
            OptionSelection::Fixed(index) => Some(OptionSelection::Fixed(index)),
        }
    }
}

/// La source d'aléa d'un tirage `Random`, injectable pour rendre les tests
/// déterministes sans compter de fréquences.
#[cfg(test)]
pub(crate) trait OptionDrawSource {
    /// Un indice dans `[0, exclusive_upper_bound[`. L'appelant garantit une
    /// borne strictement positive.
    fn draw_below(&mut self, exclusive_upper_bound: usize) -> usize;
}

impl fmt::Display for OptionSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OptionSelection::Random => formatter.write_str("aléatoire"),
            OptionSelection::Fixed(index) => write!(formatter, "option {index}"),
        }
    }
}

impl Serialize for OptionSelection {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_i64(self.to_dialect_index())
    }
}

impl<'de> Deserialize<'de> for OptionSelection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let index = i64::deserialize(deserializer)?;
        OptionSelection::from_dialect_index(index)
            .map_err(|error| serde::de::Error::custom(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une source déterministe : elle rejoue une séquence d'indices bruts,
    /// ramenés dans les bornes comme le ferait `Math.floor(Math.random() * N)`.
    struct SequenceDrawSource {
        draws: Vec<usize>,
        cursor: usize,
    }

    impl SequenceDrawSource {
        fn new(draws: &[usize]) -> Self {
            Self {
                draws: draws.to_vec(),
                cursor: 0,
            }
        }

        fn draw_count(&self) -> usize {
            self.cursor
        }
    }

    impl OptionDrawSource for SequenceDrawSource {
        fn draw_below(&mut self, exclusive_upper_bound: usize) -> usize {
            let draw = self.draws[self.cursor % self.draws.len()] % exclusive_upper_bound;
            self.cursor += 1;
            draw
        }
    }

    #[test]
    fn the_random_sentinel_survives_a_dialect_roundtrip() {
        let selection = OptionSelection::from_dialect_index(-1).expect("-1 est représentable");
        assert_eq!(selection, OptionSelection::Random);
        assert_eq!(selection.to_dialect_index(), -1);

        let json = serde_json::to_value(selection).expect("sérialisation");
        assert_eq!(json, serde_json::json!(-1));
        let reread: OptionSelection = serde_json::from_value(json).expect("relecture");
        assert_eq!(reread, OptionSelection::Random);
    }

    #[test]
    fn a_fixed_index_survives_a_dialect_roundtrip() {
        for index in [0_usize, 1, 7, 99, 2_147_483_647] {
            let selection = OptionSelection::from_dialect_index(index as i64).expect("indice");
            assert_eq!(selection, OptionSelection::Fixed(index));
            let json = serde_json::to_value(selection).expect("sérialisation");
            assert_eq!(json, serde_json::json!(index));
        }
    }

    #[test]
    fn a_dialect_index_below_minus_one_is_refused() {
        for index in [-2_i64, -3, -1_000, i64::from(i32::MIN)] {
            let error = OptionSelection::from_dialect_index(index).expect_err("hors dialecte");
            assert_eq!(error.index, index);
            let refused: Result<OptionSelection, _> =
                serde_json::from_value(serde_json::json!(index));
            assert!(refused.is_err(), "{index} doit être refusé au décodage");
        }
    }

    #[test]
    fn random_and_fixed_zero_are_distinct_values() {
        assert_ne!(OptionSelection::Random, OptionSelection::Fixed(0));
        assert_ne!(
            OptionSelection::Random.to_dialect_index(),
            OptionSelection::Fixed(0).to_dialect_index()
        );
    }

    #[test]
    fn candidate_indices_describe_the_reachable_options_without_drawing() {
        assert_eq!(
            OptionSelection::Random
                .candidate_indices(3)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            OptionSelection::Fixed(1)
                .candidate_indices(3)
                .collect::<Vec<_>>(),
            vec![1]
        );
        // Hors bornes : aucune destination, et surtout pas l'option 0.
        assert!(OptionSelection::Fixed(3)
            .candidate_indices(3)
            .collect::<Vec<_>>()
            .is_empty());
        // `Random` sur Action vide : aucune destination.
        assert!(OptionSelection::Random
            .candidate_indices(0)
            .collect::<Vec<_>>()
            .is_empty());
    }

    #[test]
    fn bounds_follow_gvi_009() {
        assert!(OptionSelection::Random.is_within_bounds(1));
        assert!(!OptionSelection::Random.is_within_bounds(0));
        assert!(OptionSelection::Fixed(0).is_within_bounds(1));
        assert!(!OptionSelection::Fixed(1).is_within_bounds(1));
        assert!(!OptionSelection::Fixed(0).is_within_bounds(0));
        // Aucune borne maximale n'entre ici.
        assert!(OptionSelection::Fixed(100).is_within_bounds(101));
    }

    #[test]
    fn a_random_selection_draws_once_per_entry() {
        let mut source = SequenceDrawSource::new(&[2, 0, 1]);
        let selection = OptionSelection::Random;
        assert_eq!(selection.select_initial_option(3, &mut source), Some(2));
        assert_eq!(selection.select_initial_option(3, &mut source), Some(0));
        assert_eq!(selection.select_initial_option(3, &mut source), Some(1));
        assert_eq!(source.draw_count(), 3);
    }

    #[test]
    fn a_fixed_selection_never_draws() {
        let mut source = SequenceDrawSource::new(&[2]);
        assert_eq!(
            OptionSelection::Fixed(1).select_initial_option(3, &mut source),
            Some(1)
        );
        assert_eq!(source.draw_count(), 0);
    }

    #[test]
    fn a_single_option_action_resolves_to_that_option() {
        let mut source = SequenceDrawSource::new(&[7]);
        assert_eq!(
            OptionSelection::Random.select_initial_option(1, &mut source),
            Some(0)
        );
        assert_eq!(
            OptionSelection::Fixed(0).select_initial_option(1, &mut source),
            Some(0)
        );
    }

    #[test]
    fn an_unselectable_selection_yields_no_option_instead_of_zero() {
        let mut source = SequenceDrawSource::new(&[0]);
        assert_eq!(
            OptionSelection::Random.select_initial_option(0, &mut source),
            None
        );
        assert_eq!(
            OptionSelection::Fixed(4).select_initial_option(2, &mut source),
            None
        );
        assert_eq!(source.draw_count(), 0);
    }

    #[test]
    fn opt_002_reordering_keeps_the_selected_destination() {
        // Permutation des options 0 et 1 : `new_position_of_old = [1, 0, 2]`.
        let permutation = [1_usize, 0, 2];
        assert_eq!(
            OptionSelection::Fixed(0).after_options_reordered(&permutation),
            OptionSelection::Fixed(1)
        );
        assert_eq!(
            OptionSelection::Fixed(1).after_options_reordered(&permutation),
            OptionSelection::Fixed(0)
        );
        assert_eq!(
            OptionSelection::Fixed(2).after_options_reordered(&permutation),
            OptionSelection::Fixed(2)
        );
        assert_eq!(
            OptionSelection::Random.after_options_reordered(&permutation),
            OptionSelection::Random
        );
    }

    #[test]
    fn opt_003_removal_table_never_creates_an_implicit_destination() {
        let removed = 2_usize;
        assert_eq!(
            OptionSelection::Fixed(1).after_option_removed(removed),
            Some(OptionSelection::Fixed(1))
        );
        assert_eq!(
            OptionSelection::Fixed(2).after_option_removed(removed),
            None
        );
        assert_eq!(
            OptionSelection::Fixed(3).after_option_removed(removed),
            Some(OptionSelection::Fixed(2))
        );
        assert_eq!(
            OptionSelection::Random.after_option_removed(removed),
            Some(OptionSelection::Random)
        );
    }

    #[test]
    fn opt_005_insertion_table_keeps_every_fixed_destination() {
        let inserted = 1_usize;
        assert_eq!(
            OptionSelection::Fixed(0).after_option_inserted(inserted),
            OptionSelection::Fixed(0)
        );
        assert_eq!(
            OptionSelection::Fixed(1).after_option_inserted(inserted),
            OptionSelection::Fixed(2)
        );
        assert_eq!(
            OptionSelection::Fixed(2).after_option_inserted(inserted),
            OptionSelection::Fixed(3)
        );
        assert_eq!(
            OptionSelection::Random.after_option_inserted(inserted),
            OptionSelection::Random
        );
        // L'ensemble de candidats de `Random` s'élargit d'une option.
        assert_eq!(
            OptionSelection::Random.candidate_indices(4).len(),
            OptionSelection::Random.candidate_indices(3).len() + 1
        );
    }
}
