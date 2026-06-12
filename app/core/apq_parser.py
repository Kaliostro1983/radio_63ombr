"""AlpineQuest (APQ) binary parser — Python port.

Port of `D:\\Armor\\goi-docs\\src\\app__utils__apq__apq-parser.ts` (GOIapp 1.4.3).
Reads AlpineQuest native files (.wpt / .set / .rte / .trk / .are / .ldk) from
raw bytes and turns them into geometry dicts: `Point`, `Line` or `Polygon` with
`name`, `observationDatetime`, `metadata`, `outlineColor` properties.

Public API:
    parse_apq(data, name=None, file_type=None) -> ApqFile
    extract_geometries(apq) -> list[dict]
    apq_to_features(data, name=None) -> list[dict]  (one-shot convenience)

Big-endian throughout; pure stdlib (`struct`, `base64`, `datetime`, `logging`).
Behaviour parity with the TS original — see `LDK_PARSING.md`.
"""

from __future__ import annotations

import base64
import logging
import struct
from datetime import datetime, timedelta, timezone
from typing import Any

log = logging.getLogger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

SUPPORTED_APQ_EXTENSIONS = [".ldk", ".set", ".trk", ".wpt", ".are", ".rte"]
_EXT_TO_TYPE = {"wpt": "wpt", "set": "set", "rte": "rte", "are": "are", "trk": "trk", "ldk": "ldk"}

MAGIC_MAP = {
    5263370:    "wpt",
    5263371:    "set",
    5263372:    "rte",
    5263373:    "are",
    5263374:    "trk",
    4998219:    "ldk",
    1279544122: "ldk",   # "LDK:"
}

MAX_REASONABLE_STRING_LEN = 2 * 1024 * 1024   # 2 MB
MAX_REASONABLE_ENTRIES    = 5_000_000

DEFAULT_COLOR = "#663399"


# ─── Exceptions ───────────────────────────────────────────────────────────────

class ApqParserError(Exception):    pass
class InvalidHeaderError(ApqParserError): pass
class InvalidDataError(ApqParserError):   pass


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _coord_from_int(n: int) -> float:
    """AlpineQuest stores coordinates as int32 scaled by 1e7."""
    return n * 1e-7


def detect_file_type_from_magic(data: bytes) -> str | None:
    if not data or len(data) < 4:
        return None
    # "LDK:"
    if data[0] == 76 and data[1] == 68 and data[2] == 75 and data[3] == 58:
        return "ldk"
    # "PP" + sub-type byte
    if data[0] == 80 and data[1] == 80 and len(data) > 2:
        t = data[2]
        if t == 10: return "wpt"
        if t == 11: return "set"
        if t == 12: return "rte"
        if t == 13: return "are"
        if t == 14: return "trk"
    return None


def detect_file_type_from_name(name: str | None) -> str | None:
    if not name:
        return None
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    if base == "tracker.data":
        return "tracker_data"
    if "." not in base:
        return None
    ext = base.rsplit(".", 1)[1].lower()
    if ext == "data":
        return "tracker_data"
    return _EXT_TO_TYPE.get(ext)


def detect_apq_file_type(data: bytes, name: str | None = None) -> str | None:
    return detect_file_type_from_name(name) or detect_file_type_from_magic(data)


# ─── Core parser ──────────────────────────────────────────────────────────────

