use std::collections::HashMap;

use super::super::{
    display_label, ActionNode, CanonicalZip, ControlSettings, ImportedZipBundle, StageNode,
    StoryBuilder, Transition,
};
use super::transitions::{action_node_name, stage_transition_uses_action, zero_position};

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack) fn build_imported_zip_branch(
        &mut self,
        zip: &CanonicalZip,
        role_prefix: &str,
        parent_return_transition: Transition,
        wrap_for_selection: bool,
    ) -> Result<String, String> {
        let bundle = self
            .imported_zip_bundle(&format!("{}/zip", role_prefix))?
            .clone();
        let mut stage_id_map = HashMap::new();
        let mut action_id_map = HashMap::new();
        let wrapper_ids = if wrap_for_selection {
            Some((self.next_id(), self.next_id()))
        } else {
            None
        };
        let skip_wrapped_root_action = wrap_for_selection
            && !bundle.document.stage_nodes.iter().any(|stage| {
                stage.uuid != bundle.square_one_stage_id
                    && (stage_transition_uses_action(
                        stage.home_transition.as_ref(),
                        &bundle.root_action_id,
                    ) || stage_transition_uses_action(
                        stage.ok_transition.as_ref(),
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
            cloned.options = action
                .options
                .iter()
                .filter_map(|option| stage_id_map.get(option).cloned())
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
            cloned.square_one = false;
            cloned.home_transition =
                self.remap_imported_transition(stage.home_transition.as_ref(), &action_id_map);
            cloned.ok_transition =
                self.remap_imported_transition(stage.ok_transition.as_ref(), &action_id_map);

            if stage.uuid == bundle.post_root_stage_id {
                cloned.home_transition = Some(parent_return_transition.clone());
            }

            self.stage_nodes.push(cloned);
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
            options: vec![imported_post_root_stage_id],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: wrapper_stage_id.clone(),
            name: display_label(&zip.name, "ZIP importe"),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: cover_stage.audio.clone(),
            image: cover_stage.image.clone(),
            control_settings: ControlSettings {
                wheel: true,
                ok: true,
                home: true,
                pause: false,
                autoplay: false,
            },
            // À la racine, parent_return_transition bouclerait vers ce stage wrapper
            // (root_action[n] == wrapper_stage_id). None évite l'auto-boucle.
            home_transition: if self.root_action_id.as_deref()
                == Some(parent_return_transition.action_node.as_str())
            {
                None
            } else {
                Some(parent_return_transition)
            },
            ok_transition: Some(Transition {
                action_node: wrapper_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        Ok(wrapper_stage_id)
    }

    fn imported_zip_bundle(&self, role: &str) -> Result<&ImportedZipBundle, String> {
        self.report
            .imported_zips
            .iter()
            .find(|bundle| bundle.role == role)
            .ok_or_else(|| format!("ZIP importe prepare introuvable pour le role {}", role))
    }

    fn remap_imported_transition(
        &self,
        transition: Option<&Transition>,
        action_id_map: &HashMap<String, String>,
    ) -> Option<Transition> {
        let transition = transition?;
        action_id_map
            .get(&transition.action_node)
            .map(|action_id| Transition {
                action_node: action_id.clone(),
                option_index: transition.option_index,
            })
    }
}
