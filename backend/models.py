from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, JSON, Text

from backend.database import Base


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    roll_no = Column(String(50), index=True, nullable=False)
    course = Column(String(120), nullable=False)
    contact = Column(String(50), nullable=False)
    token = Column(String(20), unique=True, index=True, nullable=False)
    is_used = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    entry_at = Column(DateTime, nullable=True)
    extra_data = Column(JSON, nullable=False, default=dict)


class AppSettings(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, default=1)
    config = Column(JSON, nullable=False)