class ApqFile:
    """Bottom-up binary parser. Mirrors TS `ApqFile` for behaviour parity."""

    def __init__(
        self,
        data: bytes,
        file_type: str | None = None,
        rawname: str | None = None,
        path: str | None = None,
        rawts: float | None = None,
    ):
        self.path     = path
        self.rawname  = rawname
        self.rawts    = rawts if rawts is not None else datetime.now().timestamp()
        self.rawoffs  = 0
        self.version  = 0
        self.parse_successful = False
        self.data_parsed: dict[str, Any] = {}
        self._force_skip_wp_meta = False

        ft = (file_type or "").lower() if file_type else None
        if not ft:
            ft = detect_apq_file_type(data, self.rawname or self.path)

        if data is None or not ft:
            raise ApqParserError(
                "Invalid ApqFile params: both data and fileType are required."
            )
        self.rawdata = data
        self._file_type = ft
        if not self.path:
            self.path = self.rawname
        self.rawsize = len(data)

        try:
            self.parse_successful = self._run_parse()
        except (ApqParserError, InvalidDataError) as err:
            msg = str(err)
            should_retry = (
                self._file_type in ("rte", "set")
                and (
                    "1694499" in msg or "0x102" in msg
                    or "metadata entry count" in msg
                    or (self.version < 100 and isinstance(err, InvalidDataError))
                )
                and not self._force_skip_wp_meta
            )
            if should_retry:
                log.debug("Retry %s with WP-meta skip: %s", self._file_type, msg)
                self._force_skip_wp_meta = True
                self.rawoffs = 0
                self.data_parsed = {}
                self.parse_successful = self._run_parse()
                if self.parse_successful:
                    return
            self.parse_successful = False
            raise
        except Exception as err:  # noqa: BLE001
            self.parse_successful = False
            raise ApqParserError(
                f"Unknown exception parsing {self._file_type}: {err}"
            ) from err

    def type(self) -> str:
        return self._file_type

    def get_parsed_data(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ts":   self.rawts,
            "type": self._file_type,
            "path": self.path or self.rawname,
            "file": (self.path or self.rawname or "unknown").rsplit("/", 1)[-1].rsplit("\\", 1)[-1],
            "parse_successful": self.parse_successful,
        }
        if self.parse_successful:
            out.update(self.data_parsed)
        return out

    def _run_parse(self) -> bool:
        dispatch = {
            "wpt": self._parse_wpt,
            "set": self._parse_set,
            "rte": self._parse_rte,
            "are": self._parse_are,
            "trk": self._parse_trk,
            "ldk": self._parse_ldk,
            "tracker_data": self._parse_tracker_data,
        }
        fn = dispatch.get(self._file_type)
        return fn() if fn else False

    # ─── Cursor ───────────────────────────────────────────────────────────────

    def _tell(self) -> int: return self.rawoffs
    def _seek(self, off: int) -> int:
        self.rawoffs = off
        return self.rawoffs
    def _size(self) -> int: return self.rawsize

    # ─── Typed readers ────────────────────────────────────────────────────────

    def _get_val(self, type_: str, size: int | None = None) -> Any:
        """Read a single typed value (big-endian). Returns None at EOF."""
        start = self.rawoffs
        d, off, n = self.rawdata, self.rawoffs, self.rawsize

        if type_ == "int":
            if off + 4 > n: return None
            v = struct.unpack_from(">i", d, off)[0]
            self.rawoffs += 4
            return v
        if type_ == "bool":
            if off + 1 > n: return None
            v = d[off] != 0
            self.rawoffs += 1
            return v
        if type_ == "byte":
            if off + 1 > n: return None
            v = struct.unpack_from(">b", d, off)[0]
            self.rawoffs += 1
            return v
        if type_ == "ubyte":
            if off + 1 > n: return None
            v = d[off]
            self.rawoffs += 1
            return v
        if type_ == "long":
            if off + 8 > n: return None
            v = struct.unpack_from(">q", d, off)[0]
            self.rawoffs += 8
            return v
        if type_ == "pointer":
            # uint64 BE used for file offsets
            if off + 8 > n: return None
            v = struct.unpack_from(">Q", d, off)[0]
            self.rawoffs += 8
            return v
        if type_ == "double":
            if off + 8 > n: return None
            v = struct.unpack_from(">d", d, off)[0]
            self.rawoffs += 8
            return v
        if type_ == "short":
            if off + 2 > n: return None
            v = struct.unpack_from(">h", d, off)[0]
            self.rawoffs += 2
            return v
        if type_ == "ushort":
            if off + 2 > n: return None
            v = struct.unpack_from(">H", d, off)[0]
            self.rawoffs += 2
            return v
        if type_ == "int+raw":
            sz = self._get_val("int")
            if sz is None or sz < 0 or sz > MAX_REASONABLE_STRING_LEN * 10:
                raise InvalidDataError(f"Invalid size ({sz}) for int+raw")
            if self.rawoffs + sz > n: return None
            chunk = d[self.rawoffs:self.rawoffs + sz]
            self.rawoffs += sz
            return base64.b64encode(chunk).decode("ascii")
        if type_ in ("raw", "bin"):
            sz = size
            if sz is None or sz < 0 or sz > MAX_REASONABLE_STRING_LEN * 100:
                raise InvalidDataError(f"Invalid size ({sz}) for '{type_}'")
            if self.rawoffs + sz > n: return None
            chunk = d[self.rawoffs:self.rawoffs + sz]
            self.rawoffs += sz
            return chunk if type_ == "bin" else base64.b64encode(chunk).decode("ascii")
        if type_ == "string":
            sz = size
            if sz is None or sz < 0 or sz > MAX_REASONABLE_STRING_LEN:
                raise InvalidDataError(f"Invalid size ({sz}) for string")
            if self.rawoffs + sz > n: return None
            chunk = d[self.rawoffs:self.rawoffs + sz]
            self.rawoffs += sz
            try:
                return chunk.decode("utf-8")
            except UnicodeDecodeError:
                log.debug("UTF-8 decode fallback at 0x%X", start)
                return chunk.decode("utf-8", errors="replace")
        if type_ == "coords":
            v = self._get_val("int")
            return _coord_from_int(v) if v is not None else None
        if type_ == "height":
            v = self._get_val("int")
            if v is None: return None
            return None if v == -999999999 else v * 0.001
        if type_ == "timestamp":
            v = self._get_val("long")
            if v is None: return None
            return None if v == 0 else v * 0.001
        if type_ == "accuracy":
            v = self._get_val("int")
            if v is None: return None
            return None if v == 0 else v
        if type_ == "accuracy2":
            v = self._get_val("int")
            if v is None: return None
            return None if v == 0 else v * 0.01
        if type_ == "pressure":
            v = self._get_val("int")
            if v is None: return None
            return None if v == 999999999 else v * 0.001

        log.warning("Unknown type '%s' in _get_val", type_)
        return None

    def _get_val_multi(self, spec: dict[str, Any]) -> dict[str, Any]:
        """Read a sequence of typed fields by name."""
        out: dict[str, Any] = {"_order": list(spec.keys())}
        start_off = self._tell()
        all_null = True
        critical = {"magic", "offset", "uid", "size", "metaOffset", "rootOffset",
                    "nTotal", "nChild", "nData"}
        for key, definition in spec.items():
            if isinstance(definition, (list, tuple)):
                tp, ln = definition[0], (definition[1] if len(definition) > 1 else None)
            else:
                tp, ln = definition, None
            v = self._get_val(tp, ln)
            out[key] = v
            if v is not None:
                all_null = False
            if v is None and key in critical:
                log.debug("Null critical field '%s' (%s) at 0x%X", key, tp, start_off)
        if all_null and start_off < self._size() - 8:
            log.debug("All fields null from 0x%X", start_off)
        return out

    # ─── Node data assembly (LDK chained blocks) ──────────────────────────────

    def _get_node_data(self, offset: int) -> bytes | None:
        if not (0 < offset < self.rawsize):
            log.debug("Invalid offset 0x%X for node data", offset)
            return None
        self._seek(offset)
        head = self._get_val_multi({
            "magic":     "int",
            "flags":     "int",
            "totalSize": "long",
            "size":      "long",
            "addOffset": "pointer",
        })
        if head["magic"] != 1070421:
            log.debug("Invalid data magic 0x%X at 0x%X",
                      head["magic"] or 0, offset)
            return None

        size = head["size"]
        if size is None or not (0 <= size <= self.rawsize - self._tell()):
            raise InvalidDataError(f"Wrong size ({size}) at 0x{offset:X}")
        main = self._get_val("bin", size)
        if main is None:
            raise InvalidDataError(f"Wrong block at 0x{self._tell() - size:X}")
        chunks: list[bytes] = [main]

        nxt = head["addOffset"]
        seen = {offset}
        while nxt and nxt not in seen and 0 < nxt < self.rawsize:
            seen.add(nxt)
            self._seek(nxt)
            ext = self._get_val_multi({
                "magic":     "int",
                "size":      "long",
                "addOffset": "pointer",
            })
            if ext["magic"] != 2118997:
                log.debug("Bad ext-data magic at 0x%X; chain stop", nxt)
                break
            ext_size = ext["size"]
            if ext_size is None or not (0 <= ext_size <= self.rawsize - self._tell()):
                raise InvalidDataError(f"Wrong ext size ({ext_size}) at 0x{nxt:X}")
            ext_data = self._get_val("bin", ext_size)
            if ext_data is None:
                raise InvalidDataError(f"Can't read ext at 0x{self._tell() - ext_size:X}")
            chunks.append(ext_data)
            nxt = ext["addOffset"]

        out = b"".join(chunks)
        declared = head["totalSize"]
        if declared is not None and len(out) != declared:
            log.debug("Block size at 0x%X differs: declared=%d got=%d",
                      offset, declared, len(out))
        return out

    # ─── Header + metadata + location ────────────────────────────────────────

    def _check_header(self, *versions: int) -> int:
        v = self._get_val("int")
        if v is None:
            raise InvalidHeaderError("Failed to read file version.")
        # "PP\0\0" prefix → low byte + 100
        if (v & 1347420160) == 1347420160:
            v = (v & 0xFF) + 100
        header_size = self._get_val("int")
        if header_size is None:
            raise InvalidHeaderError("Failed to read header size.")
        if header_size < 0 or header_size > self.rawsize or header_size > 1024:
            raise InvalidHeaderError(
                f"Invalid header size: {header_size} (file {self.rawsize})"
            )
        if versions and v not in versions:
            log.debug("Unexpected version %s (expected %s)", v, versions)
        self.version = v
        return header_size

    def _get_metadata(self, include_ext: bool = True) -> dict[str, Any]:
        meta_ver = 1
        if self.version > 100:
            meta_ver = 3
        elif (self._file_type == "trk" and self.version >= 3) or \
             (self._file_type != "trk" and self.version == 2):
            meta_ver = 2

        n_entries = self._get_val("int")
        if n_entries is None:
            raise InvalidDataError("Failed to read nMetaEntries.")
        meta: dict[str, Any] = {"_order": [], "_types": {}}

        if n_entries == 0:
            pass
        elif n_entries < -1 or n_entries > MAX_REASONABLE_ENTRIES:
            raise InvalidDataError(
                f"Invalid metadata entry count: {n_entries} at 0x{self._tell() - 4:X}"
            )
        elif n_entries != -1:
            for i in range(n_entries):
                name_len = self._get_val("int")
                if name_len is None or name_len < 0 or name_len > MAX_REASONABLE_STRING_LEN:
                    raise InvalidDataError(f"Invalid meta name length ({name_len}) at entry {i}")
                name = self._get_val("string", name_len)
                if name is None:
                    raise InvalidDataError(f"Failed to read meta name at entry {i}")
                type_code = self._get_val("int")
                if type_code is None:
                    raise InvalidDataError(f"Failed to read type/length for '{name}'")

                typed_map = {-1: "bool", -2: "long", -3: "double", -4: "int+raw"}
                if type_code in typed_map:
                    val_type = typed_map[type_code]
                    value = self._get_val(val_type)
                elif type_code >= 0:
                    if type_code > MAX_REASONABLE_STRING_LEN:
                        raise InvalidDataError(f"String length too large ({type_code}) for meta '{name}'")
                    val_type = "string"
                    value = self._get_val("string", type_code)
                else:
                    raise InvalidDataError(f"Unknown meta type {type_code} for '{name}'")

                meta[name] = value
                meta["_order"].append(name)
                meta["_types"][name] = val_type

        if meta_ver == 3 and n_entries >= 0:
            self._get_val("int")

        if include_ext and meta_ver >= 2:
            n_ext = self._get_val("int")
            if n_ext is None:
                raise InvalidDataError("Failed to read nMetaExt.")
            if n_ext > 0:
                for _i in range(n_ext):
                    l = self._get_val("int")
                    if l and l > 0:
                        self._get_val("string", l)
                    self._get_metadata(False)
            elif n_ext < -1:
                raise InvalidDataError(f"Invalid nMetaExt: {n_ext}")

        return meta

    @staticmethod
    def _new_location() -> dict[str, Any]:
        return {
            "lat": None, "lon": None, "alt": None, "ts": None,
            "acc": None, "bar": None, "batt": None, "acc_v": None,
            "cell":  {"gen": None, "prot": None, "sig": None},
            "numsv": {"tot": 0, "unkn": None, "G": None, "S": None,
                      "R": None, "J": None, "C": None, "E": None, "I": None},
        }

    def _get_location(self) -> dict[str, Any] | str:
        loc = self._new_location()
        start = self._tell()
        if self.rawoffs + 4 > self.rawsize:
            raise InvalidDataError(f"Not enough data for Location at 0x{start:X}")
        flag = self._get_val("int")
        if flag is None:
            raise InvalidDataError(f"Failed to read Location flag at 0x{start:X}")

        expected_end = -1
        field_map = {
            97:  ("accuracy2",  4),
            101: ("height",     4),
            112: ("pressure",   4),
            116: ("timestamp",  8),
            98:  ("byte",       1),
            110: ("group_net",  2),
            115: ("group_sats", 8),
            118: ("accuracy2",  4),
        }
        SAT_KEYS = ("unkn", "G", "S", "R", "J", "C", "E", "I")

        def parse_v2_fields(end: int) -> None:
            while self._tell() < end and not (self.rawoffs + 1 > self.rawsize):
                code = self._get_val("byte")
                if code is None:
                    break
                if code not in field_map:
                    log.debug("Unknown loc field code 0x%X; skipping rest", code & 0xFF)
                    self._seek(end)
                    break
                kind, ln = field_map[code]
                if self._tell() + ln > end:
                    break
                if kind == "accuracy2":
                    if code == 97:
                        loc["acc"]   = self._get_val(kind)
                    else:
                        loc["acc_v"] = self._get_val(kind)
                elif kind == "height":
                    loc["alt"]  = self._get_val(kind)
                elif kind == "pressure":
                    loc["bar"]  = self._get_val(kind)
                elif kind == "timestamp":
                    loc["ts"]   = self._get_val(kind)
                elif kind == "byte":
                    loc["batt"] = self._get_val(kind)
                elif kind == "group_net":
                    u = self._get_val("byte")
                    g = self._get_val("byte")
                    loc["cell"]["sig"] = g
                    if u is not None:
                        loc["cell"]["gen"]  = u // 10
                        loc["cell"]["prot"] = u % 10
                elif kind == "group_sats":
                    total = 0
                    for key in SAT_KEYS:
                        p = self._get_val("byte")
                        if p is None:
                            break
                        loc["numsv"][key] = p
                        if isinstance(p, int):
                            total += p
                    loc["numsv"]["tot"] = total

        if flag == -1:
            if self.rawoffs + 4 > self.rawsize:
                raise InvalidDataError(f"Not enough data after flag -1 at 0x{start:X}")
            nxt = self._get_val("int")
            if nxt is None:
                raise InvalidDataError(f"Failed to read 2nd int after flag -1 at 0x{self._tell() - 4:X}")
            if 8 <= nxt <= 256:
                struct_size = nxt
                expected_end = self._tell() + struct_size
                if expected_end > self.rawsize:
                    raise InvalidDataError(
                        f"struct_size ({struct_size}) exceeds file at 0x{start:X}"
                    )
                loc["lon"] = self._get_val("coords")
                loc["lat"] = self._get_val("coords")
                if loc["lon"] is None or loc["lat"] is None:
                    raise InvalidDataError("Failed to read lon/lat in Location (-1/V2)")
                parse_v2_fields(expected_end)
                # Variant 3: struct_size=8 with 8 zero-padding bytes
                if (struct_size == 8 and self._tell() == expected_end
                        and self.rawoffs + 8 <= self.rawsize
                        and all(b == 0 for b in self.rawdata[self.rawoffs:self.rawoffs + 8])):
                    self._get_val("raw", 8)
                if self._tell() != expected_end:
                    log.debug("Loc (-1/V2): realign 0x%X→0x%X", self._tell(), expected_end)
                    self._seek(expected_end)
            else:
                # simple -1 subtype: ignore the second int, read coords directly
                loc["lon"] = self._get_val("coords")
                loc["lat"] = self._get_val("coords")
        elif 8 <= flag <= 256:
            struct_size = flag
            variant = 2 if self.version > 100 else 1
            expected_end = start + 4 + struct_size
            if expected_end > self.rawsize:
                raise InvalidDataError(
                    f"struct_size ({struct_size}) exceeds file at 0x{start:X}"
                )
            loc["lon"] = self._get_val("coords")
            loc["lat"] = self._get_val("coords")
            if loc["lon"] is None or loc["lat"] is None:
                raise InvalidDataError("Failed to read lon/lat in Location (V1/V2)")
            if variant == 1:
                if self._tell() + 4 <= expected_end: loc["alt"] = self._get_val("height")
                if self._tell() + 8 <= expected_end: loc["ts"]  = self._get_val("timestamp")
                if self._tell() + 4 <= expected_end: loc["acc"] = self._get_val("accuracy")
                if self._tell() + 4 <= expected_end: loc["bar"] = self._get_val("pressure")
            else:
                parse_v2_fields(expected_end)
            if self._tell() != expected_end:
                log.debug("Loc (V1/V2): realign 0x%X→0x%X", self._tell(), expected_end)
                self._seek(expected_end)
        elif flag != 0:
            # legacy format: `flag` is actually lon*1e7
            log.debug("Legacy Location at 0x%X; first value %s", start, flag)
            loc["lon"] = flag * 1e-7
            loc["lat"] = self._get_val("coords")
            if loc["lat"] is None:
                raise InvalidDataError(f"Failed legacy Location at 0x{self._tell():X}")
        else:
            # flag == 0 → padding entry
            if self.rawoffs + 4 <= self.rawsize:
                self._get_val("int")
            return "PADDING"

        if expected_end >= 0 and expected_end <= self.rawsize and self._tell() != expected_end:
            self._seek(expected_end)
        return loc

    # ─── Bulk readers ────────────────────────────────────────────────────────

    def _get_waypoints(self, header_count: int | None = None) -> list[dict]:
        result: list[dict] = []
        start = self._tell()
        if self.rawoffs + 4 > self.rawsize:
            raise InvalidDataError(f"Not enough data for waypoint count at 0x{start:X}")
        stream_count = self._get_val("int")
        count = stream_count
        if header_count is not None and stream_count != header_count:
            if header_count > 0 and 0 < stream_count < 256:
                log.debug("RTE legacy: stream %d != header %d; using header", stream_count, header_count)
                self._seek(start)
                count = header_count
            elif stream_count == -1:
                log.debug("RTE legacy: -1 padding instead of count; using header %d", header_count)
                d = self._get_val("int")
                if d == header_count:
                    count = d
                else:
                    self._seek(start)
                    count = header_count

        if count is None or not (0 <= count < 1_000_000):
            raise InvalidDataError(f"Invalid waypoint count: {count} at 0x{start:X}")

        read_meta = True
        if (self._file_type == "rte" and self.version < 100) or \
           (self._file_type == "are" and self.version < 100):
            read_meta = False
        if self._force_skip_wp_meta:
            read_meta = False

        got = 0
        attempts = 0
        max_attempts = count * 3
        include_ext = self._file_type != "rte"
        while got < count and attempts < max_attempts:
            attempts += 1
            try:
                meta = self._get_metadata(include_ext) if read_meta else {"_raw_entries": 0}
                if meta is None and read_meta:
                    log.debug("Metadata error for waypoint; skipping")
                    continue
                location = self._get_location()
                if location == "PADDING":
                    continue
                result.append({"meta": meta, "location": location})
                got += 1
            except InvalidDataError as e:
                log.debug("Skipped corrupt waypoint (attempt %d): %s", attempts, e)
                continue
        if got < count:
            log.debug("Read fewer waypoints (%d) than expected (%d)", got, count)
        return result

    def _get_locations(self) -> list[dict]:
        result: list[dict] = []
        n = self._get_val("int")
        if n is None or n < 0 or n > MAX_REASONABLE_ENTRIES * 10:
            raise InvalidDataError(f"Invalid Locations count (ARE): {n}")
        for _i in range(n):
            loc = self._get_location()
            if loc == "PADDING":
                continue
            result.append(loc)
        return result

    def _get_segment(self) -> dict[str, Any]:
        seg_ver = 2 if (self._file_type == "trk" and self.version >= 3) else 1
        meta = self._get_metadata() if seg_ver == 2 else {}
        if meta is None and seg_ver == 2:
            meta = {}
        n = self._get_val("int")
        if n == -1:
            n = 0
        if n is None or n < 0 or n > MAX_REASONABLE_ENTRIES * 100:
            raise InvalidDataError(f"Invalid Segment locations count: {n}")
        locations: list[dict] = []
        for _i in range(n):
            loc = self._get_location()
            if loc == "PADDING":
                continue
            locations.append(loc)
        return {"meta": meta, "locations": locations}

    def _get_segments(self) -> list[dict]:
        result: list[dict] = []
        n = self._get_val("int")
        if n is None or n < 0 or n > MAX_REASONABLE_ENTRIES:
            raise InvalidDataError(f"Invalid Segments count: {n} at 0x{self._tell() - 4:X}")
        for _i in range(n):
            result.append(self._get_segment())
        return result

    def _get_areapolygon(self) -> dict[str, Any]:
        poly: dict[str, Any] = {"meta": {}, "outer_boundary": [], "holes": []}
        meta = self._get_metadata(False)
        if meta is None:
            raise InvalidDataError("Failed to read polygon metadata.")
        poly["meta"] = meta
        poly["outer_boundary"] = self._get_locations()
        n_holes = self._get_val("int")
        if n_holes is None or n_holes < 0 or n_holes > MAX_REASONABLE_ENTRIES:
            raise InvalidDataError(f"Invalid hole count: {n_holes}")
        for _i in range(n_holes):
            poly["holes"].append(self._get_locations())
        return poly

    def _get_areapolygons(self) -> list[dict]:
        result: list[dict] = []
        n = self._get_val("int")
        if n is None or n < 0 or n > MAX_REASONABLE_ENTRIES:
            raise InvalidDataError(f"Invalid polygon count: {n}")
        for _i in range(n):
            result.append(self._get_areapolygon())
        return result

    # ─── Per-format parsers ─────────────────────────────────────────────────

    def _parse_wpt(self) -> bool:
        header_size = self._check_header(2, 101)
        if self.version < 100 and header_size > 0:
            self._seek(self._tell() + header_size)
        self.data_parsed["meta"] = self._get_metadata()
        location = self._get_location()
        if location == "PADDING":
            location = None
        self.data_parsed["location"] = location
        return self.data_parsed.get("meta") is not None and self.data_parsed.get("location") is not None

    def _parse_set(self) -> bool:
        header_size = self._check_header(2, 101)
        header_count: int | None = None
        if self.version < 100:
            s = self._tell()
            self.data_parsed["legacy_header"] = self._get_val_multi({
                "nWaypoints": "int", "lon": "coords", "lat": "coords",
            })
            header_count = self.data_parsed["legacy_header"].get("nWaypoints")
            self._seek(s + header_size)
        else:
            self._get_metadata()
        self.data_parsed["meta"] = self._get_metadata()
        if self.data_parsed["meta"] is None:
            raise InvalidDataError("Failed to parse metadata for SET.")
        self.data_parsed["waypoints"] = self._get_waypoints(header_count)
        return True

    def _parse_rte(self) -> bool:
        if self._force_skip_wp_meta:
            log.debug("Re-parsing RTE with WP-meta skip")
            self.rawoffs = 0
            self.data_parsed = {}
            self.version = 0
        self._check_header(2, 101)
        after_header = self._tell()
        header_end = after_header
        if len(self.rawdata) > 8:
            declared = struct.unpack_from(">i", self.rawdata, 4)[0]
            header_end = after_header + declared
        header_count: int | None = None
        if self.version < 100:
            self.data_parsed["legacy_header"] = self._get_val_multi({
                "nWaypoints":           "int",
                "lon":                  "coords",
                "lat":                  "coords",
                "ts":                   "timestamp",
                "totalRouteLength":     "double",
                "totalTrackLengthElev": "double",
                "totalGain":            "double",
                "totalTime":            "long",
            })
            header_count = self.data_parsed["legacy_header"].get("nWaypoints")
            self.data_parsed["meta"] = self._get_metadata()
            if self.data_parsed["meta"] is None:
                raise InvalidDataError("Failed to parse route metadata (v2)")
            if self._tell() != header_end:
                if self._tell() > header_end:
                    log.debug("RTE: offset > header_end; trusting current")
                else:
                    self._seek(header_end)
        else:
            self._get_metadata()
            self.data_parsed["meta"] = self._get_metadata()
            if self.data_parsed["meta"] is None:
                raise InvalidDataError("Failed to parse route metadata (v101)")
            if self._tell() != header_end:
                self._seek(header_end)

        if header_count is not None and header_count > 0:
            before = self._tell()
            found = False
            for _i in range(25):
                if self._get_val("int") == header_count:
                    self._seek(self._tell() - 4)
                    found = True
                    break
            if not found:
                self._seek(before)

        self.data_parsed["waypoints"] = self._get_waypoints(header_count)
        if self._force_skip_wp_meta:
            self._force_skip_wp_meta = False
        return True

    def _parse_are(self) -> bool:
        header_size = self._check_header(2, 101)
        if self.version >= 100:
            self._get_metadata()
            self.data_parsed["meta"] = self._get_metadata()
            self.data_parsed["polygons"] = self._get_areapolygons()
            return self.data_parsed["meta"] is not None and self.data_parsed["polygons"] is not None
        start = self._tell()
        self.data_parsed["legacy_header"] = self._get_val_multi({
            "nLocations":  "int",
            "lon":         "coords",
            "lat":         "coords",
            "totalLength": "double",
            "totalArea":   "double",
        })
        self._seek(start + header_size)
        self.data_parsed["meta"] = self._get_metadata()
        if self.data_parsed["meta"] is None:
            raise InvalidDataError("Failed to parse metadata (v2 .are)")
        self.data_parsed["locations"] = self._get_locations()
        return True

    def _parse_trk(self) -> bool:
        header_size = self._check_header(2, 3, 101)
        data_start = self._tell() + header_size
        header_count: int | None = None
        if self.version < 100:
            self.data_parsed["legacy_header"] = self._get_val_multi({
                "nLocations":           "int",
                "nSegments":            "int",
                "nWaypoints":           "int",
                "lon":                  "coords",
                "lat":                  "coords",
                "ts":                   "timestamp",
                "totalTrackLength":     "double",
                "totalTrackLengthElev": "double",
                "totalGain":            "double",
                "totalTime":            "long",
            })
            header_count = self.data_parsed["legacy_header"].get("nWaypoints")
            if self._tell() < data_start:
                self._seek(data_start)
        else:
            try:
                self._get_metadata()
                self.data_parsed["meta"] = self._get_metadata()
            except Exception as e:  # noqa: BLE001
                log.debug("TRK metadata parse error: %s", e)
                if self.data_parsed.get("meta") is None:
                    self.data_parsed["meta"] = {"_error": str(e)}
            if self._tell() != data_start:
                self._seek(data_start)

        self.data_parsed["waypoints"] = self._get_waypoints(header_count) or []
        self.data_parsed["segments"]  = self._get_segments()
        return True

    def _parse_tracker_data(self) -> bool:
        self.data_parsed["segments"] = []
        segment: list[dict] = []
        while self.rawoffs < self.rawsize:
            tag = self._get_val("int")
            if tag is None:
                break
            if tag == 2000000001:
                if segment:
                    self.data_parsed["segments"].append(segment)
                    segment = []
            elif tag == 2000000004:
                loc = self._get_location()
                if loc and loc != "PADDING":
                    segment.append(loc)
            else:
                self.rawoffs -= 3
        if segment:
            self.data_parsed["segments"].append(segment)
        return True

    # ─── LDK container ──────────────────────────────────────────────────────

    def _parse_ldk(self) -> bool:
        self.data_parsed["items"] = []
        head = self._get_val_multi({
            "magic":       "int",
            "archVersion": "int",
            "rootOffset":  "pointer",
            "res1": "long", "res2": "long", "res3": "long", "res4": "long",
        })
        magic = head["magic"]
        if magic not in (4998219, 1279544122):
            raise InvalidHeaderError(
                f"Invalid LDK magic. Got 0x{(magic or 0):X}"
            )
        root = head["rootOffset"]
        if not root or root >= self.rawsize:
            raise InvalidDataError(f"Invalid root node offset: {root}")
        self._parse_ldk_node(root, [])
        return True

    def _parse_ldk_node(self, offset: int, path: list[str]) -> None:
        if not (0 < offset < self.rawsize):
            return
        self._seek(offset)
        node = self._get_val_multi({"magic": "int", "metaOffset": "pointer"})
        if node["magic"] != 87381:
            return

        folder_name = f"folder_{offset:x}"
        meta_off = node["metaOffset"] or 0
        if meta_off > 0:
            saved = self._tell()
            try:
                self._seek(meta_off + 32)
                meta = self._get_metadata()
                if meta and meta.get("name") is not None:
                    folder_name = str(meta["name"])
            except Exception as e:  # noqa: BLE001
                log.debug("Failed LDK folder metadata: %s", e)
            finally:
                self._seek(saved)

        child_path = path + [folder_name]
        folders: list[dict] = []
        files: list[dict] = []
        nxt = offset + 24
        seen = {nxt}
        while nxt > 0 and nxt < self.rawsize:
            self._seek(nxt)
            kind = self._get_val("int")
            add_offset = 0
            if kind == 152917:
                g = self._get_val_multi({
                    "nTotal":    "int",
                    "nChild":    "int",
                    "nData":     "int",
                    "addOffset": "pointer",
                })
                for _p in range(g["nChild"] or 0):
                    folders.append(self._get_val_multi({"offset": "pointer", "uid": "int"}))
                skip = max(0, (g["nTotal"] or 0) - (g["nChild"] or 0) - (g["nData"] or 0))
                self._seek(self._tell() + skip * 12)
                for _p in range(g["nData"] or 0):
                    files.append(self._get_val_multi({"offset": "pointer", "uid": "int"}))
                add_offset = g["addOffset"]
            elif kind == 283989:
                g = self._get_val_multi({"nChild": "int", "nData": "int"})
                for _p in range(g["nChild"] or 0):
                    folders.append(self._get_val_multi({"offset": "pointer", "uid": "int"}))
                for _p in range(g["nData"] or 0):
                    files.append(self._get_val_multi({"offset": "pointer", "uid": "int"}))
                break
            else:
                break
            if add_offset in seen:
                break
            seen.add(add_offset)
            nxt = add_offset

        type_by_code = {101: "wpt", 102: "set", 103: "rte", 104: "trk", 105: "are"}
        for f in files:
            data_offset = f.get("offset")
            if not data_offset:
                continue
            blob = self._get_node_data(data_offset)
            if not blob or len(blob) <= 1:
                continue
            file_type = type_by_code.get(blob[0])
            if not file_type:
                continue
            rawname = (
                "/".join(str(s) for s in child_path)
                + f"/file_{str(f.get('uid') or 0).rjust(8, '0')}.{file_type}"
            )
            try:
                child = ApqFile(
                    data=blob[1:], file_type=file_type, rawname=rawname,
                )
                if child.parse_successful:
                    child_meta = child.data_parsed.setdefault("meta", {})
                    if meta_off > 0:
                        saved = self._tell()
                        try:
                            self._seek(meta_off + 32)
                            folder_meta = self._get_metadata()
                            if folder_meta:
                                for k, v in folder_meta.items():
                                    if k in ("_order", "_types"):
                                        continue
                                    if k not in child_meta:
                                        child_meta[k] = v
                        except Exception:
                            pass
                        finally:
                            self._seek(saved)
                    if (not child_meta.get("name")
                            and folder_name
                            and not folder_name.startswith("folder_")):
                        child_meta["name"] = folder_name
                    self.data_parsed["items"].append(child)
            except Exception as e:  # noqa: BLE001
                log.debug("Skipped corrupt LDK child %s: %s", rawname, e)

        for folder in folders:
            f_off = folder.get("offset")
            if f_off:
                self._parse_ldk_node(f_off, child_path)


