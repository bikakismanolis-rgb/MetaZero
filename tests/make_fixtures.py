"""Builds test files stuffed with personal metadata, the way phones and Office apps write it.

Run: python3 tests/make_fixtures.py   (needs exiftool, ffmpeg, heif-enc, soffice, PIL, python-docx, openpyxl, python-pptx, reportlab)
"""
import io
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

from PIL import Image, ImageCms, ImageDraw

HERE = Path(__file__).parent
FX = HERE / "fixtures"
shutil.rmtree(FX, ignore_errors=True)
FX.mkdir(parents=True)

NAME = "Maria Papadopoulou"
GPS = ["-GPSLatitude=37.97542", "-GPSLatitudeRef=N", "-GPSLongitude=23.72738", "-GPSLongitudeRef=E", "-GPSAltitude=95"]


def run(*cmd, **kw):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kw)


def exif(path, *tags):
    run("exiftool", "-q", "-overwrite_original", *tags, str(path))


def picture(w=640, h=480, color=(30, 120, 160)):
    im = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(im)
    for i in range(0, w, 40):
        d.line([(i, 0), (w - i, h)], fill=(240, 200, 60), width=6)
    d.rectangle([20, 20, 200, 120], fill=(200, 40, 40))  # top-left marker to check orientation
    return im


srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
PHONE_TAGS = [
    "-Make=Apple", "-Model=iPhone 15 Pro", "-Software=18.1", "-DateTimeOriginal=2026:11:20 14:32:05",
    "-Artist=" + NAME, "-OwnerName=" + NAME, "-SerialNumber=F2LXK9ABC123", "-LensModel=iPhone 15 Pro back camera",
    "-ImageUniqueID=4f9a7c1e2b", "-XMP-dc:Creator=" + NAME, "-XMP-xmp:CreatorTool=Adobe Lightroom",
    "-IPTC:By-line=" + NAME, "-IPTC:City=Athens", "-Comment=private comment", *GPS,
]

# --- JPEG: phone-style EXIF + GPS + XMP + IPTC + thumbnail + rotation + data after the end
p = FX / "IMG_20261120_143205.jpg"
picture().save(p, quality=90, icc_profile=srgb)
picture(160, 120).save(FX / "thumb.jpg", quality=70)
exif(p, *PHONE_TAGS, "-Orientation#=6", "-ThumbnailImage<=" + str(FX / "thumb.jpg"))
with open(p, "ab") as f:
    f.write(b"SAMSUNG_TRAILER " + NAME.encode() + b" 37.97542,23.72738")
os.remove(FX / "thumb.jpg")

# --- JPEG with a personal colour profile (screen calibrated by its owner)
custom_icc = bytearray(srgb)
for enc in ("utf-16-be", "ascii"):
    custom_icc = custom_icc.replace("sRGB built-in".encode(enc), "Maria Monitor".encode(enc))
assert b"M\x00a\x00r\x00i\x00a" in custom_icc or b"Maria" in custom_icc
picture().save(FX / "calibrated.jpg", quality=90, icc_profile=bytes(custom_icc))

# --- PNG: text chunks, XMP, eXIf, time, AI prompt
p = FX / "Screenshot_2026-11-20-14-32-05.png"
picture().save(p)
exif(p, "-PNG:Author=" + NAME, "-PNG:Software=Samsung Screen Capture", "-XMP-dc:Creator=" + NAME,
     "-EXIF:Make=samsung", "-EXIF:Model=SM-S928B", *GPS, "-PNG:ModifyDate=2026:11:20 14:32:05")
import struct
import zlib

png = p.read_bytes()
payload = b"parameters\0a portrait of my neighbour, 8k"
chunk = struct.pack(">I", len(payload)) + b"tEXt" + payload + struct.pack(">I", zlib.crc32(b"tEXt" + payload))
iend = png.rindex(b"IEND") - 4
p.write_bytes(png[:iend] + chunk + png[iend:])

# --- WebP with EXIF + XMP
p = FX / "photo.webp"
picture().save(p, "WEBP", quality=80, exif=Image.Exif())
exif(p, "-Make=Google", "-Model=Pixel 9", "-Artist=" + NAME, *GPS, "-XMP-dc:Creator=" + NAME, "-Orientation#=3")

# --- GIF with comment + XMP
p = FX / "anim.gif"
frames = [picture(200, 150, (i * 60, 80, 120)) for i in range(3)]
frames[0].save(p, save_all=True, append_images=frames[1:], loop=0, duration=200, comment=b"made by " + NAME.encode())
exif(p, "-XMP-dc:Creator=" + NAME)

# --- HEIC (iPhone format) with EXIF + GPS
src = FX / "heic_src.jpg"
picture().save(src, quality=92)
exif(src, *PHONE_TAGS)
run("heif-enc", "-q", "80", str(src), "-o", str(FX / "IMG_4521.HEIC"))
run("heif-enc", "-q", "60", "-A", str(src), "-o", str(FX / "photo.avif"))
os.remove(src)

