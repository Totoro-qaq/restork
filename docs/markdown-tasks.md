# Markdown tasks

Markdown checkboxes remain the only canonical user task state. Start Core with an explicit Vault:

```bash
uv run restork --vault-dir /path/to/vault serve
```

The Dashboard scans supported Markdown files but owns no task database. A checkbox change or quick
capture first creates a short-lived exact preview bound to the source content hash, canonical note,
policy version, action digest, expiry, and single-use local-write approval. Approval and apply then:

1. rescan the current Markdown source;
2. reject a stale hash or changed task locator;
3. consume the exact approval capability once;
4. journal and atomically replace one file on the same filesystem;
5. validate the postimage hash and rescan the board.

Restork-created tasks use the public grammar documented in the V1 specification:

```markdown
- [ ] Implement a local Dashboard #todo [due:: 2026-08-15] [priority:: P1] [project:: [[Restork]]] [source:: restork:run/example] ^restork-example
```

The default quick-capture inbox is `Tasks.md` within the configured Vault. It must already exist in
V1. Radar `make task` produces the same preview and never writes immediately.
