#!/usr/bin/env python3
"""Clio Coder's clio-core host.

Speaks the core host protocol of src/domains/store/core-host/protocol.ts on
stdin and stdout: frames of a 4-byte big-endian length then UTF-8 JSON. It
holds one clio-core client through the iowarp_core Python bindings and maps
each op onto them. Standard library plus iowarp_core only. Nothing but frames
reaches stdout; logs go to stderr.
"""

import argparse
import base64
import errno
import json
import os
import re
import stat as stat_mode
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HOST_VERSION = "1"
MAX_FRAME_BYTES = 1024 * 1024
STEP_BYTES = 4 * 1024 * 1024
PROGRESS_BYTES = 64 * 1024 * 1024
PROGRESS_SECONDS = 2.0
# Under the supervisor's 30 s call deadline, so a stalled runtime is answered, not timed out.
CALL_SECONDS = 25.0
ATTACH_SECONDS = 10.0
EXIT_ATTACH_FAILED = 3
EXIT_PROTOCOL = 2
RECORDS_SUFFIX = "/.records"
XATTR_METHODS = ("AsyncTagSetXattr", "AsyncTagGetXattr", "AsyncTagListXattr")
PUT_IF_ABSENT = "AsyncPutBlobIfAbsent"
DEL_TAG_BINDING = "clio_cte_core_ext.Client.AsyncDelTag"
FS_BINDING = "clio_cfs_ext.Client"
# A put writes `.<leaf>#put-<12 hex>` beside the blob, then renames it over; `#` is never in a blob name.
PUT_TEMP_SUFFIX = "#put-"
DURABLE_LEVELS = ("temporary", "long_term")
VOLATILE_BDEVS = ("ram", "hbm", "pinned", "noop")

# Frames get a private copy of fd 1; fd 1 itself then points at stderr, so native logging can never corrupt a frame.
_frames_fd = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr
_send_lock = threading.Lock()


def log(message):
    sys.stderr.write(f"clio_core_host: {message}\n")
    sys.stderr.flush()


