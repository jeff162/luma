"""A minimal, valid PDF carrying a real text layer.

Tier-1 extraction reads the text a *digital* PDF already contains, so testing it needs a PDF a real
parser accepts — not a plausible-looking byte string. The difference is not cosmetic: pypdf locates
objects through the cross-reference table, so a PDF assembled without correct byte offsets parses as
having no pages and every extraction test would pass against nothing.

Small enough to keep in the repository rather than committing binary fixtures, and generating it means
the text under test is visible in the test that uses it.
"""

from __future__ import annotations


def make_text_pdf(lines: list[str]) -> bytes:
    """A one-page PDF whose text layer is `lines`, one per line."""
    content = "BT /F1 12 Tf 40 750 Td 14 TL\n" + "\n".join(
        f"({_escape(line)}) Tj T*" for line in lines
    ) + "\nET\n"
    return _assemble([content.encode("latin-1")])


def make_positioned_pdf(pages: list[list[tuple[float, float, str]]], font_size: float = 8) -> bytes:
    """A PDF whose pages carry text placed at points — `(x, y, text)`, from the bottom-left — so a reader
    that works from the printed layout (columns, indentation) sees it the way it would a real document."""
    streams = []
    for placements in pages:
        content = "".join(
            f"BT /F1 {font_size} Tf 1 0 0 1 {x} {y} Tm ({_escape(text)}) Tj ET\n" for x, y, text in placements
        )
        streams.append(content.encode("latin-1"))
    return _assemble(streams)


def _assemble(streams: list[bytes]) -> bytes:
    """The objects of a PDF with one page per content stream, written with a correct cross-reference
    table. Object 3 is the font; each page is followed by its content stream."""
    page_numbers = [4 + 2 * i for i in range(len(streams))]
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[" + b" ".join(f"{n} 0 R".encode() for n in page_numbers)
        + b"]/Count " + str(len(streams)).encode() + b">>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    for number, stream in zip(page_numbers, streams):
        objects.append(
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents " + str(number + 1).encode()
            + b" 0 R/Resources<</Font<</F1 3 0 R>>>>>>"
        )
        objects.append(b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"endstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    # The cross-reference table: byte offset of every object, which is what makes this a PDF a parser
    # can navigate rather than a file that merely starts with %PDF-.
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    return bytes(out)


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)")
