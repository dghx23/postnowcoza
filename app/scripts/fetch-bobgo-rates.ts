/**
 * Standalone script to call Bob Go's live /rates endpoint using the
 * existing thin client in src/lib/bobgo.ts, so we can see what
 * `service_level_code` / `service_name` values Bob Go actually returns
 * for this account. Those fields are currently treated as opaque
 * pass-through strings elsewhere in the codebase (see src/lib/dispatch.ts).
 *
 * Usage:
 *   npm run bobgo:rates
 *
 * Requires BOBGO_API_TOKEN (and optionally BOBGO_BASE_URL) to be set in
 * the environment, or in a `.env.local` file in the `app/` directory
 * (loaded manually below, since this project doesn't depend on dotenv).
 */

import fs from "node:fs";
import path from "node:path";

// Minimal .env.local loader (no dotenv dependency in this project).
function loadEnvLocal() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;

  const contents = fs.readFileSync(envPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

// Import after env vars are loaded, since bobgo.ts reads
// process.env.BOBGO_BASE_URL / BOBGO_API_TOKEN at module-load time.
import { getRates } from "../src/lib/bobgo";

async function main() {
  if (!process.env.BOBGO_API_TOKEN) {
    console.error(
      "BOBGO_API_TOKEN is not set. Set it in the environment or in app/.env.local before running this script."
    );
    process.exitCode = 1;
    return;
  }

  const sampleRequest = {
    collection_address: {
      company: "PostNow Dispatch",
      street_address: "1 Sandton Drive",
      local_area: "Sandhurst",
      city: "Johannesburg",
      zone: "Gauteng",
      country: "ZA",
      code: "2196",
    },
    delivery_address: {
      street_address: "1 Long Street",
      local_area: "City Bowl",
      city: "Cape Town",
      zone: "Western Cape",
      country: "ZA",
      code: "8001",
    },
    parcels: [
      {
        description: "Sample parcel",
        submitted_length_cm: 20,
        submitted_width_cm: 20,
        submitted_height_cm: 10,
        submitted_weight_kg: 1,
        custom_parcel_reference: "fetch-bobgo-rates-sample",
      },
    ],
  };

  console.log("Requesting rates from Bob Go with sample JHB -> CPT parcel...");
  console.log(JSON.stringify(sampleRequest, null, 2));
  console.log("---");

  const response = await getRates(sampleRequest);

  console.log(`Received ${response.rates.length} rate option(s):`);
  console.log(JSON.stringify(response.rates, null, 2));
}

main().catch((err) => {
  console.error("Failed to fetch Bob Go rates:", err);
  process.exitCode = 1;
});
