# EG-Desk command gate hook (prototype, c13)

Not installed anywhere, and nothing in EG-Desk installs it. `hooks.prototype.json` has the shape of the official hooks file
(https://learn.chatgpt.com/docs/hooks, "Config shape"); `../egdesk-codex-gate-hook.mjs` is the command it would run. Codex
loads hooks from `/etc/codex/hooks.json`, `$CODEX_HOME/hooks.json`, a trusted project's `.codex/hooks.json` or `[hooks]` in
`config.toml`, and runs a non-managed hook only after the person reviewed and trusted it (`/hooks`, hash-pinned). Where it would
live, and whether EG-Desk may ever write it, is an owner decision (see reports/l5-c13.md).
