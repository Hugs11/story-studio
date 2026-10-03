use std::collections::HashMap;

use uuid::Uuid;

use super::super::{CanonicalEntry, Transition};

pub(crate) struct MenuPrealloc {
    pub(crate) action_id: String,
    pub(crate) replay_transition: Transition,
}

pub(crate) fn preallocate_menus(
    entries: &[CanonicalEntry],
    parent_action_id: &str,
    result: &mut HashMap<String, MenuPrealloc>,
) {
    for (index, entry) in entries.iter().enumerate() {
        if let CanonicalEntry::Menu(menu) = entry {
            let action_id = Uuid::new_v4().to_string();
            if !menu.id.is_empty() {
                result.insert(
                    menu.id.clone(),
                    MenuPrealloc {
                        action_id: action_id.clone(),
                        replay_transition: Transition::fixed(parent_action_id, index),
                    },
                );
            }
            preallocate_menus(&menu.children, &action_id, result);
        }
    }
}
