# Email signature — info@postnow.co.za

`email-signature-info-postnow.html` in this folder is the "PostNow Team"
shared-inbox signature, designed to match the marketing site's brand
(navy `#0d2438` / teal `#0e8c82` / gold `#c9a227`, the same
POPIA-First · Chain of Custody · Zero-Touch trio from the homepage trust
bar).

Built as an inline-styled HTML `<table>` with no `<style>` block and no
custom fonts, since Outlook, Gmail, and Zoho's own signature renderer all
strip anything fancier from pasted HTML — this is the actual constraint
that shapes the whole design, not a stylistic choice.

## Using it

1. Zoho Mail → Settings → Mail → **Signature**.
2. Open the editor and switch to **source/HTML view** (the `<>` icon in
   the toolbar) — pasting into the rich-text view directly loses the
   inline styles.
3. Paste the contents of `email-signature-info-postnow.html`, switch back
   to rich-text to confirm it renders, then **Update**.
4. Set it as the default signature under "Associated From addresses" for
   `info@postnow.co.za`.

## Changing it later

Edit `email-signature-info-postnow.html` directly and re-paste — it's a
plain, self-contained file, not generated from anything else in the repo.
Keep any edits table-based with inline styles only; anything relying on
`<style>`, flexbox/grid, or custom fonts will silently break in at least
one major mail client.
