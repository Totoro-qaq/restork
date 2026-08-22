# Bundled CJK font

`NotoSansSC-wght.ttf` is the unmodified Noto Sans SC variable TrueType font
distributed by the official `google/fonts` repository under the SIL Open Font
License 1.1. Restork keeps the original font as a renderer asset and creates a
document-specific PDF subset at weight 400. The generated subset contains only
glyphs used by that PDF; the original font and `OFL.txt` remain bundled with the
application.

- Upstream: <https://github.com/google/fonts/tree/main/ofl/notosanssc>
- Upstream commit: `ec626514f79f831f1ab848a82114a0ce7e2d6372`
- Font SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- License SHA-256: `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`
- License: SIL Open Font License 1.1 (`OFL.txt`)

Do not replace the font without updating this provenance record and the PDF
embedding tests.
