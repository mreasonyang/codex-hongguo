# Plugin icon

Original artwork for codex-hongguo, distributed under the project's MIT license.

The mark combines code brackets with a play button. Its graphite background
(`#242B2E`), ivory brackets (`#FFF4E5`) and coral play button (`#FF856F`) identify
this independent Codex plugin. It does not use Hongguo's official artwork.

- `icon.svg`: vector master and composer icon, designed on a 128 × 128 grid.
- `logo.png`: 512 × 512 RGBA export for plugin details and documentation.

Keep the proportions and colors intact; use at least 16 × 16 pixels. Leave
additional space around the square when placing it beside text. The built-in
padding keeps the symbol legible in small plugin menus and on light or dark
backgrounds.

To regenerate the PNG with ImageMagick:

```sh
magick -background none -density 384 assets/icon.svg -strip assets/logo.png
```
