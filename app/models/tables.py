"""SQLModel table definitions (optional/legacy ORM layer).

This module defines SQLModel models corresponding to SQLite tables used by
the application. The project primarily uses direct `sqlite3` access in
`app.core.db` and service/repository modules; these models are useful for:

- type hints and schema reference in IDEs,
- future refactors toward SQLModel/ORM usage,
- documentation of table fields.

Important:
    The SQLite schema in production is the source of truth. If the database
    schema evolves (e.g., columns removed/renamed), this module may require
    updates to stay in sync.
"""

from __future__ import annotations

from datetime import datetime, date
from typing import Optional

from sqlmodel import SQLModel, Field, UniqueConstraint


class Status(SQLModel, table=True):
    """Reference status row (used for network/UI statuses)."""
    __tablename__ = "statuses"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    bg_color: Optional[str] = None
    border_color: Optional[str] = None


class Chat(SQLModel, table=True):
    """Chat reference row."""
    __tablename__ = "chats"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)


class Group(SQLModel, table=True):
    """Group reference row."""
    __tablename__ = "groups"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)


class Tag(SQLModel, table=True):
    """Tag reference row used for message/network tagging."""
    __tablename__ = "tags"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    template: str = Field(default="")


class Network(SQLModel, table=True):
    """Radio network definition row."""
    __tablename__ = "networks"
    __table_args__ = (UniqueConstraint("frequency"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    frequency: str = Field(index=True)
    mask: Optional[str] = Field(default=None, index=True)
    unit: str
    zone: str
    chat_id: int = Field(foreign_key="chats.id")
    group_id: int = Field(foreign_key="groups.id")
    status_id: int = Field(foreign_key="statuses.id")
    comment: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    net_key: Optional[str] = None


class NetworkAlias(SQLModel, table=True):
    """Alias row used to resolve structured intercepts to networks."""
    __tablename__ = "network_aliases"

    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", index=True)
    alias_text: str
    alias_norm: str = Field(index=True, unique=True)
    is_archived: int = Field(default=0)
    created_at: Optional[str] = None


class NetworkTagDef(SQLModel, table=True):
    """Dictionary table for network-only tags (UI labels)."""
    __tablename__ = "network_tags"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)


class NetworkTagLink(SQLModel, table=True):
    """Many-to-many link table for networks and network tags."""
    __tablename__ = "network_tag_links"

    network_id: int = Field(foreign_key="networks.id", primary_key=True)
    tag_id: int = Field(foreign_key="network_tags.id", primary_key=True)


class Etalon(SQLModel, table=True):
    """Etalon (reference) description for a network."""
    __tablename__ = "etalons"

    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", unique=True, index=True)
    start_date: Optional[date] = Field(default=None)
    end_date: Optional[date] = Field(default=None)
    correspondents: Optional[str] = None
    callsigns: Optional[str] = None
    purpose: Optional[str] = None
    operation_mode: Optional[str] = None
    traffic_type: Optional[str] = None
    raw_import_text: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class NetworkChange(SQLModel, table=True):
    """Audit log row for changes to networks."""
    __tablename__ = "network_changes"

    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", index=True)
    changed_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    changed_by: str
    field: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None


class IngestMessage(SQLModel, table=True):
    """Raw incoming message preserved for traceability."""
    __tablename__ = "ingest_messages"

    id: Optional[int] = Field(default=None, primary_key=True)
    platform: str
    source_chat_id: Optional[str] = None
    source_chat_name: Optional[str] = None
    source_message_id: str
    source_file_name: Optional[str] = None
    source_row_number: Optional[int] = None
    raw_text: str
    normalized_text: Optional[str] = None
    published_at_text: Optional[str] = None
    received_at: str
    message_format: Optional[str] = None
    parse_status: str
    parse_error: Optional[str] = None


class Message(SQLModel, table=True):
    """Parsed/normalized intercept message stored in the database."""
    __tablename__ = "messages"

    id: Optional[int] = Field(default=None, primary_key=True)
    ingest_id: int = Field(foreign_key="ingest_messages.id", index=True)
    network_id: int = Field(foreign_key="networks.id", index=True)
    created_at: str = Field(index=True)
    received_at: str
    net_description: Optional[str] = None
    body_text: str
    comment: Optional[str] = None
    parse_confidence: float = 1.0
    is_valid: int = 1
    delay_sec: Optional[int] = None
    need_approve: int = 0
    tags_json: str = "[]"


class CallsignSource(SQLModel, table=True):
    """Reference row for callsign sources."""
    __tablename__ = "callsign_sources"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)


class CallsignStatus(SQLModel, table=True):
    """Reference row for callsign statuses."""
    __tablename__ = "callsign_statuses"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    icon: Optional[str] = None


class Callsign(SQLModel, table=True):
    """Callsign entity scoped to a network."""
    __tablename__ = "callsigns"
    __table_args__ = (UniqueConstraint("network_id", "name"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: Optional[int] = Field(default=None, foreign_key="networks.id", index=True)
    name: str = Field(index=True)
    status_id: Optional[int] = Field(default=None, foreign_key="callsign_statuses.id")
    comment: Optional[str] = None
    updated_at: str
    last_seen_dt: Optional[str] = None
    callsign_status_id: Optional[int] = None
    source_id: Optional[int] = Field(default=None, foreign_key="callsign_sources.id")


class CallsignStatusMap(SQLModel, table=True):
    """Many-to-many link table for callsigns and statuses."""
    __tablename__ = "callsign_status_map"

    callsign_id: int = Field(foreign_key="callsigns.id", primary_key=True)
    status_id: int = Field(foreign_key="callsign_statuses.id", primary_key=True)


class MessageCallsign(SQLModel, table=True):
    """Link table between messages and callsigns with a role."""
    __tablename__ = "message_callsigns"

    message_id: int = Field(foreign_key="messages.id", primary_key=True)
    callsign_id: int = Field(foreign_key="callsigns.id", primary_key=True)
    role: str = Field(primary_key=True)


class CallsignEdge(SQLModel, table=True):
    """Aggregated interaction edge between callsigns in a network."""
    __tablename__ = "callsign_edges"

    id: Optional[int] = Field(default=None, primary_key=True)
    network_id: int = Field(foreign_key="networks.id", index=True)
    a_callsign_id: int = Field(foreign_key="callsigns.id", index=True)
    b_callsign_id: int = Field(foreign_key="callsigns.id", index=True)
    first_seen_dt: str
    last_seen_dt: str
    cnt: int = 1


class MessageTag(SQLModel, table=True):
    """Many-to-many link table between messages and tags."""
    __tablename__ = "message_tags"

    message_id: int = Field(foreign_key="messages.id", primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", primary_key=True)


class PelengBatch(SQLModel, table=True):
    """Peleng batch header row."""
    __tablename__ = "peleng_batches"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_dt: str
    frequency: str


class PelengPoint(SQLModel, table=True):
    """Peleng point row belonging to a batch."""
    __tablename__ = "peleng_points"

    id: Optional[int] = Field(default=None, primary_key=True)
    batch_id: int = Field(foreign_key="peleng_batches.id", index=True)
    mgrs: str


class Word(SQLModel, table=True):
    """Word rule row used by tag analysis."""
    __tablename__ = "words"

    id: Optional[int] = Field(default=None, primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", index=True)
    word: str
    probability: int = 0
    exceptions: str = "[]"