# --- Videos
ffmpeg = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
# Android-style: ©xyz location in udta, moov at the start (faststart) so offsets matter
run(*ffmpeg, "-metadata", "location=+37.9754+023.7274/", "-metadata", "make=Google", "-metadata", "model=Pixel 9",
    "-metadata", "creation_time=2026-11-20T14:32:05Z", "-metadata", "artist=" + NAME,
    "-movflags", "+faststart", str(FX / "PXL_20261120_143205.mp4"))
# iPhone-style: Apple mdta keys in moov/meta
run(*ffmpeg, "-movflags", "use_metadata_tags",
    "-metadata", "com.apple.quicktime.location.ISO6709=+37.9754+023.7274+095.000/",
    "-metadata", "com.apple.quicktime.make=Apple", "-metadata", "com.apple.quicktime.model=iPhone 15 Pro",
    "-metadata", "com.apple.quicktime.software=18.1", "-metadata", "com.apple.quicktime.creationdate=2026-11-20T14:32:05+0200",
    "-metadata", "creation_time=2026-11-20T14:32:05Z", "-f", "mov", str(FX / "IMG_4522.MOV"))
exif(FX / "IMG_4522.MOV", "-XMP-dc:Creator=" + NAME)

# --- Audio
run("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac",
    "-metadata", "title=Voice memo", "-metadata", "artist=" + NAME, "-metadata", "creation_time=2026-11-20T14:32:05Z",
    "-metadata", "location=+37.9754+023.7274/", str(FX / "Voice 001.m4a"))
run("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libmp3lame",
    "-id3v2_version", "3", "-write_id3v1", "1", "-metadata", "title=Demo", "-metadata", "artist=" + NAME,
    "-metadata", "comment=recorded at home", str(FX / "song.mp3"))

# --- PDF with info dict, embedded GPS photo, then an incremental update (old revision keeps the old author)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

photo = FX / "pdf_photo.jpg"
picture().save(photo, quality=85)
exif(photo, *PHONE_TAGS)
p = FX / "report.pdf"
c = canvas.Canvas(str(p), pagesize=A4)
c.setAuthor(NAME)
c.setTitle("Secret report")
c.setSubject("Internal")
c.setCreator("Microsoft Word for Microsoft 365")
c.drawString(72, 800, "Hello, this is the report.")
c.drawImage(str(photo), 72, 400, width=320, height=240)
c.showPage()
c.save()
os.remove(photo)
exif(p, "-PDF:Author=Old " + NAME, "-XMP-dc:Creator=" + NAME)  # incremental update + XMP stream
exif(p, "-PDF:Author=" + NAME)

# --- DOCX with comments, tracked change, photo, custom props, template path, rsids, thumbnail
import docx
from docx.shared import Inches

photo = FX / "doc_photo.jpg"
picture().save(photo, quality=85)
exif(photo, *PHONE_TAGS)
d = docx.Document()
d.core_properties.author = NAME
d.core_properties.last_modified_by = NAME
d.core_properties.title = "CV"
d.core_properties.comments = "draft for the bank"
para = d.add_paragraph("Αυτό είναι ένα έγγραφο.")
d.add_comment(para.runs, text="Check this", author=NAME, initials="MP")
d.add_picture(str(photo), width=Inches(3))
buf = io.BytesIO()
d.save(buf)
os.remove(photo)


def patch_zip(data, edits, add=None):
    zin = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            content = zin.read(item.filename)
            if item.filename in edits:
                content = edits[item.filename](content.decode("utf-8")).encode("utf-8")
            zout.writestr(item, content)
        for name, content in (add or {}).items():
            zout.writestr(name, content)
    return out.getvalue()


CUSTOM = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
          'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
          '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>ACME Bank</vt:lpwstr></property>'
          '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="MSIP_Label_1234_Enabled"><vt:lpwstr>true</vt:lpwstr></property>'
          '</Properties>')
APP = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
       'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><TotalTime>187</TotalTime>'
       '<Application>Microsoft Office Word</Application><Company>ACME Bank S.A.</Company><Manager>Giorgos K.</Manager><AppVersion>16.0000</AppVersion></Properties>')
thumb = io.BytesIO()
picture(128, 96).save(thumb, "JPEG")


def add_rel(rels, rid, typ, target, external=False):
    mode = ' TargetMode="External"' if external else ""
    return rels.replace("</Relationships>", f'<Relationship Id="{rid}" Type="{typ}" Target="{target}"{mode}/></Relationships>')


