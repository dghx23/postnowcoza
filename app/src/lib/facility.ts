// Our print/dispatch facility — the collection address for outbound
// shipments and the delivery address for returns.
export const FACILITY_ADDRESS = {
  company: "PostNow",
  street_address: process.env.FACILITY_STREET_ADDRESS ?? "",
  local_area: process.env.FACILITY_LOCAL_AREA ?? "",
  city: process.env.FACILITY_CITY ?? "",
  zone: process.env.FACILITY_ZONE ?? "",
  country: "ZA",
  code: process.env.FACILITY_POSTAL_CODE ?? "",
};

export const FACILITY_CONTACT = {
  name: process.env.FACILITY_CONTACT_NAME ?? "PostNow Dispatch",
  email: process.env.FACILITY_CONTACT_EMAIL ?? "",
  mobile_number: process.env.FACILITY_CONTACT_PHONE ?? "",
};

// A standard A4 document envelope/sleeve. Actual weight varies with page
// count but this default covers the common case; override per-document if
// we ever need to support bulkier packages.
export const DOCUMENT_PARCEL = {
  description: "Document envelope",
  submitted_length_cm: 32,
  submitted_width_cm: 23,
  submitted_height_cm: 1,
  submitted_weight_kg: 0.2,
};
