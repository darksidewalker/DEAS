#!/usr/bin/python
"""Linux-only WebKitGTK regression probe (not DEAS UI/Windows acceptance).

/usr/bin/python tools/verify_video_playback.py MEDIA_DIR OUTPUT_DIR --generate
Omit --generate to replay the same fixtures after a plugin fix. Output must be empty.
Uses only stdlib, installed ffmpeg/ffprobe and system PyGObject GTK3/WebKit2 4.1.
"""
import argparse
import base64
import hashlib
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import time


if sys.platform != 'linux':
    sys.exit('Linux-only WebKitGTK playback diagnostic; not Windows acceptance.')

FORMATS = [
    ("h264", "mp4", "libx264", "aac"),
    ("h264", "mkv", "libx264", "aac"),
    ("hevc", "mkv", "libx265", "aac"),
    ("vp8", "webm", "libvpx", "libopus"),
    ("vp9", "webm", "libvpx-vp9", "libopus"),
    ("av1", "mp4", "libaom-av1", "aac"),
    ("av1", "webm", "libaom-av1", "libopus"),
]

JS = r"""
(async () => {
 const v = document.querySelector('video'), samples = [], events = [];
 const send = x => window.webkit.messageHandlers.result.postMessage(JSON.stringify(x));
 const fail = text => { throw new Error(text); };
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 const until = async (test, label) => {
   const start = performance.now();
   while (!test()) {
     if (v.error) fail('MediaError ' + v.error.code + ': ' + v.error.message);
     if (performance.now() - start > 5000) fail('timeout: ' + label);
     await sleep(40);
   }
 };
 let blob;
 const snapshot = label => {
   const q = v.getVideoPlaybackQuality?.();
   const s = {label, time:v.currentTime, width:v.videoWidth, height:v.videoHeight,
     frames:q?.totalVideoFrames ?? null, audioTracks:v.audioTracks?.length ?? null,
     readyState:v.readyState};
   try {
     const c = document.createElement('canvas'); c.width=32; c.height=24;
     const ctx = c.getContext('2d', {willReadFrequently:true}); ctx.drawImage(v,0,0,32,24);
     const p = ctx.getImageData(0,0,32,24).data;
     let hash=2166136261, lo=255, hi=0;
     for(let i=0;i<p.length;i++) if(i%4!==3) {
       hash=Math.imul(hash^p[i],16777619); lo=Math.min(lo,p[i]); hi=Math.max(hi,p[i]);
     }
     s.pixels={hash:hash>>>0, range:hi-lo};
   } catch(e) { s.canvasError=String(e); }
   samples.push(s); return s;
 };
 const advance = async label => {
   await v.play();
   await until(() => v.readyState>=2 && v.videoWidth>0 && v.currentTime>0.08, label+' initial');
   const a=snapshot(label+' start');
   await until(() => v.currentTime>a.time+0.35, label+' advancing');
   const b=snapshot(label+' advanced');
   if(!b.width || !b.height) fail('no decoded dimensions');
   if(a.frames!==null && b.frames!==null && b.frames>a.frames) {
     b.decodedFrameAdvance=b.frames-a.frames;
   } else if(!(a.pixels && b.pixels && a.pixels.hash!==b.pixels.hash)) {
     fail('time advanced without decoded-frame or changing-pixel evidence');
   }
   if(b.pixels && (!b.pixels.range || a.pixels.hash===b.pixels.hash)) fail('blank/frozen canvas');
   v.pause();
 };
 const seek = async (target,label) => {
   v.currentTime=target;
   await until(() => !v.seeking && Math.abs(v.currentTime-target)<0.18 && v.readyState>=2,label);
   snapshot(label);
 };
 for(const name of ['error','stalled','waiting','ended','seeked'])
   v.addEventListener(name,()=>{ if(events.length<80) events.push({event:name,time:v.currentTime,
     error:v.error ? {code:v.error.code,message:v.error.message}:null}); });
 try {
   const bytes=Uint8Array.from(atob(PAYLOAD), c=>c.charCodeAt(0));
   blob=URL.createObjectURL(new Blob([bytes],{type:MIME})); v.src=blob;
   if(CORRUPT) {
     const start=performance.now();
     while(!v.error && performance.now()-start<5000) await sleep(50);
     if(!v.error) fail('corrupt input did not produce MediaError');
     send({status:'pass',corruptError:{code:v.error.code,message:v.error.message},events}); return;
   }
   await advance('initial');
   if(!Number.isFinite(v.duration) || v.duration<2 || v.duration>3.5) fail('invalid fixture duration');
   await seek(v.duration/2,'middle seek'); await advance('middle');
   await seek(v.duration-0.35,'near EOF seek'); await v.play();
   await until(()=>v.ended,'EOF'); snapshot('ended');
   v.removeAttribute('src'); v.load(); URL.revokeObjectURL(blob);
   blob=URL.createObjectURL(new Blob([bytes],{type:MIME})); v.src=blob;
   await advance('reopen');
   send({status:'pass',samples,events,audibleAudio:'unverified'});
 } catch(e) { send({status:'fail',error:String(e),samples,events}); }
 finally {v.pause();v.removeAttribute('src');v.load();if(blob) URL.revokeObjectURL(blob);}
})();
"""