class Refusal(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason
        self.message = message


def send(value):
    body = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise Refusal("io", f"The answer is {len(body)} bytes, over the {MAX_FRAME_BYTES}-byte frame limit.")
    data = struct.pack(">I", len(body)) + body
    with _send_lock:
        view = memoryview(data)
        while view:
            view = view[os.write(_frames_fd, view) :]


def read_exact(count):
    chunks = []
    while count > 0:
        chunk = os.read(0, count)
        if not chunk:
            return None
        chunks.append(chunk)
        count -= len(chunk)
    return b"".join(chunks)


def read_frame():
    head = read_exact(4)
    if head is None:
        return None
    (length,) = struct.unpack(">I", head)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"frame length {length} exceeds {MAX_FRAME_BYTES}")
    body = read_exact(length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def regex_escape(text):
    return re.sub(r"([.^$|()\[\]{}*+?\\])", r"\\\1", text)


def check_rc(code, what):
    if code == 0:
        return
    if code in (12, 13):
        raise Refusal("no-space", f"{what} failed with return code {code} (no space).")
    if code == 60:
        raise Refusal("exists", f"{what} failed with return code {code} (exists).")
    raise Refusal("io", f"{what} failed with return code {code}.")


def finish(future, what):
    """Polls `done()` against a deadline; `wait` on a runtime that is gone never returns."""
    deadline = time.monotonic() + CALL_SECONDS
    delay = 0.0005
    while not future.done():
        if time.monotonic() >= deadline:
            raise Refusal("unavailable", f"clio-core did not answer {what} within {CALL_SECONDS:g} s.")
        time.sleep(delay)
        delay = min(delay * 2, 0.02)
    return future


def result_of(future, what):
    return finish(future, what).result(0)


def rc_of(future, what):
    code = finish(future, what).wait(0)
    return -1 if code is None else int(code)


def read_config(path):
    """The clio_cte_core storage entries and whether the hostfile names more than one node; pyyaml ships with iowarp-core."""
    try:
        import yaml

        with open(path, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    except Exception as error:
        log(f"cannot read the clio-core config {path!r} ({error}); reporting the store as not durable")
        return [], False
    devices = [
        tier
        for module in config.get("compose") or []
        if isinstance(module, dict) and module.get("mod_name") == "clio_cte_core"
        for tier in module.get("storage") or []
        if isinstance(tier, dict)
    ]
    hosts = 1
    hostfile = (config.get("networking") or {}).get("hostfile")
    if hostfile:
        try:
            with open(os.path.expandvars(str(hostfile)), encoding="utf-8") as handle:
                hosts = sum(1 for line in handle if line.strip() and not line.strip().startswith("#"))
        except OSError as error:
            log(f"cannot read the hostfile {hostfile!r} ({error})")
    return devices, hosts > 1


def target_is_durable(devices, target):
    """Whether a target the running runtime lists is a durable tier.

    The bindings report no persistence level, so this maps the target back to
    its config entry the way clio-core's GetPersistenceLevelForTarget does: the
    runtime names a target `<path>_node<N>`, or `storage_device_<i>`. A target
    no entry describes is volatile, so a RAM-only runtime is never durable
    whatever the config names (M-40 F19).
    """
    for index, device in enumerate(devices):
        raw = device.get("path")
        path = os.path.expanduser(os.path.expandvars(str(raw))) if raw else ""
        if target == f"storage_device_{index}" or (path and (target == path or target.startswith(path + "_"))):
            return (
                str(device.get("bdev_type", "")).lower() not in VOLATILE_BDEVS
                and str(device.get("persistence_level", "volatile")).lower() in DURABLE_LEVELS
            )
    return False


class Core:
    def __init__(self, options):
        os.environ.pop("CLIO_WITH_RUNTIME", None)
        os.environ["CLIO_WAIT_SERVER"] = str(int(ATTACH_SECONDS))
        os.environ.setdefault("BIND_ADDR", "127.0.0.1")
        if options.config:
            os.environ["CLIO_SERVER_CONF"] = options.config
        self.config = options.config or os.environ.get("CLIO_SERVER_CONF") or os.path.expanduser("~/.clio/clio.yaml")
        self.pool = options.pool
        self.cache_dir = options.cache_dir
        import iowarp_core
        from iowarp_core import clio_cte_core_ext as cte

        self.version = str(iowarp_core.__version__)
        self.cte = cte
        if not cte.clio_init(cte.RuntimeMode.kClient, False):
            raise RuntimeError("clio_init(kClient) returned False: no clio-core runtime answered")
        if not cte.initialize_cte(options.config, cte.PoolQuery.Dynamic()):
            raise RuntimeError("initialize_cte returned False")
        major, minor = (int(part) for part in self.pool.split("."))
        self.client = cte.Client(cte.PoolId(major, minor))
        probe = self.client.AsyncTagQuery("^clio-core-host-liveness$", 1, cte.PoolQuery.Broadcast())
        deadline = time.monotonic() + ATTACH_SECONDS
        while not probe.done():
            if time.monotonic() >= deadline:
                raise RuntimeError(f"the first query after the attach got no answer within {ATTACH_SECONDS:g} s")
            time.sleep(0.01)
        guarded = (*XATTR_METHODS, PUT_IF_ABSENT)
        self.missing = [f"clio_cte_core_ext.Client.{name}" for name in guarded if not hasattr(cte.Client, name)]
        self.missing.append(DEL_TAG_BINDING)
        self.fs = None
        self.fs_problem = ""
        try:
            from iowarp_core import clio_cfs_ext

            self.fs = clio_cfs_ext.Client()
        except ImportError:
            self.fs_problem = f"the installed iowarp-core {self.version} does not have it"
            self.missing.append(FS_BINDING)
        except OSError as error:
            self.fs_problem = f"it could not bind the filesystem pool ({error})"
            self.missing.append(FS_BINDING)
        self.devices, self.multi_node = read_config(self.config)
        self.tag_ids = {}
        self.tag_lock = threading.Lock()

    # Tags

    def tag_exists(self, tag):
        names = result_of(
            self.client.AsyncTagQuery(f"^{regex_escape(tag)}$", 0, self.cte.PoolQuery.Broadcast()), "a tag query"
        )
        return tag in names

    def tag_id(self, tag):
        with self.tag_lock:
            known = self.tag_ids.get(tag)
        if known is not None:
            return known
        tag_id = result_of(self.client.AsyncGetOrCreateTag(tag, self.cte.PoolQuery.Dynamic()), "GetOrCreateTag")
        if tag_id is None or tag_id.IsNull():
            raise Refusal("io", f"GetOrCreateTag returned no id for {tag}.")
        with self.tag_lock:
            self.tag_ids[tag] = tag_id
        return tag_id

    def existing_tag_id(self, tag):
        with self.tag_lock:
            known = self.tag_ids.get(tag)
        if known is not None:
            return known
        return self.tag_id(tag) if self.tag_exists(tag) else None

    def need_tag(self, tag):
        tag_id = self.existing_tag_id(tag)
        if tag_id is None:
            raise Refusal("not-found", f"The store has no tag named {tag}.")
        return tag_id

    def need_binding(self, name):
        if not hasattr(self.cte.Client, name):
            raise Refusal(
                "unavailable",
                f"This needs clio_cte_core_ext.Client.{name}, which the installed iowarp-core {self.version} does not have.",
            )

    def need_fs(self):
        if self.fs is None:
            raise Refusal("unavailable", f"Blob data needs {FS_BINDING}; {self.fs_problem}.")
        return self.fs

    # Ops

    def facts(self, args):
        local = self.cte.PoolQuery.Local()
        tiers = []
        for name in result_of(self.client.AsyncListTargets(local), "ListTargets"):
            info = result_of(self.client.AsyncGetTargetInfo(name, local), "GetTargetInfo")
            tiers.append({"name": name, "score": float(info.target_score), "freeBytes": int(info.remaining_space)})
        capacity = result_of(self.client.AsyncGetCapacity(local), "GetCapacity")
        return {
            "kind": "clio-core",
            "mapping": "a tag is a CTE tag with a filesystem-module directory; a blob is a file there; records are CTE blobs",
            "tiers": tiers,
            "multiNode": self.multi_node,
            "durable": any(target_is_durable(self.devices, tier["name"]) for tier in tiers),
            "conditionalPut": "if-absent-and-version",
            "blobVersions": False,
            "freeBytes": int(capacity.remaining_capacity),
        }

    def get_or_create_tag(self, args):
        existed = self.tag_exists(args["tag"])
        self.tag_id(args["tag"])
        return {"created": not existed}

    def tag_exists_op(self, args):
        return {"exists": self.tag_exists(args["tag"])}

    def list_tags(self, args):
        pattern = args.get("pattern") or ".*"
        names = result_of(self.client.AsyncTagQuery(pattern, 0, self.cte.PoolQuery.Broadcast()), "a tag query")
        return {"tags": sorted(set(names))}

    def del_tag(self, args):
        raise Refusal(
            "unavailable",
            f"Deleting a tag needs {DEL_TAG_BINDING}, which no iowarp-core release binds yet; tag {args['tag']} is unchanged.",
        )

    def set_tag_xattr(self, args):
        self.need_binding("AsyncTagSetXattr")
        tag_id = self.need_tag(args["tag"])
        key, value = args["key"].encode("utf-8"), args["value"].encode("utf-8")
        answer = result_of(self.client.AsyncTagSetXattr(tag_id, key, value, 0), "TagSetXattr")
        if answer["code"] == getattr(self.cte, "TAG_XATTR_TOO_BIG_RC", None):
            raise Refusal("invalid-name", f"clio-core refused attribute {args['key']} as too big.")
        check_rc(answer["code"], "TagSetXattr")
        return {}

    def get_tag_xattrs(self, args):
        for name in XATTR_METHODS[1:]:
            self.need_binding(name)
        tag_id = self.need_tag(args["tag"])
        keys, cursor = [], b""
        while True:
            page = result_of(self.client.AsyncTagListXattr(tag_id, 0, cursor), "TagListXattr")
            check_rc(page["code"], "TagListXattr")
            keys.extend(page["keys"])
            if not page["more"] or not page["keys"]:
                break
            cursor = page["keys"][-1]
        xattrs = {}
        for key in keys:
            got = result_of(self.client.AsyncTagGetXattr(tag_id, key), "TagGetXattr")
            check_rc(got["code"], "TagGetXattr")
            if got["found"]:
                xattrs[key.decode("utf-8", "replace")] = got["value"].decode("utf-8", "replace")
        return {"xattrs": xattrs}

    def put_record_if_absent(self, args):
        self.need_binding(PUT_IF_ABSENT)
        tag_id = self.tag_id(args["tag"])
        data = base64.b64decode(args["data"], validate=True)
        answer = result_of(self.client.AsyncPutBlobIfAbsent(tag_id, args["blob"], data, 0), "PutBlobIfAbsent")
        if answer["code"] == self.cte.PUT_EXISTS_RC:
            return {"outcome": "exists"}
        check_rc(answer["code"], "PutBlobIfAbsent")
        return {"outcome": "written"}

    def record_size(self, tag_id, blob):
        size = result_of(self.client.AsyncGetBlobSize(tag_id, blob, self.cte.PoolQuery.Dynamic()), "GetBlobSize")
        return int(size or 0)

    def get_record(self, args):
        tag_id = self.existing_tag_id(args["tag"])
        size = 0 if tag_id is None else self.record_size(tag_id, args["blob"])
        if size == 0:
            return {"data": None}
        data = result_of(self.client.AsyncGetBlob(tag_id, args["blob"], size, 0), "GetBlob")
        return {"data": base64.b64encode(data).decode("ascii")}

    def path_of(self, args):
        return f"/{args['tag']}/{args['blob']}"

    def make_parents(self, fs, path):
        parent = ""
        for part in path.strip("/").split("/")[:-1]:
            parent += "/" + part
            try:
                fs.mkdir(parent)
            except OSError as error:
                if error.errno != errno.EEXIST:
                    raise

    def blob_stat(self, fs, path):
        try:
            info = fs.stat(path)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENOTDIR):
                return None
            raise
        if stat_mode.S_ISDIR(info["mode"]):
            return None
        return {"bytes": int(info["size"]), "modifiedMs": int(info["mtime_ns"]) // 1_000_000, "version": None}

    def put_blob_from_file(self, args, progress):
        fs = self.need_fs()
        path = self.path_of(args)
        try:
            source = open(args["source"], "rb")
        except FileNotFoundError:
            raise Refusal("not-found", f"No file at {args['source']}.") from None
        except IsADirectoryError:
            raise Refusal("not-a-file", f"{args['source']} is not a regular file.") from None
        # Never write the blob in place: a put killed midway (its host or the runtime) would leave a
        # truncated blob behind (M-40 F18). The rename replaces the old blob in one step.
        parent, leaf = path.rsplit("/", 1)
        temp = f"{parent}/.{leaf}{PUT_TEMP_SUFFIX}{os.urandom(6).hex()}"
        with source:
            self.make_parents(fs, path)
            fd = fs.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            try:
                done = False
                try:
                    offset, reported, reported_at = 0, 0, time.monotonic()
                    while True:
                        chunk = source.read(STEP_BYTES)
                        if not chunk:
                            break
                        written = 0
                        while written < len(chunk):
                            count = fs.pwrite(fd, chunk[written:] if written else chunk, offset + written)
                            if count <= 0:
                                raise Refusal("io", f"pwrite of {path} accepted no bytes at offset {offset + written}.")
                            written += count
                        offset += len(chunk)
                        if offset - reported >= PROGRESS_BYTES or time.monotonic() - reported_at >= PROGRESS_SECONDS:
                            progress(offset)
                            reported, reported_at = offset, time.monotonic()
                    fs.fsync(fd)
                    done = True
                finally:
                    try:
                        fs.close(fd)
                    except OSError:
                        if done:
                            raise
                fs.rename(temp, path)
            except BaseException:
                try:
                    fs.remove(temp)
                except OSError:
                    pass  # Best effort: listings hide the temp name either way.
                raise
        stat = self.blob_stat(fs, path)
        if stat is None:
            raise Refusal("io", f"{path} is missing right after its put.")
        return stat

    def get_blob_as_path(self, args, progress):
        fs = self.need_fs()
        path = self.path_of(args)
        try:
            info = fs.stat(path)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENOTDIR):
                raise Refusal("not-found", f"Tag {args['tag']} has no blob named {args['blob']}.") from None
            raise
        if stat_mode.S_ISDIR(info["mode"]):
            raise Refusal("not-a-file", f"{path} is a directory, not a blob.")
        target = os.path.join(args["destDir"], "data")
        fd = fs.open(path, os.O_RDONLY, 0)
        try:
            with open(target, "xb") as out:
                offset, reported, reported_at = 0, 0, time.monotonic()
                while True:
                    chunk = fs.pread(fd, STEP_BYTES, offset)
                    if not chunk:
                        break
                    out.write(chunk)
                    offset += len(chunk)
                    if offset - reported >= PROGRESS_BYTES or time.monotonic() - reported_at >= PROGRESS_SECONDS:
                        progress(offset)
                        reported, reported_at = offset, time.monotonic()
        finally:
            fs.close(fd)
        return {"path": target, "copied": True}

    def stat_blob(self, args):
        if args["tag"].endswith(RECORDS_SUFFIX):
            tag_id = self.existing_tag_id(args["tag"])
            size = 0 if tag_id is None else self.record_size(tag_id, args["blob"])
            return {"stat": {"bytes": size, "modifiedMs": 0, "version": None} if size else None}
        return {"stat": self.blob_stat(self.need_fs(), self.path_of(args))}

    def walk(self, fs, root, relative, names):
        directory = root + ("/" + relative if relative else "")
        for entry in fs.readdir(directory):
            name = f"{relative}/{entry}" if relative else entry
            if stat_mode.S_ISDIR(fs.stat(f"{root}/{name}")["mode"]):
                self.walk(fs, root, name, names)
            else:
                names.append(name)

    def list_blobs(self, args):
        names = []
        if args["tag"].endswith(RECORDS_SUFFIX):
            tag_id = self.existing_tag_id(args["tag"])
            if tag_id is not None:
                names = list(result_of(self.client.AsyncGetContainedBlobs(tag_id), "GetContainedBlobs"))
        else:
            try:
                self.walk(self.need_fs(), f"/{args['tag']}", "", names)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTDIR):
                    raise
        if args.get("pattern") is not None:
            try:
                matcher = re.compile(args["pattern"])
            except re.error as error:
                raise Refusal("invalid-name", f"Invalid blob pattern: {error}.") from None
            names = [name for name in names if matcher.fullmatch(name)]
        names = sorted(set(names))
        offset, limit = int(args.get("offset", 0)), int(args.get("limit", len(names)))
        return {"names": names[offset : offset + limit], "hasMore": len(names) > offset + limit}

    def del_blob(self, args):
        if args["tag"].endswith(RECORDS_SUFFIX):
            tag_id = self.existing_tag_id(args["tag"])
            if tag_id is None or self.record_size(tag_id, args["blob"]) == 0:
                return {"deleted": False}
            check_rc(rc_of(self.client.AsyncDelBlob(tag_id, args["blob"]), "DelBlob"), "DelBlob")
            return {"deleted": True}
        fs, path = self.need_fs(), self.path_of(args)
        # clio_cfs_ext's remove reports every failure, ENOENT included, as EIO, so absence is checked by stat.
        if self.blob_stat(fs, path) is None:
            return {"deleted": False}
        try:
            fs.remove(path)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.EIO) and self.blob_stat(fs, path) is None:
                return {"deleted": False}
            raise
        return {"deleted": True}


