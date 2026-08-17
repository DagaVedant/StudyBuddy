# Fonts for the generated social card

Read by `app/opengraph-image.tsx`. The app itself loads Archivo and Geist
through `next/font/google` in `app/layout.tsx`.

These are duplicated here because `next/font` returns a CSS class rather than
font bytes, and Satori requires the bytes. The subsetted `.woff2` files under
`.next/static/media/` are not a substitute: they are gitignored build output with
hashed names, and Satori reads only `ttf`, `otf` and `woff`.

| File | Family / weight | Source |
| --- | --- | --- |
| `Archivo-ExtraBold-latin.ttf` | Archivo 800, latin subset | `cdn.jsdelivr.net/fontsource/fonts/archivo@latest/latin-800-normal.ttf` |
| `Geist-Medium-latin.ttf` | Geist 500, latin subset | `cdn.jsdelivr.net/fontsource/fonts/geist@latest/latin-500-normal.ttf` |

Static single-weight latin subsets, around 73 KB for the pair. `ImageResponse`
has a 500 KB budget covering fonts, JSX and every other asset in the route.

## Licence

Both are licensed under the SIL Open Font License 1.1:

- Archivo: Copyright 2020 The Archivo Project Authors
  (https://github.com/Omnibus-Type/Archivo)
- Geist: Copyright 2024 The Geist Project Authors
  (https://github.com/vercel/geist-font)
