use super::*;
use std::sync::{Arc, Mutex as StdMutex};

fn logs(marker: &str) -> Vec<crate::logs::Entry> {
    crate::logs::native_logs(0)
        .into_iter()
        .filter(|e| e.text.contains(marker))
        .collect()
}

fn pack_preset(rows: Value, warnings: Value) -> String {
    json!({"preset":{"format":"MAIDialRack preset","version":1,"rows":rows},"warnings":warnings})
        .to_string()
}

#[tokio::test]
async fn dial_presets_list_load_and_save_use_only_the_pack_routes() {
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let record = seen.clone();
    let (base, task) = crate::jobs::tests::server(move |path, body| {
        record.lock().unwrap().push((path.clone(), body.clone()));
        let reply = if path == "GET /comfy/mainodes/dials/presets HTTP/1.1" {
            json!(["calm_then_wild", "bad name", "../x", 7, "b-2"]).to_string()
        } else if path == "GET /comfy/mainodes/dials/presets/calm_then_wild HTTP/1.1" {
            pack_preset(
                json!([
                    {"dial":"dials/h3_motion.safetensors","sha256":"a".repeat(64),"strength":1.2,"on":true,"solo":false,
                     "time":{"type":"keys","points":[[0,0],[0.5,1]]}},
                    {"dial":"dials/gone.safetensors","sha256":null,"strength":-3,"on":false,"solo":true,"hold":true},
                    {"dial":"dials/b.safetensors","sha256":"b".repeat(64),"strength":1,"on":true,"solo":false,"blocks":[1,0.5]}
                ]),
                json!([
                    {"row":1,"dial":"dials/gone.safetensors","reason":"missing","expected":null,"actual":null},
                    {"row":2,"dial":"dials/b.safetensors","reason":"sha256 mismatch","expected":"b","actual":"c"},
                    {"row":9,"dial":"x","reason":"missing"},
                    {"row":0,"dial":"x","reason":"something new"}
                ]),
            )
        } else if path == "POST /comfy/mainodes/dials/presets/from-deas_1 HTTP/1.1" {
            let mut rows = body.clone();
            rows[0]["sha256"] = json!("c".repeat(64));
            rows[1]["sha256"] = Value::Null;
            pack_preset(rows, json!([{"row":1,"dial":"dials/new.safetensors","reason":"missing","expected":null,"actual":null}]))
        } else {
            panic!("unexpected request {path}");
        };
        (200, reply)
    })
    .await;

    assert_eq!(
        native_dial_presets(base.clone()).await.unwrap(),
        json!(["calm_then_wild", "b-2"]),
        "names outside the pack's pattern are not offered"
    );
    let loaded = native_dial_preset_load(base.clone(), "calm_then_wild".into())
        .await
        .unwrap();
    // Rows come back exactly as the pack sent them: Studio converts and reports on them.
    assert_eq!(loaded["rows"].as_array().unwrap().len(), 3);
    assert_eq!(
        loaded["rows"][0]["time"],
        json!({"type":"keys","points":[[0,0],[0.5,1]]})
    );
    assert_eq!(loaded["rows"][1]["hold"], true);
    assert_eq!(
        loaded["warnings"],
        json!([{"row":1,"reason":"missing"},{"row":2,"reason":"changed"}])
    );

    let rows = json!([
        {"dial":"dials/h3_motion.safetensors","strength":1.2,"on":true,
         "time":{"type":"keys","points":[[0,0],[2.5,1]],"unit":"seconds","interp":"linear","steps":3,"audio":"protect"}},
        {"dial":"dials/new.safetensors","strength":-0.5,"on":false}
    ]);
    let saved = native_dial_preset_save(base.clone(), "from-deas_1".into(), rows.clone())
        .await
        .unwrap();
    assert_eq!(saved["warnings"], json!([{"row":1,"reason":"missing"}]));
    assert_eq!(saved["rows"][0]["sha256"], json!("c".repeat(64)));
    task.abort();

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    // The body of the save is the rows as given: no hash invented, nothing added.
    assert_eq!(seen[2].1, rows);
    // The curve's audio mode is part of what DEAS sends, so it is saved too.
    assert_eq!(seen[2].1[0]["time"]["audio"], "protect");
    assert_eq!(logs("preset=from-deas_1").len(), 1);
    assert!(logs("preset=from-deas_1")[0]
        .text
        .starts_with("INFO: Dial presets save: saved; preset=from-deas_1; rows=2"));
}

