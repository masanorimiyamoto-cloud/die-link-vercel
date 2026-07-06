# -*- coding: utf-8 -*-
"""棚登録用QRラベルPNGの一括生成（scan-register.html 用）

C:\\ai\\QR に LOC-A-1.png 〜 LOC-A-20.png を出力する。
レイアウトはサンプルと同じ「上=棚コード / 中央=QR / 下=QRの中身」。
QRの中身は loc-<棚コード>（例: loc-LOC-A-1）。
"""
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from PIL import Image, ImageDraw, ImageFont

# ==== 設定 ====
OUT_DIR = Path(r"C:\ai\QR")
PREFIX = "LOC-A"
START, END = 1, 20
PAD = 0            # 番号の桁数。0=そのまま(1,2,...)、2にすると 01,02,...
BOX_SIZE = 20      # QRの1モジュールのピクセル数（20で1辺約600px、印刷向け高解像度）
QUIET = 4          # クワイエットゾーン（モジュール数、規格推奨4）
TITLE_PT = 90      # 上部の棚コード文字サイズ
CAPTION_PT = 44    # 下部の中身テキスト文字サイズ
WITH_TEXT = True   # False にするとQR単体のPNGになる


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = ["arialbd.ttf", "arial.ttf"] if bold else ["arial.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def make_label(code: str) -> Image.Image:
    payload = f"loc-{code}"

    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=BOX_SIZE, border=QUIET)
    qr.add_data(payload)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    if not WITH_TEXT:
        return qr_img

    title_font = load_font(TITLE_PT, bold=True)
    caption_font = load_font(CAPTION_PT)

    side_pad = BOX_SIZE * 2
    title_h = TITLE_PT + BOX_SIZE * 2
    caption_h = CAPTION_PT + BOX_SIZE * 3
    width = qr_img.width + side_pad * 2
    height = title_h + qr_img.height + caption_h

    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    def draw_centered(text: str, font: ImageFont.FreeTypeFont, y: int) -> None:
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(((width - (box[2] - box[0])) // 2 - box[0], y), text, font=font, fill="black")

    draw_centered(code, title_font, BOX_SIZE)
    canvas.paste(qr_img, (side_pad, title_h))
    draw_centered(payload, caption_font, title_h + qr_img.height + BOX_SIZE // 2)
    return canvas


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for i in range(START, END + 1):
        num = str(i).zfill(PAD) if PAD else str(i)
        code = f"{PREFIX}-{num}"
        path = OUT_DIR / f"{code}.png"
        make_label(code).save(path)
        print(f"OK  {path}")


if __name__ == "__main__":
    main()
