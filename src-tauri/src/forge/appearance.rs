//! What a tag says about a character: part of her, something she wears or
//! carries, or something about the picture. Ported from PromptForge
//! web/appearance.js. The canon block keeps only what she IS — her clothes
//! and props are the brief's to decide, and an unrecognised tag is assumed to
//! describe her, the direction that fails safely.

fn key(tag: &str) -> String {
    tag.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join("_")
}

const BODY: &[&str] = &[
    "elf", "human", "demon", "demon_girl", "angel", "oni", "vampire", "youkai", "monster_girl", "mermaid", "dragon_girl",
    "robot", "android", "ghost", "furry", "kemonomimi", "dark_skin", "pale_skin", "tan", "tanlines", "very_dark_skin",
    "freckles", "mole", "mole_under_eye", "mole_under_mouth", "mole_on_neck", "thick_eyebrows", "thin_eyebrows",
    "eyebrows", "eyelashes", "long_eyelashes", "fang", "fangs", "sharp_teeth", "tongue", "lips", "thick_lips", "tsurime",
    "tareme", "jitome", "sanpaku", "bags_under_eyes", "heterochromia", "scar", "scar_on_face", "scar_across_eye",
    "birthmark", "tattoo", "facial_mark", "muscular", "muscular_female", "muscular_male", "plump", "slim", "petite",
    "curvy", "wide_hips", "thick_thighs", "toned", "abs", "navel", "collarbone", "thighs", "tall", "short", "bangs",
    "forehead", "nose", "neck", "ear", "shoulder", "cheek", "chin", "short_eyebrows", "long_eyebrows", "twintails",
    "twin_tails", "ponytail", "side_ponytail", "high_ponytail", "low_ponytail", "braid", "braids", "twin_braids",
    "single_braid", "french_braid", "crown_braid", "hair_bun", "double_bun", "single_hair_bun", "cone_hair_bun",
    "bob_cut", "hime_cut", "ahoge", "antenna_hair", "sidelocks", "drill_hair", "twin_drills", "hair_intakes", "blunt_ends",
];
const HAIR_WORN: &[&str] = &[
    "hat_flower", "hair_ribbon", "hair_bow", "hair_ornament", "hair_flower", "hair_clip", "hairclip", "hairband",
    "hair_tie", "hair_bobbles", "hair_tubes", "hair_bell", "hair_rings", "hair_beads", "hair_scrunchie", "hair_stick",
    "hairpin", "hair_pin", "hair_ribbons",
];
const FAKE_BODY: &[&str] = &["fake_animal_ears", "fake_horns", "fake_tail", "fake_wings", "animal_ear_headphones"];
const GARMENT_NOUNS: &[&str] = &[
    "shirt", "blouse", "sweater", "cardigan", "hoodie", "jacket", "coat", "blazer", "vest", "waistcoat", "tank_top",
    "camisole", "crop_top", "top", "jersey", "poncho", "cloak", "cape", "capelet", "shawl", "robe", "kimono", "yukata",
    "haori", "hanfu", "sari", "tunic", "surcoat", "tabard", "skirt", "shorts", "pants", "trousers", "jeans", "leggings",
    "hakama", "bloomers", "culottes", "dress", "gown", "sundress", "jumpsuit", "overalls", "romper", "leotard",
    "bodysuit", "swimsuit", "bikini", "uniform", "apron", "armor", "armour", "pantyhose", "tights", "stockings",
    "thighhighs", "kneehighs", "socks", "boots", "shoes", "sandals", "heels", "loafers", "sneakers", "geta", "zori",
    "slippers", "gloves", "mittens", "gauntlets", "bracers", "sleeves", "armlet", "cuffs", "scarf", "muffler", "necktie",
    "tie", "bowtie", "ascot", "collar", "choker", "ribbon", "hat", "cap", "beret", "bonnet", "hood", "helmet", "headband",
    "headdress", "veil", "crown", "tiara", "circlet", "visor", "goggles", "glasses", "eyewear", "sunglasses", "mask",
    "eyepatch", "bra", "panties", "underwear", "lingerie", "corset", "belt", "sash", "obi", "harness", "suspenders",
    "garter", "garter_belt", "buckle", "clothes", "(clothes)", "serafuku", "maid", "miko", "playboy_bunny", "race_queen",
    "magical_girl", "plugsuit", "suit", "tasuki", "muneate", "pauldrons", "randoseru", "bodystocking", "nun", "negligee",
    "denim", "lolita", "wig", "fatigues", "military", "camouflage", "self-defense", "qipao", "pelvic_curtain", "dougi",
    "outfit", "breastplate", "shoulder_pads", "armband", "wristband", "wrap", "miniskirt", "emblem", "v-neck",
    "off_shoulder", "hip_vent", "lowleg", "topless", "watch", "smartwatch", "wristwatch", "converse", "neckerchief",
    "turtleneck", "halterneck", "halter", "strap", "legwear", "thighhigh", "pocket", "frills", "button", "buttons",
    "double-breasted", "sleeveless", "cutout", "print", "midriff", "bare_shoulders", "covered_navel", "buruma",
    "lanyard", "id_card", "headscarf", "beanie", "sukajan", "knee_pads", "elbow_pads", "rash_guard", "fishnets",
    "breast_curtain", "breast_curtains", "neckline", "whistle", "name_tag", "cheerleader", "nurse", "police",
    "unzipped", "strapless", "slit", "mary_janes", "barefoot", "bare_arms", "bare_legs",
];
const NOT_GARMENT: &[&str] = &[
    "ponytail", "twintails", "twin_tails", "side_ponytail", "high_ponytail", "low_ponytail", "tail", "cat_tail",
    "fox_tail", "wolf_tail", "animal_tail", "halo", "cross_halo", "yellow_halo", "blue_halo", "red_halo", "green_halo",
    "white_halo", "black_halo", "purple_halo", "orange_halo", "pink_halo", "animal_ear_fluff", "fox_girl", "cat_girl",
    "wolf_girl", "dog_girl", "horse_girl", "rabbit_girl", "mouse_girl", "button_eyes",
];
const PROP_NOUNS: &[&str] = &[
    "sword", "katana", "dagger", "knife", "blade", "rapier", "scimitar", "greatsword", "spear", "lance", "halberd",
    "glaive", "naginata", "axe", "scythe", "sickle", "hammer", "mace", "club", "staff", "wand", "rod", "crossbow",
    "bow_(weapon)", "arrow", "quiver", "shield", "gun", "rifle", "pistol", "revolver", "shotgun", "cannon", "kunai",
    "shuriken", "whip", "chain", "sheath", "scabbard", "weapon", "firearm", "polearm", "bag", "backpack", "purse",
    "handbag", "satchel", "briefcase", "suitcase", "basket", "box", "crate", "barrel", "bucket", "umbrella", "parasol",
    "lantern", "lamp", "torch", "candle", "broom", "mop", "camera", "phone", "smartphone", "bottle", "flask", "cup", "mug",
    "glass", "plate", "tray", "book", "scroll", "map", "letter", "envelope", "fan", "mirror", "key", "coin", "pouch",
    "doll", "plushie", "teddy_bear", "balloon", "instrument", "guitar", "violin", "flute", "microphone", "flag", "gohei",
    "trident", "gourd", "orb", "stuffed", "walkman", "spray_can", "cable", "tablet_pc", "shackles", "swim_ring",
    "innertube", "inflatable", "pom_pom_(cheerleading)", "cellphone",
];
const NOT_PROP: &[&str] = &[
    "chain_necklace", "neck_chain", "chain_belt", "stained_glass", "glass_bottle", "hourglass", "sunglasses",
    "eyeglasses", "tail", "fan_(object)_removed",
];
const COUNT: &[&str] = &[
    "1girl", "1boy", "1other", "2girls", "2boys", "3girls", "3boys", "4girls", "5girls", "6+girls", "6+boys",
    "multiple_girls", "multiple_boys", "multiple_others", "male_focus", "female_focus", "solo", "solo_focus", "duo",
    "trio", "group", "twins", "sisters", "brothers", "siblings", "brother_and_sister", "everyone", "absolutely_everyone",
];
const CROP: &[&str] = &[
    "full_body", "upper_body", "lower_body", "cowboy_shot", "portrait", "close-up", "wide_shot", "cropped",
    "cropped_torso", "cropped_legs", "cropped_arms", "cropped_head", "out_of_frame", "simple_background",
    "white_background", "transparent_background", "gradient_background", "two-tone_background", "grey_background",
    "black_background", "blue_background", "pink_background", "red_background", "yellow_background",
    "green_background", "purple_background", "floral_background", "patterned_background", "abstract_background", "legs",
];
const ANGLE: &[&str] = &["straight-on", "dutch_angle", "sideways", "rotated", "from_above", "from_below", "from_outside", "pov", "first-person_view"];
const GAZE: &[&str] = &["profile", "facing_viewer", "facing_away", "facing_to_the_side", "eye_contact", "from_side", "from_behind"];
const MEDIUM: &[&str] = &[
    "depth_of_field", "bokeh", "motion_blur", "chromatic_aberration", "film_grain", "greyscale", "monochrome", "sepia",
    "limited_palette", "spot_color", "official_art", "game_cg", "promotional_art", "key_visual", "traditional_media",
    "pixel_art", "sketch", "lineart", "unfinished", "anime_coloring", "anime_screencap", "flat_color", "cel_shading",
    "soft_shading", "toon_shading", "halftone", "screentones", "painterly", "watercolor_(medium)", "oekaki",
    "retro_artstyle", "realistic", "photorealistic", "impasto", "gradient", "chibi", "chibi_only", "comic", "4koma",
    "full_page_comic", "silent_comic",
];
const META: &[&str] = &[
    "blurry", "blurry_background", "blurry_foreground", "noise", "jpeg_artifacts", "scan", "scan_artifacts", "lowres",
    "highres", "absurdres", "incredibly_absurdres", "huge_filesize", "artist_name", "signature", "watermark",
    "web_address", "username", "twitter_username", "dated", "character_name", "copyright_name", "logo", "artist_logo",
    "company_name", "copyright", "credits", "studio_name", "subtitled", "screencap", "anime_screenshot", "stitched",
    "third-party_edit", "episode_number", "english_text", "japanese_text", "text_focus", "speech_bubble",
    "thought_bubble", "translated", "translation_request", "check_translation", "border", "framed", "letterboxed",
    "pillarboxed", "outside_border", "reference_sheet", "character_sheet", "multiple_views", "variant_set",
    "alternate_costume", "official_alternate_costume", "alternate_hairstyle", "official_alternate_hairstyle",
    "alternate_hair_color", "alternate_eye_color", "cosplay", "virtual_youtuber", "album_cover", "cover",
    "magazine_cover", "cover_page", "bara", "no_humans", "parody", "red_theme",
];
const EXPRESSION: &[&str] = &[
    "sweat", "smile", "grin", "evil_grin", "smirk", "light_smile", "closed_eyes", "one_eye_closed", "half-closed_eyes",
    "wide-eyed", "narrowed_eyes", "open_mouth", "closed_mouth", "parted_lips", "frown", "pout", "gasp",
    "clenched_teeth", "teeth", "fang_out", "tongue_out", "licking_lips", "blush", "blush_stickers", "nose_blush",
    "embarrassed", "flying_sweatdrops", "sweatdrop", "crying", "crying_with_eyes_open", "tears", "happy", "sad", "angry",
    "annoyed", "surprised", "shocked", "scared", "serious", "smug", "expressionless", "empty_eyes", "sleepy", "yawning",
    "wink", "wince", ":d", ":o", ":3", ":>", ":<", ":|", ";d", ";)", "^_^", "xd", "o_o", "@_@", "heart-shaped_pupils",
    "nervous", "confused", "determined",
];
const ACTION: &[&str] = &[
    "holding", "carrying", "grabbing", "reaching", "pointing", "waving", "reaching_towards_viewer", "between_breasts",
    "restrained", "listening_to_music", "sitting", "standing", "walking", "running", "jumping", "flying", "floating",
    "falling", "kneeling", "squatting", "crouching", "leaning", "leaning_forward", "leaning_back", "lying", "on_back",
    "on_side", "on_stomach", "sleeping", "stretching", "bending_over", "all_fours", "arm_up", "arms_up", "arm_at_side",
    "arms_at_sides", "arms_crossed", "arms_behind_back", "arms_behind_head", "hand_up", "hands_up", "hand_on_hip",
    "hands_on_hips", "hand_on_own_chest", "hand_on_own_face", "against_wall", "hand_on_wall", "arm_against_wall",
    "hand_in_pocket", "hands_in_pockets", "hand_in_hair", "own_hands_together", "outstretched_arm", "outstretched_hand",
    "open_hand", "clenched_hand", "clenched_hands", "v", "salute", "thumbs_up", "peace_sign", "legs_crossed",
    "crossed_legs", "legs_up", "spread_legs", "legs_apart", "knees_together_feet_apart", "standing_on_one_leg",
    "drinking", "eating", "cooking", "reading", "writing", "singing", "dancing", "smoking", "playing_instrument",
    "fighting", "aiming", "hug", "hugging", "hugging_object", "kissing", "riding", "swimming", "looking_at_another",
    "talking", "shouting", "laughing",
];
const LIGHT: &[&str] = &[
    "day", "night", "evening", "morning", "sunset", "sunrise", "dusk", "twilight", "sunlight", "backlighting",
    "rim_lighting", "lens_flare", "light_rays", "neon_lights", "neon_trim", "sunbeam", "dappled_sunlight", "god_rays",
    "dim_lighting", "bright", "dark", "silhouette", "shadow", "cast_shadow", "lantern", "candle", "lamp", "glowing",
    "light_particles", "sparkle", "sparkles",
];
const SCENE: &[&str] = &[
    "indoors", "outdoors", "scenery", "nature", "landscape", "contemporary", "fantasy", "cliff", "horizon", "truck",
    "car", "vehicle", "motor_vehicle", "military_vehicle", "sky", "cloud", "clouds", "cloudy_sky", "blue_sky",
    "night_sky", "starry_sky", "star_(sky)", "moon", "full_moon", "crescent_moon", "sun", "tree", "trees", "forest",
    "bamboo_forest", "grass", "field", "flower", "sunflower", "sunflowers", "lotus", "spider_lily", "lily_(flower)",
    "lily_pad", "rose_petals", "flower_pot", "ivy", "moss", "fern", "flower_field", "sunflower_field", "petals",
    "falling_petals", "cherry_blossoms", "leaf", "leaves", "plant", "potted_plant", "bush", "mountain", "hill", "rock",
    "ocean", "sea", "beach", "sand", "water", "waves", "river", "lake", "puddle", "reflection", "snow", "snowing", "rain",
    "raining", "fog", "wet", "mist", "wind", "path", "pavement", "cobblestone", "arch", "archway", "column", "brick",
    "gravel", "dirt", "hedge", "shrub", "vine", "wall", "brick_wall", "stone_wall", "wooden_wall", "tiled_wall", "floor",
    "wooden_floor", "tatami", "tile_floor", "ceiling", "window", "windowsill", "curtains", "door", "doorway", "stairs",
    "railing", "fence", "pillar", "room", "bedroom", "bed", "kitchen", "bathroom", "classroom", "library", "office",
    "cafe", "restaurant", "shop", "church", "shrine", "castle", "ruins", "building", "city", "cityscape", "street", "road",
    "sidewalk", "alley", "bridge", "rooftop", "train_interior", "car_interior", "chair", "table", "desk", "bench", "sofa",
    "couch", "shelf", "bookshelf", "book", "cup", "mug", "teacup", "bottle", "glass", "plate", "bowl", "food", "drink",
    "coffee", "tea", "cake", "fruit", "fire", "smoke", "confetti", "bubble", "bubbles", "butterfly", "bird", "cat", "dog",
    "ice_cream", "ice_cream_cone", "donut", "doughnut", "candy", "strawberry", "birthday_cake", "white_bird", "seagull",
    "starfish", "fish", "marlin_(fish)", "animal",
];

