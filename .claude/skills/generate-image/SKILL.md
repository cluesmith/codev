---
name: generate-image
description: AI image generation via Gemini, or Atlas Cloud with `-p atlas`. Use when the user wants to generate, create, or make an image, or when you need to create visual assets like logos, diagrams, or illustrations. Requires GEMINI_API_KEY or GOOGLE_API_KEY, or ATLASCLOUD_API_KEY when using `-p atlas`.
---

# generate-image - AI Image Generation

Uses Google Gemini to generate images from text prompts.

## Synopsis

```
codev generate-image "<prompt>" [options]
```

Note: this is a `codev` subcommand, not standalone.

## All flags

```
-o, --output <file>        Output file path (default: output.png)
-r, --resolution <res>     Resolution: 1K, 2K, 4K (default: 1K)
-a, --aspect <ratio>       Aspect ratio (default: 1:1)
--ref <image>              Reference image (repeatable, max 14)
-p, --provider <name>      Provider: gemini (default) or atlas
```

## Aspect ratios

`1:1` | `16:9` | `9:16` | `3:4` | `4:3` | `3:2` | `2:3`

## Examples

```bash
codev generate-image "A sunset over mountains"
codev generate-image "A futuristic city" -r 4K -a 16:9 -o city.png
codev generate-image "Same style but with cats" --ref style.png --ref layout.png
codev generate-image prompt.txt -o result.png    # Prompt from .txt file
```

## Notes

- Prompt must be quoted if it contains spaces
- Prompt can be a `.txt` file path (auto-detected by extension)
- Reference images must exist on disk
- Requires `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable

## Alternative provider: Atlas Cloud

`-p atlas` generates through Atlas Cloud, which serves the same Nano Banana Pro
model over a submit-then-poll REST API. Useful when a Google AI Studio key is
not available. Requires `ATLASCLOUD_API_KEY`; the default provider is unchanged.

```bash
codev generate-image "A sunset over mountains" -p atlas -a 16:9
```

Measured differences on that path:

- `-a/--aspect` works (`1:1` returns 1024x1024, `16:9` returns 1376x768).
- `-r/--resolution` has no equivalent field; a note is printed and the model's
  default resolution comes back.
- `--ref` is not supported (text-to-image only) and exits with an error rather
  than silently ignoring the images.
- The model returns JPEG, so the output file is named after its actual bytes
  instead of writing JPEG into the default `output.png`.