def refusal_of(error):
    if isinstance(error, Refusal):
        return error.reason, error.message
    if isinstance(error, OSError) and error.errno is not None:
        name = errno.errorcode.get(error.errno, str(error.errno))
        if error.errno in (errno.ENOSPC, errno.EDQUOT):
            return "no-space", f"{error} ({name})"
        if error.errno == errno.ENOENT:
            return "not-found", f"{error} ({name})"
        if error.errno == errno.EISDIR:
            return "not-a-file", f"{error} ({name})"
        return "io", f"{error} ({name})"
    return "io", f"{type(error).__name__}: {error}"


def serve(core):
    ops = {
        "facts": core.facts,
        "getOrCreateTag": core.get_or_create_tag,
        "tagExists": core.tag_exists_op,
        "listTags": core.list_tags,
        "delTag": core.del_tag,
        "setTagXattr": core.set_tag_xattr,
        "getTagXattrs": core.get_tag_xattrs,
        "putRecordIfAbsent": core.put_record_if_absent,
        "getRecord": core.get_record,
        "statBlob": core.stat_blob,
        "listBlobs": core.list_blobs,
        "delBlob": core.del_blob,
    }
    bulk = {"putBlobFromFile": core.put_blob_from_file, "getBlobAsPath": core.get_blob_as_path}

    def run(call_id, op, args):
        try:
            if op in bulk:
                result = bulk[op](args, lambda count: send({"id": call_id, "progress": count}))
            elif op in ops:
                result = ops[op](args)
            else:
                raise Refusal("io", f"Unknown op {op!r}.")
            send({"id": call_id, "ok": True, "result": result})
        except Exception as error:
            reason, message = refusal_of(error)
            if not isinstance(error, Refusal):
                log(f"{op} #{call_id} failed: {message}")
            send({"id": call_id, "ok": False, "reason": reason, "message": message})

    workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix="op")
    while True:
        try:
            frame = read_frame()
        except (ValueError, UnicodeDecodeError) as error:
            log(f"malformed frame from the parent: {error}")
            os._exit(EXIT_PROTOCOL)
        if frame is None or frame.get("op") == "shutdown":
            break
        call_id, op, args = frame.get("id"), frame.get("op"), frame.get("args") or {}
        # Answered here, never behind a busy worker: the parent pings during long calls to see the host is alive.
        if op == "ping":
            send({"id": call_id, "ok": True, "result": {}})
            continue
        workers.submit(run, call_id, op, args)
    workers.shutdown(wait=True)


