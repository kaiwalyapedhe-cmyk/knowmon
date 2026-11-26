import asyncio
import os
import sys
from pymongo import MongoClient
from postgres_db import PostgresDatabase

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("DB_NAME", "knowmon")
POSTGRES_URL = os.environ.get("POSTGRES_URL", "postgresql://knowmon:knowmon@localhost:5433/knowmon")

async def migrate():
    print(f"Connecting to MongoDB: {MONGO_URL} (db: {DB_NAME})")
    m_client = MongoClient(MONGO_URL)
    m_db = m_client[DB_NAME]
    
    print(f"Connecting to PostgreSQL: {POSTGRES_URL}")
    pg_db = PostgresDatabase(POSTGRES_URL)
    
    collections = sorted(m_db.list_collection_names())
    print(f"Found {len(collections)} collections in MongoDB: {collections}")
    
    total_migrated = 0
    for coll_name in collections:
        if coll_name.startswith("system."):
            continue
        
        m_coll = m_db[coll_name]
        docs = list(m_coll.find({}))
        if not docs:
            print(f"  - {coll_name}: 0 docs (skipped)")
            continue
        
        pg_coll = pg_db[coll_name]
        await pg_coll._ensure_table()
        
        # Clean existing rows in postgres collection before migration
        await pg_coll.delete_many({})
        
        # Clean MongoDB _id if it's an ObjectId and convert to string
        clean_docs = []
        for d in docs:
            d_copy = dict(d)
            if "_id" in d_copy:
                d_copy["_id"] = str(d_copy["_id"])
            if "id" not in d_copy and "_id" in d_copy:
                d_copy["id"] = d_copy["_id"]
            clean_docs.append(d_copy)
            
        await pg_coll.insert_many(clean_docs)
        print(f"  ✓ {coll_name}: migrated {len(clean_docs)} documents to PostgreSQL")
        total_migrated += len(clean_docs)
        
    print(f"\nMigration complete! Total documents migrated to PostgreSQL: {total_migrated}")

if __name__ == "__main__":
    asyncio.run(migrate())