def worker(path):
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2

    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler("result")
    policies = WebKit2.WebsitePolicies(autoplay=WebKit2.AutoplayPolicy.ALLOW)
    view = WebKit2.WebView(user_content_manager=manager, website_policies=policies)
    view.get_settings().set_property("media-playback-requires-user-gesture", False)
    window = Gtk.Window()
    window.set_default_size(400, 300)
    window.add(view)
    result = {"status": "fail", "error": "worker exited without result"}

    def finish(value):
        nonlocal result
        result = value
        result["webkitVersion"] = ".".join(str(getter()) for getter in (
            WebKit2.get_major_version, WebKit2.get_minor_version, WebKit2.get_micro_version))
        Gtk.main_quit()

    manager.connect("script-message-received::result", lambda _, value:
                    finish(json.loads(value.get_js_value().to_string())))
    view.connect("web-process-terminated", lambda _, reason:
                 finish({"status": "fail", "error": "web-process-terminated", "reason": str(reason)}))
    view.connect("load-failed", lambda _, event, uri, error:
                 finish({"status": "fail", "error": "load-failed: " + str(error)}) or True)
    GLib.timeout_add_seconds(24, lambda: finish({"status": "fail", "error": "worker timeout"}) or False)
    mime = {"mp4": "video/mp4", "mkv": "video/x-matroska", "webm": "video/webm"}[path.suffix[1:]]
    script = JS.replace("PAYLOAD", json.dumps(base64.b64encode(path.read_bytes()).decode()))
    script = script.replace("MIME", json.dumps(mime)).replace("CORRUPT", str(path.name == "corrupt.mp4").lower())
    window.show_all()
    view.load_html('<!doctype html><video playsinline width="320" height="240"></video><script>' + script + '</script>', "file:///")
    Gtk.main()
    window.destroy()
    print("DEAS_RESULT=" + json.dumps(result), flush=True)
    return 0 if result["status"] == "pass" else 1


def fixtures():
    for codec, ext, encoder, audio_encoder in FORMATS:
        for audio in (False, True):
            yield f"{codec}-{'audio' if audio else 'silent'}.{ext}", encoder, audio_encoder, audio


