//! Manual bounded SAM3.1 face tracking; the only product is a silent union-mask preview.
use serde_json::{json, Value};

pub(crate) const NODES: [&str; 6] = [
    "DEAS_SAM3ShotMask",
    "DEAS_SAM3VideoWindow",
    "SAM3_VideoTrack",
    "SAM3_TrackToMask",
    "SaveVideo",
    "CreateVideo",
];
pub(crate) fn is_video_mask(i: &Value) -> bool {
    i["recipeId"] == "sam3-video-mask"
}
pub(crate) fn compile(i: &Value) -> Result<Value, String> {
    let fields = [
        "recipeId",
        "version",
        "checkpoint",
        "sourceVideo",
        "outputPrefix",
        "threshold",
        "maxObjects",
        "detectInterval",
        "startSeconds",
        "durationSeconds",
    ];
    let valid = i.as_object().is_some_and(|o| fields.iter().all(|k| o.contains_key(*k)) && o.keys().all(|k| fields.contains(&k.as_str()) || k == "sceneThreshold"))
        && i.get("sceneThreshold").is_none_or(|v| v.as_f64().is_some_and(|n| n.is_finite() && n > 0.0 && n <= 1.0))
        && is_video_mask(i) && i["version"].as_u64() == Some(1)
        && i["checkpoint"].as_str().is_some_and(crate::jobs::comfy_model_name)
        && i["sourceVideo"].as_str().is_some_and(|s| crate::jobs::model_name(s) && !s.contains(['/', '[', ']']))
        && i["outputPrefix"].as_str().is_some_and(crate::jobs::safe_output_prefix)
        && i["threshold"].as_f64().is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        && i["maxObjects"].as_u64().is_some_and(|n| (1..=64).contains(&n))
        // Core io.Int's default upper bound is signed 32-bit.
        && i["detectInterval"].as_u64().is_some_and(|n| (1..=2_147_483_647).contains(&n))
        && i["startSeconds"].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
        && i["durationSeconds"].as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
        && (i["startSeconds"].as_f64().unwrap_or(f64::INFINITY) + i["durationSeconds"].as_f64().unwrap_or(f64::INFINITY)).is_finite();
    if !valid {
        return Err("Invalid sam3-video-mask intent".into());
    }
    let mut graph = json!({
        "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":i["checkpoint"]}},
        "2":{"class_type":"LoadVideo","inputs":{"file":i["sourceVideo"]}},
        "W":{"class_type":"DEAS_SAM3VideoWindow","inputs":{"video":["2",0],"model":["1",0],"start_seconds":i["startSeconds"],"duration_seconds":i["durationSeconds"],"max_objects":i["maxObjects"]}},
        "VC":{"class_type":"GetVideoComponents","inputs":{"video":["W",0]}},
        "3":{"class_type":"CLIPTextEncode","inputs":{"clip":["1",1],"text":"face:200"}},
        "4":{"class_type":"SAM3_VideoTrack","inputs":{"images":["VC",0],"model":["1",0],"conditioning":["3",0],"detection_threshold":i["threshold"],"max_objects":i["maxObjects"],"detect_interval":i["detectInterval"]}},
        "5":{"class_type":"SAM3_TrackToMask","inputs":{"track_data":["4",0],"object_indices":""}},
        "6":{"class_type":"MaskToImage","inputs":{"mask":["5",0]}},
        "V":{"class_type":"CreateVideo","inputs":{"images":["6",0],"fps":["VC",2],"bit_depth":8,"color_space":"sRGB","chroma_subsampling":"444"}},
        "7":{"class_type":"SaveVideo","inputs":{"video":["V",0],"filename_prefix":i["outputPrefix"],"format":"mp4","format.codec":"h264"}}
    });
    if let Some(threshold) = i.get("sceneThreshold") {
        graph["4"]["class_type"] = json!("DEAS_SAM3ShotMask");
        graph["4"]["inputs"]["scene_threshold"] = threshold.clone();
        graph.as_object_mut().unwrap().remove("5");
        graph["6"]["inputs"]["mask"] = json!(["4", 0]);
    }
    Ok(graph)
}
pub(crate) fn requirements(i: &Value) -> Vec<(&str, Vec<&str>)> {
    vec![
        ("checkpoints", vec![i["checkpoint"].as_str().unwrap()]),
        ("videos", vec![i["sourceVideo"].as_str().unwrap()]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn intent() -> Value {
        json!({"recipeId":"sam3-video-mask","version":1,"checkpoint":"SAM3/sam3.1.safetensors","sourceVideo":"source.mp4","outputPrefix":"DEAS/mask-video","threshold":0.5,"maxObjects":8,"detectInterval":1,"startSeconds":0.0,"durationSeconds":1.0})
    }
    #[test]
    fn sam3_video_exact_graph_uses_bounded_window_union_source_fps_and_core_saver() {
        let g = crate::jobs::compile(&intent()).unwrap();
        assert_eq!(g.as_object().unwrap().len(), 10);
        assert_eq!(
            g["1"],
            json!({"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"SAM3/sam3.1.safetensors"}})
        );
        assert_eq!(
            g["2"],
            json!({"class_type":"LoadVideo","inputs":{"file":"source.mp4"}})
        );
        assert_eq!(
            g["W"],
            json!({"class_type":"DEAS_SAM3VideoWindow","inputs":{"video":["2",0],"model":["1",0],"start_seconds":0.0,"duration_seconds":1.0,"max_objects":8}})
        );
        assert_eq!(
            g["VC"],
            json!({"class_type":"GetVideoComponents","inputs":{"video":["W",0]}})
        );
        assert_eq!(
            g["3"],
            json!({"class_type":"CLIPTextEncode","inputs":{"clip":["1",1],"text":"face:200"}})
        );
        assert_eq!(
            g["4"],
            json!({"class_type":"SAM3_VideoTrack","inputs":{"images":["VC",0],"model":["1",0],"conditioning":["3",0],"detection_threshold":0.5,"max_objects":8,"detect_interval":1}})
        );
        assert_eq!(
            g["5"],
            json!({"class_type":"SAM3_TrackToMask","inputs":{"track_data":["4",0],"object_indices":""}})
        );
        assert_eq!(
            g["6"],
            json!({"class_type":"MaskToImage","inputs":{"mask":["5",0]}})
        );
        assert_eq!(
            g["V"],
            json!({"class_type":"CreateVideo","inputs":{"images":["6",0],"fps":["VC",2],"bit_depth":8,"color_space":"sRGB","chroma_subsampling":"444"}})
        );
        assert_eq!(g["3"]["inputs"]["text"], "face:200");
        assert_eq!(g["VC"]["inputs"]["video"], json!(["W", 0]));
        assert_eq!(g["W"]["inputs"]["model"], json!(["1", 0]));
        assert_eq!(g["5"]["inputs"]["object_indices"], "");
        assert_eq!(g["V"]["inputs"]["fps"], json!(["VC", 2]));
        assert_eq!(
            g["7"],
            json!({"class_type":"SaveVideo","inputs":{"video":["V",0],"filename_prefix":"DEAS/mask-video","format":"mp4","format.codec":"h264"}})
        );
        assert!(g["V"]["inputs"].get("audio").is_none());
        assert!(!g.to_string().contains("KSampler"));
        assert_eq!(
            requirements(&intent()),
            vec![
                ("checkpoints", vec!["SAM3/sam3.1.safetensors"]),
                ("videos", vec!["source.mp4"])
            ]
        );
    }
    #[test]
    fn sam3_video_python_admission_contract() {
        let python = if cfg!(windows) { "python" } else { "python3" };
        let output = std::process::Command::new(python)
            .args(["-B", "src/test_sam3_video_window.py"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .expect("Python is required for bundled adapter tests");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    #[ignore = "exports the native HF1 graph for an installed-Core validation probe"]
    fn dump_sam3_video_graph() {
        println!("{}", crate::jobs::compile(&intent()).unwrap());
    }

    #[test]
    #[ignore = "exports enabled native HF2a graph for installed-Core validation"]
    fn dump_sam3_shot_graph() {
        let mut i = intent();
        i["sceneThreshold"] = json!(0.3);
        println!("{}", crate::jobs::compile(&i).unwrap());
    }

    #[test]
    fn sam3_shot_optional_graph_changes_only_tracker_union_links() {
        let original = compile(&intent()).unwrap();
        for threshold in [0.000000001, 0.3, 1.0] {
            let mut i = intent();
            i["sceneThreshold"] = json!(threshold);
            let enabled = compile(&i).unwrap();
            let mut expected = original.clone();
            expected["4"]["class_type"] = json!("DEAS_SAM3ShotMask");
            expected["4"]["inputs"]["scene_threshold"] = json!(threshold);
            expected.as_object_mut().unwrap().remove("5");
            expected["6"]["inputs"]["mask"] = json!(["4", 0]);
            assert_eq!(enabled, expected);
            i.as_object_mut().unwrap().remove("sceneThreshold");
            assert_eq!(compile(&i).unwrap(), original);
        }
        for value in [
            Value::Null,
            json!(false),
            json!("0.3"),
            json!(0),
            json!(-0.1),
            json!(1.001),
            json!([]),
            json!({}),
        ] {
            let mut i = intent();
            i["sceneThreshold"] = value;
            assert!(compile(&i).is_err(), "{i}");
        }
        let mut i = intent();
        i["sceneThreshold"] = json!(0.3);
        i["extra"] = json!(1);
        assert!(compile(&i).is_err());
        for key in intent().as_object().unwrap().keys() {
            let mut i = intent();
            i["sceneThreshold"] = json!(0.3);
            i.as_object_mut().unwrap().remove(key);
            assert!(compile(&i).is_err(), "{key}");
        }
    }

    #[test]
    fn sam3_video_invalid_fields_paths_and_numbers_fail_closed() {
        for (k, v) in [
            ("version", json!(2)),
            ("checkpoint", json!("../sam.safetensors")),
            ("sourceVideo", json!("nested/source.mp4")),
            ("sourceVideo", json!("/etc/passwd")),
            ("sourceVideo", json!("https://host/video.mp4")),
            ("sourceVideo", json!("source.mp4 [output]")),
            ("sourceVideo", json!("..\\source.mp4")),
            ("outputPrefix", json!("../mask")),
            ("threshold", json!(1.1)),
            ("threshold", Value::Null),
            ("maxObjects", json!(0)),
            ("maxObjects", json!(65)),
            ("maxObjects", json!(1.5)),
            ("detectInterval", json!(0)),
            ("detectInterval", json!(2_147_483_648u64)),
            ("detectInterval", json!(true)),
            ("startSeconds", json!(-0.1)),
            ("durationSeconds", json!(0)),
            ("durationSeconds", json!("1")),
            ("durationSeconds", Value::Null),
            ("prompt", json!("person")),
            ("width", json!(640)),
        ] {
            let mut i = intent();
            i[k] = v;
            assert!(crate::jobs::compile(&i).is_err(), "{i}");
        }
        for k in intent().as_object().unwrap().keys() {
            let mut i = intent();
            i.as_object_mut().unwrap().remove(k);
            assert!(compile(&i).is_err(), "{k}");
        }
    }
}
