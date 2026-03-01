from __future__ import annotations
from datetime import datetime, date
from typing import Optional
from sqlmodel import SQLModel, Field, Relationship, UniqueConstraint

class Status(SQLModel, table=True):
    __tablename__ = "statuses"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)

class Chat(SQLModel, table=True):
    __tablename__ = "chats"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)

class Group(SQLModel, table=True):
    __tablename__ = "groups"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)

class Tag(SQLModel, table=True):
    __tablename__ = "tags"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)

class Network(SQLModel, table=True):
    __tablename__ = "networks"
    __table_args__ = (UniqueConstraint("frequency"),)

    id: Optional[int] = Field(default=None, primary_key=True)

    frequency: str = Field(index=True)  # normalized XXX.XXXX
    mask: Optional[str] = Field(default=None, index=True)  # normalized XXX.XXXX or null

    unit: str
    zone: str

    chat_id: int = Field(foreign_key="chats.id")
    group_id: int = Field(foreign_key="groups.id")
    status_id: int = Field(foreign_key="statuses.id")

    comment: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)

class NetworkTag(SQLModel, table=True):
    __tablename__ = "network_tags"
    network_id: int = Field(foreign_key="networks.id", primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", primary_key=True)

class Etalon(SQLModel, table=True):
    __tablename__ = "etalons"
    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", unique=True, index=True)

    # Stored fields only (generated fields are computed on display/export)
    start_date: Optional[date] = Field(default=None)
    correspondents: Optional[str] = None
    callsigns: Optional[str] = None  # MVP: read-only (can remain empty)
    purpose: Optional[str] = None
    operation_mode: Optional[str] = None
    traffic_type: Optional[str] = None

    raw_import_text: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)

class NetworkChange(SQLModel, table=True):
    __tablename__ = "network_changes"
    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", index=True)
    changed_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    changed_by: str

    field: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
