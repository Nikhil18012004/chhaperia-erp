# Moving from SQLite to MySQL 8.4

The backend now talks to MySQL 8.4 LTS. `database/schema.mysql.sql` is the
live schema; `database/schema.sql` is the old SQLite one, kept so the
migration below always has its reference.

## Configuration (environment)

| Variable | Meaning | Default |
|---|---|---|
| `CHHAPERIA_DB_HOST` | MySQL host | `127.0.0.1` |
| `CHHAPERIA_DB_PORT` | MySQL port | `3306` |
| `CHHAPERIA_DB_USER` | account to connect as | *(required)* |
| `CHHAPERIA_DB_PASSWORD` | its password | *(required in production)* |
| `CHHAPERIA_DB_NAME` | database name | `chhaperia_erp` |
| `CHHAPERIA_DB_SSL` | `true` to require TLS | off |
| `CHHAPERIA_DB_SSL_CA` | path to a private CA bundle | — |
| `CHHAPERIA_DB_URL` | a full `mysql://user:pass@host:port/db` URL — overrides all of the above; TLS on unless `?ssl=false` | — |

Production refuses to start with an empty password, or unencrypted to a
remote host. The account needs ALL PRIVILEGES on its own database only —
never use root.

    CREATE USER 'chhaperia'@'%' IDENTIFIED BY '<a real password>';
    GRANT ALL PRIVILEGES ON chhaperia_erp.* TO 'chhaperia'@'%';

## Carrying the old data across

One command, after the backend has been started once (so the schema exists):

    node tools/migrate-sqlite-to-mysql.js            # add --dry-run to rehearse

It copies every table row-for-row out of `data/chhaperia.db` (override with
`CHHAPERIA_SQLITE_FILE`), refuses to run into a database that already holds
rows (`--force` overrides), validates every JSON document on the way through,
and verifies the row counts at the end. User accounts and password hashes
travel with it — people sign in exactly as before.

## Tests

`npm test` needs a reachable MySQL and the same env vars. Each run creates
its own scratch database (`chh_smoke_*` / `chh_http_*`) and drops it after,
so the test account needs rights on those name patterns too:

    GRANT ALL PRIVILEGES ON `chh_smoke_%`.* TO 'chhaperia'@'%';
    GRANT ALL PRIVILEGES ON `chh_http_%`.* TO 'chhaperia'@'%';
