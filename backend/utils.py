import re
import secrets
import string
import io

import qrcode


TOKEN_ALPHABET = string.ascii_uppercase + string.digits
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{1,20}")


def is_valid_token(token: str) -> bool:
    return bool(token) and _TOKEN_RE.fullmatch(token) is not None


def generate_token(min_length: int = 10, max_length: int = 15) -> str:
    token_length = secrets.randbelow(max_length - min_length + 1) + min_length
    return "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(token_length))


def generate_qr_image(token: str) -> io.BytesIO:
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(token)
    qr.make(fit=True)

    image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer
