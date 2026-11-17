import os

import requests
from starlette.concurrency import run_in_threadpool

STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"
APP_NAME = "cadence-cx"
_storage_key = None


def init_storage(force: bool = False) -> str:
    global _storage_key
    if _storage_key and not force:
        return _storage_key
    resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": os.environ["EMERGENT_LLM_KEY"]}, timeout=30)
    resp.raise_for_status()
    _storage_key = resp.json()["storage_key"]
    return _storage_key


def _request(method: str, path: str, **kw) -> requests.Response:
    for attempt in (0, 1):
        resp = requests.request(method, f"{STORAGE_URL}/objects/{path}",
                                headers={"X-Storage-Key": init_storage(force=attempt == 1), **kw.pop("headers", {})}, **kw)
        if resp.status_code != 404 or attempt == 1 or method != "GET":
            break
    resp.raise_for_status()
    return resp


def _put(path: str, data: bytes, content_type: str) -> dict:
    return _request("PUT", path, headers={"Content-Type": content_type}, data=data, timeout=120).json()


def _get(path: str) -> tuple:
    resp = _request("GET", path, timeout=60)
    return resp.content, resp.headers.get("Content-Type", "application/octet-stream")


async def put_object(path: str, data: bytes, content_type: str) -> dict:
    return await run_in_threadpool(_put, f"{APP_NAME}/{path}", data, content_type)


async def get_object(full_path: str) -> tuple:
    return await run_in_threadpool(_get, full_path)
