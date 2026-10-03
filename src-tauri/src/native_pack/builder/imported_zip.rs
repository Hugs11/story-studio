use std::collections::HashMap;

use super::super::{
    display_label, named_option_targets, ActionNode, CanonicalZip, ControlSettings,
    ImportedZipBundle, Presence, StageNode, StoryBuilder, StoryDocument, Transition,
};
use super::transitions::{
    action_node_name, default_stage_type, no_authored_position, stage_transition_uses_action,
};

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack) fn build_imported_zip_branch(
        &mut self,
        zip: &CanonicalZip,
        role_prefix: &str,
        parent_return_transition: Transition,
        wrapper_home_transition: Option<Transition>,
        wrap_for_selection: bool,
    ) -> Result<String, String> {
        let bundle = self
            .imported_zip_bundle(&format!("{}/zip", role_prefix))?
            .clone();
        let mut stage_id_map = HashMap::new();
        let mut action_id_map = HashMap::new();
        let group_id_map = self.imported_group_id_map(&bundle.document);
        let wrapper_ids = if wrap_for_selection {
            Some((self.next_id(), self.next_id()))
        } else {
            None
        };
        let skip_wrapped_root_action = wrap_for_selection
            && !bundle.document.stage_nodes.iter().any(|stage| {
                stage.uuid != bundle.square_one_stage_id
                    && (stage_transition_uses_action(
                        stage.home_transition.value(),
                        &bundle.root_action_id,
                    ) || stage_transition_uses_action(
                        stage.ok_transition.value(),
                        &bundle.root_action_id,
                    ))
            });

        for stage in &bundle.document.stage_nodes {
            let mapped_stage_id = if wrap_for_selection && stage.uuid == bundle.square_one_stage_id
            {
                wrapper_ids
                    .as_ref()
                    .map(|(stage_id, _)| stage_id.clone())
                    .ok_or_else(|| format!("Wrapper introuvable pour {}", zip.name))?
            } else {
                self.next_id()
            };
            stage_id_map.insert(stage.uuid.clone(), mapped_stage_id);
        }

        for action in &bundle.document.action_nodes {
            if skip_wrapped_root_action && action.id == bundle.root_action_id {
                continue;
            }
            action_id_map.insert(action.id.clone(), self.next_id());
        }

        for action in &bundle.document.action_nodes {
            if skip_wrapped_root_action && action.id == bundle.root_action_id {
                continue;
            }

            let mut cloned = action.clone();
            cloned.id = action_id_map
                .get(&action.id)
                .cloned()
                .ok_or_else(|| format!("Action importee introuvable : {}", action.id))?;
            cloned.group_id = remap_group_id(&action.group_id, &group_id_map);
            // Les cibles conservent leur indice : une cible non remappée reste
            // `None` au lieu de décaler les options suivantes.
            cloned.options = action
                .options
                .iter()
                .map(|option| {
                    option
                        .as_deref()
                        .and_then(|option| stage_id_map.get(option).cloned())
                })
                .collect();
            self.action_nodes.push(cloned);
        }

        for stage in &bundle.document.stage_nodes {
            if wrap_for_selection && stage.uuid == bundle.square_one_stage_id {
                continue;
            }

            let mut cloned = stage.clone();
            cloned.uuid = stage_id_map
                .get(&stage.uuid)
                .cloned()
                .ok_or_else(|| format!("Stage importe introuvable : {}", stage.uuid))?;
            cloned.square_one = Presence::Value(false);
            cloned.group_id = remap_group_id(&stage.group_id, &group_id_map);
            cloned.home_transition =
                self.remap_imported_transition(&stage.home_transition, &action_id_map);
            cloned.ok_transition =
                self.remap_imported_transition(&stage.ok_transition, &action_id_map);

            if stage.uuid == bundle.post_root_stage_id {
                cloned.home_transition = Presence::Value(parent_return_transition.clone());
            }

            self.push_entry_stage(&zip.id, cloned);
        }

        let imported_entry_stage_id = stage_id_map
            .get(&bundle.entry_stage_id)
            .cloned()
            .ok_or_else(|| format!("Entree importee introuvable pour {}", zip.name))?;

        if !wrap_for_selection {
            return Ok(imported_entry_stage_id);
        }

        // En mode wrapper de sélection, le stage wrapper affiche déjà l'audio/image
        // de couverture importés. ok_transition doit sauter le squareOne importé
        // et viser le premier vrai stage de contenu, sinon la couverture joue deux fois.
        let imported_post_root_stage_id = stage_id_map
            .get(&bundle.post_root_stage_id)
            .cloned()
            .ok_or_else(|| format!("Post-root introuvable pour {}", zip.name))?;

        let (wrapper_stage_id, wrapper_action_id) =
            wrapper_ids.ok_or_else(|| format!("Wrapper introuvable pour {}", zip.name))?;
        let cover_stage = bundle
            .document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == bundle.square_one_stage_id)
            .ok_or_else(|| format!("Cover importe introuvable pour {}", zip.name))?;

        self.action_nodes.push(ActionNode {
            id: wrapper_action_id.clone(),
            name: action_node_name(),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
            options: named_option_targets(vec![imported_post_root_stage_id]),
            position: no_authored_position(),
        });

        self.push_entry_stage(
            &zip.id,
            StageNode {
                uuid: wrapper_stage_id.clone(),
                name: Presence::Value(display_label(&zip.name, "ZIP importe")),
                stage_type: default_stage_type(),
                square_one: Presence::Value(false),
                group_id: Presence::Absent,
                audio: cover_stage.audio.clone(),
                image: cover_stage.image.clone(),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, true, false, false,
                )),
                // Le retour interne du ZIP vise sa couverture wrapper, tandis que Home
                // sur cette couverture revient au sélecteur parent. Réutiliser ici
                // parent_return_transition sélectionnerait le wrapper lui-même.
                home_transition: Presence::from_nullable(wrapper_home_transition),
                ok_transition: Presence::Value(Transition::fixed(wrapper_action_id, 0)),
                position: no_authored_position(),
            },
        );

        Ok(wrapper_stage_id)
    }

    /// Espace de groupes propre à ce ZIP : un identifiant déjà posé par un
    /// ZIP précédent est remplacé, pour tous les membres du groupe à la fois ;
    /// sinon il est gardé tel quel (un pack seul ne change pas).
    fn imported_group_id_map(&mut self, document: &StoryDocument) -> HashMap<String, String> {
        let group_ids = document
            .stage_nodes
            .iter()
            .map(|stage| &stage.group_id)
            .chain(document.action_nodes.iter().map(|action| &action.group_id))
            .filter_map(|group_id| group_id.as_deref());
        let mut map = HashMap::new();
        for group_id in group_ids {
            if map.contains_key(group_id) {
                continue;
            }
            let mapped = if self.imported_group_ids.contains(group_id) {
                self.next_id()
            } else {
                group_id.to_string()
            };
            map.insert(group_id.to_string(), mapped);
        }
        self.imported_group_ids.extend(map.values().cloned());
        map
    }

    fn imported_zip_bundle(&self, role: &str) -> Result<&ImportedZipBundle, String> {
        self.report
            .imported_zips
            .iter()
            .find(|bundle| bundle.role == role)
            .ok_or_else(|| format!("ZIP importe prepare introuvable pour le role {}", role))
    }

    /// Remappe une transition importée sans écraser sa forme d'origine :
    /// une transition absente reste absente, une transition `null` reste
    /// `null`, et seule une transition dont l'action n'existe plus dans la
    /// branche remappée retombe sur `null`.
    fn remap_imported_transition(
        &self,
        transition: &Presence<Transition>,
        action_id_map: &HashMap<String, String>,
    ) -> Presence<Transition> {
        match transition {
            Presence::Absent => Presence::Absent,
            Presence::Null => Presence::Null,
            Presence::Value(transition) => {
                // La sélection est recopiée telle quelle : un `Random` du ZIP
                // source reste `Random` dans la branche remappée.
                Presence::from_nullable(action_id_map.get(&transition.action_node).map(
                    |action_id| Transition {
                        action_node: action_id.clone(),
                        selection: transition.selection,
                    },
                ))
            }
        }
    }
}

fn remap_group_id(
    group_id: &Presence<String>,
    group_id_map: &HashMap<String, String>,
) -> Presence<String> {
    match group_id {
        Presence::Value(group_id) => Presence::Value(
            group_id_map
                .get(group_id)
                .cloned()
                .unwrap_or_else(|| group_id.clone()),
        ),
        other => other.clone(),
    }
}