# ─── Geometry extraction ──────────────────────────────────────────────────────

def _last_sunday_utc(year: int, month: int, hour_utc: int) -> datetime:
    """UTC datetime of last Sunday of `month` (1-based) at `hour_utc`."""
    # First day of next month, minus its weekday → last Sunday of `month`.
    if month == 12:
        next_first = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        next_first = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    last_day = next_first - timedelta(days=1)
    # Python: Monday=0..Sunday=6. We want last Sunday → subtract `(weekday+1) % 7`
    delta = (last_day.weekday() + 1) % 7
    last_sunday = last_day - timedelta(days=delta)
    return last_sunday.replace(hour=hour_utc, minute=0, second=0, microsecond=0)


def _ukraine_offset_hours(ms: float) -> int:
    """EEST(+3) in summer, EET(+2) in winter, EU DST rule."""
    instant = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    year = instant.year
    dst_start = _last_sunday_utc(year, 3, 1)
    dst_end   = _last_sunday_utc(year, 10, 1)
    return 3 if dst_start <= instant < dst_end else 2


def format_observation_datetime(ms: float | None) -> str | None:
    if ms is None:
        return None
    try:
        ms_f = float(ms)
    except (TypeError, ValueError):
        return None
    if not (ms_f == ms_f) or ms_f in (float("inf"), float("-inf")):  # NaN/Inf
        return None
    d = datetime.fromtimestamp(ms_f / 1000.0, tz=timezone.utc)
    if d.year < 2000:
        return None
    shifted = d + timedelta(hours=_ukraine_offset_hours(ms_f))
    return f"{shifted.year:04d}-{shifted.month:02d}-{shifted.day:02d}" \
           f"T{shifted.hour:02d}:{shifted.minute:02d}:{shifted.second:02d}"


