#!/usr/bin/env python3
"""Reviewable, pinned PromptForge data updates. No application/runtime updates."""
import argparse
import hashlib
import json
import pathlib
import re
import sqlite3
import sys
import time
import subprocess
import os
import shutil
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
UPSTREAM = "https://github.com/yoimtrashgaming-prog/PromptForge-Public"
SOURCES = {
    "randomizer.json": "config/randomizer.json",
    "tags.sqlite": "data/seed/tags.sqlite",
    "character_traits.sqlite": "data/seed/character_traits.sqlite",
}
FILES = ("forge-pack.json", *SOURCES)
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_file(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError(f"Not a regular bounded data file: {path.name}")
    data = path.read_bytes()
    if len(data) > limit:
        raise ValueError(f"Data file exceeds limit: {path.name}")
    return data


def database(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("PRAGMA query_only=ON")
    deadline = time.monotonic() + 30
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    return db


def validate_data(directory):
    manifest = json.loads(read_file(directory / "MANIFEST.json", 65536))
    if manifest.get("repository") != UPSTREAM or not SHA.fullmatch(str(manifest.get("commit", ""))):
        raise ValueError("Invalid source repository or full commit SHA")
    if set(manifest.get("files", {})) != set(FILES):
        raise ValueError("Manifest must contain exactly the four Forge data files")
    if "sourceLicenseSha256" in manifest and manifest["sourceLicenseSha256"] != sha256((ROOT / "LICENSE").read_bytes()):
        raise ValueError("Source license changed: manual review required")
    payload = {}
    for name in FILES:
        data = read_file(directory / name, 128 * 1024 * 1024 if name.endswith(".sqlite") else 4 * 1024 * 1024)
        entry = manifest["files"][name]
        if entry.get("bytes") != len(data) or entry.get("sha256") != sha256(data):
            raise ValueError(f"Manifest size/digest mismatch: {name}")
        if name in SOURCES and (entry.get("upstreamPath") != SOURCES[name] or not DIGEST.fullmatch(str(entry.get("upstreamSha256", "")))):
            raise ValueError(f"Missing upstream provenance: {name}")
        if name.endswith(".json"):
            payload[name] = json.loads(data)
    pack = payload["forge-pack.json"]
    if pack.get("source", {}).get("commit") != manifest["commit"]:
        raise ValueError("Pack and manifest source revisions differ")
    missing = sorted({"illustrious", "anima", "krea2", "moss"} - set(pack.get("models", {})))
    if missing:
        raise ValueError(f"Missing supported image-model writer(s): {missing}")
    for key in ("config", "defaults", "shared", "models"):
        if not isinstance(pack.get(key), dict):
            raise ValueError(f"Invalid Forge pack field: {key}")
    if not isinstance(pack.get("creativity_order"), list) or not pack["creativity_order"]:
        raise ValueError("Missing creativity presets")
    for model in pack["models"].values():
        if not isinstance(model.get("entry"), dict) or not isinstance(model.get("system"), str) or not model["system"].strip():
            raise ValueError("Invalid model entry/system prompt")
    if not isinstance(pack["shared"].get("chat"), str) or not pack["shared"]["chat"].strip():
        raise ValueError("Missing Chat system prompt")
    categories = payload["randomizer.json"].get("categories")
    if not isinstance(categories, list) or not categories:
        raise ValueError("Missing Randomizer categories")
    def category(item, depth=0):
        if depth > 3 or not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise ValueError("Invalid Randomizer category")
        for text in item.get("templates", []):
            if not isinstance(text, str):
                raise ValueError("Invalid Randomizer template")
        for child in item.get("children", []):
            category(child, depth + 1)
    for item in categories:
        category(item)
    counts = {}
    for name, table, required in [
        ("tags.sqlite", "tags", {"tag", "category", "post_count", "variant", "aliases"}),
        ("character_traits.sqlite", "characters", {"tag", "traits"}),
    ]:
        with database(directory / name) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError(f"SQLite integrity failure: {name}")
            if any(kind in ("view", "trigger") or (sql and "CREATE VIRTUAL" in sql.upper()) for kind, sql in db.execute("SELECT type,sql FROM sqlite_master")):
                raise ValueError(f"Unsupported active SQLite schema: {name}")
            cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
            if not required.issubset(cols):
                raise ValueError(f"SQLite schema incompatible with native reader: {name}")
            count = db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            if not 0 < count <= 2_000_000:
                raise ValueError(f"Invalid table row count: {name}")
            counts[table] = count
    return manifest, {"models": sorted(pack["models"]), "tagRows": counts["tags"], "characterRows": counts["characters"]}


def git(repo, *args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(["git", "-c", "credential.helper=", "-C", str(repo), *args], env=env, timeout=120, stderr=subprocess.PIPE)


def ensure_repo(repo, fetch):
    if not repo.exists():
        if not fetch:
            raise ValueError("Local upstream checkout missing; retry without --no-fetch")
        subprocess.run(["git", "-c", "credential.helper=", "clone", "--depth", "1", "--single-branch", UPSTREAM + ".git", str(repo)], check=True, timeout=180, stdout=sys.stderr)
    if git(repo, "remote", "get-url", "origin").decode().strip() not in (UPSTREAM, UPSTREAM + ".git"):
        raise ValueError("Local checkout origin is not the expected PromptForge repository")
    if fetch:
        git(repo, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
        clean = not git(repo, "status", "--porcelain").strip()
        branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD").decode().strip() if git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() != b"HEAD" else ""
        if clean and branch == "main":
            # Divergence is not permission to reset a user's local history.
            subprocess.run(["git", "-C", str(repo), "merge", "--ff-only", "refs/remotes/origin/main"], stdout=sys.stderr, stderr=sys.stderr, check=False, timeout=60)
    return git(repo, "rev-parse", "refs/remotes/origin/main").decode().strip()


def ensure_commit(repo, revision, fetch):
    if not SHA.fullmatch(revision):
        raise ValueError("Expected an exact full lowercase source commit SHA")
    try:
        git(repo, "cat-file", "-e", revision + "^{commit}")
    except subprocess.CalledProcessError:
        if not fetch:
            raise ValueError("Pinned source commit not available locally") from None
        git(repo, "fetch", "--no-tags", "origin", revision)
        git(repo, "cat-file", "-e", revision + "^{commit}")


def notices(repo, revision):
    names = git(repo, "ls-tree", "-r", "--name-only", revision).decode().splitlines()
    result = {}
    for name in names:
        if re.match(r"(?i)^(license|copying|notice)([.\-_]|$)", pathlib.PurePosixPath(name).name):
            result[name] = sha256(git(repo, "show", f"{revision}:{name}"))
    if "README.md" in names:
        readme = git(repo, "show", f"{revision}:README.md").decode()
        for section in re.split(r"(?m)^## ", readme)[1:]:
            heading = section.splitlines()[0].lower()
            if any(word in heading for word in ("license", "licence", "licensing", "what ships")):
                result["README.md#" + heading] = sha256(section.strip().encode())
    return result


def check_sources(repo, old, new, summary):
    changed = git(repo, "diff", "--name-only", old, new).decode().splitlines()
    relevant = [p for p in changed if p.startswith(("prompts/", "server/")) or p in (*SOURCES.values(), "config/models.yaml", "config/server.yaml", "LICENSE")]
    old_notices, new_notices = notices(repo, old), notices(repo, new)
    notice_changes = sorted(k for k in old_notices.keys() | new_notices.keys() if old_notices.get(k) != new_notices.get(k))
    return {"status": "review-required" if notice_changes else "available" if relevant else "current", "oldCommit": old, "newCommit": new, "changedFiles": relevant, "noticeChanges": notice_changes,
            "changes": {"modelsAdded": [], "modelsRemoved": [], "tagRows": {"old": summary["tagRows"], "new": None}, "characterRows": {"old": summary["characterRows"], "new": None}}}


def source_snapshot(repo, revision, work):
    listing = git(repo, "ls-tree", "-rl", revision).decode().splitlines()
    if len(listing) > 10000 or sum(int(line.split()[3]) for line in listing if line.split()[2] != "tree" and line.split()[3].isdigit()) > 512 * 1024 * 1024:
        raise ValueError("Upstream snapshot exceeds import limits")
    archive = work / "source.tar"
    git(repo, "archive", "--format=tar", "--output=" + str(archive), revision)
    source = work / "source"
    source.mkdir()
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 512 * 1024 * 1024:
            raise ValueError("Archive exceeds import limits")
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            if not (member.isfile() or member.isdir()) or path.is_absolute() or ".." in path.parts:
                raise ValueError("Upstream archive contains links, special files or unsafe paths")
        tar.extractall(source, filter="data")
    return source


def export_pack(source, revision, work):
    if sys.platform != "linux" or not shutil.which("bwrap"):
        raise ValueError("Export requires Linux with bubblewrap; use --check/--verify here or the Linux CI workflow. No unsandboxed fallback.")
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise ValueError("Node.js 22+ and npm are required for the development exporter")
    dependencies = ROOT / "tools/forge-export"
    # Only the trusted, locked YAML parser is installed; never upstream's package scripts.
    subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", str(dependencies)], check=True, timeout=120, stdout=sys.stderr)
    if (source / "node_modules").exists():
        raise ValueError("Upstream must not ship node_modules")
    (source / "node_modules").mkdir()
    command = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
               "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
               "--ro-bind", "/usr", "/usr", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc"]
    for path in ("/lib", "/lib64", "/bin"):
        if pathlib.Path(path).exists():
            command += ["--ro-bind", path, path]
    if pathlib.Path("/etc/ld.so.cache").exists():
        command += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    command += ["--ro-bind", str(pathlib.Path(node).resolve()), "/node", "--ro-bind", str(source), "/upstream",
                "--ro-bind", str(dependencies / "node_modules"), "/upstream/node_modules",
                "--ro-bind", str(ROOT / "tools/export-forge-pack.mjs"), "/export-forge-pack.mjs", "--chdir", "/upstream",
                "/node", "--max-old-space-size=256", "/export-forge-pack.mjs", "/upstream", revision]
    def limits():
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_AS, (8 * 1024 ** 3, 8 * 1024 ** 3))
    with (work / "export.json").open("wb") as output, (work / "export.log").open("wb") as errors:
        result = subprocess.run(command, stdout=output, stderr=errors, timeout=60, preexec_fn=limits)
    if result.returncode:
        detail = (work / "export.log").read_bytes()[:4096].decode(errors="replace")
        raise ValueError(f"Isolated exporter failed ({result.returncode}): {detail}")
    pack = json.loads(read_file(work / "export.json", 4 * 1024 * 1024))
    return (json.dumps(pack, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def replace_data(candidate, destination, original):
    # Same-filesystem directory swap with rollback; never partially replace a data set.
    lock = destination.parent / ".forge-data-update.lock"
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.close(fd)
        current, _ = validate_data(destination)
        if current != original:
            raise ValueError("Bundled data changed during preparation; refusing to overwrite it")
        with tempfile.TemporaryDirectory(prefix=".forge-data-", dir=destination.parent) as temp:
            new, backup = pathlib.Path(temp) / "new", pathlib.Path(temp) / "previous"
            shutil.copytree(destination, new)
            for name in (*FILES, "MANIFEST.json"):
                shutil.copyfile(candidate / name, new / name)
            os.replace(destination, backup)
            try:
                os.replace(new, destination)
            except OSError:
                try:
                    os.replace(backup, destination)
                except OSError:
                    # Both swaps failed: the temporary backup would otherwise vanish with the temp dir.
                    shutil.copytree(backup, destination)
                raise
    finally:
        lock.unlink()


def update_data(repo, revision, destination, original, summary, report):
    if sys.platform != "linux" or not shutil.which("bwrap"):
        raise ValueError("Export requires Linux/bubblewrap; no unsandboxed fallback")
    if destination.resolve() == (ROOT / "src-tauri/forge-data").resolve() and git(ROOT, "status", "--porcelain", "--", "src-tauri/forge-data").strip():
        raise ValueError("Bundled data has local changes; commit or review them before updating")
    with tempfile.TemporaryDirectory(prefix="deas-forge-import-") as temp:
        work = pathlib.Path(temp)
        source = source_snapshot(repo, revision, work)
        candidate = work / "candidate"
        candidate.mkdir()
        (candidate / "forge-pack.json").write_bytes(export_pack(source, revision, work))
        manifest = {"repository": UPSTREAM, "commit": revision, "sourceLicenseSha256": sha256(read_file(source / "LICENSE", 1024 * 1024)), "files": {}}
        for name, upstream in SOURCES.items():
            raw = read_file(source / upstream, 128 * 1024 * 1024)
            raw_digest = sha256(raw)
            out = candidate / name
            if name.endswith(".sqlite") and raw_digest != original["files"][name]["upstreamSha256"]:
                with database(source / upstream) as before, sqlite3.connect(out) as after:
                    before.backup(after)
                    after.execute("PRAGMA journal_mode=DELETE")
            else:
                out.write_bytes((destination / name).read_bytes() if name.endswith(".sqlite") else raw)
            manifest["files"][name] = {"upstreamPath": upstream, "upstreamSha256": raw_digest}
        for name in FILES:
            raw = (candidate / name).read_bytes()
            manifest["files"].setdefault(name, {}).update(sha256=sha256(raw), bytes=len(raw))
        (candidate / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
        _, new_summary = validate_data(candidate)
        old_pack = json.loads((destination / "forge-pack.json").read_bytes())
        new_pack = json.loads((candidate / "forge-pack.json").read_bytes())
        old_pack["source"].pop("commit", None)
        new_pack["source"].pop("commit", None)
        changed = [name for name in SOURCES if manifest["files"][name]["sha256"] != original["files"][name]["sha256"]]
        if old_pack != new_pack:
            changed.insert(0, "forge-pack.json")
        report["changes"] = {"modelsAdded": sorted(set(new_summary["models"]) - set(summary["models"])), "modelsRemoved": sorted(set(summary["models"]) - set(new_summary["models"])),
                             "tagRows": {"old": summary["tagRows"], "new": new_summary["tagRows"]}, "characterRows": {"old": summary["characterRows"], "new": new_summary["characterRows"]}}
        report.update(status="updated" if changed else "current", changedFiles=changed)
        if changed:
            replace_data(candidate, destination, original)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify", action="store_true", help="Validate bundled/candidate files without network or execution")
    mode.add_argument("--check", action="store_true", help="Check pinned source inputs; never execute upstream code or write data")
    mode.add_argument("--update", action="store_true", help="Prepare isolated candidate data, validate it and replace only substantive changes")
    parser.add_argument("--repo", type=pathlib.Path, default=ROOT.parent / "PromptForge-Public")
    parser.add_argument("--revision", help="Exact full source SHA; default is origin/main")
    parser.add_argument("--no-fetch", action="store_true", help="Use only existing local Git objects")
    parser.add_argument("--data-dir", type=pathlib.Path, default=ROOT / "src-tauri/forge-data")
    args = parser.parse_args()
    try:
        if args.revision and not SHA.fullmatch(args.revision):
            raise ValueError("Expected an exact full lowercase source commit SHA")
        manifest, summary = validate_data(args.data_dir)
        if args.verify:
            report = {"status": "verified", "newCommit": manifest["commit"], **summary}
        else:
            head = ensure_repo(args.repo, not args.no_fetch)
            revision = args.revision or head
            ensure_commit(args.repo, revision, not args.no_fetch)
            ensure_commit(args.repo, manifest["commit"], not args.no_fetch)
            report = check_sources(args.repo, manifest["commit"], revision, summary)
            if args.update:
                if report["status"] == "review-required":
                    print(json.dumps(report))
                    return 3
                if revision == manifest["commit"] or report["status"] == "available":
                    report = update_data(args.repo, revision, args.data_dir, manifest, summary, report)
        print(json.dumps(report))
        return 0
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
