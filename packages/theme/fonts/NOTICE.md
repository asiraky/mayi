# Suisse Int'l — not covered by this repository's licence

The `SuisseIntl-*.woff2` files in this directory are **not** Apache-2.0, and the LICENSE
at the root of this repository does not apply to them. They are a commercial typeface
licensed from Swiss Typefaces, and that licence is granted **per origin** — mayi.sh and
app.mayi.sh are two separate origins and each needs to be covered.

Their presence here does not grant you any right to use, serve, or redistribute them.

If you are self-hosting May I?, you need either your own Suisse Int'l licence covering
the origin you serve from, or a substitute face. To substitute one, replace the
`--font-suisse` mapping in `tokens.css`'s consumers (`apps/site/src/styles/tailwind.css`
and `apps/web/src/styles.css`) and the `local()` font entries in
`apps/site/astro.config.mjs`. Nothing else in the theme depends on this typeface.
