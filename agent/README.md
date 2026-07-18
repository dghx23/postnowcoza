# PostNow Linux Print Agent

An alternative to Epson Connect for printing dispatch documents: a small
unattended script that runs on any Ubuntu (or other Linux) machine with a
CUPS-configured printer attached, polls PostNow for print jobs, and prints
them locally. Switch to it from `/printer` in the staff app (**Printing
Method → Linux Print Agent**).

Unlike Epson Connect, this works with **any printer CUPS supports** - not
just Epson devices - and doesn't depend on Epson's cloud API being up or
correctly configured.

## How it works

1. Staff click **Print (API)** on `/print-queue` (relabeled "Send to Linux
   Printer" when this mode is active). This creates a `LinuxPrintJob` row
   in the database - the document itself stays in its current status
   (`UPLOADED`/`QUEUED_FOR_PRINT`) until the agent confirms it printed.
2. `linux-print-agent.py`, running on your machine, polls
   `GET /api/print-agent/jobs` every `POLL_INTERVAL_SECONDS` (default 10s).
3. For each pending job, it downloads the PDF from
   `GET /api/print-agent/jobs/{id}/file`, prints it via `lp`, and reports
   back to `POST /api/print-agent/jobs/{id}/complete`.
4. On success, the document moves to `PRINTED` and a chain-of-custody audit
   event is recorded (`via: "linux_agent"`). On failure, the document stays
   where it was and a `linux_agent_print_failed` audit event records the
   error, so staff can retry or fall back to Epson Connect for that job.

The agent authenticates with a static bearer token
(`PRINT_AGENT_TOKEN`) rather than a user login, since there's no browser
session on an unattended machine - this must be set to the exact same
value in Vercel's environment variables and in this agent's own config.

## Prerequisites

- Ubuntu (or any Linux distribution) with **CUPS** installed and your
  printer already configured and working - confirm with:
  ```
  lpstat -p
  ```
  You should see your printer listed as `idle` or `printing`, not
  `disabled`. If nothing's configured yet, use `Settings → Printers`
  (GNOME) or `http://localhost:631` (CUPS' own web UI) to add it first.
- Python 3 (ships with Ubuntu by default - no extra packages needed).

## Setup

1. **Generate a token** for `PRINT_AGENT_TOKEN` - any long random string, e.g.:
   ```
   openssl rand -hex 32
   ```
   Add it to Vercel's environment variables as `PRINT_AGENT_TOKEN`, and
   redeploy so it takes effect.

2. **Copy the script to the machine**:
   ```
   sudo mkdir -p /opt/postnow
   sudo cp linux-print-agent.py /opt/postnow/
   ```

3. **Create the config file** at `/etc/postnow-print-agent.env`:
   ```
   POSTNOW_API_BASE=https://app.postnow.co.za
   PRINT_AGENT_TOKEN=<the same token you put in Vercel>
   CUPS_PRINTER_NAME=<exact name from `lpstat -p`, or omit to use the system default>
   POLL_INTERVAL_SECONDS=10
   ```
   Restrict its permissions since it holds a credential:
   ```
   sudo chmod 600 /etc/postnow-print-agent.env
   ```

4. **Install the systemd service**:
   ```
   sudo cp postnow-print-agent.service /etc/systemd/system/
   ```
   The unit file runs the agent as a `postnow-agent` user. Create it and
   add it to the `lp` group so it can submit print jobs:
   ```
   sudo useradd --system --no-create-home postnow-agent
   sudo usermod -aG lp postnow-agent
   ```
   (If you'd rather run it as your own logged-in user instead of creating
   a dedicated one, edit `User=` in the service file to match.)

5. **Enable and start it**:
   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now postnow-print-agent
   ```

6. **Check it's running**:
   ```
   sudo systemctl status postnow-print-agent
   journalctl -u postnow-print-agent -f
   ```
   You should see a "PostNow Linux Print Agent starting" log line.

7. **Switch the app over**: go to `/printer` in the staff app and click
   **Linux Print Agent** under Printing Method. Print a test document from
   `/print-queue` and watch the journal log to confirm it picks up the job.

## Troubleshooting

- **"POSTNOW_API_BASE and PRINT_AGENT_TOKEN must both be set"** - the
  service didn't load `/etc/postnow-print-agent.env`; check the path and
  that `EnvironmentFile=` in the unit file matches.
- **401 from the API** - `PRINT_AGENT_TOKEN` doesn't match what's in
  Vercel. Copy it again carefully (the trailing-whitespace-from-paste bug
  has bitten this project's other credentials more than once - see
  TECH_SPEC.md section 6.6).
- **`lp` errors ("no destination")** - `CUPS_PRINTER_NAME` doesn't match a
  name from `lpstat -p` exactly, or no default printer is set. Try leaving
  it unset once you've set a system default with
  `lpoptions -d <printer_name>`.
- **Jobs never move past "Queued for Linux printer" in the UI** - check
  the journal log for errors, and confirm the agent's machine can actually
  reach `app.postnow.co.za` (no corporate firewall/proxy blocking it).
