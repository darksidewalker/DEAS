use super::*;

fn logs(marker: &str) -> Vec<crate::logs::Entry> {
    crate::logs::native_logs(0)
        .into_iter()
        .filter(|e| e.text.contains(marker))
        .collect()
}

/// Info as the pack's `check_dial_info` returns it for a file without any (`INFO_DEFAULTS`).
fn unknown() -> Value {
    json!({"version":2,"description":"","negative":"","positive":"","pipeline":"","notes":"",
        "neg":{"useful":null,"overcook":null},"pos":{"useful":null,"overcook":null},"evidence":null})
}

/// Entries of the catalog on the development machine (public dial metadata, 2026-11-16), as
/// `GET /mainodes/dials/catalog` returns them.
fn real() -> Vec<Value> {
    vec![
        json!({"dial":"dials/h3_day_night_hook.safetensors","family":"MiniMax H3","mode":"post","info":{
            "version":2,"description":"Time of day: +1 dusk, +2 night with a blue cast. Measured on Pika H3 Flex, 1 seed.",
            "negative":"bright midday","positive":"night","pipeline":"Pika H3 Flex 6-step","notes":"",
            "neg":{"useful":1.5,"overcook":3.0},"pos":{"useful":1.5,"overcook":3.0},"evidence":"one-seed"}}),
        json!({"dial":"dials/h3_ink_wash.safetensors","family":"MiniMax H3","mode":"post","info":{
            "version":2,"description":"Ink wash: the scene becomes a flowing black ink-wash painting on paper; negative goes to clean cel-shaded anime colour.",
            "negative":"cel-shaded colour","positive":"ink wash","pipeline":"Pika H3 Flex 6-step, time rows k = 6, audio: protect",
            "notes":"Best as a constant look on text to video: 1.5 to 2. On a seep in/out curve, 2 at k = 6 follows but re-composes the landscape (k = 2 smears the look over the clip).",
            "neg":{"useful":null,"overcook":null},"pos":{"useful":2.0,"overcook":null},"evidence":"one-seed"}}),
        json!({"dial":"dials/h3_impact_frame.safetensors","family":"MiniMax H3","mode":"post","info":{
            "version":2,"description":"Impact frame: the anime hit flash. k = 2 drew no flash at 3.0.",
            "negative":"normal shading","positive":"impact frame","pipeline":"Pika H3 Flex 6-step, time rows k = 6, audio: protect",
            "notes":"Text to video: pulse 4.5 (a 0.5 s step at the hit) gives ~6 inverted ink frames and the shot comes back clean; constant 3 inks the whole clip.",
            "neg":{"useful":null,"overcook":null},"pos":{"useful":4.5,"overcook":8.0},"evidence":"one-seed"}}),
        json!({"dial":"dials/h3_motion.safetensors","family":"MiniMax H3","mode":"pre","info":unknown()}),
    ]
}

