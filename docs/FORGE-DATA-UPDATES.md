# Updating bundled PromptForge data

[Documentation index](README.md) · [Prompting](PROMPTING.md) · [Credits and upstream notices](CREDITS.md)

This is a maintainer/development operation, not a DEAS runtime updater. DEAS continues to use its bundled data until a reviewed update is merged and a new application is built. No automatic merge, installed-source update or background application download is added.

## Source and prerequisites

The only upstream is [yoimtrashgaming-prog/PromptForge-Public](https://github.com/yoimtrashgaming-prog/PromptForge-Public). The initial bundled revision is `29a37c4e43f144f6ff4c0bc8c02f96b440b64826`; the current accepted revision is recorded in `src-tauri/forge-data/MANIFEST.json`.

Use Python 3 and Git. Export/update additionally requires Linux, working user namespaces, Bubblewrap (`bwrap`), system Node.js/npm, and the locked YAML export dependency:

```sh
npm ci --ignore-scripts --prefix tools/forge-export
```

The small Python/Node tooling is a development-only adapter for exporting the upstream format; it is not a new application service. `--check` and `--verify` work on Windows without executing upstream loaders. `--update` fails closed outside Linux or when its Bubblewrap sandbox cannot start; there is no unsandboxed fallback. On Windows, prepare the update in Linux/WSL with working Bubblewrap, then review the resulting data-only diff.

## Local checkout and commands

From the DEAS repository root, create a separate sibling checkout once:

```sh
git clone https://github.com/yoimtrashgaming-prog/PromptForge-Public ../PromptForge-Public
python tools/update-forge-data.py --check
python tools/update-forge-data.py --update
python tools/update-forge-data.py --verify
```

The default source path is sibling `../PromptForge-Public`; use `--repo PATH` for another local checkout. The updater must not reset, clean, switch or overwrite local source edits. Commit/stash your changes yourself or use a separate clean checkout if source validation refuses to proceed. Export uses a read-only snapshot of the selected Git revision, not writable access to your working tree.

By default the updater fetches the fixed upstream's `main` and selects its resolved full commit. To reproduce a reviewed commit, supply `--revision FULL_SHA` with a full 40-character Git SHA. To work offline, add `--no-fetch` and ensure the required revision is already available locally. For example, reproducing the initial revision, if it is present locally:

```sh
python tools/update-forge-data.py --check --repo ../PromptForge-Public --revision 29a37c4e43f144f6ff4c0bc8c02f96b440b64826 --no-fetch
python tools/update-forge-data.py --update --repo ../PromptForge-Public --revision 29a37c4e43f144f6ff4c0bc8c02f96b440b64826 --no-fetch
```

`--check` performs no data writes and executes no upstream loader; its fetch may update Git objects/remote references unless `--no-fetch` is used. It reports commit availability, not proof that exported content differs. `--update` exports and validates before replacing the bundled data. An upstream commit with identical substantive content is a no-op: a changed `source.commit` field alone must not churn the data or open a PR.

`--verify` validates an existing candidate without fetching or exporting. The default target is `src-tauri/forge-data`; a downloaded candidate can be checked separately:

```sh
python tools/update-forge-data.py --verify --data-dir /path/to/forge-data-candidate
```

All modes emit a JSON report on stdout. Relevant fields are `status`, `oldCommit`, `newCommit`, `changedFiles`, and `changes` (added/removed models and old/new tag/character row counts). Keep this report separate from the five-file data directory. Reports distinguish `current`, `available`, `updated`, `review-required`, `verified` and `error`.

| Mode | Exit status |
| --- | --- |
| `--check` | `0` for current or available; `1` on error |
| `--update` | `0` for current/no-op or updated; `3` for license/notice review required; `1` on error |
| `--verify` | `0` for verified; `1` on error |

A revision that predates a supported image model fails closed with `Missing supported image-model writer(s): ['moss']` instead of crashing the exporter; DEAS still requires Illustrious, Anima, Krea2 and MOSS in the pack.

## Export and review boundaries

The exporter is run under Bubblewrap with all namespaces unshared, no network, no host credentials, read-only source/dependency snapshots and a bounded writable output area. Installing dependencies uses the committed lockfile and `--ignore-scripts`, not upstream lifecycle scripts. Network acquisition and dependency installation are separate from executing upstream code. Sandbox failures are errors, not permission to run the loader directly.

The only update targets are:

- `src-tauri/forge-data/forge-pack.json`
- `src-tauri/forge-data/randomizer.json`
- `src-tauri/forge-data/tags.sqlite`
- `src-tauri/forge-data/character_traits.sqlite`
- `src-tauri/forge-data/MANIFEST.json`

The manifest records the selected source commit, `sourceLicenseSha256`, and file sizes/SHA-256 digests. Review the JSON report and manifest, model additions/removals, database schema/integrity and row counts, and applicable redistribution/attribution requirements. Run the updater fixtures:

```sh
python -m unittest discover -s tools/tests -p 'test_forge_data*.py'
```

A changed source license or required notice stops `--update` with `review-required` / exit `3` before publication. Do not bypass this by editing manifest hashes or suppressing the exit status. A maintainer must inspect the exact upstream license/notice diff, establish continuing redistribution permission, and make any approved attribution/baseline changes in a separate reviewed change before retrying. There is no automatic license acceptance switch.

## Weekly pull-request workflow

[Update Forge data](../.github/workflows/update-forge-data.yml) defines a Monday 06:23 UTC schedule and manual `workflow_dispatch`, restricted to `main`. Repository Actions are enabled (`gh api repos/OWNER/REPO/actions/permissions` reports `enabled: true`), and both workflows are `active`. Hosted jobs are currently **blocked before start** by account billing/spending limit (annotation: "recent account payments have failed or your spending limit needs to be increased"), which also blocks the existing Verify/Release workflows since 19 Oct. Fix billing or raise the spending limit before expecting green hosted runs; a blocked job has no steps and no logs.

The two jobs run on separate hosted runners:

1. **Import:** `contents: read`, no write token, no custom secrets, checkout credentials not persisted. It installs the locked export dependency without scripts, runs updater fixtures, clones the fixed upstream and imports through the updater's sandbox. Ubuntu's hosted-runner AppArmor user-namespace restriction is relaxed solely on this disposable runner so Bubblewrap can create its namespaces; export itself remains isolated. Trusted Python parses the redirected JSON report and emits only a literal `updated=true/false`. Only `updated` uploads the exact five-file candidate; the report is a separate artifact. Exit `3` fails the job for manual review, and same-content no-ops skip publication.
2. **Publish:** a fresh checkout of the same trusted DEAS commit; only this job receives `contents: write` and `pull-requests: write`. It downloads the candidate outside the checkout, rejects unexpected names/non-regular files, and runs the checked-out trusted `--verify --data-dir ...` without network/export. It never runs code from the artifact or upstream. It copies only the five literal filenames and supplies the same exact allowlist to the PR action.

Publication uses dedicated branch `bot/update-forge-data` and creates/updates one review PR against `main`. Do not use that bot branch for manual work: later updates may replace its contents. No merge action or auto-merge setting is configured. The PR action is pinned to `peter-evans/create-pull-request` **v8.1.1**, commit `5f6978faf089d4d20b00c7766989d076bb2fc7f1`; its action inputs and branch/PR implementation were reviewed for this use. Built-in actions follow the repository's existing version conventions. Treat future action-pin upgrades as reviewed dependency changes, not floating updates.

Before enabling, a maintainer may need to allow Actions under repository/organization policy, permit the pinned action, grant the publish job its declared permissions, and enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. This workflow needs PR creation, not automatic approval. Branch protection and required manual review must remain in place. No PAT or new secret is required.

PRs created with `GITHUB_TOKEN` do **not** automatically trigger the existing push/PR verification workflows. Before manual merge, explicitly run the existing **Verify DEAS** workflow on the candidate PR branch/head (when Actions is enabled), or supply equivalent full local verification evidence. The importer performs JSON/schema, digest, SQLite and updater-fixture checks through the updater; it deliberately does not install the full native WebKit build stack. Those checks do not replace native fixtures/build verification and human review. With Actions disabled, use the local commands and normal manual review process instead.

No workflow was triggered or repository Actions setting changed as part of adding this workflow.
