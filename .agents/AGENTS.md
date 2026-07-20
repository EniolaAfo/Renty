# Renty Project Guidelines & Lessons Learned

## Core Rules & Avoiding Past Mistakes

1. **Beware Quoted-Printable Encoded HTML:**
   Users will often upload `.mhtml` files containing Quoted-Printable encodings. The pound sign (`£`) is commonly encoded as `=C2=A3`. When writing regex to parse monetary values from raw HTML/MHTML strings, **always** include `=C2=A3` in your currency matchers, otherwise you will accidentally parse the `3` as part of the price digits (e.g., extracting `32,495` instead of `2,495`).
   *Best Practice:* Try to use `DOMParser` and extract `.textContent` (which natively decodes HTML entities) before falling back to regex on raw text.

2. **Geocoding Constraints:**
   When using external Geocoders (like Nominatim), **always** constrain the search to the United Kingdom (`countrycodes=gb`) and bias it using bounding boxes (`viewbox`). Without these constraints, a search for "High Street" or "Mile End" will confidently plot properties in Texas or Canada.

3. **Leaflet Map Initialization:**
   Do not use Leaflet's `flyTo` or `flyToBounds` when the map is just initializing or when boundary boxes might be extreme or broken. Use `.setView([lat, lng], zoom, { animate: true })` for robust, smooth centering.

4. **Frictionless UX & Premature Optimization:**
   While users rarely manually extract URLs or cleanly copy/paste HTML (and the UI should auto-extract metadata like canonical URLs), do **not** aggressively auto-submit forms when files are uploaded or text is pasted if there are other configurable fields (e.g., price format overrides, manual address fallbacks). Always allow the user to explicitly submit when multiple inputs are interdependent.
