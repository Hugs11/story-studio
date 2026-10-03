//! Le parallélisme des préparations de médias, **commun aux deux chaînes**.
//!
//! Préparer un média, c'est presque toujours lancer FFmpeg et attendre. Sur un
//! pack qui en porte cent, attendre cent fois de suite est le seul vrai coût de
//! la production — et il n'y a aucune raison de l'accepter : chaque média est
//! indépendant des autres.
//!
//! La chaîne Libre le faisait déjà, la chaîne avancée non. Plutôt que de
//! recopier le geste dans la seconde, il vit ici, et les deux l'empruntent.
//!
//! ## L'ordre, et pourquoi il ne se perd pas
//!
//! Le parallélisme n'a le droit de changer ni un résultat, ni un message. Les
//! deux fonctions de ce module rendent donc leurs valeurs **dans l'ordre
//! d'entrée**, jamais dans l'ordre d'arrivée, et le refus rendu par
//! `try_map_parallel` est celui du **premier élément en défaut**, pas du premier
//! à avoir échoué dans le temps.
//!
//! C'est une propriété fonctionnelle, pas une commodité : un export dont le
//! message de refus dépendrait de la vitesse relative de deux conversions ne
//! serait pas reproductible, et son diagnostic ne serait pas opposable.

use rayon::prelude::*;

/// Applique une transformation indépendante à chaque élément, en parallèle, et
/// s'arrête au **premier élément en défaut au sens de l'ordre d'entrée**.
///
/// Tous les éléments sont évalués : rayon n'a pas de raison d'abandonner le
/// travail déjà lancé, et l'abandonner ne ferait gagner que sur un pack déjà
/// refusé. Ce qui compte est que le refus rendu soit toujours le même.
pub(crate) fn try_map_parallel<T, U, E, F>(items: &[T], transform: F) -> Result<Vec<U>, E>
where
    T: Sync,
    U: Send,
    E: Send,
    F: Fn(&T) -> Result<U, E> + Sync + Send,
{
    let results: Vec<Result<U, E>> = items.par_iter().map(&transform).collect();
    let mut prepared = Vec::with_capacity(results.len());
    for result in results {
        match result {
            Ok(value) => prepared.push(value),
            // Le premier au sens de l'entrée, parce qu'on parcourt dans cet
            // ordre — et non le premier revenu.
            Err(error) => return Err(error),
        }
    }
    Ok(prepared)
}

/// Applique une transformation indépendante à chaque élément, en parallèle, et
/// rend **les succès et les échecs**, chacun dans l'ordre d'entrée.
///
/// C'est ce dont un inventaire a besoin : annoncer les huit médias manquants
/// d'un coup vaut mieux que de les faire découvrir un par un, à raison d'une
/// production refusée par média.
pub(crate) fn partition_map_parallel<T, U, E, F>(items: &[T], transform: F) -> (Vec<U>, Vec<E>)
where
    T: Sync,
    U: Send,
    E: Send,
    F: Fn(&T) -> Result<U, E> + Sync + Send,
{
    let results: Vec<Result<U, E>> = items.par_iter().map(&transform).collect();
    let mut prepared = Vec::new();
    let mut failures = Vec::new();
    for result in results {
        match result {
            Ok(value) => prepared.push(value),
            Err(error) => failures.push(error),
        }
    }
    (prepared, failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'ordre de sortie est celui de l'entrée, quelle que soit la durée de
    /// chaque élément.
    #[test]
    fn results_keep_the_input_order_whatever_the_finishing_order() {
        let items: Vec<usize> = (0..64).collect();
        let prepared = try_map_parallel(&items, |item| {
            // Les premiers éléments sont les plus lents : sans conservation de
            // l'ordre, ils arriveraient en dernier.
            std::thread::sleep(std::time::Duration::from_micros((64 - *item as u64) * 20));
            Ok::<usize, ()>(*item * 2)
        })
        .expect("aucun défaut");
        assert_eq!(
            prepared,
            items.iter().map(|item| item * 2).collect::<Vec<_>>()
        );
    }

    /// Le refus rendu est celui du premier élément en défaut **dans l'entrée**,
    /// même quand un défaut plus tardif se produit bien avant dans le temps.
    #[test]
    fn the_refusal_is_the_first_in_input_order_not_the_first_to_happen() {
        let items: Vec<usize> = (0..32).collect();
        let error = try_map_parallel(&items, |item| {
            if *item == 5 {
                // Le défaut « lent » : il arrive bon dernier dans le temps.
                std::thread::sleep(std::time::Duration::from_millis(30));
                return Err(*item);
            }
            if *item == 30 {
                return Err(*item);
            }
            Ok(*item)
        })
        .expect_err("deux défauts");
        assert_eq!(error, 5);
    }

    /// Les deux versants gardent l'ordre d'entrée, séparément.
    #[test]
    fn successes_and_failures_are_both_ordered() {
        let items: Vec<usize> = (0..40).collect();
        let (prepared, failures) = partition_map_parallel(&items, |item| {
            std::thread::sleep(std::time::Duration::from_micros((40 - *item as u64) * 10));
            if item % 3 == 0 {
                Err(*item)
            } else {
                Ok(*item)
            }
        });
        assert_eq!(
            prepared,
            items
                .iter()
                .copied()
                .filter(|item| item % 3 != 0)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            failures,
            items
                .iter()
                .copied()
                .filter(|item| item % 3 == 0)
                .collect::<Vec<_>>()
        );
    }
}