fn noun_match(k: &str, nouns: &[&str]) -> bool {
    let words: Vec<&str> = k.split('_').collect();
    nouns.iter().any(|n| k == *n || words.contains(n) || (n.contains('_') && k.contains(n)))
}

/// Something she puts on and could take off.
pub fn is_garment(tag: &str) -> bool {
    let k = key(tag);
    if k.is_empty() || NOT_GARMENT.contains(&k.as_str()) || HAIR_WORN.contains(&k.as_str()) {
        return false;
    }
    FAKE_BODY.contains(&k.as_str()) || noun_match(&k, GARMENT_NOUNS)
}

/// Something she carries. A garment wins the tie.
pub fn is_prop(tag: &str) -> bool {
    let k = key(tag);
    !k.is_empty() && !NOT_PROP.contains(&k.as_str()) && !is_garment(&k) && noun_match(&k, PROP_NOUNS)
}

fn ends_with_any(k: &str, suffixes: &[&str]) -> bool {
    suffixes.iter().any(|s| k.ends_with(&format!("_{s}")))
}

/// The fine class. `appearance` is the fallback: an unknown tag describes her.
pub fn tag_facet(tag: &str) -> &'static str {
    let k = key(tag);
    let k = k.as_str();
    if k.is_empty() || HAIR_WORN.contains(&k) || FAKE_BODY.contains(&k) {
        return "appearance";
    }
    if k.starts_with("holding_") {
        return "action";
    }
    if k.starts_with("looking_") {
        return "gaze";
    }
    if k == "blurry_background" || k == "blurry_foreground" {
        return "meta";
    }
    if k.ends_with("_background") {
        return "crop";
    }
    if matches!(k, "male_focus" | "female_focus" | "solo_focus") {
        return "count";
    }
    if k.ends_with("_focus") {
        return "crop";
    }
    if k.ends_with("_(medium)") {
        return "medium";
    }
    if k.starts_with("commentary") || k.ends_with("_commentary") {
        return "meta";
    }
    if k == "chaldea_logo" || k == "rhine_lab_logo" {
        return "appearance";
    }
    if ends_with_any(k, &["username", "logo", "watermark"]) || k == "copyright_notice" || k == "notice_lines" {
        return "meta";
    }
    if k.ends_with("_(blue_archive)") {
        return "meta";
    }
    if is_count_pattern(k) {
        return "count";
    }
    if ACTION.contains(&k) {
        return "action";
    }
    if ends_with_any(k, &["hair", "bangs", "eyes", "pupils", "iris", "skin", "ears", "horns", "tail", "wings", "breasts"])
        || ends_with_any(k, &["braid", "braids", "ponytail", "updo"])
    {
        return "body";
    }
    let last = k.rsplit('_').next().unwrap_or(k);
    if matches!(last, "flower" | "flowers" | "rose" | "roses") {
        return "scene";
    }
    if k == "fourth_wall" || k == "through_wall" {
        return "meta";
    }
    if ends_with_any(k, &["floor", "fence", "wall"]) {
        return "scene";
    }
    if k.starts_with("hair_") || k.starts_with("eyes_") {
        return "body";
    }
    for (name, set) in [
        ("body", BODY), ("count", COUNT), ("crop", CROP), ("angle", ANGLE), ("gaze", GAZE), ("medium", MEDIUM),
        ("meta", META), ("expression", EXPRESSION), ("action", ACTION), ("light", LIGHT), ("scene", SCENE),
    ] {
        if set.contains(&k) {
            return name;
        }
    }
    "appearance"
}

