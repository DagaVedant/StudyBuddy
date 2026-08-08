# Fonts for the generated social card

Read by `app/opengraph-image.tsx`. Nothing else uses them; the app itself
gets Archivo and Geist through `next/font/google` in `app/layout.tsx`.

They are duplicated here because `next/font` cannot reach an `ImageResponse`:
Satori needs the raw font bytes handed to it, and `next/font` only ever hands
back a CSS class. The subsetted `.woff2` files that `next/font` leaves in
`.next/static/media/` are not usable as a substitute for two reasons: they
are build output in a gitignored directory, so they are absent on a clean
checkout and their hashed names change from build to build; and Satori reads
only `ttf`, `otf`, and `woff`, never `woff2`.

| File | Family / weight | Source |
| --- | --- | --- |
| `Archivo-ExtraBold-latin.ttf` | Archivo 800, latin subset | `cdn.jsdelivr.net/fontsource/fonts/archivo@latest/latin-800-normal.ttf` |
| `Geist-Medium-latin.ttf` | Geist 500, latin subset | `cdn.jsdelivr.net/fontsource/fonts/geist@latest/latin-500-normal.ttf` |

Static single-weight latin subsets, ~73 KB for the pair. Variable or full
Unicode builds would be several times that, and `ImageResponse` has a 500 KB
budget covering the fonts, the JSX, and every other asset in the route.

Both are licensed under the SIL Open Font License 1.1:

- Archivo: Copyright 2020 The Archivo Project Authors
  (https://github.com/Omnibus-Type/Archivo)
- Geist: Copyright 2024 The Geist Project Authors
  (https://github.com/vercel/geist-font)
