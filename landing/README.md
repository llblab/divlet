# Landing page

One static page for GitHub Pages: `index.html`, `landing.css` and `favicon.svg`. It fetches nothing — no fonts, scripts,
images or stylesheets from anywhere else — so what is in this folder is exactly what a visitor gets.

Publishing is a CI job, not a manual step (`.github/workflows/landing.yml`):

1. It computes a fingerprint of this folder (`node scripts/landing-hash.mjs`).
2. It reads `.landing-hash` from the root of the `gh-pages` branch.
3. If the fingerprint is the same, it stops: the live page already is this folder.
4. If it differs, it copies this folder to the root of `gh-pages`, writes the new `.landing-hash` and commits.

So the branch is the published site plus one line saying which version of this folder it came from, and re-running the
workflow without changing anything never makes a commit. Serve Pages from the `gh-pages` branch root.

Keep it self-contained: the check is `node --test core/tests/landing.test.js`, and it refuses a page that reaches for an
external asset. Edit the text and layout here; the page is not generated from the product.

The install section names the npm package `divlet`, its two commands (`divlet` and `divlet-mcp`) and the optional Pi wrapper
`divlet-pi`. Keep the pre-publication notice until the packages are actually available; the repository's publication guide is
`docs/publishing.md`. Long commands wrap so the examples remain readable on narrow screens.
