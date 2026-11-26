import asyncio
import json
import logging
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Union

import asyncpg

logger = logging.getLogger("postgres_db")


class ReturnDocument:
    BEFORE = 1
    AFTER = 2


class InsertOneResult:
    def __init__(self, inserted_id: str):
        self.inserted_id = inserted_id


class InsertManyResult:
    def __init__(self, inserted_ids: List[str]):
        self.inserted_ids = inserted_ids


class UpdateResult:
    def __init__(self, matched_count: int, modified_count: int, upserted_id: Optional[str] = None):
        self.matched_count = matched_count
        self.modified_count = modified_count
        self.upserted_id = upserted_id


class DeleteResult:
    def __init__(self, deleted_count: int):
        self.deleted_count = deleted_count


def _json_serializer(obj: Any) -> Any:
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    raise TypeError(f"Type {type(obj)} not serializable")


def _get_nested(doc: Dict[str, Any], path: str) -> Any:
    parts = path.split(".")
    curr = doc
    for p in parts:
        if isinstance(curr, dict) and p in curr:
            curr = curr[p]
        else:
            return None
    return curr


def _set_nested(doc: Dict[str, Any], path: str, val: Any) -> None:
    parts = path.split(".")
    curr = doc
    for p in parts[:-1]:
        if p not in curr or not isinstance(curr[p], dict):
            curr[p] = {}
        curr = curr[p]
    curr[parts[-1]] = val


def _unset_nested(doc: Dict[str, Any], path: str) -> None:
    parts = path.split(".")
    curr = doc
    for p in parts[:-1]:
        if isinstance(curr, dict) and p in curr:
            curr = curr[p]
        else:
            return
    if isinstance(curr, dict) and parts[-1] in curr:
        del curr[parts[-1]]


def _inc_nested(doc: Dict[str, Any], path: str, amount: Union[int, float]) -> None:
    val = _get_nested(doc, path)
    if val is None:
        _set_nested(doc, path, amount)
    else:
        _set_nested(doc, path, val + amount)


def _push_nested(doc: Dict[str, Any], path: str, val: Any) -> None:
    parts = path.split(".")
    curr = doc
    for p in parts[:-1]:
        if p not in curr or not isinstance(curr[p], dict):
            curr[p] = {}
        curr = curr[p]
    last = parts[-1]
    if last not in curr or not isinstance(curr[last], list):
        curr[last] = []
    curr[last].append(val)


def _pull_nested(doc: Dict[str, Any], path: str, val: Any) -> None:
    lst = _get_nested(doc, path)
    if isinstance(lst, list):
        if isinstance(val, dict):
            _set_nested(doc, path, [x for x in lst if not _matches_filter(x, val)])
        else:
            _set_nested(doc, path, [x for x in lst if x != val])


def _add_to_set_nested(doc: Dict[str, Any], path: str, val: Any) -> None:
    lst = _get_nested(doc, path)
    if not isinstance(lst, list):
        _set_nested(doc, path, [val])
    else:
        if val not in lst:
            lst.append(val)


def _matches_filter(doc: Dict[str, Any], flt: Optional[Dict[str, Any]]) -> bool:
    if not flt:
        return True
    for key, condition in flt.items():
        if key == "$or":
            if not any(_matches_filter(doc, sub) for sub in condition):
                return False
            continue
        if key == "$and":
            if not all(_matches_filter(doc, sub) for sub in condition):
                return False
            continue
        if key == "$nor":
            if any(_matches_filter(doc, sub) for sub in condition):
                return False
            continue

        actual_val = _get_nested(doc, key)

        if isinstance(condition, dict):
            for op, op_val in condition.items():
                if op == "$eq":
                    if actual_val != op_val:
                        return False
                elif op == "$ne":
                    if actual_val == op_val:
                        return False
                elif op == "$in":
                    if actual_val not in op_val:
                        return False
                elif op == "$nin":
                    if actual_val in op_val:
                        return False
                elif op == "$gt":
                    if actual_val is None or actual_val <= op_val:
                        return False
                elif op == "$gte":
                    if actual_val is None or actual_val < op_val:
                        return False
                elif op == "$lt":
                    if actual_val is None or actual_val >= op_val:
                        return False
                elif op == "$lte":
                    if actual_val is None or actual_val > op_val:
                        return False
                elif op == "$exists":
                    exists = actual_val is not None
                    if exists != bool(op_val):
                        return False
                elif op == "$regex":
                    flags = re.IGNORECASE if condition.get("$options") == "i" else 0
                    if not re.search(op_val, str(actual_val or ""), flags=flags):
                        return False
                elif op == "$elemMatch":
                    if not isinstance(actual_val, list) or not any(_matches_filter(x, op_val) for x in actual_val):
                        return False
        else:
            if actual_val != condition:
                return False
    return True


