use super::*;

#[test]
fn deserializes_story_document_with_float_positions() {
    let json = r#"{
          "title": "Float positions",
          "version": 1,
          "description": "",
          "format": "v1",
          "nightModeAvailable": false,
          "actionNodes": [
            {
              "id": "root-action",
              "name": "Action node",
              "options": ["stage-1"],
              "position": { "x": 905.5, "y": 40 }
            }
          ],
          "stageNodes": [
            {
              "uuid": "stage-1",
              "name": "Cover node",
              "type": "stage",
              "squareOne": true,
              "audio": "cover.mp3",
              "image": "cover.png",
              "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": false,
                "pause": false,
                "autoplay": false
              },
              "homeTransition": null,
              "okTransition": {
                "actionNode": "root-action",
                "optionIndex": 0
              },
              "position": { "x": 100, "y": 120.25 }
            }
          ]
        }"#;

    let document: StoryDocument =
        serde_json::from_str(json).expect("story document with float positions");

    assert_eq!(document.action_nodes.len(), 1);
    assert_eq!(document.stage_nodes.len(), 1);
    assert_eq!(document.action_nodes[0].position.x.as_f64(), Some(905.5));
    assert_eq!(document.stage_nodes[0].position.y.as_f64(), Some(120.25));
}

#[test]
fn deserializes_stage_without_square_one_flag() {
    let json = r#"{
          "title": "Missing square one",
          "version": 1,
          "description": "",
          "format": "v1",
          "nightModeAvailable": false,
          "actionNodes": [
            {
              "id": "root-action",
              "name": "Action node",
              "options": ["stage-1"],
              "position": { "x": 0, "y": 0 }
            }
          ],
          "stageNodes": [
            {
              "uuid": "stage-1",
              "name": "Stage sans flag",
              "type": "stage",
              "audio": "cover.mp3",
              "image": "cover.png",
              "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": false,
                "pause": false,
                "autoplay": false
              },
              "homeTransition": null,
              "okTransition": {
                "actionNode": "root-action",
                "optionIndex": 0
              },
              "position": { "x": 0, "y": 0 }
            }
          ]
        }"#;

    let document: StoryDocument =
        serde_json::from_str(json).expect("story document without squareOne");

    assert_eq!(document.stage_nodes.len(), 1);
    assert!(!document.stage_nodes[0].square_one);
}

#[test]
fn normalizes_stage_ports_for_studio_compatibility() {
    // Verifies that normalize_document_for_studio_compat enables the ok/home port flags
    // when transitions exist but the corresponding flags are off.
    // Uses distinct non-circular transition targets to satisfy the structural validator.
    let mut document = StoryDocument {
        title: "Compat".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: vec![
            ActionNode {
                id: "root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["source-stage".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "home-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["home-dest".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "ok-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["ok-dest".to_string()],
                position: zero_position(),
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "source-stage".to_string(),
                name: "Source".to_string(),
                stage_type: "stage".to_string(),
                square_one: true,
                audio: Some("cover.mp3".to_string()),
                image: None,
                control_settings: ControlSettings {
                    wheel: true,
                    ok: false,
                    home: false,
                    pause: true,
                    autoplay: false,
                },
                home_transition: Some(transition("home-action", 0)),
                ok_transition: Some(transition("ok-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "home-dest".to_string(),
                name: "Home dest".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("a.mp3".to_string()),
                image: None,
                control_settings: ControlSettings {
                    wheel: false,
                    ok: false,
                    home: false,
                    pause: false,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: None,
                position: zero_position(),
            },
            StageNode {
                uuid: "ok-dest".to_string(),
                name: "Ok dest".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("b.mp3".to_string()),
                image: None,
                control_settings: ControlSettings {
                    wheel: false,
                    ok: false,
                    home: false,
                    pause: false,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: None,
                position: zero_position(),
            },
        ],
    };

    normalize_document_for_studio_compat(&mut document);

    let stage = &document.stage_nodes[0];
    assert!(stage.control_settings.ok);
    assert!(stage.control_settings.home);
    validate_document_for_studio_compat(&document).expect("validated document");
}

#[test]
fn rejects_missing_transition_targets_for_studio_compatibility() {
    let document = StoryDocument {
        title: "Compat".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: vec![ActionNode {
            id: "root-action".to_string(),
            name: "Action node".to_string(),
            options: vec!["known-stage".to_string()],
            position: zero_position(),
        }],
        stage_nodes: vec![StageNode {
            uuid: "known-stage".to_string(),
            name: "Broken stage".to_string(),
            stage_type: "stage".to_string(),
            square_one: true,
            audio: Some("cover.mp3".to_string()),
            image: None,
            control_settings: ControlSettings {
                wheel: false,
                ok: true,
                home: false,
                pause: true,
                autoplay: false,
            },
            home_transition: None,
            ok_transition: Some(transition("missing-action", 0)),
            position: zero_position(),
        }],
    };

    let error = validate_document_for_studio_compat(&document).expect_err("invalid document");
    assert!(error.contains("missing-action"));
}