#[tokio::test]
async fn dial_presets_fail_closed_with_a_reason_and_a_log_entry() {
    // Invalid names and rows never reach the backend.
    for name in ["", "a b", "../x", "ä", &"n".repeat(81)] {
        for result in [
            native_dial_preset_load("http://127.0.0.1:1/".into(), name.into()).await,
            native_dial_preset_save(
                "http://127.0.0.1:1/".into(),
                name.into(),
                json!([{"dial":"dials/a.safetensors","strength":1}]),
            )
            .await,
        ] {
            assert!(result.unwrap_err().starts_with("DIAL_PRESET_NAME: "));
        }
    }
    for (rows, reason) in [
        (json!([]), "A preset holds 1 to 8 rows"),
        (json!({"dial":"dials/a.safetensors"}), "A preset holds 1 to 8 rows"),
        (json!((0..9).map(|n| json!({"dial":format!("dials/d{n}.safetensors"),"strength":1})).collect::<Vec<_>>()), "A preset holds 1 to 8 rows"),
        (json!([{"dial":"dials/a.safetensors","strength":1,"solo":true}]), "Invalid dials: a row is {dial, strength, on?, time?}"),
        (json!([{"dial":"dials/a.safetensors","strength":1,"sha256":"a".repeat(64)}]), "Invalid dials: a row is {dial, strength, on?, time?}"),
        (json!([{"dial":"dials/a.safetensors","strength":1,"hold":true}]), "Invalid dials: hold rows are unsupported in this experimental version"),
        (json!([{"dial":"dials/a.safetensors","strength":1,"time":{"type":"keys","points":[[0,0],[1,1]]}}]),
            "Invalid dials: time is {type keys, points, unit seconds, interp? linear|step, smooth? 0..1, steps?, audio? follow|protect}"),
        (json!([{"dial":"loras/a.safetensors","strength":1}]), "Invalid dials: dial must be a .safetensors file inside dials/ (forward slashes, no traversal)"),
    ] {
        assert_eq!(
            native_dial_preset_save("http://127.0.0.1:1/".into(), "rows-check".into(), rows).await.unwrap_err(),
            format!("DIAL_PRESET_ROWS: {reason}")
        );
    }
    assert!(logs("preset=rows-check")[0].text.starts_with(
        "WARN: Dial presets save: rows outside what DEAS sends; preset=rows-check; repeated=0"
    ));

    assert_eq!(
        native_dial_presets("http://secret-user:secret-pass@private.invalid/?secret-token".into())
            .await
            .unwrap_err(),
        "DIAL_PRESETS_ENDPOINT: Backend URL must not contain credentials, a query, or a fragment"
    );
    // Nothing listens here: a transport failure.
    assert_eq!(
        native_dial_preset_load("http://127.0.0.1:1/".into(), "unreachable-one".into())
            .await
            .unwrap_err(),
        "DIAL_PRESETS_UNREACHABLE: The backend did not answer the rack preset request"
    );
    assert!(logs("preset=unreachable-one")[0]
        .text
        .starts_with("ERROR: Dial presets load: backend request failed; preset=unreachable-one"));

    // A backend without the pack: ComfyUI answers an unknown route with plain text.
    let (base, task) = crate::jobs::tests::server(|path, _| {
        if path.starts_with("POST ") {
            (405, "405: Method Not Allowed".into())
        } else {
            (404, "404: Not Found".into())
        }
    })
    .await;
    let missing = "DIAL_PRESETS_UNAVAILABLE: This backend has no rack preset route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet";
    assert_eq!(
        native_dial_presets(base.clone()).await.unwrap_err(),
        missing
    );
    for _ in 0..5 {
        assert_eq!(
            native_dial_preset_load(base.clone(), "no-pack-load".into())
                .await
                .unwrap_err(),
            missing
        );
    }
    assert_eq!(
        native_dial_preset_save(
            base.clone(),
            "no-pack-save".into(),
            json!([{"dial":"dials/a.safetensors","strength":1}])
        )
        .await
        .unwrap_err(),
        missing
    );
    task.abort();
    // Repeats of one cause are limited; the first one names the operation and the cause.
    let unavailable = logs("the backend has no rack preset route");
    assert!(
        !unavailable.is_empty() && unavailable.len() <= 2,
        "{}",
        unavailable.len()
    );
    assert!(unavailable[0].text.starts_with("WARN: Dial presets "));

    // The pack's own answers keep their reason.
    let (base, task) = crate::jobs::tests::server(|path, _| {
        if path.starts_with("POST /comfy/mainodes/dials/presets/taken ") {
            (409, json!({"error":"Preset already exists. Choose a new name."}).to_string())
        } else if path.starts_with("POST ") {
            (400, json!({"error":format!("preset rows must name a file inside dials/\u{7}{}", "x".repeat(900))}).to_string())
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/absent ") {
            (404, json!({"error":"Preset not found."}).to_string())
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/old ") {
            (400, json!({"error":"unsupported rack preset format or version (expected MAIDialRack preset v1)"}).to_string())
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/broken ") {
            (500, json!({"error":"secret-body"}).to_string())
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/shape ") {
            (200, json!({"preset":{"format":"Other","version":1,"rows":[]},"warnings":[]}).to_string())
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/many ") {
            (200, pack_preset(json!(vec![json!({"dial":"dials/a.safetensors","strength":1}); 65]), json!([])))
        } else if path.starts_with("GET /comfy/mainodes/dials/presets/text ") {
            (200, "not json".into())
        } else {
            (200, json!({"not":"a list"}).to_string())
        }
    })
    .await;
    let row = json!([{"dial":"dials/a.safetensors","strength":1}]);
    assert_eq!(
        native_dial_preset_save(base.clone(), "taken".into(), row.clone())
            .await
            .unwrap_err(),
        "DIAL_PRESET_EXISTS: Preset already exists. Choose a new name."
    );
    assert!(logs("preset=taken")[0].text.starts_with(
        "WARN: Dial presets save: preset already exists, nothing written; preset=taken"
    ));
    let refused = native_dial_preset_save(base.clone(), "refused".into(), row)
        .await
        .unwrap_err();
    assert!(refused.starts_with("DIAL_PRESET_REFUSED: preset rows must name a file inside dials/x"));
    assert_eq!(
        refused.len(),
        "DIAL_PRESET_REFUSED: ".len() + 300,
        "the pack's reason is bounded and has no control characters"
    );
    for (name, expected) in [
        ("absent", "DIAL_PRESET_NOT_FOUND: Preset not found."),
        ("old", "DIAL_PRESET_REFUSED: unsupported rack preset format or version (expected MAIDialRack preset v1)"),
        ("broken", "DIAL_PRESETS_FAILED: The backend answered HTTP 500 to the rack preset request"),
        ("shape", "DIAL_PRESETS_MALFORMED: The backend's rack preset is not a MAIDialRack preset v1 of at most 64 rows"),
        ("many", "DIAL_PRESETS_MALFORMED: The backend's rack preset is not a MAIDialRack preset v1 of at most 64 rows"),
        ("text", "DIAL_PRESETS_MALFORMED: The backend's rack preset answer is not JSON"),
    ] {
        assert_eq!(native_dial_preset_load(base.clone(), name.into()).await.unwrap_err(), expected);
    }
    assert_eq!(
        native_dial_presets(base.clone()).await.unwrap_err(),
        "DIAL_PRESETS_MALFORMED: The backend's rack preset list is malformed"
    );
    task.abort();

    for entry in logs("Dial presets ") {
        assert_eq!(entry.source, crate::logs::Source::Deas);
        for secret in ["secret-", "private.invalid", "http://", "https://", "xxxx"] {
            assert!(!entry.text.contains(secret), "{}", entry.text);
        }
    }
}