/// `2girls`, `6+boys`, `1other`.
fn is_count_pattern(k: &str) -> bool {
    let digits = k.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let rest = k[digits..].strip_prefix('+').unwrap_or(&k[digits..]);
    matches!(rest, "girl" | "girls" | "boy" | "boys" | "other" | "others")
}

/// Does this tag describe the character? (`appearance` or `body`.)
pub fn is_appearance_tag(tag: &str) -> bool {
    matches!(tag_facet(tag), "appearance" | "body")
}

/// Ears and tails that are a costume, judged from the whole list: Asuna's
/// `rabbit_ears` are her bunny suit's. Returns (kept, worn).
pub fn without_costume_body(tags: &[String]) -> (Vec<String>, Vec<String>) {
    let keys: Vec<String> = tags.iter().map(|t| key(t)).collect();
    let has = |k: &str| keys.iter().any(|x| x == k);
    let girls: Vec<&str> = keys
        .iter()
        .filter_map(|k| k.strip_suffix("_girl"))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase()))
        .collect();
    let headphones: Vec<&str> = keys
        .iter()
        .filter_map(|k| k.strip_suffix("_ear_headphones"))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase()))
        .collect();
    let bunny = has("playboy_bunny");
    let fake_ears = has("fake_animal_ears") || has("animal_ear_headphones") || !headphones.is_empty() || bunny;
    let fake_tail = has("fake_tail") || bunny;
    let species = |k: &str, part: &str| -> Option<String> {
        let s = k.strip_suffix(&format!("_{part}"))?;
        (!s.is_empty()
            && s.chars().all(|c| c.is_ascii_lowercase())
            && !["extra", "pointy", "long", "animal", "multiple", "fake"].contains(&s))
        .then(|| s.to_string())
    };
    let costume = |k: &str| {
        if let Some(ear) = species(k, "ears") {
            if !girls.contains(&ear.as_str()) && (fake_ears || headphones.contains(&ear.as_str()) || !girls.is_empty()) {
                return true;
            }
        }
        if let Some(tail) = species(k, "tail") {
            if fake_tail && !girls.contains(&tail.as_str()) && (tail == "rabbit" || has("fake_tail")) {
                return true;
            }
        }
        false
    };
    let mut worn: Vec<String> = keys.iter().filter(|k| costume(k)).cloned().collect();
    let real_ears = keys.iter().any(|k| species(k, "ears").is_some() && !worn.contains(k)) || !girls.is_empty();
    if !real_ears && fake_ears {
        for k in ["animal_ears", "animal_ear_fluff"] {
            if has(k) {
                worn.push(k.into());
            }
        }
    }
    let real_tail = keys.iter().any(|k| species(k, "tail").is_some() && !worn.contains(k)) || !girls.is_empty();
    if !real_tail && fake_tail && has("tail") {
        worn.push("tail".into());
    }
    let (mut kept, mut out) = (vec![], vec![]);
    for (tag, k) in tags.iter().zip(&keys) {
        if worn.contains(k) { out.push(tag.clone()) } else { kept.push(tag.clone()) }
    }
    (kept, out)
}

