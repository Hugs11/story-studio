//! Représentation à trois états d'un champ du dialecte STUdio v1.
//!
//! Il faut préserver **absent / `null` / valeur**. Avec Serde, un
//! `Option<T>` ne suffit pas : un champ absent et un champ explicitement `null`
//! produisent tous deux `None`, et `Option<Option<T>>` les confond de la même
//! façon parce que l'implémentation `Deserialize` d'`Option` répond `None` à
//! `visit_none` sans distinguer la clé manquante du littéral `null`.
//!
//! `Presence<T>` porte donc la distinction dans le type, avec un désérialiseur
//! qui l'obtient de la seule information dont Serde dispose réellement :
//!
//! - la clé manquante n'appelle **pas** `Deserialize` — c'est `Default`
//!   (`Presence::Absent`) qui répond, via `#[serde(default)]` sur le champ ;
//! - la clé présente appelle `Deserialize`, qui distingue alors `null`
//!   (`Presence::Null`) de toute autre valeur (`Presence::Value`).
//!
//! La sérialisation restitue la forme d'origine : `Value(v)` émet `v`, `Null`
//! émet `null`, et `Absent` n'émet rien — à condition que le champ porte
//! `#[serde(skip_serializing_if = "Presence::is_absent")]`. Sans cet attribut la
//! clé ressortirait à `null`, ce que le test `document.rs` d'émission minimale
//! surveille champ par champ.

use serde::de::{Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};

/// Absent, `null`, ou valeur — les trois formes admises par le dialecte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Presence<T> {
    /// La clé n'était pas dans l'objet source.
    #[default]
    Absent,
    /// La clé était présente et valait `null`.
    Null,
    /// La clé était présente et portait une valeur.
    Value(T),
}

impl<T> Presence<T> {
    pub(crate) fn is_absent(&self) -> bool {
        matches!(self, Presence::Absent)
    }

    /// Vrai seulement pour une valeur : ni l'absence ni `null` n'en sont une.
    pub(crate) fn is_value(&self) -> bool {
        matches!(self, Presence::Value(_))
    }

    /// Complément de `is_value` : absent **ou** `null`. Réservé aux
    /// consommateurs de comportement pour qui les deux formes sont
    /// équivalentes ; il ne remplace jamais l'oracle d'auteur.
    pub(crate) fn has_no_value(&self) -> bool {
        !self.is_value()
    }

    /// La valeur portée, si le champ en porte une. Écrase la distinction
    /// absent/`null` : réservé aux consommateurs qui n'ont besoin que de la
    /// valeur, jamais à la conservation d'auteur.
    pub(crate) fn value(&self) -> Option<&T> {
        match self {
            Presence::Value(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn value_mut(&mut self) -> Option<&mut T> {
        match self {
            Presence::Value(value) => Some(value),
            _ => None,
        }
    }

    /// Convertit un `Option` dont le `None` signifiait « émis à `null` ».
    /// C'est la sémantique historique des champs `Option<T>` de `StageNode`,
    /// que la projection FS et les builders Libre doivent conserver telle
    /// quelle : leurs consommateurs déréférencent la clé sans garde.
    pub(crate) fn from_nullable(value: Option<T>) -> Self {
        match value {
            Some(value) => Presence::Value(value),
            None => Presence::Null,
        }
    }
}

// Un JSON nul est une présence réelle, jamais un instantané manquant.
impl Presence<serde_json::Value> {
    pub(crate) fn from_json(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            value => Self::Value(value),
        }
    }

    pub(crate) fn matches_json(&self, value: &serde_json::Value) -> bool {
        match self {
            Self::Absent => false,
            Self::Null => value.is_null(),
            Self::Value(snapshot) => snapshot == value,
        }
    }
}

impl Presence<String> {
    /// La chaîne portée, si le champ en porte une.
    pub(crate) fn as_deref(&self) -> Option<&str> {
        self.value().map(String::as_str)
    }

    /// La chaîne portée, ou le repli **de comportement** du consommateur.
    /// Ce repli n'est pas une présence d'auteur : il ne ressort jamais à la
    /// sérialisation, il ne sert qu'au libellé ou à la comparaison locale.
    pub(crate) fn as_str_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.as_deref().unwrap_or(fallback)
    }
}

impl Presence<bool> {
    /// Vrai seulement pour un `true` explicite : ni l'absence ni `null` ne le sont.
    pub(crate) fn is_true(&self) -> bool {
        matches!(self, Presence::Value(true))
    }
}

impl<T: Serialize> Serialize for Presence<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            // `Absent` ne devrait jamais atteindre le sérialiseur : les champs
            // présence-sensibles portent `skip_serializing_if`. Émettre `null`
            // plutôt que paniquer garde la sérialisation totale ; l'oubli d'un
            // attribut se voit alors comme une clé `null` inattendue, pas comme
            // un crash en production.
            Presence::Absent | Presence::Null => serializer.serialize_none(),
            Presence::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Presence<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Appelé seulement quand la clé est présente : `Absent` vient de
        // `Default`, jamais d'ici.
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Presence::Value(value),
            None => Presence::Null,
        })
    }
}
