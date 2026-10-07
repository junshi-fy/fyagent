# Retired Cloud Sync

WebDAV / S3 cloud sync, including automatic sync, is retired. The host has no
cloud sync commands, transport modules, workers, or database change listener.

## Legacy configuration preservation

- `AppSettings.webdav_sync`, `s3_sync`, and `webdav_backup` are opaque
  `Option<serde_json::Value>` values. Keep their existing camelCase JSON keys
  and `skip_serializing_if = "Option::is_none"` behavior.
- Never inspect, validate, normalize, migrate, clear, or use their contents.
  Ordinary settings serialization preserves existing JSON values unchanged.
- Frontend settings set all three fields to `None`. Settings saves always
  preserve the latest stored values and ignore renderer-supplied values.
- Do not remove database tables or change schema for this retirement.
- Legacy SQL sync helpers and skip/preserve sets in `database/backup.rs` remain
  under `#[cfg(test)]` solely for existing database regression coverage.
- Model pricing synchronization, local Skill synchronization, SQL import/export,
  and local backups remain owned by their existing modules.

## Required regression coverage

Rust settings tests cover unchanged JSON round trips, frontend omission,
missing/forged renderer values, and rejection of new legacy values.
`tests/architecture/rustModuleBoundaries.test.ts` guards module and hook removal;
`tests/renderer/platform/tauriAclContract.test.ts` guards command/ACL removal.
