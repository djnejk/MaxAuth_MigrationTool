# Data Migration

Use the separate **MaxAuth Migration Tool** to convert authentication accounts from **jPremium** or **MaxAuth BETA (0.9.x and older)** to MaxAuth 1.0.0 and newer. The server plugin does not import legacy rows itself.

## Download

- [MaxAuth Migration Tool repository](https://github.com/djnejk/MaxAuth_MigrationTool)
- [Download the latest release](https://github.com/djnejk/MaxAuth_MigrationTool/releases/latest)

## Supported migration paths

| Source | Usual source table | Destination |
| --- | --- | --- |
| jPremium | `user_profiles` | `<storageTablePrefix>accounts`, `<storageTablePrefix>identities`, `<storageTablePrefix>metadata` |
| MaxAuth BETA | `maxauth_users`, or the custom legacy `storageTableName` | `<storageTablePrefix>accounts`, `<storageTablePrefix>identities`, `<storageTablePrefix>metadata` |

The tool supports SQLite, MySQL, MariaDB, and PostgreSQL as a source and direct destination. It can also export a standalone SQL script for SQLite, MySQL/MariaDB, or PostgreSQL.

With the default `storageTablePrefix: 'maxauth_'`, the destination tables are:

- `maxauth_accounts`
- `maxauth_identities`
- `maxauth_metadata`

The target `accounts` table contains the reserved column `gender VARCHAR(32) NULL` between `pendingPremiumId` and `normalizedNickname`. The current MaxAuth version does not use it. The migration tool never reads, maps, or infers gender from legacy data; every migrated account receives `NULL`.

An existing target `accounts` table without this column is incompatible and the tool stops with an error. It does not alter or automatically upgrade old development target tables; use clean target tables.

The selected prefix must match `storageTablePrefix` in the new MaxAuth proxy configuration. It may contain only ASCII letters, numbers, and underscores and may be at most 36 characters long.

## What the tool preserves

For every compatible legacy row, the tool preserves the nickname, password hash, email address, 2FA verification token, session expiration, last server, first and last address, and first and last seen timestamps.

The conversion intentionally changes identity handling:

- Every imported account starts as `MIGRATED`, which has exactly the same authentication privileges as `CRACKED`.
- A legacy `premiumId` becomes a **pending Mojang claim**, never a trusted identity.
- A pending claim becomes trusted only after a reconnect proves the exact Mojang identity through the current online-mode flow.
- A stale or incorrect pending claim is removed when the nickname no longer resolves to that Mojang identity, and the player continues through the cracked flow.
- `lastServerRedirectionEnabled` starts as `false`; players can opt in later with `/maxauth lastserver` when `allowPlayerLastServerRedirection` is enabled.
- No Floodgate identity is inferred from a UUID or nickname. Bedrock identity is created only after current Floodgate API proof.
- A malformed or all-zero legacy backend UUID is deterministically replaced with a usable UUID and listed under UUID repairs in the preview.

Password hashes are copied without weakening or re-hashing them. MaxAuth verifies supported legacy hashes and, when `rehashPasswordWhenUsingDifferentAlgorithm` is enabled, upgrades a hash after the player's next successful password login.

## Before you begin

1. Stop every proxy and backend instance that can write authentication data.
2. Back up the complete legacy database and both plugin directories.
3. Restore the backup into an isolated staging environment.
4. Record the legacy row count and the configured database type, table name, and MaxAuth UUID mode.
5. Prepare the new MaxAuth configuration. Keep `storageTableName: ''` and set `storageTablePrefix` to the prefix you will select in the tool.
6. Do not expose the staging proxy to public traffic.

Never use the only copy of a production database as the first migration attempt.

## Running MaxAuth Migration Tool

1. Start **MaxAuth Migration Tool**.
2. Select `jPremium` or `MaxAuth BETA` as the legacy source.
3. Select the source database type and enter its connection details, or choose the SQLite file.
4. Click **Test connection and load tables**.
5. Select the compatible legacy table. The tool highlights `user_profiles` for jPremium and `maxauth_users` or another MaxAuth-looking table for MaxAuth BETA.
6. Choose **Write to database** for a direct migration or **Export SQL script** for a reviewed/manual import.
7. Enter the exact new table prefix used by `storageTablePrefix`. The default is `maxauth_`.
8. If the destination is different from the source database, enable **Migrate to a different server or database** and test that connection.
9. Click **Build preview**.
10. Review every count and expand **Skipped rows and UUID repairs**. Do not continue until each skipped row and repaired UUID is understood.
11. Confirm that a complete backup exists and all proxy instances are stopped.
12. Run the migration or save the SQL script.

The legacy source table is read-only: the tool does not rename or delete it. Direct account inserts and the completion marker are written transactionally. MySQL and MariaDB implicitly commit DDL, so empty destination tables can remain after a rolled-back import; restore or clean only the failed **destination**, never the only legacy source.

### SQL export warning

SQL export cannot inspect the database where the script will eventually run. Execute it only against an empty or already compatible MaxAuth target. Review the selected dialect, prefix, skipped-row report, and UUID-repair report before executing the script.

## Understanding the preview

- **Source rows**: rows read from the selected legacy table.
- **Will migrate**: rows that can be inserted into the destination.
- **Will skip**: invalid nicknames or rows colliding by normalized nickname, backend UUID, trusted Mojang identity, or pending Mojang claim.
- **UUID repairs**: malformed or all-zero backend UUIDs replaced by deterministic usable UUIDs.
- **Pending proof**: legacy premium IDs that require a fresh Mojang online-mode proof.

Skipped rows are not silently merged. Correct the source or migration plan offline, restore a clean destination backup, and repeat the preview. If a backend UUID changes, migrate UUID-keyed permissions, ranks, inventories, statistics, and playerdata in their owning plugins separately.

## Validation before production

1. Confirm the destination account count equals **Will migrate**, not necessarily **Source rows** when the preview contains skips.
2. Set the proxy `storageTablePrefix` to the migrated prefix and keep `storageTableName: ''`.
3. Start the new MaxAuth proxy and backends only in staging.
4. Run `/maxauth authaudit`; it must pass without an integrity issue.
5. Run `/maxauth pending list` and compare the result with **Pending proof**.
6. Test at least one migrated cracked account with its old password.
7. Test a migrated premium account with an official client and verify that it becomes trusted only after online proof.
8. Test an account whose old premium ID is stale and verify that it requires cracked authentication instead of receiving premium access.
9. Test every repaired UUID and migrate its external permissions/playerdata mapping before production.
10. Test new and existing Floodgate players separately; the migration does not create Floodgate identities.
11. Test session expiry, 2FA, email recovery, and last-server behavior if those fields were used previously.

Keep the network closed if the preview has unexplained skips, `/maxauth authaudit` fails, an expected password hash cannot be verified, or any UUID-owned external data is missing.

## Clearing the legacy warning

MaxAuth warns when `storageTableName` is non-empty or when the active database still contains the exact jPremium table `user_profiles`.

After staging validation and final acceptance:

1. Keep the immutable pre-migration backup.
2. Set `storageTableName: ''`.
3. If `user_profiles` is in the active destination database, archive it outside that database or rename/remove it only after confirming the external backup can be restored.
4. Restart MaxAuth and confirm that no legacy-data warning remains.
5. Run `/maxauth authaudit` once more.

Do not delete or rename the only legacy copy merely to hide a warning.

## Rollback

If validation fails, stop every writer and restore the pre-migration database, plugin directories, and previous proxy/backend jars as one coordinated unit. Do not combine restored legacy data with a partially populated new target. Preserve the tool preview, skipped-row list, UUID-repair mapping, SQL export, and logs for the next staging attempt.
