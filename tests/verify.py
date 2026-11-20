"""Independent check of tests/out against tests/fixtures, using third-party tools only.

For every cleaned file:
  1. No sensitive string may appear anywhere in the raw bytes (or inside ZIP parts / decompressed PDF streams).
  2. exiftool must not report GPS, XMP, IPTC, maker notes or personal fields.
  3. The file must still open, and pictures / video frames / audio must be identical to the original.
"""
import io
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
import os
FX, OUT = HERE / "fixtures", Path(os.environ.get("VERIFY_DIR", HERE / "out"))
SECRETS = [b"Papadopoulou", b"mpapadopoulou", b"iPhone", b"Pixel 9", b"SM-S928B", b"ACME", b"Athens", b"F2LXK9",
           b"Lightroom", b"neighbour", b"private comment", b"Giorgos", b"LaserJet", b"recorded at home", b"4f9a7c1e2b",
           b"+37.97", b"37.975", b"23.727", b"Voice memo", b"Samsung Screen", b"ReportLab", b"Secret report"]
BAD_GROUPS = ("GPS", "XMP", "IPTC", "Photoshop", "MakerNotes", "Keys", "ItemList", "UserData", "ID3", "IFD1")
BAD_TAGS = {"Artist", "Author", "Creator", "Make", "Model", "Software", "OwnerName", "SerialNumber", "LensModel",
            "DateTimeOriginal", "Comment", "Title", "LastModifiedBy", "Company", "Producer", "GPSPosition", "Location"}

ok_all = True


def sh(*cmd, check=True):
    return subprocess.run(cmd, capture_output=True, check=check)


def fail(name, msg):
    global ok_all
    ok_all = False
    print(f"  ✗ {name}: {msg}")


