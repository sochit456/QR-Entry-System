import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, validator

# Only letters and spaces are allowed in a student's name. This rejects
# digits and special characters such as < > <= >= + - _ etc.
NAME_PATTERN = re.compile(r"^[A-Za-z]+(?:[ ][A-Za-z]+)*$")


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

    @validator("name")
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Name cannot be empty.")
        if not NAME_PATTERN.match(cleaned):
            raise ValueError("Name cannot contain special characters.")
        return cleaned


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
