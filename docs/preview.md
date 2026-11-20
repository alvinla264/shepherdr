# The document preview

The panel that shows a document beside a chat is the human's own plugin (`~/.shepherdr/plugins/markdown-preview`,
outside this repository, [docs/plugins.md](plugins.md)). What this repository provides is the reader behind it:
`GET /api/markdown-preview?path=<absolute path>`, which answers with JSON.

## What it will read

- Markdown, HTML, and allowlisted text/code (`.txt .log .csv .tsv .json .jsonl .yaml .yml .toml .ini .conf .xml
  .sh .bash .zsh .py .js .jsx .ts .tsx .css .c .h .cc .cpp .hpp .rs .go .java .sql .nix .diff .patch`).
- PNG, JPEG, GIF and WebP, base64 in the JSON with the MIME type the magic bytes prove, never as a file response.
- Not PDF, Office, SVG, audio or video: those are refused rather than guessed at.

## Limits

- 512 KiB for text, 8 MiB for an image; a file that grows while it is read is cut off at the limit.
- An image is previewed only if its own headers say it is a single frame within **12,000 pixels a side** and
  **16,000,000 pixels** in total. The compressed size says nothing about what a browser would decode, so the header
  numbers are what the reader trusts; a header it cannot read is refused rather than assumed small.
- What is checked is the file's structure (signatures, chunk lengths, CRCs, sizes, frame count), not the compressed
  image stream: a file whose headers are consistent but whose encoded data is broken is previewed and the panel shows
  the browser's own failure. Decoding it here would mean carrying an image decoder.
- **Tradeoff, deliberately:** animated GIF, animated WebP and APNG are not previewed ("Animated images are not
  previewed; save a single frame"). Animation made the decoded work unbounded, which the file-size limit could not
  bound. Static images of every supported format are unaffected.

## Where it reads

Only inside the roots named in `<shepherdr home>/markdown-preview.json`, which has no default:

```json
{ "roots": ["/home/you/notes", "/home/you/work/specs"] }
```

A path outside them, a relative path, a symlink, a hard link, a hidden path component, a non-regular file and an
oversized file are all refused. Every component is opened without following links, on Linux only (a descriptor-relative
walk); elsewhere the reader fails closed. The response is `no-store` JSON with `nosniff` and no cross-origin sharing,
needs the `x-shepherdr: 1` header every same-origin call sends, and is not available from a demo source or a remote
helper. `docs/autopilot.md` covers the tasks side.
