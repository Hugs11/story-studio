use serde_json::json;

use super::*;
use crate::native_pack::graph_view::read_advanced_graph_view;

#[test]
fn node_colors_are_project_context_only_and_survive_reopening() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload initial");
    let stage_path = format!("/stageNodes/@uuid={ENTRY}#0");
    let action_path = "/actionNodes/@id=action-1#0";
    let colored = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-node-color",
            "paths": [stage_path, action_path],
            "color": "#7c6af7"
        }),
    );
    let reopened = saved_and_reopened(&colored.payload);

    assert_eq!(
        reopened.document, before.document,
        "la couleur ne touche pas le dialecte exporté"
    );
    assert_eq!(reopened.context.node_colors.len(), 2);
    let view = read_advanced_graph_view(&colored.payload).expect("vue lisible");
    assert_eq!(view.stages[0].personal_color.as_deref(), Some("#7c6af7"));
    assert_eq!(view.actions[0].personal_color.as_deref(), Some("#7c6af7"));

    let cleared = applied(
        &colored.payload,
        colored.media_bindings,
        json!({
            "gesture": "set-node-color",
            "paths": [format!("/stageNodes/@uuid={ENTRY}#0")],
            "color": null
        }),
    );
    let after = saved_and_reopened(&cleared.payload);
    assert_eq!(after.context.node_colors.len(), 1);
    assert_eq!(after.context.node_colors[0].path, action_path);
}

#[test]
fn node_color_refuses_unknown_paths_duplicates_and_colors_outside_the_shared_palette() {
    let payload = payload();
    for (request, code) in [
        (
            json!({"gesture":"set-node-color","paths":["/stageNodes/@uuid=missing#0"],"color":"#7c6af7"}),
            "UNKNOWN_NODE_PATH",
        ),
        (
            json!({"gesture":"set-node-color","paths":[format!("/stageNodes/@uuid={ENTRY}#0"),format!("/stageNodes/@uuid={ENTRY}#0")],"color":"#7c6af7"}),
            "DUPLICATE_NODE_COLOR_TARGET",
        ),
        (
            json!({"gesture":"set-node-color","paths":[format!("/stageNodes/@uuid={ENTRY}#0")],"color":"rebeccapurple"}),
            "UNSUPPORTED_NODE_COLOR",
        ),
    ] {
        assert_eq!(refused(&payload, bindings(), request).code, code);
    }
}

#[test]
fn renaming_preserves_the_three_presence_forms_and_refuses_an_ambiguous_identifier() {
    let payload = payload();
    let renamed = applied(
        &payload,
        bindings(),
        json!({
            "gesture":"set-node-name",
            "node":{"kind":"stage","id":ENTRY},
            "update":{"form":"set","value":""}
        }),
    );
    let after_empty = saved_and_reopened(&renamed.payload);
    assert_eq!(
        after_empty.document.stage_nodes[0].name,
        Presence::Value(String::new())
    );

    let nulled = applied(
        &renamed.payload,
        renamed.media_bindings,
        json!({
            "gesture":"set-node-name",
            "node":{"kind":"stage","id":ENTRY},
            "update":{"form":"null"}
        }),
    );
    assert_eq!(
        saved_and_reopened(&nulled.payload).document.stage_nodes[0].name,
        Presence::Null
    );

    let absent = applied(
        &nulled.payload,
        nulled.media_bindings,
        json!({
            "gesture":"set-node-name",
            "node":{"kind":"stage","id":ENTRY},
            "update":{"form":"absent"}
        }),
    );
    assert_eq!(
        saved_and_reopened(&absent.payload).document.stage_nodes[0].name,
        Presence::Absent
    );

    let mut source = source_document();
    source["stageNodes"][1]["uuid"] = json!(ENTRY);
    let ambiguous = payload_from(&source);
    assert_eq!(
        refused(
            &ambiguous,
            bindings(),
            json!({
                "gesture":"set-node-name",
                "node":{"kind":"stage","id":ENTRY},
                "update":{"form":"set","value":"Jamais appliqué"}
            }),
        )
        .code,
        "AMBIGUOUS_NODE"
    );
}
