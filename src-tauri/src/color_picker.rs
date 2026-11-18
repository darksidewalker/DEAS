// Screen colour pipette. Linux uses the consent-based xdg-desktop-portal PickColor
// (returns only the picked RGB; no screenshot is captured or stored).
// WebView2/Chromium uses the browser EyeDropper API in the frontend instead.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn native_pick_screen_color() -> Result<String, String> {
    use futures_util::StreamExt;
    use std::collections::HashMap;
    use std::time::Duration;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Structure};
    let conn = zbus::Connection::session()
        .await
        .map_err(|e| format!("Portal session bus: {e}"))?;
    let portal = zbus::Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .await
    .map_err(|e| format!("Portal proxy: {e}"))?;
    let path: OwnedObjectPath = portal
        .call("PickColor", &("", &HashMap::<String, OwnedValue>::new()))
        .await
        .map_err(|e| format!("PickColor request: {e}"))?;
    let request = zbus::Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        path.into_inner().clone(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|e| format!("Request proxy: {e}"))?;
    let mut signals = request
        .receive_signal("Response")
        .await
        .map_err(|e| e.to_string())?;
    let (code, results) = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(signal) = signals.next().await {
            if signal.header().sender().map(|s| s.as_str())
                == Some("org.freedesktop.portal.Desktop")
            {
                let (code, results): (u32, HashMap<String, OwnedValue>) =
                    signal.body().deserialize().map_err(|e| e.to_string())?;
                return Ok((code, results));
            }
        }
        Err("Request stream ended".to_string())
    })
    .await
    .map_err(|_| "Colour picker timed out".to_string())??;
    if code != 0 {
        return Err("Colour pick cancelled".into());
    }
    let rgb = results.get("rgb").ok_or("PickColor response missing rgb")?;
    let triple = rgb.downcast_ref::<Structure>().map_err(|e| e.to_string())?;
    let channel = |i: usize| -> Result<u8, String> {
        let value = triple.fields().get(i).ok_or("missing rgb channel")?;
        let number: u32 = value.downcast_ref::<u32>().map_err(|e| e.to_string())?;
        u8::try_from(number).map_err(|_| "rgb channel out of range".to_string())
    };
    Ok(format!(
        "#{:02x}{:02x}{:02x}",
        channel(0)?,
        channel(1)?,
        channel(2)?
    ))
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn native_pick_screen_color() -> Result<String, String> {
    // shortcut: no portal on this platform; the frontend EyeDropper path covers WebView2.
    Err("This runtime has no screen eyedropper".into())
}