def generate(media):
    media.mkdir(parents=True, exist_ok=True)
    names = [name for name, *_ in fixtures()] + ["corrupt.mp4"]
    if any((media / name).exists() for name in names):
        raise ValueError("--generate refuses to overwrite any existing fixture; omit it to replay")
    for name, encoder, audio_encoder, audio in fixtures():
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
               "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24"]
        if audio:
            cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
        cmd += ["-t", "2.5", "-map", "0:v", "-c:v", encoder, "-threads", "1", "-pix_fmt", "yuv420p", "-g", "12"]
        if encoder == "libx265":
            cmd += ["-preset", "ultrafast", "-x265-params", "pools=none:frame-threads=1:log-level=error"]
        elif encoder == "libx264":
            cmd += ["-preset", "ultrafast"]
        else:
            cmd += ["-cpu-used", "8", "-b:v", "160k"]
        cmd += ["-map", "1:a", "-c:a", audio_encoder, "-b:a", "48k"] if audio else ["-an"]
        if name.endswith("mp4"):
            cmd += ["-movflags", "+faststart"]
        subprocess.run(cmd + [str(media / name)], check=True, timeout=45)
    (media / "corrupt.mp4").write_bytes(b"DEAS corrupt video fixture\x00" * 64)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--generate", action="store_true")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        return worker(args.worker)
    media, output = args.media_dir.resolve(), args.output_dir.resolve()
    if output == media or media in output.parents or output in media.parents:
        parser.error("media and output must be separate, non-nested directories")
    if output.exists() and any(output.iterdir()):
        parser.error("output directory must be empty (reports are never overwritten)")
    output.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(GDK_BACKEND="x11", WEBKIT_DISABLE_DMABUF_RENDERER="1", LIBGL_ALWAYS_SOFTWARE="1")
    env.setdefault("GST_PLUGIN_PATH", str(Path(__file__).resolve().parents[1] / "src-tauri/gstreamer"))
    if Path("/sys/module/nvidia").exists() or Path("/proc/driver/nvidia").exists():
        env["WEBKIT_GST_DMABUF_SINK_DISABLED"] = "1"
    report = {"environment": {k: env.get(k) for k in (
        "DISPLAY", "GDK_BACKEND", "GST_PLUGIN_PATH", "LD_LIBRARY_PATH", "WEBKIT_GST_DMABUF_SINK_DISABLED",
        "WEBKIT_DISABLE_DMABUF_RENDERER", "LIBGL_ALWAYS_SOFTWARE")},
        "limits": ["X11 software renderer; not production Wayland/GPU-renderer acceptance",
                   "Audio streams/properties recorded; actual audible output unverified",
                   "Linux WebKitGTK only; not live DEAS UI or Windows WebView2"], "results": []}
    report["pluginHashes"] = {
        str(plugin): hashlib.sha256(plugin.read_bytes()).hexdigest()
        for directory in env["GST_PLUGIN_PATH"].split(os.pathsep)
        for plugin in sorted(Path(directory).glob("*.so")) if directory
    }
    for command in (["ffmpeg", "-version"], ["gst-inspect-1.0", "--version"]):
        version = subprocess.run(command, capture_output=True, text=True, timeout=10)
        report[command[0] + "Version"] = version.stdout.splitlines()[:3]
    if args.generate:
        generate(media)
    for name in [name for name, *_ in fixtures()] + ["corrupt.mp4"]:
        path = media / name
        item = {"file": str(path), "status": "fail"}
        start = time.monotonic()
        try:
            if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("fixture missing or exceeds 8 MiB bound")
            if name != "corrupt.mp4":
                probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format",
                                        "-of", "json", str(path)], capture_output=True, text=True,
                                       timeout=10, check=True)
                item["metadata"] = json.loads(probe.stdout)
            command = [sys.executable, str(Path(__file__).resolve()), str(media), str(output), "--worker", str(path)]
            proc = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, start_new_session=True)
            try:
                stdout, stderr = proc.communicate(timeout=28)
            except subprocess.TimeoutExpired:
                item['error'] = 'worker process-group timeout'
                os.killpg(proc.pid, signal.SIGKILL)
                stdout, stderr = proc.communicate()
            finally:
                # WebKit children must not outlive this owned fixture worker, even on failure.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            (output / (name + ".stderr.log")).write_text(stderr, encoding='utf-8')
            messages = [line.removeprefix("DEAS_RESULT=") for line in stdout.splitlines()
                        if line.startswith("DEAS_RESULT=")]
            if messages:
                item.update(json.loads(messages[-1]))
            else:
                item.setdefault("error", "no result; worker returncode=" + str(proc.returncode))
            item["returncode"] = proc.returncode
            if proc.returncode != 0:
                item["status"] = "fail"
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            item["error"] = str(exc)
        item["seconds"] = round(time.monotonic() - start, 3)
        report["results"].append(item)
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(f"{name}: {item['status']} {item.get('error', '')}", flush=True)
    assert len(report["results"]) == 15 and len({r["file"] for r in report["results"]}) == 15
    print("Report:", output / "report.json")
    return int(any(r["status"] != "pass" for r in report["results"]))


if __name__ == "__main__":
    raise SystemExit(main())