#[tokio::test]
async fn dial_catalog_is_read_once_and_reduced_to_the_bounded_fields_studio_shows() {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let record = seen.clone();
    let (base, task) = crate::jobs::tests::server(move |path, body| {
        record.lock().unwrap().push((path, body));
        let mut dials = real();
        // Built from the pack's schema (`check_pipeline_info`); no file on the development
        // machine carries per-pipeline measurements yet.
        dials.push(json!({"dial":"dials\\sub\\h3_measured.safetensors","family":"MiniMax H3","mode":"post","secret":"x","info":{
            "version":2,"description":"a\u{7}b\nc","negative":"n".repeat(61),"positive":" day ","pipeline":7,"notes":"x".repeat(900),
            "neg":{"useful":"1.5","overcook":true},"pos":{"useful":2,"overcook":1,"extra":9},"evidence":"hearsay","kind":"look","author":"someone",
            "pipelines":{
                "t2v":{"useful":2.0,"overcook":4.0,"steps":6,"evidence":"multi-seed","notes":"follows at 6, smears at 2","gpu":"x"},
                "ref2v":{"useful":25,"overcook":-1,"steps":0,"evidence":null,"notes":null},
                "fl2v":{"steps":151},
                "v2v":{"useful":1,"steps":3}}}}));
        dials.push(json!({"dial":"dials/h3_kind.safetensors","family":7,"mode":"other","info":{"version":2,"kind":"flavour","pipelines":{"t2v":"six","fl2v":{"steps":2.5}},
            "neg":[1,2],"pos":{"useful":0,"overcook":20.5}}}));
        // Left out: not offered by Studio, not a dial file, not info v2, or listed twice.
        dials.push(json!({"dial":"dials/_probes/x.safetensors","family":"MiniMax H3","mode":"post","info":unknown()}));
        dials.push(json!({"dial":"loras/style.safetensors","family":"MiniMax H3","mode":"post","info":unknown()}));
        dials.push(json!({"dial":"dials/../x.safetensors","family":"MiniMax H3","mode":"post","info":unknown()}));
        dials.push(json!({"dial":"dials/old.safetensors","family":"MiniMax H3","mode":"post","info":{"version":1,"useful":2}}));
        dials.push(json!({"dial":"dials/none.safetensors","family":"MiniMax H3","mode":"post"}));
        dials.push(json!({"dial":"dials/h3_motion.safetensors","family":"MiniMax H3","mode":"post","info":unknown()}));
        dials.push(json!("dials/text.safetensors"));
        (200, json!({"dials":dials,"families":{"minimax_h3":"MiniMax H3"},"more":true}).to_string())
    })
    .await;

    let got = native_dial_catalog(base).await.unwrap();
    task.abort();
    assert_eq!(
        *seen.lock().unwrap(),
        [(
            "GET /comfy/mainodes/dials/catalog HTTP/1.1".to_owned(),
            Value::Null
        )],
        "one read-only request to the pack's catalog route"
    );
    let mut expected = real();
    expected.push(json!({"dial":"dials/sub/h3_measured.safetensors","family":"MiniMax H3","mode":"post","info":{
        "version":2,"description":"a b c","negative":"n".repeat(60),"positive":"day","pipeline":"","notes":"x".repeat(500),
        "neg":{"useful":null,"overcook":null},"pos":{"useful":2.0,"overcook":null},"evidence":null,"kind":"look",
        "pipelines":{
            "t2v":{"useful":2.0,"overcook":4.0,"steps":6,"evidence":"multi-seed","notes":"follows at 6, smears at 2"},
            "ref2v":{"useful":null,"overcook":null,"evidence":null,"notes":""},
            "fl2v":{"useful":null,"overcook":null,"evidence":null,"notes":""}}}}));
    let mut bare = unknown();
    bare["pipelines"] = json!({"fl2v":{"useful":null,"overcook":null,"evidence":null,"notes":""}});
    expected.push(json!({"dial":"dials/h3_kind.safetensors","family":"","mode":"","info":bare}));
    assert_eq!(got, json!({"dials":expected,"dropped":7,"truncated":false}));
    // Nothing but the listed fields leaves the command.
    let text = got.to_string();
    for dropped in [
        "secret", "author", "gpu", "extra", "v2v", "families", "more",
    ] {
        assert!(!text.contains(dropped), "{dropped}");
    }
    let left = logs("Dial info catalog: entries outside what DEAS reads were left out");
    assert!(!left.is_empty());
    assert!(left[0].text.starts_with("WARN: Dial info catalog: "));
}