def _normalize_metadata(meta: Any) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not isinstance(meta, dict):
        return out
    for k, v in meta.items():
        if k.startswith("_"):
            continue
        if v is None:
            continue
        out[k] = [str(x) for x in v] if isinstance(v, list) else [str(v)]
    return out


def _merge_metadata(target: dict[str, list[str]], src_raw: Any) -> dict[str, list[str]]:
    norm = _normalize_metadata(src_raw)
    for k, vals in norm.items():
        target.setdefault(k, []).extend(vals)
    return target


def _location_to_coord(loc: Any) -> list[float] | None:
    if not isinstance(loc, dict):
        return None
    lon, lat = loc.get("lon"), loc.get("lat")
    if lon is None or lat is None:
        return None
    try:
        lon = float(lon); lat = float(lat)
    except (TypeError, ValueError):
        return None
    if lon != lon or lat != lat:  # NaN
        return None
    return [lon, lat]


def _locations_to_coords(locs: list[Any]) -> list[list[float]]:
    out: list[list[float]] = []
    for loc in locs or []:
        c = _location_to_coord(loc)
        if c:
            out.append(c)
    return out


def _extract_comments(meta: dict[str, list[str]]) -> list[str]:
    out: list[str] = []
    if meta.get("desc"):
        out.append(meta["desc"][-1])
    if meta.get("comment"):
        out.extend(meta["comment"])
    return [x for x in out if x]


