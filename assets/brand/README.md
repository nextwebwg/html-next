# HTML Next brand assets

Use the symbol without words for GitHub avatars, favicons, app icons, and navigation beside the project name. Use the full symbol-and-name lockup for repository introductions, standalone headings, and presentation covers where the name stays legible.

| File | Use |
| --- | --- |
| `html-next-mark.svg` / `.png` | Transparent symbol, square canvas; inline icons and navigation. |
| `html-next-avatar.svg` / `.png` | Symbol only on white, padded for square or circular profile crops. Upload the PNG to GitHub. |
| `html-next-lockup.svg` / `.png` | Symbol and name, for light backgrounds. |
| `html-next-lockup-dark.svg` / `.png` | Symbol and name, with light lettering for dark backgrounds. |
| `html-next-mark-dark.svg` / `.png` | Symbol for dark backgrounds; the HTML Next orange mark is unchanged. |
| `html-next-mark-128.png` | Transparent 128 × 128 symbol packaged as the NuGet gallery icon. |
| `html-next-lockup-nuget.png` | 280 px lockup on white for NuGet's Markdown README, legible in either gallery theme. |

SVG files are the vector masters; every corresponding PNG is rendered from its SVG. Keep proportions, internal spacing, and colors intact. Do not crop the avatar padding or squeeze a lockup into a profile image. Use an empty image alt attribute when adjacent text already supplies the name; otherwise use "HTML Next".

Generate the NuGet assets with `rsvg-convert --width 128 --height 128 html-next-mark.svg --output html-next-mark-128.png` and `rsvg-convert --width 280 --background-color white html-next-lockup.svg --output html-next-lockup-nuget.png` from this directory. NuGet README images use absolute `raw.githubusercontent.com` URLs because the gallery does not render relative image paths.

The masters use explicitly constructed lines and Bézier curves for both symbols and lettering, with no raster-derived contour polygons.
The N retains 88 source units of horizontal clearance on both sides and vertical clearance above its top and below both lower tips.
