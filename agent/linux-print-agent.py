#!/usr/bin/env python3
"""PostNow Linux Print Agent.

Polls PostNow's print-agent API for documents queued to the "Linux Print
Agent" printing method (set on /printer in the staff app), downloads each
one, prints it via CUPS (`lp`), and reports success/failure back so the
document's status advances and the chain-of-custody audit log gets an
entry either way.

This exists as an alternative to Epson Connect for sites where a directly
network-attached printer (of any brand CUPS supports) is preferred over
cloud-based printing, or as a fallback while Epson Connect is unavailable.

No third-party Python packages required - stdlib only, so no pip install
is needed beyond a working Python 3 interpreter.

Configuration is via environment variables (see README.md for full setup):
  POSTNOW_API_BASE       e.g. https://app.postnow.co.za
  PRINT_AGENT_TOKEN      must match PRINT_AGENT_TOKEN in Vercel exactly
  CUPS_PRINTER_NAME      optional; omit to use the system default printer
  POLL_INTERVAL_SECONDS  optional; default 10
"""
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("POSTNOW_API_BASE", "").rstrip("/")
TOKEN = os.environ.get("PRINT_AGENT_TOKEN", "")
PRINTER_NAME = os.environ.get("CUPS_PRINTER_NAME")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "10"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("postnow-print-agent")


def api_request(method, path, body=None):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def download_file(job_id):
    url = f"{API_BASE}/api/print-agent/jobs/{job_id}/file"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req, timeout=60) as resp:
        fd, path = tempfile.mkstemp(suffix=".pdf", prefix="postnow-")
        with os.fdopen(fd, "wb") as f:
            f.write(resp.read())
        return path


def print_file(path):
    cmd = ["lp"]
    if PRINTER_NAME:
        cmd += ["-d", PRINTER_NAME]
    cmd.append(path)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"lp exited with status {result.returncode}")


def report(job_id, success, error=None):
    body = {"success": success}
    if error:
        body["error"] = error[:500]
    api_request("POST", f"/api/print-agent/jobs/{job_id}/complete", body)


def process_job(job):
    job_id = job["id"]
    log.info("Printing job %s (%s) for %s", job_id, job["jobName"], job["recipientName"])
    tmp_path = None
    try:
        tmp_path = download_file(job_id)
        print_file(tmp_path)
        report(job_id, True)
        log.info("Job %s printed successfully", job_id)
    except Exception as exc:  # noqa: BLE001 - report every failure mode back to the app
        log.error("Job %s failed: %s", job_id, exc)
        try:
            report(job_id, False, str(exc))
        except Exception as report_exc:  # noqa: BLE001
            log.error("Failed to report failure for job %s: %s", job_id, report_exc)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def main():
    if not API_BASE or not TOKEN:
        log.error("POSTNOW_API_BASE and PRINT_AGENT_TOKEN must both be set - see README.md")
        sys.exit(1)

    log.info(
        "PostNow Linux Print Agent starting (base=%s, printer=%s, interval=%ss)",
        API_BASE,
        PRINTER_NAME or "<system default>",
        POLL_INTERVAL,
    )

    while True:
        try:
            data = api_request("GET", "/api/print-agent/jobs")
            for job in data.get("jobs", []):
                process_job(job)
        except urllib.error.URLError as exc:
            log.warning("Could not reach PostNow API: %s", exc)
        except Exception as exc:  # noqa: BLE001 - keep the poll loop alive on any error
            log.error("Unexpected error polling for jobs: %s", exc)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
