import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Only letters, numbers, spaces, apostrophes, periods, commas, and hyphens
# are allowed in free-text identity fields. This is a defense-in-depth
# control: even though the frontend always HTML-escapes this data before
# rendering it, restricting the accepted character set at the API boundary
# means the stored value can never contain the characters (<, >, ", ', /)
# needed to break out of an HTML tag or attribute in the first place.
NAME_ROLL_PATTERN = re.compile(r"^[A-Za-z0-9 '.,-]+$")


class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RegisterStudentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    roll_no: str = Field(..., min_length=1, max_length=50)
    course: Literal["BCA 1st", "BCA 2nd", "BCA 3rd", "PGDCA"]
    contact: str = Field(..., min_length=1, max_length=10)

    @field_validator("name", "roll_no")
    @classmethod
    def validate_allowed_characters(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        if not NAME_ROLL_PATTERN.match(value):
            raise ValueError(
                "Only letters, numbers, spaces, apostrophes, periods, "
                "commas, and hyphens are allowed."
            )
        return value


class RegisterStudentResponse(BaseModel):
    message: str
    token: str
    qr_code_url: str


class VerifyQRRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=20)


class VerifyQRResponse(BaseModel):
    status: Literal["VALID", "INVALID", "USED"]
    message: str


class EntryActionResponse(BaseModel):
    status: Literal["VALID", "USED"]
    message: str
    entry_at: Optional[datetime] = None


class ResetEntryResponse(BaseModel):
    message: str
    entry_at: Optional[datetime] = None


class StudentResponse(BaseModel):
    id: int
    name: str
    roll_no: str
    course: str
    contact: str
    token: str
    is_used: bool
    created_at: datetime
    entry_at: Optional[datetime] = None

    class Config:
        orm_mode = True