def main():
    parser = argparse.ArgumentParser(description="Clio Coder's clio-core host (core host protocol on stdio).")
    parser.add_argument("--pool", default="563.0", help="CTE pool the client addresses, major.minor")
    parser.add_argument("--config", default="", help="clio-core config file (CLIO_SERVER_CONF)")
    parser.add_argument("--cache-dir", default="", help="directory the parent materializes blobs under")
    options = parser.parse_args()
    try:
        core = Core(options)
    except BaseException as error:
        reason = f"{type(error).__name__}: {error}".replace("\n", " ")
        log(f"could not attach to clio-core: {reason}")
        try:
            send({"hello": None, "error": reason})
        finally:
            os._exit(EXIT_ATTACH_FAILED)
    send(
        {
            "hello": {
                "host": "python",
                "hostVersion": f"{HOST_VERSION} (python {sys.version.split()[0]})",
                "coreVersion": core.version,
                "pool": core.pool,
                "transport": os.environ.get("CLIO_IPC_MODE", "auto"),
                "missing": core.missing,
            }
        }
    )
    log(f"attached: iowarp-core {core.version}, pool {core.pool}, missing {core.missing or 'nothing'}")
    serve(core)
    sys.stderr.flush()
    # The native client's teardown can block on a runtime that is gone; the parent waits for this exit.
    os._exit(0)


if __name__ == "__main__":
    main()