/// The canon a prompt may receive: what describes her, minus garments, props
/// and costume body parts. Returns (kept, withheld).
pub fn canon_traits(traits: &[String]) -> (Vec<String>, Vec<String>) {
    let about: Vec<String> = traits.iter().filter(|t| is_appearance_tag(t)).cloned().collect();
    let mut withheld: Vec<String> = traits.iter().filter(|t| !is_appearance_tag(t)).cloned().collect();
    let (body, costume) = without_costume_body(&about);
    let kept = body.iter().filter(|t| !is_garment(t) && !is_prop(t)).cloned().collect();
    withheld.extend(body.into_iter().filter(|t| is_garment(t) || is_prop(t)));
    withheld.extend(costume);
    (kept, withheld)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn garments_and_props_are_not_canon() {
        assert!(is_garment("white_dress") && is_garment("detached_sleeves") && is_garment("pleated skirt"));
        assert!(!is_garment("cross_halo") && !is_garment("ponytail") && !is_garment("hair_ribbon"));
        assert!(is_prop("staff") && is_prop("holding_staff") && !is_prop("chain_necklace") && !is_prop("glasses"));
    }

    #[test]
    fn facets_follow_the_families() {
        assert_eq!(tag_facet("green_eyes"), "body");
        assert_eq!(tag_facet("holding_staff"), "action");
        assert_eq!(tag_facet("looking_at_viewer"), "gaze");
        assert_eq!(tag_facet("2girls"), "count");
        assert_eq!(tag_facet("sunflower"), "scene");
        assert_eq!(tag_facet("yellow_flower"), "scene");
        assert_eq!(tag_facet("hair_flower"), "appearance");
        assert_eq!(tag_facet("between_breasts"), "action");
        assert_eq!(tag_facet("some_new_jacket_shape"), "appearance");
    }

    #[test]
    fn frieren_keeps_her_ears_loses_her_capelet_and_staff() {
        let (kept, withheld) = canon_traits(&s(&[
            "pointy_ears", "white_hair", "green_eyes", "twintails", "earrings", "capelet", "staff", "closed_mouth", "1girl",
        ]));
        assert_eq!(kept, s(&["pointy_ears", "white_hair", "green_eyes", "twintails", "earrings"]));
        assert!(withheld.contains(&"capelet".to_string()) && withheld.contains(&"staff".to_string()));
    }

    #[test]
    fn costume_ears_go_with_the_costume() {
        let (kept, worn) = without_costume_body(&s(&["rabbit_ears", "playboy_bunny", "blue_eyes", "rabbit_tail"]));
        assert_eq!(worn, s(&["rabbit_ears", "rabbit_tail"]));
        assert_eq!(kept, s(&["playboy_bunny", "blue_eyes"]));
        let (kept, _) = without_costume_body(&s(&["cat_ears", "cat_girl", "cat_tail"]));
        assert_eq!(kept.len(), 3);
    }
}