def _extract_name(meta: dict[str, list[str]]) -> str | None:
    arr = meta.get("name")
    if not arr:
        return None
    v = (arr[-1] or "").strip()
    return v or None


def _extract_color(meta: dict[str, list[str]]) -> str | None:
    arr = meta.get("color")
    if not arr:
        return None
    v = (str(arr[-1]) or "").strip()
    return v or None


def _normalize_coordinates(type_: str, coords: Any, depth: int = 0) -> Any:
    """Validate and (for polygons) close coordinate rings."""
    if type_ == "Point":
        return coords if (isinstance(coords, list) and len(coords) >= 2
                          and all(isinstance(x, (int, float)) for x in coords[:2])) else None
    if type_ == "Line":
        if isinstance(coords, list) and len(coords) >= 2:
            return coords
        # Single-point line: degenerate but tolerated (duplicate the point).
        if depth < 3 and isinstance(coords, list) and len(coords) == 1:
            return _normalize_coordinates(type_, coords + [coords[0]], depth + 1)
        return None
    # Polygon
    ring = coords[0] if (coords and isinstance(coords[0], list)
                         and coords[0] and isinstance(coords[0][0], list)) else coords
    if not isinstance(ring, list):
        return None
    if len(ring) >= 3:
        first, last = ring[0], ring[-1]
        if first[0] != last[0] or first[1] != last[1]:
            if depth < 3:
                return _normalize_coordinates(type_, [ring + [first]], depth + 1)
        return [ring]
    if depth < 3 and len(ring) >= 1:
        return _normalize_coordinates(type_, [ring + [ring[0]]], depth + 1)
    return None