def raw_views(path):
    """Yield (label, bytes) for the file and everything packed inside it."""
    data = path.read_bytes()
    yield "raw", data
    if data[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                yield info.filename, z.read(info.filename)
    if data.lstrip()[:5] == b"%PDF-" or b"%PDF-" in data[:1024]:
        with tempfile.NamedTemporaryFile(suffix=".pdf") as t:
            sh("qpdf", "--qdf", "--object-streams=disable", "--stream-data=uncompress", str(path), t.name, check=False)
            yield "pdf-uncompressed", Path(t.name).read_bytes()


def exif_dump(path):
    r = sh("exiftool", "-j", "-a", "-G1", "-u", str(path), check=False)
    try:
        return json.loads(r.stdout)[0]
    except Exception:
        return {}


def pixels_equal(a, b):
    with Image.open(a) as ia, Image.open(b) as ib:
        ia.load()
        ib.load()
        return ia.size == ib.size and ia.convert("RGBA").tobytes() == ib.convert("RGBA").tobytes()


def media_md5(path, extra=()):
    r = sh("ffmpeg", "-v", "error", "-i", str(path), *extra, "-map", "0:v?", "-map", "0:a?", "-f", "md5", "-", check=False)
    return r.stdout.strip(), r.stderr.strip()


def office_text(path):
    suffix = path.suffix.lower()
    if suffix == ".docx":
        import docx
        d = docx.Document(str(path))
        return "\n".join(p.text for p in d.paragraphs)
    if suffix == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(str(path))
        return "\n".join(f"{ws.title}:{c.coordinate}={c.value}" for ws in wb for row in ws.iter_rows() for c in row if c.value is not None)
    if suffix == ".pptx":
        from pptx import Presentation
        prs = Presentation(str(path))
        return "\n".join(sh.text_frame.text for s in prs.slides for sh in s.shapes if sh.has_text_frame)
    return ""


def libreoffice_opens(path):
    with tempfile.TemporaryDirectory() as d:
        r = sh("soffice", "--headless", "--convert-to", "pdf", "--outdir", d, str(path), check=False)
        pdf = Path(d) / (path.stem + ".pdf")
        return pdf.exists() and pdf.stat().st_size > 500, r.stderr.decode()[-200:]


for out in sorted(OUT.iterdir()):
    if out.name == "summary.json":
        continue
    orig = FX / out.name
    print(f"{out.name}")
    problems_before = ok_all

    # 1. raw bytes
    for label, data in raw_views(out):
        for s in SECRETS:
            if s in data:
                fail(out.name, f"found {s.decode()!r} in {label}")

    # 2. exiftool view
    meta = exif_dump(out)
    for key, value in meta.items():
        group, _, tag = key.partition(":")
        if any(group.startswith(g) for g in BAD_GROUPS) and tag not in ("XMPToolkit",):
            fail(out.name, f"exiftool still sees {key} = {str(value)[:60]}")
        elif tag in BAD_TAGS and group not in ("System", "File", "ExifTool", "Composite") and value not in ("", None):
            fail(out.name, f"exiftool still sees {key} = {str(value)[:60]}")
        if tag in ("CreateDate", "ModifyDate", "TrackCreateDate", "MediaCreateDate", "CreationDate") and "2026" in str(value):
            fail(out.name, f"date kept: {key} = {value}")

    # 3. still works, content unchanged
    ext = out.suffix.lower()
    if ext in (".jpg", ".png", ".webp", ".gif"):
        if not pixels_equal(orig, out):
            fail(out.name, "pixels differ from the original")
        o1 = exif_dump(orig).get("IFD0:Orientation")
        o2 = meta.get("IFD0:Orientation")
        if o1 and o1 != "Horizontal (normal)" and o1 != o2:
            fail(out.name, f"orientation lost ({o1} → {o2})")
    elif ext in (".heic", ".avif"):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a.png", Path(d) / "b.png"
            ra = sh("heif-convert", str(orig), str(a), check=False)
            rb = sh("heif-convert", str(out), str(b), check=False)
            if rb.returncode != 0 or not b.exists():
                fail(out.name, "cannot be decoded: " + rb.stderr.decode()[-200:])
            elif not pixels_equal(a, b):
                fail(out.name, "pixels differ from the original")
    elif ext in (".mp4", ".mov", ".m4a", ".mp3"):
        m1, _ = media_md5(orig)
        m2, err = media_md5(out)
        if err:
            fail(out.name, "decoder errors: " + err[:200])
        if m1 != m2:
            fail(out.name, f"decoded media differs ({m1} vs {m2})")
    elif ext == ".pdf":
        r = sh("qpdf", "--check", str(out), check=False)
        if r.returncode not in (0, 3):
            fail(out.name, "qpdf --check failed: " + r.stdout.decode()[-200:])
        t1 = sh("pdftotext", str(orig), "-").stdout
        t2 = sh("pdftotext", str(out), "-").stdout
        if t1 != t2:
            fail(out.name, "text differs from the original")
        if sh("pdfimages", "-list", str(orig)).stdout.count(b"\n") != sh("pdfimages", "-list", str(out)).stdout.count(b"\n"):
            fail(out.name, "number of images differs")
    elif ext in (".docx", ".xlsx", ".pptx", ".odt"):
        if ext != ".odt" and office_text(orig) != office_text(out):
            fail(out.name, "document text differs from the original")
        opened, err = libreoffice_opens(out)
        if not opened:
            fail(out.name, "LibreOffice could not open it: " + err)
        with zipfile.ZipFile(out) as z:
            infos = z.infolist()
            if any(i.date_time[:3] != (1980, 1, 1) for i in infos):
                fail(out.name, "ZIP entries still carry real timestamps")
            if z.testzip() is not None:
                fail(out.name, "ZIP is corrupt")
            if ext == ".odt" and (infos[0].filename != "mimetype" or infos[0].compress_type != zipfile.ZIP_STORED):
                fail(out.name, "mimetype must be the first, uncompressed entry")

    if problems_before == ok_all and ok_all:
        print("  ✓ clean, opens, content identical")
    elif problems_before and not ok_all:
        pass

print("\nALL GOOD" if ok_all else "\nPROBLEMS FOUND")
sys.exit(0 if ok_all else 1)
