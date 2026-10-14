# MaxAuth Migration Tool

Portable migration tool for converting authentication data from **jPremium** or **MaxAuth BETA** to **MaxAuth 1.0.0 and newer**.

Supported databases:

- SQLite
- MySQL
- MariaDB
- PostgreSQL

The application can migrate data directly to a database or export a standalone SQL script.

The target `accounts` table includes the reserved nullable column `gender VARCHAR(32)`. Legacy data is never mapped or inferred into this column; every migrated account stores `NULL`.

## Documentation

- [Data Migration](https://github.com/djnejk/MaxAuth_public/wiki/Data-Migration)
- [Migrace dat – česká verze](https://github.com/djnejk/MaxAuth_public/wiki/Migrace-dat-%28CZ%29)

Read the documentation and create a complete database backup before starting a migration.