def _build_geometry(*, type_: str, name: str | None, coordinates: Any,
                    observation_datetime: str | None,
                    metadata: dict[str, list[str]],
                    color_string: str | None,
                    default_color: str | None = None) -> dict | None:
    coords = _normalize_coordinates(type_, coordinates)
    if coords is None:
        return None
    return {
        "type": type_,
        "name": name,
        "coordinates": coords,
        "observationDatetime": observation_datetime,
        "comments": _extract_comments(metadata),
        "metadata": metadata,
        "outlineColor": color_string or default_color,
    }


def _location_to_datetime(loc: Any) -> str | None:
    if isinstance(loc, dict) and loc.get("ts"):
        return format_observation_datetime(loc["ts"])
    return None


def extract_geometries_from_parsed(parsed: dict | None) -> list[dict]:
    """Convert parsed APQ data → list of geometry dicts (coords already [lon,lat])."""
    if not parsed or not parsed.get("parse_successful"):
        return []
    t = parsed.get("type")
    base_meta = _normalize_metadata(parsed.get("meta"))
    out: list[dict] = []

    if t == "wpt":
        loc = parsed.get("location")
        coord = _location_to_coord(loc)
        if not coord:
            return out
        g = _build_geometry(
            type_="Point", name=_extract_name(base_meta), coordinates=coord,
            observation_datetime=_location_to_datetime(loc),
            metadata=base_meta, color_string=_extract_color(base_meta),
            default_color=DEFAULT_COLOR,
        )
        if g:
            out.append(g)
        return out

    if t == "set":
        for wp in parsed.get("waypoints") or []:
            meta = _merge_metadata(dict(base_meta), wp.get("meta"))
            coord = _location_to_coord(wp.get("location"))
            if not coord:
                continue
            g = _build_geometry(
                type_="Point", name=_extract_name(meta), coordinates=coord,
                observation_datetime=_location_to_datetime(wp.get("location")),
                metadata=meta, color_string=_extract_color(meta),
                default_color=DEFAULT_COLOR,
            )
            if g:
                out.append(g)
        return out

    if t == "rte":
        wps = parsed.get("waypoints") or []
        coords = _locations_to_coords([w.get("location") for w in wps if w])
        if len(coords) < 2:
            if len(coords) == 1 and wps:
                meta = _merge_metadata(dict(base_meta), wps[0].get("meta"))
                g = _build_geometry(
                    type_="Point", name=_extract_name(meta), coordinates=coords[0],
                    observation_datetime=_location_to_datetime(wps[0].get("location")),
                    metadata=meta, color_string=_extract_color(meta),
                    default_color=DEFAULT_COLOR,
                )
                if g:
                    out.append(g)
            return out
        meta = _merge_metadata(dict(base_meta), wps[0].get("meta") if wps else None)
        g = _build_geometry(
            type_="Line", name=_extract_name(meta), coordinates=coords,
            observation_datetime=_location_to_datetime(wps[0].get("location") if wps else None),
            metadata=meta, color_string=_extract_color(meta),
        )
        if g:
            out.append(g)
        return out

    if t == "trk":
        for wp in parsed.get("waypoints") or []:
            meta = _merge_metadata(dict(base_meta), wp.get("meta"))
            coord = _location_to_coord(wp.get("location"))
            if not coord:
                continue
            g = _build_geometry(
                type_="Point", name=_extract_name(meta), coordinates=coord,
                observation_datetime=_location_to_datetime(wp.get("location")),
                metadata=meta, color_string=_extract_color(meta),
                default_color=DEFAULT_COLOR,
            )
            if g:
                out.append(g)
        for seg in parsed.get("segments") or []:
            meta = _merge_metadata(dict(base_meta), seg.get("meta"))
            coords = _locations_to_coords(seg.get("locations") or [])
            if len(coords) < 2:
                continue
            first_loc = (seg.get("locations") or [None])[0]
            g = _build_geometry(
                type_="Line", name=_extract_name(meta), coordinates=coords,
                observation_datetime=_location_to_datetime(first_loc),
                metadata=meta, color_string=_extract_color(meta),
            )
            if g:
                out.append(g)
        return out

    if t == "are":
        polys = parsed.get("polygons") or []
        if polys:
            for poly in polys:
                meta = _merge_metadata(dict(base_meta), poly.get("meta"))
                ring = _locations_to_coords(poly.get("outer_boundary") or [])
                if len(ring) < 3:
                    continue
                first_loc = (poly.get("outer_boundary") or [None])[0]
                g = _build_geometry(
                    type_="Polygon", name=_extract_name(meta), coordinates=[ring],
                    observation_datetime=_location_to_datetime(first_loc),
                    metadata=meta, color_string=_extract_color(meta),
                )
                if g:
                    out.append(g)
            return out
        locs = parsed.get("locations") or []
        ring = _locations_to_coords(locs)
        if len(ring) >= 3:
            g = _build_geometry(
                type_="Polygon", name=_extract_name(base_meta), coordinates=[ring],
                observation_datetime=_location_to_datetime(locs[0] if locs else None),
                metadata=base_meta, color_string=_extract_color(base_meta),
            )
            if g:
                out.append(g)
        return out

    if t == "tracker_data":
        for idx, seg in enumerate(parsed.get("segments") or []):
            coords = _locations_to_coords(seg)
            if len(coords) < 2:
                continue
            meta = {"name": [f"Tracker Segment {idx + 1}"]}
            g = _build_geometry(
                type_="Line", name=meta["name"][0], coordinates=coords,
                observation_datetime=_location_to_datetime(seg[0] if seg else None),
                metadata=meta, color_string=None,
            )
            if g:
                out.append(g)
        return out

    if t == "ldk":
        for item in parsed.get("items") or []:
            if hasattr(item, "get_parsed_data"):
                out.extend(extract_geometries_from_parsed(item.get_parsed_data()))
        return out

    return out


