# Running the ERP on the factory machine

One script, run once:

```
powershell -ExecutionPolicy Bypass -File deploy\local\setup-windows.ps1 -OpenFirewall -AutoStart
```

(`-OpenFirewall` needs an administrator window; leave it off and the ERP is
reachable on that machine only. `-AutoStart` makes it come back every time you
log in — worth having if a terminal window keeps getting closed.)

It checks Node and MySQL, creates this project's database and an account
fenced to it, writes `.env`, installs the dependencies, and starts the server.
Running it again is safe: it keeps the password and the token secret already
in `.env` rather than rotating them, which would lock the plant out of its own
database and log everyone out.

Day to day, `deploy\local\start-erp.cmd` is a double-clickable start — pin a
shortcut to the desktop. Closing its window stops the ERP.

## Why this machine and not a cloud server

Two features run on the server's **own Windows desktop**:

- **BarTender labels** — `backend/src/services/bartenderService.js` launches
  `bartend.exe` with the operator's `.btw` template.
- **The TDS booklet** — `tdsService.js` converts Word → PDF through Word
  itself, and answers *"Word is not available on this server"* on anything
  that is not Windows.

Host the ERP on Linux or in the cloud and both stop working — silently, in the
TDS case. Moving it off this machine is a project (browser-side printing, or a
small Windows agent at the plant that the server talks to), not a config
change. Until that exists, the server belongs where BarTender and Word are.

That is also why `-AutoStart` registers a task at **logon** rather than at
boot. A task started at boot runs in session 0, which has no desktop, so
BarTender's window would open where nobody can see it.

## What it deliberately does not do

- **It never writes the MySQL root password anywhere.** It is typed once, held
  in memory for the three statements that need it, and wiped.
- **The account it creates cannot leave this project.** `chhaperia_erp` plus
  the two scratch schemas the test suite uses, and nothing else on the server —
  so a misconfigured `CHHAPERIA_DB_NAME` is refused by MySQL itself, not just
  by the application's own guard.
- **`.env` is locked to the account that ran the script** (`icacls`), because
  it holds the database password and the token-signing secret.
- **The firewall rule is private and domain networks only** — the office LAN,
  never a public hotspot.

## The two things to do the day it goes live

1. **Change the eight seeded passwords.** They start as `<username>@123`.
2. **Give this machine a fixed IP** (or a DHCP reservation). The address goes
   into every tablet and phone; when it moves, they all stop working.