#[tokio::test]
async fn dial_presets_report_an_oversize_answer_as_too_large_not_unreachable() {
    let big = format!(
        r#"{{"preset":{{"format":"MAIDialRack preset","version":1,"rows":[]}},"warnings":[],"pad":"{}"}}"#,
        "x".repeat(super::super::RESPONSE_LIMIT)
    );
    let (base, task) = crate::jobs::tests::server(move |_, _| (200, big.clone())).await;
    let expected = "DIAL_PRESETS_TOO_LARGE: The backend's rack preset answer is larger than 1 MiB and was not read";
    assert_eq!(
        native_dial_presets(base.clone()).await.unwrap_err(),
        expected
    );
    assert_eq!(
        native_dial_preset_load(base.clone(), "oversize-load".into())
            .await
            .unwrap_err(),
        expected
    );
    assert_eq!(
        native_dial_preset_save(
            base.clone(),
            "oversize-save".into(),
            json!([{"dial":"dials/a.safetensors","strength":1}])
        )
        .await
        .unwrap_err(),
        expected
    );
    task.abort();
    let entries = logs("answer above the 1 MiB limit, not read");
    assert!(
        !entries.is_empty() && entries.len() <= 2,
        "{}",
        entries.len()
    );
    assert!(entries[0].text.starts_with("WARN: Dial presets "));
    assert!(logs("preset=oversize-")
        .iter()
        .all(|e| !e.text.contains("backend request failed")));
}