#[tokio::test]
async fn dial_catalog_fails_closed_with_a_reason_and_a_log_entry() {
    assert_eq!(
        native_dial_catalog("http://secret-user:secret-pass@private.invalid/?secret-token".into())
            .await
            .unwrap_err(),
        "DIAL_INFO_ENDPOINT: Backend URL must not contain credentials, a query, or a fragment"
    );
    // Nothing listens here: a transport failure.
    assert_eq!(
        native_dial_catalog("http://127.0.0.1:1/".into())
            .await
            .unwrap_err(),
        "DIAL_INFO_UNREACHABLE: The backend did not answer the dial info request"
    );
    assert!(logs("Dial info catalog: backend request failed")[0]
        .text
        .starts_with("ERROR: Dial info catalog: backend request failed; repeated=0"));

    // A backend without the pack: ComfyUI answers an unknown route with 404 and no JSON.
    let missing = "DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route. It comes with the Dial Rack nodes (ComfyUI-Dials): Backend → Upgrade installs the pinned pack on an owned backend";
    for (status, body) in [
        (404, "404: Not Found"),
        (405, "405: Method Not Allowed"),
        (404, ""),
    ] {
        let (base, task) = crate::jobs::tests::server(move |_, _| (status, body.into())).await;
        // The tab reads the catalog every time it opens: repeats are limited in the log.
        for _ in 0..4 {
            assert_eq!(
                native_dial_catalog(base.clone()).await.unwrap_err(),
                missing
            );
        }
        task.abort();
    }
    let unavailable = logs("the backend has no dial catalog route");
    assert!(
        !unavailable.is_empty() && unavailable.len() <= 2,
        "{}",
        unavailable.len()
    );
    assert!(unavailable[0].text.starts_with("WARN: Dial info catalog: "));

    let big = format!(
        r#"{{"dials":[],"pad":"{}"}}"#,
        "x".repeat(super::super::RESPONSE_LIMIT)
    );
    let many: Vec<Value> = (0..LISTED + 5)
        .map(|n| json!({"dial":format!("dials/d{n}.safetensors"),"family":"MiniMax H3","mode":"post","info":{"version":2}}))
        .collect();
    let many = json!({"dials":many}).to_string();
    let (base, task) = crate::jobs::tests::server(move |path, _| {
        let case = path
            .trim_start_matches("GET /comfy/")
            .split('/')
            .next()
            .unwrap()
            .to_owned();
        match case.as_str() {
            // One dial file with broken info makes the pack's catalog raise.
            "broken" => (500, json!({"error":"secret-body"}).to_string()),
            "refused" => (400, json!({"error":"secret-body"}).to_string()),
            "text" => (200, "not json".into()),
            "list" => (200, json!([{"dial":"dials/a.safetensors"}]).to_string()),
            "object" => (200, json!({"dials":{"dials/a.safetensors":{}}}).to_string()),
            "absent" => (200, json!({"families":{}}).to_string()),
            "null" => (200, "null".into()),
            "big" => (200, big.clone()),
            "many" => (200, many.clone()),
            "empty" => (200, json!({"dials":[]}).to_string()),
            other => panic!("unexpected request {other}"),
        }
    })
    .await;
    for (case, expected) in [
        (
            "broken",
            "DIAL_INFO_FAILED: The backend answered HTTP 500 to the dial info request",
        ),
        (
            "refused",
            "DIAL_INFO_FAILED: The backend answered HTTP 400 to the dial info request",
        ),
        (
            "text",
            "DIAL_INFO_MALFORMED: The backend's dial catalog answer is not JSON",
        ),
        (
            "list",
            "DIAL_INFO_MALFORMED: The backend's dial catalog is malformed",
        ),
        (
            "object",
            "DIAL_INFO_MALFORMED: The backend's dial catalog is malformed",
        ),
        (
            "absent",
            "DIAL_INFO_MALFORMED: The backend's dial catalog is malformed",
        ),
        (
            "null",
            "DIAL_INFO_MALFORMED: The backend's dial catalog is malformed",
        ),
        (
            "big",
            "DIAL_INFO_TOO_LARGE: The backend's dial catalog is larger than 1 MiB and was not read",
        ),
    ] {
        assert_eq!(
            native_dial_catalog(format!("{base}/{case}"))
                .await
                .unwrap_err(),
            expected,
            "{case}"
        );
    }
    // More dials than Studio takes: the first ones, and the answer says so.
    let capped = native_dial_catalog(format!("{base}/many")).await.unwrap();
    assert_eq!(capped["dials"].as_array().unwrap().len(), LISTED);
    assert_eq!(capped["truncated"], true);
    assert_eq!(capped["dropped"], 0);
    assert_eq!(
        capped["dials"][LISTED - 1]["dial"],
        "dials/d999.safetensors"
    );
    assert_eq!(
        native_dial_catalog(format!("{base}/empty")).await.unwrap(),
        json!({"dials":[],"dropped":0,"truncated":false})
    );
    task.abort();

    for entry in logs("Dial info catalog") {
        assert_eq!(entry.source, crate::logs::Source::Deas);
        for secret in ["secret-", "private.invalid", "http://", "https://", "xxxx"] {
            assert!(!entry.text.contains(secret), "{}", entry.text);
        }
    }
}