def _apply_update_ops(doc: Dict[str, Any], update: Dict[str, Any], is_insert: bool = False) -> None:
    for op, spec in update.items():
        if op == "$set":
            for k, v in spec.items():
                _set_nested(doc, k, v)
        elif op == "$unset":
            for k in spec:
                _unset_nested(doc, k)
        elif op == "$inc":
            for k, v in spec.items():
                _inc_nested(doc, k, v)
        elif op == "$push":
            for k, v in spec.items():
                _push_nested(doc, k, v)
        elif op == "$pull":
            for k, v in spec.items():
                _pull_nested(doc, k, v)
        elif op == "$addToSet":
            for k, v in spec.items():
                _add_to_set_nested(doc, k, v)
        elif op == "$setOnInsert":
            if is_insert:
                for k, v in spec.items():
                    _set_nested(doc, k, v)
        else:
            # Direct field replacement if no $ operators present
            if not op.startswith("$"):
                doc[op] = spec


def _project(doc: Dict[str, Any], projection: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not projection:
        return dict(doc)

    include_keys = [k for k, v in projection.items() if v and k != "_id"]
    exclude_keys = [k for k, v in projection.items() if not v and k != "_id"]
    include_id = projection.get("_id", 1) != 0

    if include_keys:
        res = {}
        if include_id and "_id" in doc:
            res["_id"] = doc["_id"]
        for k in include_keys:
            val = _get_nested(doc, k)
            if val is not None:
                _set_nested(res, k, val)
        return res
    elif exclude_keys or not include_id:
        res = dict(doc)
        if not include_id:
            res.pop("_id", None)
        for k in exclude_keys:
            _unset_nested(res, k)
        return res
    return dict(doc)


class PostgresCursor:
    def __init__(self, collection: "PostgresCollection", flt: Optional[Dict[str, Any]], projection: Optional[Dict[str, Any]]):
        self.collection = collection
        self.flt = flt or {}
        self.projection = projection
        self._sort_specs = []
        self._skip = 0
        self._limit = None

    def sort(self, key_or_list: Union[str, List], direction: Optional[int] = None) -> "PostgresCursor":
        if isinstance(key_or_list, str):
            dir_val = direction if direction is not None else 1
            self._sort_specs.append((key_or_list, dir_val))
        elif isinstance(key_or_list, list):
            for item in key_or_list:
                if isinstance(item, tuple):
                    self._sort_specs.append(item)
                elif isinstance(item, str):
                    self._sort_specs.append((item, 1))
        return self

    def skip(self, n: int) -> "PostgresCursor":
        self._skip = max(0, n)
        return self

    def limit(self, n: int) -> "PostgresCursor":
        self._limit = max(0, n)
        return self

    async def _fetch_filtered(self) -> List[Dict[str, Any]]:
        docs = await self.collection._fetch_all_docs()
        matched = [d for d in docs if _matches_filter(d, self.flt)]

        # Apply sorting
        if self._sort_specs:
            for key, direction in reversed(self._sort_specs):
                reverse = direction < 0
                matched.sort(
                    key=lambda x: (_get_nested(x, key) is None, _get_nested(x, key)),
                    reverse=reverse,
                )

        # Apply skip & limit
        if self._skip:
            matched = matched[self._skip:]
        if self._limit is not None:
            matched = matched[:self._limit]

        return [_project(d, self.projection) for d in matched]

    async def to_list(self, length: Optional[int] = None) -> List[Dict[str, Any]]:
        if length is not None and (self._limit is None or length < self._limit):
            self._limit = length
        return await self._fetch_filtered()

    async def __aiter__(self):
        items = await self._fetch_filtered()
        for item in items:
            yield item


class PostgresAggregationCursor:
    def __init__(self, collection: "PostgresCollection", pipeline: List[Dict[str, Any]]):
        self.collection = collection
        self.pipeline = pipeline

    async def to_list(self, length: Optional[int] = None) -> List[Dict[str, Any]]:
        docs = await self.collection._fetch_all_docs()
        curr = [dict(d) for d in docs]

        for stage in self.pipeline:
            for op, spec in stage.items():
                if op == "$match":
                    curr = [d for d in curr if _matches_filter(d, spec)]
                elif op == "$group":
                    group_id_field = spec.get("_id")
                    groups = {}
                    for d in curr:
                        if isinstance(group_id_field, str) and group_id_field.startswith("$"):
                            gkey = _get_nested(d, group_id_field[1:])
                        else:
                            gkey = None

                        if gkey not in groups:
                            groups[gkey] = {"_id": gkey}
                            for accum_key, accum_op in spec.items():
                                if accum_key == "_id":
                                    continue
                                if isinstance(accum_op, dict) and "$sum" in accum_op:
                                    groups[gkey][accum_key] = 0

                        for accum_key, accum_op in spec.items():
                            if accum_key == "_id":
                                continue
                            if isinstance(accum_op, dict) and "$sum" in accum_op:
                                sval = accum_op["$sum"]
                                if isinstance(sval, int):
                                    groups[gkey][accum_key] += sval
                                elif isinstance(sval, str) and sval.startswith("$"):
                                    val = _get_nested(d, sval[1:]) or 0
                                    groups[gkey][accum_key] += val
                    curr = list(groups.values())
                elif op == "$sort":
                    for key, direction in reversed(list(spec.items())):
                        reverse = direction < 0
                        curr.sort(
                            key=lambda x: (_get_nested(x, key) is None, _get_nested(x, key)),
                            reverse=reverse,
                        )
                elif op == "$limit":
                    curr = curr[:spec]
                elif op == "$skip":
                    curr = curr[spec:]
                elif op == "$project":
                    curr = [_project(d, spec) for d in curr]

        if length is not None:
            curr = curr[:length]
        return curr


class PostgresCollection:
    def __init__(self, db: "PostgresDatabase", name: str):
        self.db = db
        self.name = name
        self.table_name = f"col_{name}"
        self._table_ensured = False

    async def _ensure_table(self):
        if self._table_ensured:
            return
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            await conn.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.table_name} (
                    id TEXT PRIMARY KEY,
                    data JSONB NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_{self.name}_data ON {self.table_name} USING gin(data);
            """)
        self._table_ensured = True

    async def _fetch_all_docs(self) -> List[Dict[str, Any]]:
        await self._ensure_table()
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
            res = []
            for r in rows:
                doc = json.loads(r["data"])
                doc.setdefault("id", r["id"])
                doc.setdefault("_id", r["id"])
                res.append(doc)
            return res

    def find(self, flt: Optional[Dict[str, Any]] = None, projection: Optional[Dict[str, Any]] = None) -> PostgresCursor:
        return PostgresCursor(self, flt, projection)

    async def find_one(self, flt: Optional[Dict[str, Any]] = None, projection: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        cursor = self.find(flt, projection).limit(1)
        res = await cursor.to_list(1)
        return res[0] if res else None

    async def find_one_and_update(
        self,
        flt: Dict[str, Any],
        update: Dict[str, Any],
        return_document: int = ReturnDocument.AFTER,
        upsert: bool = False,
    ) -> Optional[Dict[str, Any]]:
        await self._ensure_table()
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
                matched_row = None
                matched_doc = None

                for r in rows:
                    doc = json.loads(r["data"])
                    doc.setdefault("id", r["id"])
                    doc.setdefault("_id", r["id"])
                    if _matches_filter(doc, flt):
                        matched_row = r
                        matched_doc = doc
                        break

                if matched_doc:
                    before_doc = dict(matched_doc)
                    _apply_update_ops(matched_doc, update, is_insert=False)
                    matched_doc.setdefault("id", matched_row["id"])
                    matched_doc.setdefault("_id", matched_row["id"])
                    payload = json.dumps(matched_doc, default=_json_serializer)
                    await conn.execute(
                        f"UPDATE {self.table_name} SET data = $1::jsonb, updated_at = NOW() WHERE id = $2",
                        payload, matched_row["id"],
                    )
                    return matched_doc if return_document == ReturnDocument.AFTER else before_doc

                elif upsert:
                    new_doc = {}
                    for k, v in flt.items():
                        if not k.startswith("$") and not isinstance(v, dict):
                            new_doc[k] = v
                    _apply_update_ops(new_doc, update, is_insert=True)
                    doc_id = str(new_doc.get("id") or new_doc.get("_id") or uuid.uuid4())
                    new_doc["id"] = doc_id
                    new_doc["_id"] = doc_id
                    payload = json.dumps(new_doc, default=_json_serializer)
                    await conn.execute(
                        f"INSERT INTO {self.table_name} (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())",
                        doc_id, payload,
                    )
                    return new_doc
                return None

    async def insert_one(self, doc: Dict[str, Any]) -> InsertOneResult:
        await self._ensure_table()
        d = dict(doc)
        doc_id = str(d.get("id") or d.get("_id") or uuid.uuid4())
        d["id"] = doc_id
        d["_id"] = doc_id
        # Also sync back to original doc dictionary (same as pymongo does)
        doc.setdefault("id", doc_id)
        doc.setdefault("_id", doc_id)

        payload = json.dumps(d, default=_json_serializer)
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                f"""
                INSERT INTO {self.table_name} (id, data, created_at, updated_at)
                VALUES ($1, $2::jsonb, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()
                """,
                doc_id, payload,
            )
        return InsertOneResult(doc_id)

    async def insert_many(self, docs: List[Dict[str, Any]]) -> InsertManyResult:
        await self._ensure_table()
        ids = []
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                for doc in docs:
                    d = dict(doc)
                    doc_id = str(d.get("id") or d.get("_id") or uuid.uuid4())
                    d["id"] = doc_id
                    d["_id"] = doc_id
                    doc.setdefault("id", doc_id)
                    doc.setdefault("_id", doc_id)
                    ids.append(doc_id)
                    payload = json.dumps(d, default=_json_serializer)
                    await conn.execute(
                        f"""
                        INSERT INTO {self.table_name} (id, data, created_at, updated_at)
                        VALUES ($1, $2::jsonb, NOW(), NOW())
                        ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()
                        """,
                        doc_id, payload,
                    )
        return InsertManyResult(ids)

    async def update_one(self, flt: Dict[str, Any], update: Dict[str, Any], upsert: bool = False) -> UpdateResult:
        await self._ensure_table()
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
                for r in rows:
                    doc = json.loads(r["data"])
                    doc.setdefault("id", r["id"])
                    doc.setdefault("_id", r["id"])
                    if _matches_filter(doc, flt):
                        _apply_update_ops(doc, update, is_insert=False)
                        doc.setdefault("id", r["id"])
                        doc.setdefault("_id", r["id"])
                        payload = json.dumps(doc, default=_json_serializer)
                        await conn.execute(
                            f"UPDATE {self.table_name} SET data = $1::jsonb, updated_at = NOW() WHERE id = $2",
                            payload, r["id"],
                        )
                        return UpdateResult(matched_count=1, modified_count=1)

                if upsert:
                    new_doc = {}
                    for k, v in flt.items():
                        if not k.startswith("$") and not isinstance(v, dict):
                            new_doc[k] = v
                    _apply_update_ops(new_doc, update, is_insert=True)
                    doc_id = str(new_doc.get("id") or new_doc.get("_id") or uuid.uuid4())
                    new_doc["id"] = doc_id
                    new_doc["_id"] = doc_id
                    payload = json.dumps(new_doc, default=_json_serializer)
                    await conn.execute(
                        f"INSERT INTO {self.table_name} (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())",
                        doc_id, payload,
                    )
                    return UpdateResult(matched_count=0, modified_count=0, upserted_id=doc_id)
                return UpdateResult(matched_count=0, modified_count=0)

    async def update_many(self, flt: Dict[str, Any], update: Dict[str, Any], upsert: bool = False) -> UpdateResult:
        await self._ensure_table()
        matched = 0
        modified = 0
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
                for r in rows:
                    doc = json.loads(r["data"])
                    doc.setdefault("id", r["id"])
                    doc.setdefault("_id", r["id"])
                    if _matches_filter(doc, flt):
                        matched += 1
                        _apply_update_ops(doc, update, is_insert=False)
                        doc.setdefault("id", r["id"])
                        doc.setdefault("_id", r["id"])
                        payload = json.dumps(doc, default=_json_serializer)
                        await conn.execute(
                            f"UPDATE {self.table_name} SET data = $1::jsonb, updated_at = NOW() WHERE id = $2",
                            payload, r["id"],
                        )
                        modified += 1

                if matched == 0 and upsert:
                    new_doc = {}
                    for k, v in flt.items():
                        if not k.startswith("$") and not isinstance(v, dict):
                            new_doc[k] = v
                    _apply_update_ops(new_doc, update, is_insert=True)
                    doc_id = str(new_doc.get("id") or new_doc.get("_id") or uuid.uuid4())
                    new_doc["id"] = doc_id
                    new_doc["_id"] = doc_id
                    payload = json.dumps(new_doc, default=_json_serializer)
                    await conn.execute(
                        f"INSERT INTO {self.table_name} (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())",
                        doc_id, payload,
                    )
                    return UpdateResult(matched_count=0, modified_count=0, upserted_id=doc_id)

        return UpdateResult(matched_count=matched, modified_count=modified)

    async def delete_one(self, flt: Dict[str, Any]) -> DeleteResult:
        await self._ensure_table()
        pool = await self.db.get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
            for r in rows:
                doc = json.loads(r["data"])
                doc.setdefault("id", r["id"])
                doc.setdefault("_id", r["id"])
                if _matches_filter(doc, flt):
                    await conn.execute(f"DELETE FROM {self.table_name} WHERE id = $1", r["id"])
                    return DeleteResult(deleted_count=1)
        return DeleteResult(deleted_count=0)

    async def delete_many(self, flt: Dict[str, Any]) -> DeleteResult:
        await self._ensure_table()
        pool = await self.db.get_pool()
        count = 0
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(f"SELECT id, data FROM {self.table_name}")
                for r in rows:
                    doc = json.loads(r["data"])
                    doc.setdefault("id", r["id"])
                    doc.setdefault("_id", r["id"])
                    if _matches_filter(doc, flt):
                        await conn.execute(f"DELETE FROM {self.table_name} WHERE id = $1", r["id"])
                        count += 1
        return DeleteResult(deleted_count=count)

    async def count_documents(self, flt: Optional[Dict[str, Any]] = None) -> int:
        docs = await self._fetch_all_docs()
        if not flt:
            return len(docs)
        return sum(1 for d in docs if _matches_filter(d, flt))

    async def distinct(self, field: str, flt: Optional[Dict[str, Any]] = None) -> List[Any]:
        docs = await self._fetch_all_docs()
        vals = set()
        for d in docs:
            if _matches_filter(d, flt):
                v = _get_nested(d, field)
                if v is not None:
                    if isinstance(v, list):
                        for item in v:
                            vals.add(item)
                    else:
                        vals.add(v)
        return sorted(list(vals), key=lambda x: str(x))

    def aggregate(self, pipeline: List[Dict[str, Any]]) -> PostgresAggregationCursor:
        return PostgresAggregationCursor(self, pipeline)

    async def create_indexes(self, models: List[Any]) -> None:
        # PostgreSQL GIN index on data is already ensured in _ensure_table
        pass


class PostgresDatabase:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self._pool: Optional[asyncpg.Pool] = None
        self._collections: Dict[str, PostgresCollection] = {}

    async def get_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self.dsn, min_size=2, max_size=20)
        return self._pool

    def __getitem__(self, name: str) -> PostgresCollection:
        if name not in self._collections:
            self._collections[name] = PostgresCollection(self, name)
        return self._collections[name]

    def __getattr__(self, name: str) -> PostgresCollection:
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    async def list_collection_names(self) -> List[str]:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT table_name FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_name LIKE 'col_%'
            """)
            return [r["table_name"][4:] for r in rows]
