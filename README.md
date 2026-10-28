# MaxAuth Migration Tool

Cross-platform migration tool for converting authentication data from **jPremium** or **MaxAuth BETA** to **MaxAuth 1.0.0 and newer**.

Supported databases:

- SQLite
- MySQL
- MariaDB
- PostgreSQL

The application can migrate data directly to a database or export a standalone SQL script.

Release downloads are available for Windows as a portable `.exe` and for Linux as `.AppImage`, `.deb`, and `.tar.gz` packages.

On Linux, make the AppImage executable before starting it:

```bash
chmod +x MaxAuth-Migration-Tool-*-linux-x86_64.AppImage
./MaxAuth-Migration-Tool-*-linux-x86_64.AppImage
```

Install the Debian/Ubuntu package with `sudo apt install ./MaxAuth-Migration-Tool-*-linux-amd64.deb`. The `.tar.gz` archive can be extracted and started directly without installation.

## Documentation

- [Data Migration](https://github.com/djnejk/MaxAuth_public/wiki/02-%7C-Data-Migration)
- [Migrace dat – česká verze](https://github.com/djnejk/MaxAuth_public/wiki/CZ_02-%7C-Migrace-dat)

Read the documentation and create a complete database backup before starting a migration.