def extract_geometries(apq: ApqFile) -> list[dict]:
    return extract_geometries_from_parsed(apq.get_parsed_data()) if apq.parse_successful else []


# ─── One-shot convenience ─────────────────────────────────────────────────────

def apq_to_features(data: bytes, name: str | None = None) -> list[dict]:
    """Parse `data` and return a list of GeoJSON-like Feature dicts.

    Convenience entry-point for the palette-import pipeline. Raises
    `ApqParserError` on hard failure.
    """
    if name is None:
        name = "file.apq"
    apq = ApqFile(data=data, rawname=name)
    if not apq.parse_successful:
        raise ApqParserError(f"APQ parse failed for {name}")

    features: list[dict] = []
    for g in extract_geometries(apq):
        gtype = g["type"]
        if gtype == "Point":
            geom = {"type": "Point", "coordinates": g["coordinates"]}
        elif gtype == "Line":
            geom = {"type": "LineString", "coordinates": g["coordinates"]}
        elif gtype == "Polygon":
            geom = {"type": "Polygon", "coordinates": g["coordinates"]}
        else:
            continue
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "name":                g["name"],
                "observationDatetime": g["observationDatetime"],
                "comments":            g["comments"],
                "outlineColor":        g["outlineColor"],
                "metadata":            g["metadata"],
            },
        })
    return features