def root_rels(x):
    x = add_rel(x, "rIdC1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties", "docProps/custom.xml")
    if "metadata/thumbnail" not in x:
        x = add_rel(x, "rIdT1", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail", "docProps/thumbnail.jpeg")
    if "extended-properties" not in x:
        x = add_rel(x, "rIdA1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", "docProps/app.xml")
    return x


def content_types(x):
    x = x.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>')
    if 'Extension="jpeg"' not in x:
        x = x.replace("</Types>", '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>')
    if "/docProps/app.xml" not in x:
        x = x.replace("</Types>", '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>')
    return x


def word_doc(x):
    x = x.replace("<w:p>", '<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">', 1)
    return x.replace("</w:body>", '<w:p><w:ins w:id="901" w:author="' + NAME + '" w:date="2026-11-01T10:00:00Z"><w:r><w:t>inserted text</w:t></w:r></w:ins></w:p></w:body>')


def word_settings(x):
    x = re.sub(r"(<w:settings\b[^>]*>)", r'\1<w:attachedTemplate r:id="rIdTpl1"/>', x, count=1)
    if "xmlns:r=" not in x:
        x = x.replace("<w:settings ", '<w:settings xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
    return x.replace("</w:settings>", '<w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/></w:rsids></w:settings>')


SETTINGS_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rIdTpl1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" '
                 'Target="file:///C:\\Users\\mpapadopoulou\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm" TargetMode="External"/></Relationships>')
names = zipfile.ZipFile(io.BytesIO(buf.getvalue())).namelist()
data = patch_zip(buf.getvalue(), {
    "_rels/.rels": root_rels, "[Content_Types].xml": content_types,
    "word/document.xml": word_doc, "word/settings.xml": word_settings,
    **({"docProps/app.xml": lambda _: APP} if "docProps/app.xml" in names else {}),
}, add={"docProps/custom.xml": CUSTOM, **({} if "docProps/thumbnail.jpeg" in names else {"docProps/thumbnail.jpeg": thumb.getvalue()}), "word/_rels/settings.xml.rels": SETTINGS_RELS,
        **({} if "docProps/app.xml" in names else {"docProps/app.xml": APP})})
(FX / "CV_final.docx").write_bytes(data)

# --- XLSX with comment author, absolute path, printer settings, hidden sheet
import openpyxl
from openpyxl.comments import Comment

wb = openpyxl.Workbook()
wb.properties.creator = NAME
wb.properties.lastModifiedBy = NAME
ws = wb.active
ws["A1"] = "Salary"
ws["B1"] = 1234
ws["A1"].comment = Comment("confidential", NAME)
hidden = wb.create_sheet("Secret")
hidden["A1"] = "hidden data"
hidden.sheet_state = "hidden"
buf = io.BytesIO()
wb.save(buf)


def workbook(x):
    absp = ('<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15ac">'
            '<x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\Users\\mpapadopoulou\\Documents\\Finance\\"/>'
            '</mc:Choice></mc:AlternateContent>')
    return re.sub(r"(<workbookPr\b[^>]*/>)", lambda m: absp + m.group(1), x, count=1)


def sheet1(x):
    if "<pageSetup" in x:
        return re.sub(r"<pageSetup\b", '<pageSetup r:id="rIdPS1"', x, count=1)
    return x.replace("</worksheet>", '<pageSetup orientation="portrait" r:id="rIdPS1"/></worksheet>')


def sheet1_rels(x):
    return add_rel(x, "rIdPS1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings", "../printerSettings/printerSettings1.bin")


zin = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
edits = {"xl/workbook.xml": workbook, "xl/worksheets/sheet1.xml": sheet1, "_rels/.rels": root_rels, "[Content_Types].xml": content_types}
add = {"xl/printerSettings/printerSettings1.bin": b"HP LaserJet M404 at ACME floor 3".ljust(256, b"\0"),
       "docProps/custom.xml": CUSTOM, "docProps/thumbnail.jpeg": thumb.getvalue()}
if "xl/worksheets/_rels/sheet1.xml.rels" in zin.namelist():
    edits["xl/worksheets/_rels/sheet1.xml.rels"] = sheet1_rels
else:
    add["xl/worksheets/_rels/sheet1.xml.rels"] = sheet1_rels('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')
if 'xmlns:r=' not in re.match(r"<worksheet\b[^>]*>", zin.read("xl/worksheets/sheet1.xml").decode()).group(0):
    prev = edits["xl/worksheets/sheet1.xml"]
    edits["xl/worksheets/sheet1.xml"] = lambda x: prev(x.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1))
prev_ct = edits["[Content_Types].xml"]
edits["[Content_Types].xml"] = lambda x: prev_ct(x).replace("</Types>", '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/></Types>') if 'Extension="bin"' not in x else prev_ct(x)
(FX / "budget.xlsx").write_bytes(patch_zip(buf.getvalue(), edits, add))

# --- PPTX with speaker notes and a GPS photo
from pptx import Presentation
from pptx.util import Inches as PInches

photo = FX / "ppt_photo.jpg"
picture().save(photo, quality=85)
exif(photo, *PHONE_TAGS)
prs = Presentation()
prs.core_properties.author = NAME
prs.core_properties.last_modified_by = NAME
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Q4 plan"
slide.shapes.add_picture(str(photo), PInches(1), PInches(2), width=PInches(4))
slide.notes_slide.notes_text_frame.text = "Don't tell them about the layoffs"
prs.save(FX / "deck.pptx")
os.remove(photo)

# --- ODT via LibreOffice (writes meta.xml with author, dates, editing time, thumbnail)
r = subprocess.run(["soffice", "--headless", "--convert-to", "odt", "--outdir", str(FX), str(FX / "CV_final.docx")], capture_output=True, text=True, timeout=180)
print(r.stdout.strip(), r.stderr.strip()[-300:])
print("fixtures:", ", ".join(sorted(x.name for x in FX.iterdir())))
